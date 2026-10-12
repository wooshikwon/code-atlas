"""확인한 지점으로 노드·선을 조립하고 상속 사슬·진입점·측정값을 판정한다."""

from __future__ import annotations

from collections import deque

from .collect import RepoFiles, is_test_path
from .extract import DATA_BASES, FileFacts, VarInfo
from .lsp import to_utf16
from .model import Analysis, Edge, Node, SiteRef
from .resolve import ACCESS_KINDS, Resolution, ResolvedSite

ENTRY_DECORATORS = {"command", "group", "route", "get", "post", "put", "patch", "delete", "websocket"}
EDGE_GROUPS = {
    "call": "run",
    "construct": "run",
    "import": "use",
    "pass": "use",
    "decorate": "use",
    "type": "use",
    "read": "use",
    "write": "use",
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
    """실행 스크립트의 대상과 진입점 데코레이터가 붙은 함수를 진입점으로 표시한다. 대상이 변수이면 그 변수를 둔 모듈이 진입점이다."""
    prefix = repo.source_root.replace("/", ".") + "." if repo.source_root else ""
    for script in repo.scripts:
        target = script.split("[", 1)[0].strip()
        for nid in (target, target[len(prefix) :] if prefix and target.startswith(prefix) else None):
            if nid and nid in nodes:
                node = nodes[nid]
                (nodes[node.parent] if node.kind == "variable" else node).entry = True
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


def _unknown_call(site: ResolvedSite) -> bool:
    """대상을 확인하지 못한 호출 지점이다. 변수로 답한 호출도 그 변수에 든 대상을 모르므로 여기에 든다."""
    return site.kind == "call" and (site.status in ("unresolved", "dynamic") or site.edge == "read")


def _holders(facts: list[FileFacts], modules: dict[str, str]) -> dict[str, list[VarInfo]]:
    """모듈 노드 id → 값 식의 범위가 있는 그 파일의 변수 후보."""
    return {modules[f.file.path]: [v for v in f.variables if v.value is not None] for f in facts}


def _holder(site: ResolvedSite, holders: list[VarInfo]) -> str | None:
    """지점이 어느 변수 후보의 값 식 안에 있으면 그 후보의 id."""
    at = (site.line, site.col)
    for var in holders:
        if var.value[:2] <= at < var.value[2:]:
            return var.node_id
    return None


def _variable_nodes(
    facts: list[FileFacts],
    modules: dict[str, str],
    drafts: list[tuple[ResolvedSite, str]],
    lines: dict[str, list[str]],
) -> dict[str, Node]:
    """함수·클래스나 다른 파일이 읽거나 바꾸는 변수 후보를 노드로 만든다. `drafts`는 지점과 그 지점이 만들 선의 출발이다.

    같은 파일의 변수 후보가 값 식에서 읽거나 바꾸는 후보는 그 후보가 노드일 때만 노드이고, 노드가 더 늘지 않을 때까지
    되풀이한다. 자기 파일의 모듈 최상위 문장만 읽거나 바꾸는 후보는 노드가 아니다.
    """
    owners = {v.node_id: f.file.path for f in facts for v in f.variables}
    held: dict[str, set[str]] = {}  # 변수 후보 id → 같은 파일의 그 후보가 값 식에서 읽거나 바꾸는 변수 후보
    chosen: set[str] = set()
    for site, source in drafts:
        if site.edge not in ACCESS_KINDS or site.target not in owners or site.target == source:
            continue
        if owners.get(source) == owners[site.target]:
            held.setdefault(source, set()).add(site.target)
        elif source != modules[owners[site.target]]:
            chosen.add(site.target)
    queue = list(chosen)
    while queue:
        for target in held.get(queue.pop(), ()):
            if target not in chosen:
                chosen.add(target)
                queue.append(target)

    makers = {(s.path, s.request_line, s.request_col): s.status for s, _ in drafts if s.kind == "call"}
    nodes: dict[str, Node] = {}
    for f in facts:
        text = lines.get(f.file.path, [])
        for var in f.variables:
            if var.node_id not in chosen:
                continue
            nodes[var.node_id] = Node(
                id=var.node_id,
                kind="variable",
                name=var.name,
                parent=modules[f.file.path],
                path=f.file.path,
                range=var.range,
                loc=sum(1 for line in text[var.range[0] - 1 : var.range[1]] if line.strip()),
                test=f.file.test,
                value={"kind": var.value_kind, "size": var.size, "text": var.text},
                external_value=var.maker is not None and makers.get((f.file.path, *var.maker)) == "external",
            )
    return nodes


def build(repo: RepoFiles, facts: list[FileFacts], resolution: Resolution, texts: dict[str, str]) -> Analysis:
    nodes: dict[str, Node] = {n.id: n for f in facts for n in f.nodes}
    _package_nodes(repo, facts, nodes)
    modules = {f.file.path: f.nodes[0].id for f in facts}
    lines = {path: text.splitlines() for path, text in texts.items()}

    def site_ref(path: str, line: int, col: int) -> SiteRef:
        text = lines.get(path, [])
        return SiteRef(path, line, to_utf16(text[line - 1], col) if 0 < line <= len(text) else col)

    # 모듈 최상위 문장의 지점이 변수 후보의 값 식 안에 있으면 선의 출발을 그 후보로 둔다.
    holders = _holders(facts, modules)
    drafts: list[tuple[ResolvedSite, str]] = []
    for site in resolution.sites:
        source = _source(site, nodes, modules)
        if _unknown_call(site):
            nodes[source].unresolved += 1
        if site.enclosing == source and site.kind != "import" and holders.get(source):
            source = _holder(site, holders[source]) or source
        drafts.append((site, source))
    variables = _variable_nodes(facts, modules, drafts, lines)
    candidates = {v.node_id for f in facts for v in f.variables} - set(variables)

    edges: dict[tuple[str, str, str], Edge] = {}
    deferred: dict[tuple[str, str, str], bool] = {}
    for site, source in drafts:
        if source in candidates:
            source = modules[site.path]
        if site.edge is None or site.target is None or site.target == source or site.target in candidates:
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
    nodes.update(variables)

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
        "resolved": sum(not _unknown_call(s) for s in calls),
        "unresolved": sum(_unknown_call(s) for s in calls),
        "timed_out": 0,
        "elapsed_ms": 0,
    }
    errors = [{"path": f.file.path, "message": f.error} for f in facts if f.error]
    return Analysis(list(nodes.values()), edge_list, resolution.sites, errors, stats)
