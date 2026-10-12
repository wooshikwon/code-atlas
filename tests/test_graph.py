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


TABLES = "app.tables:"


def test_variable_nodes(analyzed):
    analysis, _ = analyzed
    n = nodes(analysis)
    found = {node.id for node in analysis.nodes if node.kind == "variable"}
    # `__all__`, 모듈 최상위 문장만 읽는 BANNER, 읽는 곳이 없는 UNREAD, 함수의 지역 이름과만 이름이 같은 name은 노드가 아니다.
    assert found == {
        "app.core:REGISTRY",
        "app.core:counter",
        "app.plugins.base:PLUGINS",
        *(TABLES + name for name in ("logger", "PATTERN", "LIMITS", "DEFAULTS", "HANDLERS", "SEEN", "total", "BASE", "DOUBLE")),
    }
    limits = n[TABLES + "LIMITS"]
    assert (limits.name, limits.parent, limits.path, limits.range, limits.loc) == ("LIMITS", "app.tables", "src/app/tables.py", (9, 9), 1)
    assert limits.value == {"kind": "dict", "size": 2, "text": "{'low': 1, 'high': 9}"}
    assert (limits.reads, limits.writes, limits.unresolved, limits.test) == ([], [], 0, False)
    assert {i for i in found if n[i].external_value} == {TABLES + "logger", TABLES + "PATTERN"}
    assert not any(node.external_value or node.value for node in analysis.nodes if node.kind != "variable")


def test_read_and_write_edges(analyzed):
    analysis, _ = analyzed
    edges = {(e.kind, e.source, e.target): e for e in analysis.edges}
    assert {
        ("read", "app.lookup:lowest", TABLES + "LIMITS"),  # from app.tables import LIMITS
        ("read", "app.lookup:highest", TABLES + "LIMITS"),  # tables.LIMITS
        ("read", "app.lookup:Window", TABLES + "LIMITS"),  # 클래스 본문
        ("write", "app.lookup:reset", TABLES + "total"),  # tables.total = 0
        ("write", "app.tables:remember", TABLES + "total"),  # global
        ("write", "app.tables:remember", TABLES + "SEEN"),  # SEEN.append
        ("write", "app.core:Engine.stop", "app.core:REGISTRY"),  # REGISTRY[k] = v
        ("read", "app.tables:dispatch", TABLES + "logger"),
        ("read", "tests.test_tables:test_tables", TABLES + "LIMITS"),
        ("write", "tests.test_tables:test_tables", TABLES + "total"),
    } <= set(edges)
    assert {e.group for e in analysis.edges if e.kind in ("read", "write")} == {"use"}
    targets = {e.target for e in analysis.edges}
    assert not targets & {TABLES + name for name in ("BANNER", "UNREAD", "name", "__all__")}


def test_edges_leave_from_the_variable_whose_value_holds_the_site(analyzed):
    analysis, _ = analyzed
    edges = {(e.kind, e.source, e.target): e for e in analysis.edges}
    assert len(edges[("construct", TABLES + "DEFAULTS", "app.models:Config")].sites) == 2
    assert ("pass", TABLES + "HANDLERS", "app.core:helper") in edges
    assert ("read", TABLES + "DOUBLE", TABLES + "BASE") in edges  # 노드인 변수의 값이 읽는 변수도 노드다
    assert not [key for key in edges if key[1] == "app.tables" and key[0] in ("construct", "pass", "read")]
    # 노드가 아닌 변수의 값 안에 있는 지점과 모듈 최상위 문장은 모듈에서 나간다.
    assert ("write", "app.tables", TABLES + "SEEN") in edges


HELD = """\
import functools


def on_done():
    return 1


hook = on_done
quiet = functools.partial(on_done)
count = len("ab")


def run():
    return hook(), count
"""
NAMESAKE = "def hook():\n    return 2\n"


def test_call_answered_with_a_variable_stays_an_unknown_call(tmp_path):
    import sys

    from code_atlas.analyze import analyze

    repo = tmp_path / "held"
    (repo / "pkg").mkdir(parents=True)
    (repo / "pkg" / "__init__.py").write_text("")
    (repo / "pkg" / "core.py").write_text(HELD)
    (repo / "pkg" / "other.py").write_text(NAMESAKE)
    (repo / "main.py").write_text("import pkg.core\n")
    found = analyze(repo, sys.executable, cache=False)
    analysis = found.analysis
    n = nodes(analysis)
    call = next(s for s in analysis.sites if s.text == "hook()")
    assert (call.status, call.target, call.edge) == ("resolved", "pkg.core:hook", "read")
    assert n["pkg.core:run"].unresolved == 1 and analysis.stats["unresolved"] == 1
    pairs = {(e.kind, e.source, e.target) for e in analysis.edges}
    assert {("read", "pkg.core:run", "pkg.core:hook"), ("pass", "pkg.core:hook", "pkg.core:on_done")} <= pairs
    # `quiet`는 읽는 곳이 없어 노드가 아니고, 그 값 안의 전달 지점은 모듈에서 나간다.
    assert "pkg.core:quiet" not in n and ("pass", "pkg.core", "pkg.core:on_done") in pairs
    # 값을 만든 호출이 내장 함수면 외부 값이 아니다.
    assert n["pkg.core:count"].value["kind"] == "len(…)" and not n["pkg.core:count"].external_value
    # 변수로 답한 호출의 이름과 같은 정의는 미사용 규칙 5가 후보에서 뺀다.
    assert found.unused.candidates == ["pkg.core:run"]
