"""분석 결과의 자료형. 필드 이름과 의미는 HTTP API 계약과 같다."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Node:
    id: str
    kind: str  # package·module·class·dataclass·function·method·external
    name: str
    parent: str | None
    path: str | None
    range: tuple[int, int] | None
    loc: int
    unresolved: int = 0
    test: bool = False
    entry: bool = False
    reads: list[str] = field(default_factory=list)
    writes: list[str] = field(default_factory=list)
    global_write: bool = False
    fields: list[dict[str, str | None]] | None = None
    method_kind: str | None = None  # property·static·class
    origin: str | None = None  # stdlib·thirdparty


@dataclass
class SiteRef:
    """API에 내보내는 관계 위치. line은 1부터, col은 0부터 세는 UTF-16 단위다."""

    path: str
    line: int
    col: int


@dataclass
class Edge:
    group: str  # run·use·derive
    kind: str  # call·construct·import·pass·decorate·type·inherit·override
    source: str
    target: str
    sites: list[SiteRef] = field(default_factory=list)
    deferred: bool = False


@dataclass
class Site:
    """ast에서 찾은 관계 후보 하나. col·request_col은 UTF-8 바이트 단위다.

    kind는 call·import·pass·decorate·type·inherit 가운데 하나다. call은 대상이
    클래스인지 확인한 뒤 construct가 된다. request_line·request_col은 언어 서버에
    정의 위치를 물을 위치이고, dynamic이면 묻지 않는다.
    """

    kind: str
    path: str
    line: int
    col: int
    request_line: int
    request_col: int
    enclosing: str
    text: str
    dynamic: bool = False
    deferred: bool = False


@dataclass
class Analysis:
    nodes: list[Node]
    edges: list[Edge]
    sites: list  # list[ResolvedSite]
    errors: list[dict[str, str]]
    stats: dict[str, int]


def to_dict(obj) -> dict:
    return asdict(obj)
