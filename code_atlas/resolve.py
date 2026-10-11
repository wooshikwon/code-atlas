"""언어 서버가 돌려준 정의 위치를 노드 id로 바꾼다.

ast 노드를 다시 읽지 않고 extract가 낸 정의 목록과 지점 목록만 쓴다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .collect import disk_path
from .extract import FileFacts
from .lsp import Location
from .model import Node, Site

STATUSES = ("resolved", "external", "builtin", "unresolved", "dynamic")
EXTERNAL_PREFIX = "ext:"

# 지점 종류마다 대상 노드 종류가 정하는 선 종류. 표에 없는 조합은 선을 만들지 않는다.
EDGE_KINDS: dict[str, dict[str, str]] = {
    "call": {"function": "call", "method": "call", "class": "construct", "dataclass": "construct"},
    "pass": {k: "pass" for k in ("function", "method", "class", "dataclass")},
    "decorate": {k: "decorate" for k in ("function", "method", "class", "dataclass")},
    "type": {k: "type" for k in ("class", "dataclass")},
    "inherit": {k: "inherit" for k in ("class", "dataclass", "external")},
    "import": {k: "import" for k in ("module", "package", "external")},
}

_STUB_SUFFIX = re.compile(r"(-stubs)?(\.pyi?)?$")
_STDLIB_DIR = re.compile(r"/lib/python3\.\d+/")


@dataclass
class ResolvedSite(Site):
    status: str = "unresolved"
    target: str | None = None
    edge: str | None = None  # 이 지점이 만드는 선 종류. 선을 만들지 않으면 None


@dataclass
class Resolution:
    sites: list[ResolvedSite]
    externals: dict[str, Node] = field(default_factory=dict)


class Index:
    """레포 안 위치를 노드 id로 찾는 표."""

    def __init__(self, root: Path, facts: list[FileFacts]):
        self.root = disk_path(root)
        self.modules: dict[str, str] = {}  # 레포 루트 기준 경로 → 그 파일의 노드 id
        self.names: dict[tuple[str, int, int], str] = {}  # (경로, 줄, 열) → 노드 id
        self.kinds: dict[str, str] = {}
        self.ranges: dict[str, list[tuple[int, int, str]]] = {}  # 레포 루트 기준 경로 → (시작 줄, 끝 줄, 노드 id)
        for f in facts:
            self.modules[f.file.path] = f.nodes[0].id
            for node in f.nodes:
                self.kinds[node.id] = node.kind
                self.ranges.setdefault(f.file.path, []).append((*node.range, node.id))
            for info in f.defs.values():
                self.names[(f.file.path, info.name_line, info.name_col)] = info.node_id

    def relative(self, path: str) -> str | None:
        """레포 루트 기준 경로. 레포 밖이면 None이다."""
        try:
            return disk_path(path).relative_to(self.root).as_posix()
        except ValueError:
            return None

    def enclosing(self, path: str, line: int, col: int) -> str | None:
        """레포 루트 기준 경로의 위치를 품은 가장 안쪽 노드 id. 파일 첫 위치는 모듈이고, 분석 대상 파일이 아니면 None이다."""
        if line == 1 and col == 0:
            return self.modules.get(path)
        inside = [r for r in self.ranges.get(path, []) if r[0] <= line <= r[1]]
        return max(inside, key=lambda r: (r[0], -r[1]))[2] if inside else None


def external_of(path: str) -> tuple[str, str] | None:
    """레포 밖 경로에서 (최상위 모듈 이름, origin)을 구한다. 내장 모듈이면 origin이 builtin이다."""
    p = Path(path).as_posix()
    if p.endswith("/builtins.pyi"):
        return "builtins", "builtin"
    if "/typeshed-fallback/stdlib/" in p:
        return _top_module(p.split("/typeshed-fallback/stdlib/", 1)[1]), "stdlib"
    if "/typeshed-fallback/stubs/" in p:
        rest = p.split("/typeshed-fallback/stubs/", 1)[1].split("/", 1)
        return (_top_module(rest[1]) if len(rest) > 1 else rest[0]), "thirdparty"
    for marker in ("/site-packages/", "/dist-packages/"):
        if marker in p:
            return _top_module(p.split(marker, 1)[1]), "thirdparty"
    m = _STDLIB_DIR.search(p)
    if m:
        return _top_module(p[m.end() :]), "stdlib"
    return None


def _top_module(rel: str) -> str:
    return _STUB_SUFFIX.sub("", rel.split("/", 1)[0])


def _external_node(name: str, origin: str) -> Node:
    return Node(
        id=EXTERNAL_PREFIX + name,
        kind="external",
        name=name,
        parent=None,
        path=None,
        range=None,
        loc=0,
        origin=origin,
    )


def _in_repo_target(site: Site, loc: Location, rel: str, index: Index) -> str | None:
    module = index.modules.get(rel)
    if module is None:
        return None
    if site.kind == "import":
        return module
    target = index.names.get((rel, loc.line, loc.col))
    if target is not None:
        return target
    if loc.line == 1 and loc.col == 0:
        return module
    return None


def resolve_site(site: Site, locations: list[Location], index: Index, externals: dict[str, Node]) -> ResolvedSite:
    base = {k: getattr(site, k) for k in Site.__dataclass_fields__}
    if site.dynamic:
        return ResolvedSite(**base, status="dynamic")
    external: tuple[str, str] | None = None
    for loc in locations:
        rel = index.relative(loc.path)
        if rel is not None and "/site-packages/" not in "/" + rel:
            target = _in_repo_target(site, loc, rel, index)
            edge = EDGE_KINDS[site.kind].get(index.kinds.get(target, ""))
            if edge is not None:
                return ResolvedSite(**base, status="resolved", target=target, edge=edge)
        elif external is None:
            external = external_of(loc.path)
    if external is None:
        return ResolvedSite(**base, status="unresolved")
    name, origin = external
    if origin == "builtin":
        return ResolvedSite(**base, status="builtin")
    node = externals.setdefault(EXTERNAL_PREFIX + name, _external_node(name, origin))
    return ResolvedSite(**base, status="external", target=node.id, edge=EDGE_KINDS[site.kind].get("external"))


def resolve(facts: list[FileFacts], locations: dict[int, list[Location]], index: Index) -> Resolution:
    """지점 순번(`facts`의 지점을 차례로 센 번호)마다 받은 위치로 대상을 정한다."""
    externals: dict[str, Node] = {}
    sites: list[ResolvedSite] = []
    n = 0
    for f in facts:
        for site in f.sites:
            sites.append(resolve_site(site, locations.get(n, []), index, externals))
            n += 1
    return Resolution(sites, externals)
