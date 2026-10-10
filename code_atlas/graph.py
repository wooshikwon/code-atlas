"""확인한 지점으로 노드·선을 조립하고 상속 사슬·진입점·측정값을 판정한다."""

from __future__ import annotations

from collections import deque

from .collect import RepoFiles, is_test_path
from .extract import DATA_BASES, FileFacts
from .lsp import to_utf16
from .model import Analysis, Edge, Node, SiteRef
from .resolve import Resolution, ResolvedSite

ENTRY_DECORATORS = {"command", "group", "route", "get", "post", "put", "patch", "delete", "websocket"}
EDGE_GROUPS = {
    "call": "run",
    "construct": "run",
    "import": "use",
    "pass": "use",
    "decorate": "use",
    "type": "use",
    "inherit": "derive",
    "override": "derive",
}
_CLASS_KINDS = ("class", "dataclass")
_LIFTED_FROM_CLASS = ("call", "pass")


def _package_nodes(repo: RepoFiles, facts: list[FileFacts], nodes: dict[str, Node]) -> None:
    """`.py` 파일을 품은 폴더마다 패키지 노드를 두고 줄 수를 자식 파일의 합으로 바꾼다."""
    prefix = repo.source_root + "/" if repo.source_root else ""
    for d in repo.packages:
        if d == repo.source_root:
            continue
        pid = (d[len(prefix) :] if d.startswith(prefix) else d).replace("/", ".")
        if pid not in nodes:
            nodes[pid] = Node(
                id=pid,
                kind="package",
                name=pid.rsplit(".", 1)[-1],
                parent=pid.rsplit(".", 1)[0] if "." in pid else None,
                path=d,
                range=None,
                loc=0,
                test=is_test_path(d + "/__init__.py"),
            )
        nodes[pid].loc = sum(
            f.nodes[0].loc for f in facts if f.file.module_id == pid or f.file.module_id.startswith(pid + ".")
        )


def _base_name(base: str) -> str:
    return base.split("[", 1)[0].rsplit(".", 1)[-1]


def _inherit_parents(edges: dict[tuple[str, str, str], Edge]) -> dict[str, list[str]]:
    parents: dict[str, list[str]] = {}
    for (kind, source, target) in edges:
        if kind == "inherit":
            parents.setdefault(source, []).append(target)
    return parents


def _mark_dataclasses(facts: list[FileFacts], nodes: dict[str, Node], parents: dict[str, list[str]]) -> None:
    """부모 클래스 표현식에 `DATA_BASES`가 있는 클래스와 그 자손을 데이터 클래스로 판정한다."""
    infos = {info.node_id: info for f in facts for info in f.defs.values()}
    seeds = {nid for nid, info in infos.items() if any(_base_name(b) in DATA_BASES for b in info.bases)}

    def reaches_seed(nid: str, seen: set[str]) -> bool:
        if nid in seeds:
            return True
        seen.add(nid)
        return any(p not in seen and reaches_seed(p, seen) for p in parents.get(nid, []))

    for nid, node in nodes.items():
        if node.kind == "class" and reaches_seed(nid, set()):
            node.kind = "dataclass"
            node.fields = infos[nid].fields


def _overrides(nodes: dict[str, Node], parents: dict[str, list[str]], facts: list[FileFacts]) -> list[Edge]:
    """메서드마다 부모 쪽 상속 사슬을 가까운 순서로 따라가 같은 이름의 메서드를 처음 찾은 곳으로 잇는다."""
    infos = {info.node_id: (f.file.path, info) for f in facts for info in f.defs.values()}
    edges: list[Edge] = []
    for node in nodes.values():
        if node.kind != "method" or node.parent is None or nodes[node.parent].kind not in _CLASS_KINDS:
            continue
        queue = deque(parents.get(node.parent, []))
        seen: set[str] = set()
        while queue:
            cls = queue.popleft()
            if cls in seen or cls not in nodes or nodes[cls].kind not in _CLASS_KINDS:
                continue
            seen.add(cls)
            candidate = f"{cls}.{node.name}"
            if candidate in nodes and nodes[candidate].kind == "method":
                path, info = infos[node.id]
                site = SiteRef(path, info.name_line, info.name_col)
                edges.append(Edge("derive", "override", node.id, candidate, [site]))
                break
            queue.extend(parents.get(cls, []))
    return edges


def _mark_entries(repo: RepoFiles, facts: list[FileFacts], nodes: dict[str, Node]) -> None:
    prefix = repo.source_root.replace("/", ".") + "." if repo.source_root else ""
    for script in repo.scripts:
        target = script.split("[", 1)[0].strip()
        for nid in (target, target[len(prefix) :] if prefix and target.startswith(prefix) else None):
            if nid and nid in nodes:
                nodes[nid].entry = True
                break
    for f in facts:
        for info in f.defs.values():
            node = nodes[info.node_id]
            if node.kind in ("function", "method") and any(
                d.rsplit(".", 1)[-1] in ENTRY_DECORATORS for d in info.decorators
            ):
                node.entry = True


def _source(site: ResolvedSite, nodes: dict[str, Node], modules: dict[str, str]) -> str:
    """선의 출발 노드. import는 모듈로, 클래스 본문의 호출·전달도 모듈로 올린다."""
    if site.kind == "import":
        return modules[site.path]
    if site.kind in _LIFTED_FROM_CLASS and nodes[site.enclosing].kind in _CLASS_KINDS:
        return modules[site.path]
    return site.enclosing


def build(repo: RepoFiles, facts: list[FileFacts], resolution: Resolution, texts: dict[str, str]) -> Analysis:
    nodes: dict[str, Node] = {n.id: n for f in facts for n in f.nodes}
    _package_nodes(repo, facts, nodes)
    modules = {f.file.path: f.file.module_id for f in facts}
    lines = {path: text.splitlines() for path, text in texts.items()}

    def site_ref(path: str, line: int, col: int) -> SiteRef:
        text = lines.get(path, [])
        return SiteRef(path, line, to_utf16(text[line - 1], col) if 0 < line <= len(text) else col)

    edges: dict[tuple[str, str, str], Edge] = {}
    deferred: dict[tuple[str, str, str], bool] = {}
    for site in resolution.sites:
        source = _source(site, nodes, modules)
        if site.kind == "call" and site.status in ("unresolved", "dynamic"):
            nodes[source].unresolved += 1
        if site.edge is None or site.target is None or site.target == source:
            continue
        key = (site.edge, source, site.target)
        edge = edges.get(key)
        if edge is None:
            edge = edges[key] = Edge(EDGE_GROUPS[site.edge], site.edge, source, site.target)
        edge.sites.append(site_ref(site.path, site.line, site.col))
        deferred[key] = deferred.get(key, True) and site.deferred
    for key, edge in edges.items():
        edge.deferred = deferred[key]

    for ext in resolution.externals.values():
        if any(e.target == ext.id for e in edges.values()):
            nodes[ext.id] = ext

    parents = _inherit_parents(edges)
    _mark_dataclasses(facts, nodes, parents)
    override_edges = _overrides(nodes, parents, facts)
    for e in override_edges:
        e.sites = [site_ref(s.path, s.line, s.col) for s in e.sites]
    _mark_entries(repo, facts, nodes)

    calls = [s for s in resolution.sites if s.kind == "call" and s.status != "builtin"]
    edge_list = [*edges.values(), *override_edges]
    stats = {
        "files": len(repo.files),
        "nodes": len(nodes),
        "edges": len(edge_list),
        "call_sites": len(calls),
        "resolved": sum(s.status in ("resolved", "external") for s in calls),
        "unresolved": sum(s.status in ("unresolved", "dynamic") for s in calls),
        "timed_out": 0,
        "elapsed_ms": 0,
    }
    errors = [{"path": f.file.path, "message": f.error} for f in facts if f.error]
    return Analysis(list(nodes.values()), edge_list, resolution.sites, errors, stats)
