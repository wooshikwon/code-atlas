"""두 시점의 분석 결과를 견줘 노드와 선의 추가·삭제·수정과 줄 수를 판정한다.

기준 시점과 대상 시점의 분석 결과, 바뀐 파일 목록, 파일마다의 줄 단위 비교 토막을 받는다. git 명령과 언어 서버를
부르지 않고 받은 자료를 읽기만 한다. 바뀐 파일 목록에 없는 파일의 노드와, 양 끝의 파일이 모두 그 목록에 없는 선은
견주지 않는다.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

from .extract import FileFacts
from .model import Analysis, Edge, Node
from .unused import DEFINITION_KINDS

if TYPE_CHECKING:
    from .git import Changed, Hunk

ADDED = "added"
DELETED = "deleted"
MODIFIED = "modified"
RENAMED = "renamed"
ONLY_BASE = "base"

_FILE_KINDS = ("module", "package")
_ONLY_KINDS = ("variable", "external")
_INIT = ".__init__"


@dataclass
class NodeChange:
    change: str | None  # added·deleted·modified. 줄 수만 있는 폴더와 only가 base인 노드는 None
    added: int
    deleted: int
    slot: int | None = None  # 삭제된 노드가 대상 시점의 본문에서 놓였을 줄 번호
    only: str | None = None  # base: 파일은 그대로인데 기준 시점에만 노드로 있던 변수·외부 노드


@dataclass
class EdgeChange:
    change: str | None  # added·deleted. 지점의 수만 달라진 선은 None
    before: int | None  # 지점의 수만 달라진 선의 기준 시점 지점 수


@dataclass
class Comparison:
    nodes: list[Node]  # 대상 시점의 노드에 삭제된 노드와 only가 base인 노드를 더한 것
    edges: list[Edge]  # 대상 시점의 선에 삭제된 선을 더한 것
    node_changes: dict[str, NodeChange]  # 바뀐 노드만
    edge_changes: dict[str, EdgeChange]  # 키는 `edge_key`. 바뀐 선만
    files: list[dict]  # 바뀐 파일마다 path·old·status·added·deleted


@dataclass
class _File:
    """바뀐 파일 하나. `shallow`는 분석한 뒤 본문이 바뀌어 파일의 상태와 줄 수만 내는 파일이다."""

    status: str
    path: str  # 대상 쪽 경로. 삭제된 파일은 기준 쪽 경로
    base: str | None  # 기준 쪽 경로. 추가된 파일은 None
    node: str | None  # 파일의 노드 id. 대상 시점에 그 파일의 노드가 없으면 옮긴 기준 시점의 id
    removed: list[int]  # 삭제된 기준 쪽 줄 번호
    inserted: list[int]  # 추가된 대상 쪽 줄 번호
    hunks: list[Hunk]
    shallow: bool = False


@dataclass
class _Definitions:
    files: list[_File]
    moved: dict[str, str]  # 이름이 바뀐 파일의 기준 시점 노드 id → 새 모듈 id로 옮긴 id
    homes: dict[tuple[str, str], str]  # 이름이 바뀐 `__init__.py`의 (기준 쪽 경로, 옛 패키지 노드 id) → 새 패키지 노드 id
    changes: dict[str, NodeChange]
    deleted: list[Node]


def edge_key(edge: Edge) -> str:
    return f"{edge.source}|{edge.target}|{edge.kind}"


def _within(lines: list[int], span: tuple[int, int]) -> int:
    """줄 번호 목록 가운데 줄 범위에 든 수."""
    return bisect_right(lines, span[1]) - bisect_left(lines, span[0])


def _slot(line: int, hunks: list[Hunk]) -> int:
    """기준 쪽 줄이 대상 시점의 본문에서 놓였을 줄 번호. 삭제된 줄은 그 토막이 대상 쪽에서 가리키는 줄이다."""
    shift = 0
    for h in hunks:
        if line < (h.old_start if h.old_count else h.old_start + 1):
            break
        if line < h.old_start + h.old_count:
            return h.new_start
        shift = (h.new_start + max(h.new_count - 1, 0)) - (h.old_start + max(h.old_count - 1, 0))
    return line + shift


def _module_id(node: Node) -> str:
    """파일의 노드에서 정의와 변수의 id가 앞에 붙이는 모듈 id."""
    packaged = node.kind == "module" and node.id.endswith(_INIT) and (node.path or "").endswith("/__init__.py")
    return node.id[: -len(_INIT)] if packaged else node.id


def _file_nodes(target: list[Node]) -> dict[str, Node]:
    return {n.path: n for n in target if n.kind in _FILE_KINDS and n.path and n.path.endswith(".py")}


def _numbers(count: int) -> list[int]:
    return list(range(1, count + 1))


def _files(
    base: dict[str, FileFacts],
    file_nodes: dict[str, Node],
    base_texts: dict[str, list[str]],
    target_texts: dict[str, list[str]],
    files: list[Changed],
    hunks: dict[str, list[Hunk]],
    skip: set[str] | frozenset[str],
) -> list[_File]:
    """바뀐 파일 목록에서 분석한 파일만 고르고 파일마다 삭제된 줄과 추가된 줄의 번호를 모은다.

    한쪽 시점에서만 분석한 파일은 이름이 바뀐 경우에만 추가나 삭제로 고쳐 내고, 그 밖에는 뺀다.
    """
    found: list[_File] = []
    for c in files:
        own = hunks.get(c.path, [])
        removed = [n for h in own for n in range(h.old_start, h.old_start + h.old_count)]
        inserted = [n for h in own for n in range(h.new_start, h.new_start + h.new_count)]
        old = c.old if c.status == RENAMED else None if c.status == ADDED else c.path
        new = None if c.status == DELETED else c.path
        if c.path in skip or (c.old is not None and c.old in skip):
            node = file_nodes.get(c.path)
            found.append(_File(c.status, c.path, old, node and node.id, removed, inserted, own, shallow=True))
            continue
        has_base = old is not None and old in base
        has_target = new is not None and new in file_nodes
        if has_base and has_target:
            found.append(_File(c.status, c.path, old, file_nodes[c.path].id, removed, inserted, own))
        elif c.status == ADDED and has_target:
            found.append(_File(ADDED, c.path, None, file_nodes[c.path].id, [], inserted, own))
        elif c.status == DELETED and has_base:
            found.append(_File(DELETED, c.path, old, base[old].nodes[0].id, removed, [], own))
        elif c.status == RENAMED and has_target:
            found.append(
                _File(ADDED, c.path, None, file_nodes[c.path].id, [], _numbers(len(target_texts.get(c.path, []))), [])
            )
        elif c.status == RENAMED and has_base:
            found.append(_File(DELETED, old, old, base[old].nodes[0].id, _numbers(len(base_texts.get(old, []))), [], []))
    return found


def _moved(
    base: dict[str, FileFacts], file_nodes: dict[str, Node], files: list[_File]
) -> tuple[dict[str, str], dict[tuple[str, str], str]]:
    """이름이 바뀐 파일의 기준 시점 노드 id를 새 모듈 id로 옮기는 표와, 그 파일에 든 노드의 부모를 옮기는 표.

    정의가 없는 `__init__.py`의 노드는 폴더의 패키지 노드이므로 id를 옮기지 않는다. 옛 폴더는 기준 시점에만 있는 폴더로
    남고, 그 파일에 든 변수의 부모만 새 패키지 노드로 옮긴다.
    """
    moved: dict[str, str] = {}
    homes: dict[tuple[str, str], str] = {}
    for f in files:
        if f.shallow or f.base is None or f.base == f.path or f.path not in file_nodes:
            continue
        facts = base[f.base]
        old, new = facts.file.module_id, _module_id(file_nodes[f.path])
        for node_id in [*(n.id for n in facts.nodes), *(v.node_id for v in facts.variables)]:
            moved[node_id] = new + node_id[len(old) :]
        if facts.nodes[0].kind == "package":
            homes[f.base, facts.nodes[0].id] = moved.pop(facts.nodes[0].id)
    return moved, homes


def _parent(n: Node, found: _Definitions) -> str | None:
    """기준 시점의 노드를 대상 시점의 그래프에 더할 때의 부모 id."""
    return found.homes.get((n.path, n.parent)) or found.moved.get(n.parent, n.parent)


def _file_change(f: _File) -> str | None:
    if f.status in (ADDED, DELETED):
        return f.status
    return MODIFIED if f.removed or f.inserted else None


def _span_text(lines: list[str], span: tuple[int, int]) -> list[str]:
    return lines[span[0] - 1 : span[1]]


def _definitions(
    base: dict[str, FileFacts],
    target: list[Node],
    base_texts: dict[str, str],
    target_texts: dict[str, str],
    files: list[Changed],
    hunks: dict[str, list[Hunk]],
    skip: set[str] | frozenset[str],
) -> tuple[_Definitions, dict[str, list[str]], dict[str, list[str]]]:
    file_nodes = _file_nodes(target)
    live = {n.id for n in target}
    old_lines = {path: text.splitlines() for path, text in base_texts.items()}
    new_lines = {path: text.splitlines() for path, text in target_texts.items()}
    paired = _files(base, file_nodes, old_lines, new_lines, files, hunks, skip)
    moved, homes = _moved(base, file_nodes, paired)
    found = _Definitions(paired, moved, homes, {}, [])
    changes, deleted = found.changes, found.deleted
    by_path: dict[str, dict[str, Node]] = {f.path: {} for f in paired}
    for n in target:
        if n.kind in DEFINITION_KINDS and n.path in by_path:
            by_path[n.path][n.id] = n

    for f in paired:
        change = _file_change(f)
        at_target = f.path in file_nodes
        if f.node is not None and change is not None and (at_target or f.node not in live):
            changes[f.node] = NodeChange(change, len(f.inserted), len(f.removed))
            if not at_target:
                deleted.append(base[f.base].nodes[0])
        if f.shallow:
            continue
        facts = base[f.base] if f.base is not None else None
        before = {moved.get(n.id, n.id): n for n in facts.nodes[1:]} if facts else {}
        after = by_path[f.path] if at_target else {}
        was, now = old_lines.get(f.base or "", []), new_lines.get(f.path, [])
        for node_id, n in before.items():
            t = after.get(node_id)
            if t is None:
                slot = n.range[0] if f.status == DELETED else _slot(n.range[0], f.hunks)
                changes[node_id] = NodeChange(DELETED, 0, _within(f.removed, n.range), slot)
                deleted.append(replace(n, id=node_id, parent=_parent(n, found)))
            elif _span_text(was, n.range) != _span_text(now, t.range):
                changes[node_id] = NodeChange(MODIFIED, _within(f.inserted, t.range), _within(f.removed, n.range))
        for node_id, t in after.items():
            if node_id not in before:
                changes[node_id] = NodeChange(ADDED, _within(f.inserted, t.range), 0)
    return found, old_lines, new_lines


def definitions(
    base: dict[str, FileFacts],
    target: list[Node],
    base_texts: dict[str, str],
    target_texts: dict[str, str],
    files: list[Changed],
    hunks: dict[str, list[Hunk]],
    skip: set[str] | frozenset[str] = frozenset(),
) -> tuple[dict[str, NodeChange], list[Node]]:
    """바뀐 파일과 그 안에 든 정의의 판정, 삭제된 파일과 정의의 노드.

    `base`와 `base_texts`의 키는 기준 시점의 경로이고 `target`은 대상 시점의 노드다. 정의는 id로 짝을 짓는다. 짝이 없는
    대상 쪽은 추가, 짝이 없는 기준 쪽은 삭제, 두 시점에서 줄 범위에 든 글이 다른 짝은 수정이고 글이 같은 짝은 내지 않는다.
    `skip`은 분석한 뒤 본문이 바뀐 파일의 경로이고 그 파일은 파일 노드의 상태와 줄 수만 낸다.
    """
    found, _, _ = _definitions(base, target, base_texts, target_texts, files, hunks, skip)
    return found.changes, found.deleted


def _variables(
    found: _Definitions,
    base: Analysis,
    base_facts: dict[str, FileFacts],
    target: Analysis,
    target_facts: dict[str, FileFacts],
    old_lines: dict[str, list[str]],
    new_lines: dict[str, list[str]],
) -> None:
    """바뀐 파일의 변수 노드를 두 시점의 변수 후보로 짝지어 판정한다. 대입문이 양쪽에 있으면 추가도 삭제도 아니다."""
    moved = found.moved
    files = {f.path: f for f in found.files if not f.shallow and (f.status == DELETED or f.path in target_facts)}
    olds = {f.base: f for f in files.values() if f.base is not None}
    was = {
        f.path: {moved.get(v.node_id, v.node_id): v for v in base_facts[f.base].variables}
        for f in files.values()
        if f.base is not None
    }
    now = {
        f.path: set() if f.status == DELETED else {v.node_id for v in target_facts[f.path].variables}
        for f in files.values()
    }
    for n in target.nodes:
        f = files.get(n.path) if n.kind == "variable" else None
        if f is None:
            continue
        candidate = was.get(f.path, {}).get(n.id)
        if candidate is None:
            found.changes[n.id] = NodeChange(ADDED, _within(f.inserted, n.range), 0)
        elif _span_text(old_lines.get(f.base, []), candidate.range) != _span_text(new_lines.get(f.path, []), n.range):
            found.changes[n.id] = NodeChange(
                MODIFIED, _within(f.inserted, n.range), _within(f.removed, candidate.range)
            )
    for n in base.nodes:
        f = olds.get(n.path) if n.kind == "variable" else None
        node_id = moved.get(n.id, n.id)
        if f is None or node_id in now[f.path]:
            continue
        slot = n.range[0] if f.status == DELETED else _slot(n.range[0], f.hunks)
        found.changes[node_id] = NodeChange(DELETED, 0, _within(f.removed, n.range), slot)
        found.deleted.append(replace(n, id=node_id, parent=_parent(n, found)))


def compare(
    base: Analysis,
    base_facts: dict[str, FileFacts],
    base_texts: dict[str, str],
    target: Analysis,
    target_facts: dict[str, FileFacts],
    target_texts: dict[str, str],
    files: list[Changed],
    hunks: dict[str, list[Hunk]],
    skip: set[str] | frozenset[str] = frozenset(),
) -> Comparison:
    """대상 시점의 그래프에 삭제된 노드와 선을 더하고 바뀐 노드와 선의 판정을 낸다.

    `base_facts`와 `target_facts`는 각 시점의 경로 → 추출 결과다. 선은 종류와 양 끝 id로 짝을 짓고, 양 끝의 파일 가운데
    하나라도 바뀐 파일 목록에 있는 선만 견준다. 삭제된 선의 끝이 기준 시점에만 노드로 있던 변수나 외부 노드면 그 노드를
    `only`가 base인 노드로 더한다. 패키지 노드의 줄 수는 아래 파일의 합이다.
    """
    found, old_lines, new_lines = _definitions(base_facts, target.nodes, base_texts, target_texts, files, hunks, skip)
    _variables(found, base, base_facts, target, target_facts, old_lines, new_lines)
    moved, changes = found.moved, found.changes
    nodes: dict[str, Node] = {n.id: n for n in target.nodes}
    live = set(nodes)
    for n in found.deleted:
        nodes.setdefault(n.id, n)
    olds: dict[str, Node] = {moved.get(n.id, n.id): n for n in base.nodes}

    def adopt(node_id: str | None) -> bool:
        """기준 시점에만 있는 노드를 부모 사슬과 함께 그래프에 더한다. 어느 시점에도 없는 id면 False다."""
        if node_id is None or node_id in nodes:
            return True
        n = olds.get(node_id)
        if n is None:
            return False
        nodes[node_id] = replace(n, id=node_id, parent=_parent(n, found))
        if n.kind in _ONLY_KINDS:
            changes[node_id] = NodeChange(None, 0, 0, only=ONLY_BASE)
        else:
            changes.setdefault(node_id, NodeChange(DELETED, 0, 0))
        adopt(nodes[node_id].parent)
        return True

    for n in list(nodes.values()):
        if n.id not in live:
            adopt(n.parent)

    touched = {path for f in found.files for path in (f.path, f.base) if path is not None}

    def compared(source: str, target_id: str) -> bool:
        """선의 양 끝 가운데 하나라도 바뀐 파일에 든 노드다."""
        return any((n := nodes.get(i) or olds.get(i)) is not None and n.path in touched for i in (source, target_id))

    edges = list(target.edges)
    edge_changes: dict[str, EdgeChange] = {}
    before = {(e.kind, moved.get(e.source, e.source), moved.get(e.target, e.target)): e for e in base.edges}
    after = {(e.kind, e.source, e.target) for e in target.edges}
    for e in target.edges:
        if not compared(e.source, e.target):
            continue
        old = before.get((e.kind, e.source, e.target))
        if old is None:
            edge_changes[edge_key(e)] = EdgeChange(ADDED, None)
        elif len(old.sites) != len(e.sites):
            edge_changes[edge_key(e)] = EdgeChange(None, len(old.sites))
    for (kind, source, target_id), e in before.items():
        if (kind, source, target_id) in after or not compared(source, target_id):
            continue
        if adopt(source) and adopt(target_id):
            gone = replace(e, source=source, target=target_id)
            edges.append(gone)
            edge_changes[edge_key(gone)] = EdgeChange(DELETED, None)

    totals: dict[str, list[int]] = {}
    for f in found.files:
        n = nodes.get(f.node) if f.node is not None else None
        if n is not None and n.kind != "package":
            n = nodes.get(n.parent) if n.parent is not None else None
        while n is not None:
            total = totals.setdefault(n.id, [0, 0])
            total[0] += len(f.inserted)
            total[1] += len(f.removed)
            n = nodes.get(n.parent) if n.parent is not None else None
    for n in nodes.values():
        if n.kind != "package":
            continue
        added, removed = totals.get(n.id, (0, 0))
        if n.id not in live:
            changes[n.id] = NodeChange(DELETED, added, removed)
        elif added or removed:
            changes[n.id] = NodeChange(None, added, removed)
        else:
            changes.pop(n.id, None)

    listed = [
        {
            "path": f.path,
            "old": f.base if f.status == RENAMED else None,
            "status": f.status,
            "added": len(f.inserted),
            "deleted": len(f.removed),
        }
        for f in found.files
    ]
    return Comparison(list(nodes.values()), edges, changes, edge_changes, listed)
