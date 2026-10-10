import sys

import pytest
from lsprotocol import types

from code_atlas.analyze import analyze_async
from code_atlas.collect import collect
from code_atlas.lsp import Session, markdown_of, to_utf16, to_utf8


def edge_set(analysis, kind):
    return {(e.source, e.target) for e in analysis.edges if e.kind == kind}


def test_column_conversion_round_trip():
    line = '    label = "엔진 시작"; run_engine(config)'
    col8 = line.encode().index(b"run_engine")
    col16 = line.index("run_engine")
    assert to_utf16(line, col8) == col16
    assert to_utf8(line, col16) == col8


def test_markdown_of_hover_content_forms():
    code = types.MarkedStringWithLanguage(language="python", value="def f(): ...")
    assert markdown_of(types.MarkupContent(kind=types.MarkupKind.Markdown, value="**f**")) == "**f**"
    assert markdown_of("plain") == "plain"
    assert markdown_of(code) == "```python\ndef f(): ...\n```"
    assert markdown_of([code, "설명"]) == "```python\ndef f(): ...\n```\n\n설명"


@pytest.mark.asyncio
async def test_hover_and_definition_at_after_korean_string(sample_repo):
    files = collect(sample_repo)
    async with Session(files.root, sys.executable, files.extra_paths) as session:
        analyzed = await analyze_async(files, session)
        line = analyzed.texts["src/app/cli.py"].splitlines()[9]
        col = line.index("run_engine")
        assert col != line.encode().index(b"run_engine")

        hover = await session.hover("src/app/cli.py", 10, col)
        assert "run_engine" in hover.markdown
        assert hover.range == (10, col, 10, col + len("run_engine"))

        [loc] = await session.definition_at("src/app/cli.py", 10, col)
        assert (loc.path, loc.line, loc.col) == (str(files.root / "src/app/core.py"), 31, 4)
        assert not session.stopped
    assert session.stopped


def test_call_after_korean_string(analyzed):
    analysis, _ = analyzed
    assert ("app.cli:main", "app.core:run_engine") in edge_set(analysis, "call")
    edge = next(e for e in analysis.edges if e.kind == "call" and e.target == "app.core:run_engine")
    site = edge.sites[0]
    assert (site.path, site.line, site.col) == ("src/app/cli.py", 10, 21)


def test_deferred_import(analyzed):
    analysis, _ = analyzed
    edges = {(e.source, e.target): e for e in analysis.edges if e.kind == "import"}
    assert edges[("app.cli", "app.plugins.base")].deferred
    assert not edges[("app.cli", "app.models")].deferred


def test_override(analyzed):
    analysis, _ = analyzed
    assert edge_set(analysis, "override") == {("app.plugins.base:Loud.run", "app.plugins.base:Plugin.run")}


def test_namedtuple_and_enum_are_dataclasses(analyzed):
    analysis, _ = analyzed
    nodes = {n.id: n for n in analysis.nodes}
    assert nodes["app.models:Point"].kind == "dataclass"
    assert nodes["app.models:Point"].fields == [{"name": "x", "type": "int"}, {"name": "y", "type": "int"}]
    assert nodes["app.models:Color"].kind == "dataclass"
    assert nodes["app.models:Config"].kind == "dataclass"
