import asyncio
import os
import signal
import sys
import time

import pytest
from lsprotocol import types

from conftest import group_ended

from code_atlas import lsp
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


@pytest.mark.asyncio
async def test_timed_out_request_is_cancelled_on_the_server(sample_repo, monkeypatch):
    files = collect(sample_repo)
    async with Session(files.root, sys.executable, files.extra_paths) as session:
        await analyze_async(files, session)
        cancelled: list[types.CancelParams] = []
        cancel_request = session.client.cancel_request
        monkeypatch.setattr(session.client, "cancel_request", lambda params: (cancelled.append(params), cancel_request(params)))
        with pytest.raises(asyncio.TimeoutError):
            await session.definition_at("src/app/cli.py", 10, 21, timeout=0)
        assert len(cancelled) == 1 and isinstance(cancelled[0].id, str)

        [loc] = await session.definition_at("src/app/cli.py", 10, 21)
        assert loc.line == 31 and len(cancelled) == 1


@pytest.mark.asyncio
async def test_session_ends_the_process_group_when_shutdown_gets_no_response(sample_repo, monkeypatch):
    async def no_response(params):
        await asyncio.Event().wait()

    monkeypatch.setattr(lsp, "SHUTDOWN_TIMEOUT", 0.2)
    async with Session(sample_repo, sys.executable, []) as session:
        pid = session.client._server.pid
        assert os.getpgid(pid) == pid != os.getpgid(0)
        monkeypatch.setattr(session.client, "shutdown_async", no_response)
        started = time.monotonic()
    assert time.monotonic() - started < 3
    assert session.stopped and group_ended(pid)


@pytest.mark.asyncio
async def test_session_ends_the_child_left_by_a_killed_launcher(sample_repo):
    async with Session(sample_repo, sys.executable, []) as session:
        pid = session.client._server.pid
        os.kill(pid, signal.SIGKILL)
        started = time.monotonic()
    assert time.monotonic() - started < 3
    assert group_ended(pid)


@pytest.mark.asyncio
async def test_session_left_by_an_exception_ends_without_a_shutdown_request(sample_repo, monkeypatch):
    asked: list[None] = []
    with pytest.raises(RuntimeError, match="분석 실패"):
        async with Session(sample_repo, sys.executable, []) as session:
            pid = session.client._server.pid
            monkeypatch.setattr(session.client, "shutdown_async", asked.append)
            raise RuntimeError("분석 실패")
    assert asked == [] and session.stopped and group_ended(pid)


@pytest.mark.asyncio
async def test_session_that_fails_to_initialize_ends_its_process_group(sample_repo, monkeypatch):
    async def fail(params):
        raise RuntimeError("초기화 실패")

    session = Session(sample_repo, sys.executable, [])
    monkeypatch.setattr(session.client, "initialize_async", fail)
    with pytest.raises(RuntimeError, match="초기화 실패"):
        await session.__aenter__()
    assert session.stopped and group_ended(session.client._server.pid)


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
