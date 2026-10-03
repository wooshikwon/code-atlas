def nodes(analysis):
    return {n.id: n for n in analysis.nodes}


def test_edges_reference_known_nodes(analyzed):
    analysis, _ = analyzed
    ids = set(nodes(analysis))
    for e in analysis.edges:
        assert e.source in ids and e.target in ids
        assert e.source != e.target


def test_package_nodes_and_loc(analyzed):
    analysis, files = analyzed
    n = nodes(analysis)
    assert "src" not in n
    assert n["app.plugins"].kind == "package"
    assert n["app.plugins"].loc == n["app.plugins.base"].loc
    assert n["tests"].test
    under_app = [f for f in files.files if f.path.startswith("src/app/")]
    text = "".join(files.abs_path(f.path).read_text() for f in under_app)
    assert n["app"].loc == sum(1 for line in text.splitlines() if line.strip())


def test_import_and_reexport(analyzed):
    analysis, _ = analyzed
    imports = {(e.source, e.target) for e in analysis.edges if e.kind == "import"}
    assert ("app.cli", "app.core") in imports
    assert ("app", "app.core") in imports
    assert ("app.core", "ext:os") in imports
    assert nodes(analysis)["ext:os"].origin == "stdlib"


def test_decorator_and_inherit(analyzed):
    analysis, _ = analyzed
    pairs = {(e.kind, e.source, e.target) for e in analysis.edges}
    assert ("decorate", "app.plugins.base:Loud", "app.plugins.base:register") in pairs
    assert ("inherit", "app.plugins.base:Loud", "app.plugins.base:Plugin") in pairs
    assert ("inherit", "app.models:Color", "ext:enum") in pairs
    assert ("call", "app.cli", "app.cli:main") in pairs


def test_entries(analyzed):
    analysis, _ = analyzed
    assert {n.id for n in analysis.nodes if n.entry} == {"app.cli", "app.cli:main"}


def test_unresolved_counts_and_stats(analyzed):
    analysis, _ = analyzed
    n = nodes(analysis)
    assert n["app.cli:main"].unresolved == 1
    assert n["app.plugins.base:Plugin.run"].unresolved == 1
    calls = [s for s in analysis.sites if s.kind == "call"]
    stats = analysis.stats
    assert stats["call_sites"] == sum(s.status != "builtin" for s in calls)
    assert stats["resolved"] + stats["unresolved"] == stats["call_sites"]
    assert analysis.errors == [{"path": "src/app/broken.py", "message": "invalid syntax (줄 1)"}]
