"""분석 결과에서 미사용 후보를 판정한다.

테스트 코드가 아닌 함수·메서드·클래스·데이터 클래스 가운데, 자기와 자기 안의 노드를 뺀 곳에서 들어오는 실행·사용 선이
없는 정의에서 `RULES`의 규칙에 걸리는 정의를 뺀다. 테스트 코드에서 들어오는 선도 사용으로 센다.
분석 결과를 읽기만 하고 바꾸지 않는다.
"""

from __future__ import annotations

import ast
import re
from collections.abc import Callable
from dataclasses import dataclass

from .extract import FileFacts
from .model import Analysis, Node

DEFINITION_KINDS = ("function", "method", "class", "dataclass")
_CLASS_KINDS = ("class", "dataclass")
_USE_GROUPS = ("run", "use")
_NAMED_SITES = ("call", "pass")

_IDENTIFIER = re.compile(r"[^\W\d]\w*")
_DOTTED = re.compile(r"[^\W\d]\w*(?:\.[^\W\d]\w*)*")


@dataclass
class Unused:
    definitions: int  # 판정 대상 정의 수
    candidates: list[str]  # 미사용 후보의 노드 id. 파일 경로, 시작 줄 순서


@dataclass
class Known:
    """규칙이 읽는 사실."""

    nodes: dict[str, Node]
    users: dict[str, set[str]]  # 노드 id → 그 노드로 들어오는 실행·사용 선의 출발 노드
    methods: dict[str, list[str]]  # 클래스 id → 안에 든 메서드
    decorated: set[str]  # 데코레이터가 붙은 정의
    bases: dict[str, list[str]]  # 클래스 id → 상속 선의 도착 노드
    inherited: set[str]  # 다른 클래스가 상속하는 클래스
    overrides: dict[str, set[str]]  # 메서드 id → 오버라이드 선으로 이어진 메서드
    called: set[str]  # 대상을 확인하지 못한 호출·전달 지점이 부른 이름
    strings: set[str]  # 분석 대상 파일의 문자열 상수에 적힌 이름
    configs: list[str]  # 설정 파일의 본문

    def used(self, node_id: str) -> bool:
        """자기와 자기 안의 노드를 뺀 곳에서 들어오는 실행·사용 선이 있다."""
        return any(not self._inside(source, node_id) for source in self.users.get(node_id, ()))

    def _inside(self, node_id: str | None, outer: str) -> bool:
        while node_id is not None:
            if node_id == outer:
                return True
            node_id = self.nodes[node_id].parent if node_id in self.nodes else None
        return False


def _declared(node: Node, known: Known) -> bool:
    """진입점, 이름이 `test_`로 시작하는 함수, 데코레이터가 붙은 정의, 이름이 이중 밑줄로 시작하고 끝나는 정의."""
    dunder = node.name.startswith("__") and node.name.endswith("__")
    return node.entry or node.name.startswith("test_") or node.id in known.decorated or dunder


def _class_in_use(node: Node, known: Known) -> bool:
    """다른 클래스가 상속하는 클래스, 안에 든 메서드로 들어오는 실행·사용 선이 있는 클래스."""
    if node.kind not in _CLASS_KINDS:
        return False
    return node.id in known.inherited or any(known.used(m) for m in known.methods.get(node.id, ()))


def _override_in_use(node: Node, known: Known) -> bool:
    """오버라이드 선으로 이어진 메서드 묶음 가운데 하나라도 들어오는 실행·사용 선이 있는 메서드."""
    seen = {node.id}
    stack = [node.id]
    while stack:
        for other in known.overrides.get(stack.pop(), ()):
            if other not in seen:
                seen.add(other)
                stack.append(other)
    return any(known.used(m) for m in seen)


def _externally_based(node: Node, known: Known) -> bool:
    """상속 사슬에 외부 클래스가 있는 클래스의 메서드."""
    if node.kind != "method" or node.parent is None:
        return False
    seen: set[str] = set()
    stack = [node.parent]
    while stack:
        cls = stack.pop()
        if cls in seen:
            continue
        seen.add(cls)
        if cls in known.nodes and known.nodes[cls].kind == "external":
            return True
        stack.extend(known.bases.get(cls, ()))
    return False


def _called_by_name(node: Node, known: Known) -> bool:
    """대상을 확인하지 못한 호출·전달 지점이 같은 이름을 부르는 정의."""
    return node.name in known.called


def _named_in_string(node: Node, known: Known) -> bool:
    """이름이 분석 대상 파일의 문자열 상수로 적힌 정의."""
    return node.name in known.strings


def _named_in_config(node: Node, known: Known) -> bool:
    """점 경로가 레포의 설정 파일에 적힌 정의."""
    path = re.compile(rf"(?<![\w.]){re.escape(node.id.replace(':', '.'))}(?!\w)")
    return any(path.search(text) for text in known.configs)


RULES: list[Callable[[Node, Known], bool]] = [
    _declared,
    _class_in_use,
    _override_in_use,
    _externally_based,
    _called_by_name,
    _named_in_string,
    _named_in_config,
]


def _called_names(analysis: Analysis, texts: dict[str, str]) -> set[str]:
    """대상을 확인하지 못한 호출·전달 지점마다 언어 서버에 물은 위치에서 시작하는 식별자. 변수로 답한 지점도 대상을 모른다."""
    lines = {path: [line.encode() for line in text.splitlines()] for path, text in texts.items()}
    names: set[str] = set()
    for site in analysis.sites:
        if site.kind not in _NAMED_SITES or not (site.status == "unresolved" or site.edge == "read"):
            continue
        source = lines.get(site.path, [])
        if not 0 < site.request_line <= len(source):
            continue
        found = _IDENTIFIER.match(source[site.request_line - 1][site.request_col :].decode(errors="replace"))
        if found:
            names.add(found.group())
    return names


def _string_names(texts: dict[str, str]) -> set[str]:
    """식별자나 점 경로 모양인 문자열 상수의 마지막 마디."""
    names: set[str] = set()
    for text in texts.values():
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        for e in ast.walk(tree):
            if isinstance(e, ast.Constant) and isinstance(e.value, str) and _DOTTED.fullmatch(e.value):
                names.add(e.value.rsplit(".", 1)[-1])
    return names


def _known(analysis: Analysis, facts: list[FileFacts], texts: dict[str, str], configs: list[str]) -> Known:
    nodes = {n.id: n for n in analysis.nodes}
    users: dict[str, set[str]] = {}
    bases: dict[str, list[str]] = {}
    overrides: dict[str, set[str]] = {}
    for e in analysis.edges:
        if e.group in _USE_GROUPS:
            users.setdefault(e.target, set()).add(e.source)
        elif e.kind == "inherit":
            bases.setdefault(e.source, []).append(e.target)
        elif e.kind == "override":
            overrides.setdefault(e.source, set()).add(e.target)
            overrides.setdefault(e.target, set()).add(e.source)
    methods: dict[str, list[str]] = {}
    for n in analysis.nodes:
        if n.kind == "method" and n.parent is not None:
            methods.setdefault(n.parent, []).append(n.id)
    return Known(
        nodes=nodes,
        users=users,
        methods=methods,
        decorated={info.node_id for f in facts for info in f.defs.values() if info.decorators},
        bases=bases,
        inherited={target for targets in bases.values() for target in targets},
        overrides=overrides,
        called=_called_names(analysis, texts),
        strings=_string_names(texts),
        configs=configs,
    )


def candidates(analysis: Analysis, facts: list[FileFacts], texts: dict[str, str], configs: list[str]) -> Unused:
    """`texts`는 레포 루트 기준 경로별 본문, `configs`는 설정 파일의 본문이다."""
    known = _known(analysis, facts, texts, configs)
    definitions = [n for n in analysis.nodes if n.kind in DEFINITION_KINDS and not n.test]
    found = [n for n in definitions if not known.used(n.id) and not any(rule(n, known) for rule in RULES)]
    found.sort(key=lambda n: (n.path, n.range[0]))
    return Unused(len(definitions), [n.id for n in found])
