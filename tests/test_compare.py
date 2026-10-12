import ast
import copy
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

from code_atlas import compare as compare_module
from code_atlas.collect import RepoFiles, SourceFile, is_test_path, module_id
from code_atlas.compare import Comparison, EdgeChange, NodeChange, compare, definitions
from code_atlas.extract import extract
from code_atlas.graph import EDGE_GROUPS, build
from code_atlas.model import Analysis, Edge, Node, SiteRef
from code_atlas.resolve import Resolution


@dataclass
class Changed:
    status: str
    path: str
    old: str | None = None


@dataclass
class Hunk:
    old_start: int
    old_count: int
    new_start: int
    new_count: int


@dataclass
class Point:
    """손으로 만든 한 시점. `facts`와 `texts`의 키는 그 시점의 경로다."""

    analysis: Analysis
    facts: dict
    texts: dict[str, str]


def point(texts: dict[str, str], edges=(), variables=(), externals=()) -> Point:
    """본문으로 노드를 만들고 선, 변수 노드, 외부 노드를 손으로 더한다. 선은 (종류, 출발, 도착, 지점 수)다."""
    paths = sorted(texts)
    files = [SourceFile(p, module_id(p, ""), is_test_path(p), p.endswith("__init__.py")) for p in paths]
    packages = sorted({"/".join(p.split("/")[:i]) for p in paths for i in range(1, p.count("/") + 1)})
    facts = [extract(f, texts[f.path], frozenset()) for f in files]
    analysis = build(RepoFiles(Path("."), "", files, packages), facts, Resolution([]), texts)
    by_id = {v.node_id: (f, v) for f in facts for v in f.variables}
    for node_id in variables:
        f, v = by_id[node_id]
        analysis.nodes.append(Node(node_id, "variable", v.name, f.nodes[0].id, f.file.path, v.range, 1))
    for node_id in externals:
        analysis.nodes.append(Node(node_id, "external", node_id.split(":")[1], None, None, None, 0, origin="stdlib"))
    paths_of = {n.id: n.path for n in analysis.nodes}
    for kind, source, target, count in edges:
        sites = [SiteRef(paths_of[source], i + 1, 0) for i in range(count)]
        analysis.edges.append(Edge(EDGE_GROUPS[kind], kind, source, target, sites))
    return Point(analysis, {f.file.path: f for f in facts}, dict(texts))


def hunks_of(old: str, new: str) -> list[Hunk]:
    """두 본문의 줄 단위 비교를 `git diff -U0`의 토막 모양으로 낸다."""
    found = []
    matcher = SequenceMatcher(None, old.splitlines(), new.splitlines(), autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            found.append(Hunk(i1 + 1 if i2 > i1 else i1, i2 - i1, j1 + 1 if j2 > j1 else j1, j2 - j1))
    return found


def diff(base: Point, target: Point, renames: dict[str, str] | None = None):
    """두 시점의 본문에서 바뀐 파일 목록과 토막을 만든다. `renames`는 새 경로 → 옛 경로다."""
    renames = renames or {}
    files, hunks = [], {}
    for path in sorted(set(base.texts) | set(target.texts)):
        if path in renames.values():
            continue
        old = renames.get(path, path)
        before, after = base.texts.get(old), target.texts.get(path)
        if before == after and path not in renames:
            continue
        status = "renamed" if path in renames else "added" if before is None else "deleted" if after is None else "modified"
        files.append(Changed(status, path, renames.get(path)))
        if before != after:
            hunks[path] = hunks_of(before or "", after or "")
    return files, hunks


def run(base: Point, target: Point, files, hunks, skip=frozenset()) -> Comparison:
    return compare(
        base.analysis, base.facts, base.texts, target.analysis, target.facts, target.texts, files, hunks, skip
    )


def compared(base: Point, target: Point, renames=None, skip=frozenset()) -> Comparison:
    return run(base, target, *diff(base, target, renames), skip)


CORE = """\
import os

LIMIT = 3


def load(path):
    return os.path.join(path, "a")


def run(path):
    data = load(path)
    return data


class Engine:
    def start(self):
        return run("x")

    def stop(self):
        return None
"""


def test_same_points_have_no_changes():
    base = point({"app/core.py": CORE}, [("call", "app.core:run", "app.core:load", 1)])
    result = compared(base, copy.deepcopy(base))
    assert result.node_changes == {} and result.edge_changes == {} and result.files == []
    assert result.nodes == base.analysis.nodes and result.edges == base.analysis.edges


def test_shifted_definition_is_not_modified():
    base = point({"app/core.py": CORE})
    target = point({"app/core.py": CORE.replace("LIMIT = 3\n", "LIMIT = 3\nDEPTH = 4\n# 설명\n")})
    result = compared(base, target)
    assert result.node_changes == {
        "app.core": NodeChange("modified", 2, 0),
        "app": NodeChange(None, 2, 0),
    }


def test_line_counts_of_modified_definition_and_class():
    base = point({"app/core.py": CORE})
    edited = CORE.replace("    data = load(path)\n    return data\n", "    return load(path)\n")
    edited = edited.replace("        return None\n", "        self.done = True\n        return None\n")
    result = compared(base, point({"app/core.py": edited}))
    assert result.node_changes == {
        "app.core": NodeChange("modified", 2, 2),
        "app": NodeChange(None, 2, 2),
        "app.core:run": NodeChange("modified", 1, 2),
        "app.core:Engine": NodeChange("modified", 1, 0),
        "app.core:Engine.stop": NodeChange("modified", 1, 0),
    }


def test_hunk_pushed_into_neighbour_leaves_same_text_unmodified():
    old = "def a():\n    x = 1\n    return x\n\n\ndef c():\n    x = 1\n    return x\n"
    new = "def a():\n    x = 1\n    return x\n\n\ndef b():\n    x = 1\n    return x\n\n\ndef c():\n    x = 1\n    return x\n"
    base, target = point({"m.py": old}), point({"m.py": new})
    # git이 같은 줄이 되풀이되는 곳에서 추가된 줄을 한 줄 위로 밀어 적은 토막이다. 3번 줄은 `a`의 범위에 든다.
    hunks = {"m.py": [Hunk(2, 0, 3, 5)]}
    result = run(base, target, [Changed("modified", "m.py")], hunks)
    assert result.node_changes == {"m": NodeChange("modified", 5, 0), "m:b": NodeChange("added", 2, 0)}


def test_file_count_is_definitions_plus_module_level_code():
    old = "import os\n\nA = 1\n\n\ndef f():\n    return 1\n\n\ndef g():\n    return 2\n"
    new = "import os\nimport sys\n\nA = 2\n\n\ndef f():\n    return 10\n\n\ndef h():\n    return sys.argv\n"
    base, target = point({"pkg/sub/m.py": old, "pkg/n.py": "x = 1\n"}), point({"pkg/sub/m.py": new, "pkg/n.py": "x = 2\ny = 3\n"})
    files, hunks = diff(base, target)
    result = run(base, target, files, hunks)
    changes = result.node_changes
    numstat = {path: (sum(h.new_count for h in hs), sum(h.old_count for h in hs)) for path, hs in hunks.items()}
    assert {f["path"]: (f["added"], f["deleted"]) for f in result.files} == numstat
    m = changes["pkg.sub.m"]
    assert (m.added, m.deleted) == numstat["pkg/sub/m.py"] == (5, 4)
    inside = [changes[i] for i in ("pkg.sub.m:f", "pkg.sub.m:g", "pkg.sub.m:h")]
    assert [(c.change, c.added, c.deleted) for c in inside] == [("modified", 1, 1), ("deleted", 0, 2), ("added", 2, 0)]
    # 모듈 수준 코드의 몫은 `import sys`와 `A = 2`가 추가 2줄, `A = 1`이 삭제 1줄이다.
    assert m.added == sum(c.added for c in inside) + 2 and m.deleted == sum(c.deleted for c in inside) + 1
    assert changes["pkg.sub"] == NodeChange(None, 5, 4)
    assert changes["pkg"] == NodeChange(None, 5 + 2, 4 + 1)
    assert changes["pkg.n"] == NodeChange("modified", 2, 1)


def test_renamed_file_keeps_definitions_and_incoming_edges():
    cli = "from app.core import run\n\n\ndef main():\n    return run('x')\n"
    base = point({"app/core.py": CORE, "cli.py": cli}, [("call", "cli:main", "app.core:run", 1), ("import", "cli", "app.core", 1)])
    moved = CORE.replace('"a"', '"b"')
    cli_new = cli.replace("app.core", "app.engine")
    target = point(
        {"app/engine.py": moved, "cli.py": cli_new},
        [("call", "cli:main", "app.engine:run", 1), ("import", "cli", "app.engine", 1)],
    )
    result = compared(base, target, renames={"app/engine.py": "app/core.py"})
    assert result.node_changes == {
        "app.engine": NodeChange("modified", 1, 1),
        "app.engine:load": NodeChange("modified", 1, 1),
        "cli": NodeChange("modified", 1, 1),
        "app": NodeChange(None, 1, 1),
    }
    assert result.edge_changes == {}
    assert result.nodes == target.analysis.nodes and result.edges == target.analysis.edges
    assert result.files[0] == {"path": "app/engine.py", "old": "app/core.py", "status": "renamed", "added": 1, "deleted": 1}


def test_renamed_file_without_edit_changes_no_node():
    base, target = point({"app/core.py": CORE}), point({"app/engine.py": CORE})
    result = run(base, target, [Changed("renamed", "app/engine.py", "app/core.py")], {})
    assert result.node_changes == {} and result.nodes == target.analysis.nodes
    assert result.files == [{"path": "app/engine.py", "old": "app/core.py", "status": "renamed", "added": 0, "deleted": 0}]


def test_edge_away_from_changed_files_is_left_alone():
    texts = {"a.py": "def f():\n    return 1\n", "b.py": "def g():\n    return 1\n", "c.py": "def h():\n    return 1\n"}
    base = point(texts, [("call", "a:f", "b:g", 1), ("call", "b:g", "a:f", 2)])
    edited = {**texts, "c.py": "def h():\n    return 2\n"}
    # 언어 서버가 한쪽 시점에서 답하지 못해 선이 빠지거나 지점 수가 달라진 경우다.
    target = point(edited, [("call", "a:f", "b:g", 3), ("pass", "a:f", "b:g", 1)])
    result = compared(base, target)
    assert result.edge_changes == {}
    assert result.edges == target.analysis.edges
    assert result.node_changes == {"c": NodeChange("modified", 1, 1), "c:h": NodeChange("modified", 1, 1)}


def test_edges_touching_changed_file_are_added_deleted_or_counted():
    texts = {"a.py": "def f():\n    return 1\n\n\ndef k():\n    return 1\n", "b.py": "def g():\n    return 1\n"}
    base = point(texts, [("call", "a:f", "b:g", 2), ("call", "b:g", "a:k", 1), ("pass", "a:f", "b:g", 1)])
    edited = {**texts, "a.py": texts["a.py"].replace("return 1\n\n", "return 2\n\n")}
    target = point(edited, [("call", "a:f", "b:g", 3), ("call", "a:k", "b:g", 1), ("pass", "a:f", "b:g", 1)])
    result = compared(base, target)
    assert result.edge_changes == {
        "a:f|b:g|call": EdgeChange(None, 2),
        "a:k|b:g|call": EdgeChange("added", None),
        "b:g|a:k|call": EdgeChange("deleted", None),
    }
    assert result.edges[:3] == target.analysis.edges
    [gone] = result.edges[3:]
    assert (gone.kind, gone.source, gone.target, len(gone.sites)) == ("call", "b:g", "a:k", 1)


def test_deleted_class_comes_with_methods_and_slot():
    base = point({"app/core.py": CORE}, [("call", "app.core:Engine.start", "app.core:run", 1)])
    cut = CORE[: CORE.index("class Engine")].rstrip("\n") + "\n\n\ndef tail():\n    return 0\n"
    target = point({"app/core.py": cut})
    result = compared(base, target)
    deleted = {i: c for i, c in result.node_changes.items() if c.change == "deleted"}
    assert deleted == {
        "app.core:Engine": NodeChange("deleted", 0, 6, slot=15),
        "app.core:Engine.start": NodeChange("deleted", 0, 2, slot=15),
        "app.core:Engine.stop": NodeChange("deleted", 0, 2, slot=15),
    }
    assert result.node_changes["app.core:tail"] == NodeChange("added", 2, 0)
    added = {n.id: n for n in result.nodes[len(target.analysis.nodes) :]}
    assert list(added) == ["app.core:Engine", "app.core:Engine.start", "app.core:Engine.stop"]
    assert added["app.core:Engine.stop"].parent == "app.core:Engine" and added["app.core:Engine"].parent == "app.core"
    assert added["app.core:Engine"].range == (15, 20) and added["app.core:Engine"].path == "app/core.py"
    assert result.edge_changes == {"app.core:Engine.start|app.core:run|call": EdgeChange("deleted", None)}


def test_slot_of_deleted_definition_follows_shift_before_it():
    old = "def a():\n    return 1\n\n\ndef b():\n    return 2\n\n\ndef c():\n    return 3\n"
    new = "import os\nimport sys\n\n\ndef a():\n    return 1\n\n\ndef c():\n    return 3\n"
    result = compared(point({"m.py": old}), point({"m.py": new}))
    # 삭제 토막이 대상 쪽에서 가리키는 줄은 `a`의 끝 뒤 빈 줄(8)이고 `c`는 9번 줄에서 시작한다.
    assert result.node_changes["m:b"] == NodeChange("deleted", 0, 2, slot=8)
    assert "m:a" not in result.node_changes and "m:c" not in result.node_changes


def test_deleted_file_and_folder_end_at_target_node():
    texts = {"pkg/keep.py": "def k():\n    return 1\n", "pkg/old/gone.py": "def g():\n    return 1\n\n\nclass C:\n    def m(self):\n        return 1\n"}
    base = point(texts, [("call", "pkg.keep:k", "pkg.old.gone:g", 1)])
    target = point({"pkg/keep.py": "def k():\n    return 2\n"})
    result = compared(base, target)
    changes = result.node_changes
    assert changes["pkg.old"] == NodeChange("deleted", 0, 7)
    assert changes["pkg.old.gone"] == NodeChange("deleted", 0, 7)
    assert changes["pkg.old.gone:g"] == NodeChange("deleted", 0, 2, slot=1)
    assert changes["pkg.old.gone:C.m"] == NodeChange("deleted", 0, 2, slot=6)
    assert changes["pkg"] == NodeChange(None, 1, 8)
    nodes = {n.id: n for n in result.nodes}
    live = {n.id for n in target.analysis.nodes}
    for node_id, change in changes.items():
        if change.change != "deleted":
            continue
        chain = [node_id]
        while chain[-1] not in live:
            chain.append(nodes[chain[-1]].parent)
        assert chain[-1] == "pkg"
        assert all(changes[i].change == "deleted" for i in chain[:-1])
    assert nodes["pkg.old"].kind == "package" and nodes["pkg.old.gone"].path == "pkg/old/gone.py"
    assert result.edge_changes == {"pkg.keep:k|pkg.old.gone:g|call": EdgeChange("deleted", None)}
    assert result.files[1] == {"path": "pkg/old/gone.py", "old": None, "status": "deleted", "added": 0, "deleted": 7}


def test_deleted_method_in_renamed_file_moves_id_and_parent():
    base = point({"app/core.py": CORE})
    target = point({"app/engine.py": CORE.replace("\n    def stop(self):\n        return None\n", "")})
    result = compared(base, target, renames={"app/engine.py": "app/core.py"})
    assert result.node_changes["app.engine:Engine.stop"] == NodeChange("deleted", 0, 2, slot=17)
    assert result.node_changes["app.engine:Engine"] == NodeChange("modified", 0, 3)
    [gone] = result.nodes[len(target.analysis.nodes) :]
    assert (gone.id, gone.parent, gone.path, gone.range) == ("app.engine:Engine.stop", "app.engine:Engine", "app/core.py", (19, 20))


def test_renamed_init_file_leaves_old_folder_deleted():
    texts = {"pkg/old/__init__.py": "NAME = 1\n", "pkg/old/gone.py": "def g():\n    return 1\n", "top.py": "x = 1\n"}
    base = point(texts, [("import", "top", "pkg.old", 1)])
    target = point({"pkg/new/__init__.py": "NAME = 1\n", "top.py": "x = 2\n"}, [("import", "top", "pkg.new", 1)])
    result = compared(base, target, renames={"pkg/new/__init__.py": "pkg/old/__init__.py"})
    assert result.node_changes == {
        "top": NodeChange("modified", 1, 1),
        "pkg": NodeChange(None, 0, 2),
        "pkg.old": NodeChange("deleted", 0, 2),
        "pkg.old.gone": NodeChange("deleted", 0, 2),
        "pkg.old.gone:g": NodeChange("deleted", 0, 2, slot=1),
    }
    nodes = {n.id: n for n in result.nodes}
    assert all(n.parent is None or n.parent in nodes for n in result.nodes)
    assert result.edge_changes == {"top|pkg.new|import": EdgeChange("added", None), "top|pkg.old|import": EdgeChange("deleted", None)}


def test_init_file_losing_definitions_keeps_parent_chain():
    base = point({"pkg/__init__.py": "def make():\n    return 1\n", "pkg/a.py": "x = 1\n"})
    target = point({"pkg/__init__.py": "NAME = 1\n", "pkg/a.py": "x = 1\n"})
    result = compared(base, target)
    assert result.node_changes == {
        "pkg": NodeChange(None, 1, 2),
        "pkg:make": NodeChange("deleted", 0, 2, slot=1),
        "pkg.__init__": NodeChange("deleted", 0, 0),
    }
    nodes = {n.id: n for n in result.nodes}
    assert nodes["pkg:make"].parent == "pkg.__init__" and nodes["pkg.__init__"].parent == "pkg"


def test_variable_assigned_on_both_sides_is_neither_added_nor_deleted():
    reader = "from app.core import LIMIT\n\n\ndef peek():\n    return LIMIT\n"
    base = point(
        {"app/core.py": CORE, "reader.py": reader},
        [("read", "reader:peek", "app.core:LIMIT", 1), ("call", "app.core:load", "ext:os.path", 1)],
        variables=["app.core:LIMIT"],
        externals=["ext:os.path"],
    )
    # 읽는 쪽 파일만 바뀌어 대상 시점에는 변수 노드와 외부 노드가 없다. 대입문은 양쪽에 있다.
    target = point({"app/core.py": CORE.replace("os.path.join(path, \"a\")", "path"), "reader.py": "def peek():\n    return 3\n"})
    result = compared(base, target)
    assert result.node_changes["app.core:LIMIT"] == NodeChange(None, 0, 0, only="base")
    assert result.node_changes["ext:os.path"] == NodeChange(None, 0, 0, only="base")
    assert result.edge_changes == {
        "reader:peek|app.core:LIMIT|read": EdgeChange("deleted", None),
        "app.core:load|ext:os.path|call": EdgeChange("deleted", None),
    }
    assert [n.id for n in result.nodes[len(target.analysis.nodes) :]] == ["app.core:LIMIT", "ext:os.path"]

    # 대상 시점에만 노드로 있는 변수와 외부 노드는 추가된 선의 끝일 뿐이고 표시를 받지 않는다.
    back = compared(target, base)
    assert "app.core:LIMIT" not in back.node_changes and "ext:os.path" not in back.node_changes
    assert back.edge_changes == {
        "reader:peek|app.core:LIMIT|read": EdgeChange("added", None),
        "app.core:load|ext:os.path|call": EdgeChange("added", None),
    }
    assert back.nodes == base.analysis.nodes


def test_variable_only_on_base_is_left_out_without_deleted_edge():
    texts = {"app/core.py": CORE, "reader.py": "def peek():\n    return 1\n", "other.py": "def o():\n    return 1\n"}
    base = point(texts, [("read", "reader:peek", "app.core:LIMIT", 1)], variables=["app.core:LIMIT"])
    # 변수의 파일과 읽는 쪽 파일이 모두 그대로이므로 대상 시점에서 빠진 선과 변수 노드는 견주지 않는다.
    target = point({**texts, "other.py": "def o():\n    return 2\n"})
    result = compared(base, target)
    assert result.edge_changes == {}
    assert result.nodes == target.analysis.nodes and result.edges == target.analysis.edges


def test_variable_assignment_added_modified_and_deleted():
    reader = "def peek():\n    return 1\n"
    old = "LIMIT = 3\nDEPTH = [\n    1,\n]\n\n\ndef f():\n    return LIMIT\n"
    new = "DEPTH = [\n    1,\n    2,\n]\nSIZE = 5\n\n\ndef f():\n    return SIZE\n"
    base = point(
        {"m.py": old, "reader.py": reader},
        [("read", "reader:peek", "m:LIMIT", 1), ("read", "reader:peek", "m:DEPTH", 1)],
        variables=["m:LIMIT", "m:DEPTH"],
    )
    target = point(
        {"m.py": new, "reader.py": reader},
        [("read", "reader:peek", "m:SIZE", 1), ("read", "reader:peek", "m:DEPTH", 1)],
        variables=["m:SIZE", "m:DEPTH"],
    )
    result = compared(base, target)
    assert result.node_changes["m:LIMIT"] == NodeChange("deleted", 0, 1, slot=0)
    assert result.node_changes["m:DEPTH"] == NodeChange("modified", 1, 0)
    assert result.node_changes["m:SIZE"] == NodeChange("added", 1, 0)
    assert result.edge_changes == {
        "reader:peek|m:SIZE|read": EdgeChange("added", None),
        "reader:peek|m:LIMIT|read": EdgeChange("deleted", None),
    }


def test_skipped_file_gives_only_file_state_and_counts():
    base = point({"app/core.py": CORE})
    edited = CORE.replace("    data = load(path)\n    return data\n", "    return load(path)\n")
    result = compared(base, point({"app/core.py": edited}), skip={"app/core.py"})
    assert result.node_changes == {"app.core": NodeChange("modified", 1, 2), "app": NodeChange(None, 1, 2)}
    assert result.files == [{"path": "app/core.py", "old": None, "status": "modified", "added": 1, "deleted": 2}]


def test_changed_file_outside_analysis_is_ignored():
    base = point({"app/core.py": CORE})
    files = [Changed("modified", ".hidden/tool.py"), Changed("added", "env/new.py"), Changed("deleted", "env/old.py")]
    hunks = {".hidden/tool.py": [Hunk(1, 1, 1, 1)], "env/new.py": [Hunk(0, 0, 1, 3)], "env/old.py": [Hunk(1, 3, 0, 0)]}
    result = run(base, copy.deepcopy(base), files, hunks)
    assert result.node_changes == {} and result.files == [] and result.nodes == base.analysis.nodes


def test_compare_does_not_change_its_inputs():
    base = point({"app/core.py": CORE, "old/gone.py": "X = 1\n\n\ndef g():\n    return X\n"}, [("call", "app.core:run", "old.gone:g", 1)])
    target = point({"app/engine.py": CORE.replace("return None", "return 0")})
    before = copy.deepcopy((base, target))
    compared(base, target, renames={"app/engine.py": "app/core.py"})
    assert (base, target) == before


def test_definitions_judges_nodes_from_extraction_only():
    """`/api/changes`가 쓰는 길: 기준 쪽은 바뀐 파일의 추출 결과만 있고 선과 변수는 다루지 않는다."""
    edited = CORE.replace("LIMIT = 3\n", "LIMIT = 3\nDEPTH = 4\n").replace("        return None\n", "        return 0\n")
    edited += "\n\ndef fresh():\n    return 1\n"
    edited = edited.replace("def load(path):\n    return os.path.join(path, \"a\")\n\n\n", "")
    base, target = point({"app/core.py": CORE}), point({"app/core.py": edited, "app/new.py": "def n():\n    return 1\n"})
    files, hunks = diff(base, target)
    changes, deleted = definitions(base.facts, target.analysis.nodes, base.texts, target.texts, files, hunks)
    assert {i: c.change for i, c in changes.items()} == {
        "app.core": "modified",
        "app.core:load": "deleted",
        "app.core:Engine": "modified",
        "app.core:Engine.stop": "modified",
        "app.core:fresh": "added",
        "app.new": "added",
        "app.new:n": "added",
    }
    assert [n.id for n in deleted] == ["app.core:load"]

    changes, deleted = definitions(base.facts, target.analysis.nodes, base.texts, target.texts, files, hunks, {"app/core.py"})
    assert {i: c.change for i, c in changes.items()} == {"app.core": "modified", "app.new": "added", "app.new:n": "added"}
    assert deleted == []


def test_module_imports_no_process_server_or_web_layer():
    tree = ast.parse(Path(compare_module.__file__).read_text())
    names = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    names |= {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.level == 0}
    local = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.level == 1}
    assert not names & {"subprocess", "fastapi", "asyncio"}
    assert local <= {"extract", "model", "unused", "git"}
