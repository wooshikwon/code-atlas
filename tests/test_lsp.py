from code_atlas.lsp import to_utf16, to_utf8


def edge_set(analysis, kind):
    return {(e.source, e.target) for e in analysis.edges if e.kind == kind}


def test_column_conversion_round_trip():
    line = '    label = "엔진 시작"; run_engine(config)'
    col8 = line.encode().index(b"run_engine")
    col16 = line.index("run_engine")
    assert to_utf16(line, col8) == col16
    assert to_utf8(line, col16) == col8


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
