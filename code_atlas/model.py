"""분석 결과의 자료형. 필드 이름과 의미는 HTTP API 계약과 같다."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Node:
    id: str
    kind: str  # package·module·class·dataclass·function·method·variable·external
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
    value: dict[str, str | int | None] | None = None  # 변수 노드만: 값의 종류 kind, 원소 수 size, 값의 글 text
    external_value: bool = False  # 변수 노드만: 값을 만든 호출의 대상이 외부 노드다


@dataclass
class SiteRef:
    """API에 내보내는 관계 위치. line은 1부터, col은 0부터 세는 UTF-16 단위다."""

    path: str
    line: int
    col: int


@dataclass
class Edge:
    group: str  # run·use·derive
    kind: str  # call·construct·import·pass·decorate·type·read·write·inherit·override
    source: str
    target: str
    sites: list[SiteRef] = field(default_factory=list)
    deferred: bool = False


@dataclass
class Site:
    """ast에서 찾은 관계 후보 하나. col·request_col은 UTF-8 바이트 단위다.

    kind는 call·import·pass·decorate·type·inherit·read·write 가운데 하나다. call은 대상이
    클래스인지 확인한 뒤 construct가 된다. read·write는 모듈 변수와 이름이 같은 식별자가 값으로 쓰이거나
    바뀌는 위치다. request_line·request_col은 언어 서버에
    정의 위치를 물을 위치이고, dynamic이거나 builtin이면 묻지 않는다. builtin은 식이
    그 파일에서 묶이지 않은 내장 이름 하나인 지점이다.
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
    builtin: bool = False


@dataclass
class Analysis:
    nodes: list[Node]
    edges: list[Edge]
    sites: list  # list[ResolvedSite]
    errors: list[dict[str, str]]
    stats: dict[str, int]


def to_dict(obj) -> dict:
    return asdict(obj)
