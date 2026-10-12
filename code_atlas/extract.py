"""파일 하나의 ast에서 노드와 관계 후보 지점을 뽑는다.

대상을 확인하지 않는다. 지점마다 언어 서버에 정의 위치를 물을 위치만 정하고,
대상 확인과 선 조립은 resolve·graph가 맡는다.
"""

from __future__ import annotations

import ast
import builtins
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

from .collect import RepoFiles, SourceFile
from .model import Node, Site
from .routes import declared, prefixes

DATA_BASES = {"NamedTuple", "TypedDict", "Enum", "IntEnum", "StrEnum", "Flag", "IntFlag", "BaseModel"}
METHOD_KINDS = {
    "property": "property",
    "cached_property": "property",
    "staticmethod": "static",
    "classmethod": "class",
}
BUILTIN_NAMES = frozenset(dir(builtins))
# 내장 컨테이너를 바꾸는 메서드. 모듈 변수에 이 메서드를 부르면 그 변수를 바꾸는 지점이다.
MUTATORS = frozenset(
    "append extend insert add update setdefault pop popitem remove discard clear sort reverse appendleft extendleft".split()
)
_CONTAINERS: dict[type, str] = {
    ast.Dict: "dict",
    ast.DictComp: "dict",
    ast.List: "list",
    ast.ListComp: "list",
    ast.Set: "set",
    ast.SetComp: "set",
    ast.Tuple: "tuple",
}
# 첨자를 붙이면 타입 식이 되는 `typing`·`collections.abc`의 이름과 내장 제네릭
_TYPE_HEADS = frozenset(
    "Literal Union Optional Callable Annotated Type ClassVar Final Required NotRequired Concatenate TypeGuard "
    "List Dict Set FrozenSet Tuple DefaultDict OrderedDict Counter Deque ChainMap "
    "Sequence MutableSequence Mapping MutableMapping Collection Container Iterable Iterator Generator "
    "AsyncIterable AsyncIterator AsyncGenerator Awaitable Coroutine "
    "list dict set frozenset tuple type".split()
)
# `|` 합의 한쪽에 있으면 그 합이 타입 식인 내장 자료형 이름
_TYPE_NAMES = frozenset("int float complex bool str bytes bytearray object list dict set frozenset tuple type".split())
_DEF_HEAD = re.compile(rb"(?:async\s+)?(?:def|class)\s+")
_TEXT_LIMIT = 80


@dataclass
class DefInfo:
    """API 노드에 담지 않는 정의 사실. name_col은 UTF-8 바이트 단위다."""

    node_id: str
    name_line: int
    name_col: int
    decorators: list[str] = field(default_factory=list)
    bases: list[str] = field(default_factory=list)
    fields: list[dict[str, str | None]] = field(default_factory=list)


@dataclass
class VarInfo:
    """모듈 수준에서 대입한 이름 하나. 위치의 열은 UTF-8 바이트 단위다.

    value_kind는 값 식의 종류이고 구문만 보고 아래 순서로 정한다.

    1. 상수와 f-string은 자료형 이름, 컨테이너 표기와 컴프리헨션은 dict·list·set·tuple이다.
    2. 호출은 받는 식의 글에 `(…)`를 붙인 글이다. 호출 뒤에 첨자나 연산이 붙은 식은 호출이 아니다.
    3. `alias`는 이름 하나나 점으로 이은 이름이다(`make_forward_fn`, `OutputFormat.text`, `str`).
    4. `type`은 바탕의 마지막 이름이 `_TYPE_HEADS`에 든 첨자 식(`Literal['a', 'b']`, `typing.Optional[int]`, `list[str]`)과,
       그런 첨자 식이나 `None`, `_TYPE_NAMES`의 이름이 한쪽에라도 있고 모든 쪽이 이름·점으로 이은 이름·첨자 식·`None`·문자열인
       `|` 합이다(`str | ComponentSpec`). 양쪽이 모두 그 밖의 이름인 합(`re.I | re.M`, `A | B`)은 타입 식인지 알 수 없으므로 `expr`이다.
    5. `expr`은 그 밖의 식과 값 식 범위가 없는 대입이다.
    """

    node_id: str  # "{모듈 id}:{이름}"
    name: str
    range: tuple[int, int]  # 첫 대입문의 시작 줄과 끝 줄
    targets: list[tuple[int, int]]  # 그 이름을 대입한 모든 위치 (줄, 열)
    value: tuple[int, int, int, int] | None  # 첫 대입문의 값 식 범위 (시작 줄, 열, 끝 줄, 열). 대입 대상이 이름 하나가 아니면 None
    value_kind: str
    size: int | None  # 컨테이너 표기의 원소 수, 컨테이너 표기 하나를 인자로 받은 호출의 그 원소 수
    text: str  # 값 식의 글. `_TEXT_LIMIT`에서 자른다
    maker: tuple[int, int] | None  # 값을 만든 호출 지점이 언어 서버에 묻는 위치 (줄, 열)


@dataclass
class FileFacts:
    file: SourceFile
    nodes: list[Node]
    defs: dict[str, DefInfo]
    sites: list[Site]
    error: str | None = None
    variables: list[VarInfo] = field(default_factory=list)


def _loc(lines: list[str], start: int, end: int) -> int:
    return sum(1 for line in lines[start - 1 : end] if line.strip())


def _text(e: ast.AST) -> str:
    text = ast.unparse(e)
    return text if len(text) <= _TEXT_LIMIT else text[: _TEXT_LIMIT - 1] + "…"


def _last_name(e: ast.expr) -> str | None:
    if isinstance(e, ast.Call):
        e = e.func
    if isinstance(e, ast.Subscript):
        e = e.value
    if isinstance(e, ast.Name):
        return e.id
    if isinstance(e, ast.Attribute):
        return e.attr
    return None


def _request_pos(e: ast.Name | ast.Attribute) -> tuple[int, int]:
    if isinstance(e, ast.Name):
        return e.lineno, e.col_offset
    return e.end_lineno, e.end_col_offset - len(e.attr.encode())


def _is_main_guard(test: ast.expr) -> bool:
    if not (isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq)):
        return False
    sides = [test.left, test.comparators[0]]
    has_name = any(isinstance(s, ast.Name) and s.id == "__name__" for s in sides)
    has_main = any(isinstance(s, ast.Constant) and s.value == "__main__" for s in sides)
    return has_name and has_main


def _assigned_targets(target: ast.expr) -> list[ast.Name]:
    if isinstance(target, ast.Name):
        return [target]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [n for el in target.elts for n in _assigned_targets(el)]
    if isinstance(target, ast.Starred):
        return _assigned_targets(target.value)
    return []


def _module_statements(body: list[ast.stmt]) -> Iterator[ast.stmt]:
    """모듈 최상위 문장과 그 안에 든 `if`·`try`·`for`·`with`의 문장을 소스 순서로 낸다. 함수·클래스 본문은 들어가지 않는다."""
    for stmt in body:
        yield stmt
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        for child in ast.iter_child_nodes(stmt):
            if isinstance(child, ast.stmt):
                yield from _module_statements([child])
            elif isinstance(child, ast.ExceptHandler):
                yield from _module_statements(child.body)


def _size(e: ast.expr) -> int | None:
    if isinstance(e, ast.Dict):
        return len(e.keys)
    if isinstance(e, (ast.List, ast.Set, ast.Tuple)):
        return len(e.elts)
    return None


def _is_dotted(e: ast.expr) -> bool:
    while isinstance(e, ast.Attribute):
        e = e.value
    return isinstance(e, ast.Name)


def _is_generic(e: ast.expr) -> bool:
    """바탕의 마지막 이름이 `_TYPE_HEADS`에 든 첨자 식이다."""
    return isinstance(e, ast.Subscript) and _is_dotted(e.value) and _last_name(e.value) in _TYPE_HEADS


def _is_union(e: ast.expr) -> bool:
    """타입 식임이 한쪽에서라도 확인되는 `|` 합이다."""
    sides: list[ast.expr] = []
    stack = [e]
    while stack:
        side = stack.pop()
        if isinstance(side, ast.BinOp) and isinstance(side.op, ast.BitOr):
            stack += [side.left, side.right]
        else:
            sides.append(side)
    if len(sides) < 2:
        return False
    sure = False
    for side in sides:
        if isinstance(side, ast.Constant):
            if side.value is not None and not isinstance(side.value, str):
                return False
            sure = sure or side.value is None
        elif isinstance(side, ast.Subscript):
            sure = sure or _is_generic(side)
        elif _is_dotted(side):
            sure = sure or (isinstance(side, ast.Name) and side.id in _TYPE_NAMES)
        else:
            return False
    return sure


def _value_kind(e: ast.expr) -> tuple[str, int | None]:
    """값 식의 (종류, 원소 수)."""
    if isinstance(e, ast.Constant):
        return "None" if e.value is None else type(e.value).__name__, None
    if isinstance(e, ast.JoinedStr):
        return "str", None
    if type(e) in _CONTAINERS:
        return _CONTAINERS[type(e)], _size(e)
    if isinstance(e, ast.Call):
        only = e.args[0] if len(e.args) == 1 and not e.keywords else None
        return f"{_text(e.func)}(…)", _size(only) if only is not None else None
    if _is_dotted(e):
        return "alias", None
    if _is_generic(e) or _is_union(e):
        return "type", None
    return "expr", None


def _maker(e: ast.expr) -> tuple[int, int] | None:
    """값을 만든 호출 지점이 묻는 위치. 이항 연산의 왼쪽, 속성과 첨자의 대상, 호출의 받는 쪽을 따라 내려가 만나는 가장 안쪽 호출이다."""
    call: ast.Call | None = None
    while True:
        if isinstance(e, ast.Call):
            call, e = e, e.func
        elif isinstance(e, ast.BinOp):
            e = e.left
        elif isinstance(e, (ast.Attribute, ast.Subscript)):
            e = e.value
        else:
            break
    if call is None:
        return None
    func = call.func
    return _request_pos(func) if isinstance(func, (ast.Name, ast.Attribute)) else (func.lineno, func.col_offset)


def module_variables(tree: ast.Module, module_id: str) -> list[VarInfo]:
    """모듈 최상위에서 대입한 이름마다 후보 하나를 첫 대입문의 순서로 낸다. 함수·클래스 본문은 들어가지 않는다."""
    found: dict[str, VarInfo] = {}
    for stmt in _module_statements(tree.body):
        value: ast.expr | None = None
        if isinstance(stmt, ast.Assign):
            targets = [n for t in stmt.targets for n in _assigned_targets(t)]
            if len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                value = stmt.value
        elif isinstance(stmt, ast.AnnAssign):
            targets, value = _assigned_targets(stmt.target), stmt.value
        elif isinstance(stmt, (ast.AugAssign, ast.For, ast.AsyncFor)):
            targets = _assigned_targets(stmt.target)
        else:
            continue
        for name in targets:
            info = found.get(name.id)
            if info is None:
                kind, size = _value_kind(value) if value is not None else ("expr", None)
                info = found[name.id] = VarInfo(
                    node_id=f"{module_id}:{name.id}",
                    name=name.id,
                    range=(stmt.lineno, stmt.end_lineno),
                    targets=[],
                    value=None
                    if value is None
                    else (value.lineno, value.col_offset, value.end_lineno, value.end_col_offset),
                    value_kind=kind,
                    size=size,
                    text="" if value is None else _text(value),
                    maker=None if value is None else _maker(value),
                )
            info.targets.append((name.lineno, name.col_offset))
    return list(found.values())


def bound_names(tree: ast.Module) -> set[str]:
    """파일 어디에서든 묶이는 이름. `from m import *`가 있으면 `*`가 들어간다.

    대입·`for`·`with`·컴프리헨션의 대상, `def`·`class`, import, 매개변수, `except`의 대상,
    `match`의 캡처, 타입 매개변수, `global`·`nonlocal`에 적힌 이름이다.
    """
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.alias):
            names.add(node.asname or node.name.split(".")[0])
        elif isinstance(node, ast.Name):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                names.add(node.id)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names.update(node.names)
        else:
            name = getattr(node, "rest" if isinstance(node, ast.MatchMapping) else "name", None)
            if isinstance(name, str):
                names.add(name)
    return names


def _root_name(e: ast.expr) -> ast.Name | None:
    while isinstance(e, (ast.Attribute, ast.Subscript)):
        e = e.value
    return e if isinstance(e, ast.Name) else None


def _receiver_attr(e: ast.expr, receiver: str | None) -> str | None:
    """`self.a`, `self.a[k]`, `self.a.b`에서 `self.a`를 돌려준다."""
    if receiver is None:
        return None
    while isinstance(e, (ast.Attribute, ast.Subscript)):
        if isinstance(e, ast.Attribute) and isinstance(e.value, ast.Name) and e.value.id == receiver:
            return f"{receiver}.{e.attr}"
        e = e.value
    return None


def _function_names(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> tuple[set[str], set[str]]:
    """함수가 묶는 (지역 이름, `global`로 선언한 이름). 안에 중첩한 함수와 클래스가 묶는 이름도 함께 센다."""
    declared_global: set[str] = set()
    local: set[str] = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Global):
            declared_global.update(node.names)
    for node in ast.walk(fn):
        if isinstance(node, ast.arg):
            local.add(node.arg)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            if node.id not in declared_global:
                local.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node is not fn:
            local.add(node.name)
    return local, declared_global


def _class_names(d: ast.ClassDef) -> set[str]:
    """클래스 본문이 묶는 이름. 메서드 본문이 묶는 이름은 들어가지 않는다."""
    names: set[str] = set()
    stack: list[ast.AST] = list(d.body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
            continue
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        stack.extend(ast.iter_child_nodes(node))
    return names


def variable_access(
    fn: ast.FunctionDef | ast.AsyncFunctionDef, module_vars: set[str], receiver: str | None
) -> tuple[list[str], list[str], bool]:
    """함수 본문이 읽고 바꾸는 모듈 변수와 receiver 속성, `global` 선언 여부를 구한다."""
    local, declared_global = _function_names(fn)
    called = {id(n.func) for n in ast.walk(fn) if isinstance(n, ast.Call)}
    mutated = {
        id(root)
        for n in ast.walk(fn)
        if isinstance(n, (ast.Attribute, ast.Subscript)) and isinstance(n.ctx, (ast.Store, ast.Del))
        for root in [_root_name(n)]
        if root is not None
    }
    reads: set[str] = set()
    writes: set[str] = set(declared_global)
    for node in ast.walk(fn):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            if node.id in module_vars and node.id not in local and id(node) not in mutated:
                reads.add(node.id)
        elif isinstance(node, (ast.Attribute, ast.Subscript)):
            attr = _receiver_attr(node, receiver)
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                if attr:
                    writes.add(attr)
                else:
                    root = _root_name(node)
                    if root and root.id in module_vars and root.id not in local:
                        writes.add(root.id)
            elif attr and isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                if id(node) not in called:
                    reads.add(attr)
    return sorted(reads), sorted(writes), bool(declared_global)


class _Extractor:
    def __init__(
        self,
        file: SourceFile,
        text: str,
        tree: ast.Module,
        repo_names: frozenset[str],
        repo_variables: frozenset[str],
    ):
        self.file = file
        self.lines = text.splitlines()
        self.line_bytes = [line.encode() for line in self.lines]
        self.tree = tree
        self.repo_names = repo_names
        self.repo_variables = repo_variables
        self.bound: set[str] = set()
        self.file_names = bound_names(tree)
        self.variables = module_variables(tree, file.module_id)
        self.module_vars = {v.name for v in self.variables}
        self.prefixes = prefixes(tree)
        self.nodes: list[Node] = []
        self.defs: dict[str, DefInfo] = {}
        self.sites: list[Site] = []
        self.module = self._module_node()
        self.enclosing = self.module.id
        self.qual: list[str] = []
        self.in_function = False
        self.in_class: Node | None = None

    # 노드

    def _module_node(self) -> Node:
        """파일의 노드. 패키지의 `__init__.py`는 함수·클래스 정의가 있으면 `{패키지}.__init__` 모듈 노드이고 없으면 패키지 노드다."""
        f = self.file
        packaged = f.is_init and f.module_id != "__init__"
        defines = any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) for n in ast.walk(self.tree))
        node_id = f"{f.module_id}.__init__" if packaged and defines else f.module_id
        node = Node(
            id=node_id,
            kind="package" if packaged and not defines else "module",
            name=node_id.rsplit(".", 1)[-1],
            parent=node_id.rsplit(".", 1)[0] if "." in node_id else None,
            path=f.path,
            range=(1, max(len(self.lines), 1)),
            loc=_loc(self.lines, 1, len(self.lines)),
            test=f.test,
        )
        self.nodes.append(node)
        return node

    def _def_node(self, d: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef, kind: str) -> Node:
        qual = ".".join([*self.qual, d.name])
        start = min([d.lineno, *(dec.lineno for dec in d.decorator_list)])
        node = Node(
            id=f"{self.file.module_id}:{qual}",
            kind=kind,
            name=d.name,
            parent=self.enclosing,
            path=self.file.path,
            range=(start, d.end_lineno),
            loc=_loc(self.lines, start, d.end_lineno),
            test=self.file.test,
        )
        m = _DEF_HEAD.match(self.line_bytes[d.lineno - 1], d.col_offset)
        info = DefInfo(
            node_id=node.id,
            name_line=d.lineno,
            name_col=m.end() if m else d.col_offset,
            decorators=[ast.unparse(dec.func if isinstance(dec, ast.Call) else dec) for dec in d.decorator_list],
        )
        self.nodes.append(node)
        self.defs[node.id] = info
        return node

    # 지점

    def _site(self, kind: str, e: ast.expr, target: ast.expr | None = None, dynamic: bool = False) -> None:
        target = target if target is not None else e
        if isinstance(target, (ast.Name, ast.Attribute)) and not dynamic:
            req_line, req_col = _request_pos(target)
        else:
            req_line, req_col, dynamic = target.lineno, target.col_offset, True
        self.sites.append(
            Site(
                kind=kind,
                path=self.file.path,
                line=e.lineno,
                col=e.col_offset,
                request_line=req_line,
                request_col=req_col,
                enclosing=self.enclosing,
                text=_text(e),
                dynamic=dynamic,
                deferred=False,
                builtin=not dynamic and self._builtin(target),
            )
        )

    def _builtin(self, e: ast.expr) -> bool:
        """식이 내장 이름 하나이고 이 파일이 그 이름을 묶지 않는다. `import *`가 있는 파일은 묶는 이름을 알 수 없다."""
        if not isinstance(e, ast.Name) or e.id not in BUILTIN_NAMES:
            return False
        return e.id not in self.file_names and "*" not in self.file_names

    def _known(self, e: ast.expr) -> bool:
        if isinstance(e, ast.Name):
            return e.id in self.bound or e.id in self.repo_names
        if isinstance(e, ast.Attribute):
            return e.attr in self.repo_names
        return False

    def _import_site(self, line: int, col: int, text: str) -> None:
        self.sites.append(
            Site(
                kind="import",
                path=self.file.path,
                line=line,
                col=col,
                request_line=line,
                request_col=col,
                enclosing=self.enclosing,
                text=text,
                deferred=self.in_function,
            )
        )

    # 표현식

    def expr(self, e: ast.expr | None, passed: bool = False) -> None:
        if e is None:
            return
        if isinstance(e, ast.Call):
            self.call(e)
        elif isinstance(e, ast.Name):
            if passed and isinstance(e.ctx, ast.Load) and self._known(e):
                self._site("pass", e)
        elif isinstance(e, ast.Attribute):
            if passed and isinstance(e.ctx, ast.Load) and self._known(e):
                self._site("pass", e)
            self.expr(e.value)
        elif isinstance(e, (ast.List, ast.Tuple, ast.Set)):
            for el in e.elts:
                self.expr(el, passed)
        elif isinstance(e, ast.Dict):
            for k in e.keys:
                self.expr(k)
            for v in e.values:
                self.expr(v, passed)
        elif isinstance(e, (ast.Starred, ast.Await)):
            self.expr(e.value, passed)
        elif isinstance(e, ast.IfExp):
            self.expr(e.test)
            self.expr(e.body, passed)
            self.expr(e.orelse, passed)
        elif isinstance(e, ast.NamedExpr):
            self.expr(e.value, True)
        elif isinstance(e, ast.Lambda):
            self.arguments(e.args, annotate=False)
            self.expr(e.body, True)
        elif isinstance(e, (ast.Yield, ast.YieldFrom)):
            self.expr(e.value, True)
        else:
            self.generic(e)

    def call(self, e: ast.Call) -> None:
        func = e.func
        if isinstance(func, (ast.Name, ast.Attribute)):
            self._site("call", e, func)
            if isinstance(func, ast.Attribute):
                self.expr(func.value)
        else:
            self._site("call", e, func, dynamic=True)
            self.expr(func)
        if isinstance(func, ast.Name) and func.id in ("isinstance", "issubclass") and len(e.args) >= 2:
            self.expr(e.args[0], True)
            self.type_expr(e.args[1])
            rest = e.args[2:]
        else:
            rest = e.args
        for a in rest:
            self.expr(a, True)
        for k in e.keywords:
            self.expr(k.value, True)

    def type_expr(self, e: ast.expr | None) -> None:
        if e is None:
            return
        if isinstance(e, (ast.Name, ast.Attribute)):
            if self._known(e):
                self._site("type", e)
            if isinstance(e, ast.Attribute):
                self.expr(e.value)
        elif isinstance(e, ast.Subscript):
            self.type_expr(e.value)
            self.type_expr(e.slice)
        elif isinstance(e, (ast.Tuple, ast.List)):
            for el in e.elts:
                self.type_expr(el)
        elif isinstance(e, ast.BinOp):
            self.type_expr(e.left)
            self.type_expr(e.right)
        elif isinstance(e, ast.Constant) and isinstance(e.value, str):
            self.string_annotation(e)
        else:
            self.expr(e)

    def string_annotation(self, e: ast.Constant) -> None:
        """한 줄짜리 따옴표 문자열 주석을 다시 파싱해 원본 열로 옮긴다."""
        if e.lineno != e.end_lineno:
            return
        raw = self.line_bytes[e.lineno - 1][e.col_offset : e.end_col_offset]
        if len(raw) < 2 or raw[:1] not in (b'"', b"'") or raw[:3] in (b'"""', b"'''"):
            return
        if raw[1:-1].decode() != e.value:
            return
        try:
            inner = ast.parse(e.value, mode="eval").body
        except SyntaxError:
            return
        offset = e.col_offset + 1
        for n in ast.walk(inner):
            if isinstance(n, (ast.expr)) and hasattr(n, "lineno"):
                n.lineno = n.end_lineno = e.lineno
                n.col_offset += offset
                n.end_col_offset += offset
        before = len(self.sites)
        self.type_expr(inner)
        self.sites[before:] = [s for s in self.sites[before:] if s.kind == "type"]

    def arguments(self, args: ast.arguments, annotate: bool = True) -> None:
        all_args = [*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg]
        if annotate:
            for a in all_args:
                if a is not None:
                    self.type_expr(a.annotation)
        for d in [*args.defaults, *args.kw_defaults]:
            self.expr(d, True)

    def generic(self, node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.stmt):
                self.stmt(child)
            elif isinstance(child, ast.expr):
                self.expr(child)
            elif isinstance(child, ast.ExceptHandler):
                self.type_expr(child.type)
                for s in child.body:
                    self.stmt(s)
            else:
                self.generic(child)

    # 문장

    def stmt(self, s: ast.stmt) -> None:
        if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.function(s)
        elif isinstance(s, ast.ClassDef):
            self.klass(s)
        elif isinstance(s, ast.Import):
            for alias in s.names:
                self.bound.add(alias.asname or alias.name.split(".")[0])
                last = alias.name.rsplit(".", 1)[-1]
                col = alias.col_offset + len(alias.name.encode()) - len(last.encode())
                self._import_site(alias.lineno, col, f"import {alias.name}")
        elif isinstance(s, ast.ImportFrom):
            self.import_from(s)
        elif isinstance(s, ast.Return):
            self.expr(s.value, True)
        elif isinstance(s, ast.Assign):
            for t in s.targets:
                self.expr(t)
            self.expr(s.value, True)
        elif isinstance(s, ast.AnnAssign):
            self.expr(s.target)
            self.type_expr(s.annotation)
            self.expr(s.value, True)
        elif isinstance(s, ast.AugAssign):
            self.expr(s.target)
            self.expr(s.value, True)
        elif isinstance(s, ast.If) and not self.in_function and self.in_class is None and _is_main_guard(s.test):
            self.module.entry = True
            self.generic(s)
        else:
            self.generic(s)

    def import_from(self, s: ast.ImportFrom) -> None:
        module = "." * s.level + (s.module or "")
        for alias in s.names:
            if alias.name == "*":
                line = self.line_bytes[s.lineno - 1]
                m = re.compile(rb"from\s+\.*").match(line, s.col_offset)
                col = m.end() if m else s.col_offset
                self._import_site(s.lineno, col, f"from {module} import *")
            else:
                self.bound.add(alias.asname or alias.name)
                self._import_site(alias.lineno, alias.col_offset, f"from {module} import {alias.name}")

    def _visit_decorators(self, d: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) -> None:
        for dec in d.decorator_list:
            if isinstance(dec, ast.Call):
                self._site("decorate", dec, dec.func)
                route = declared(dec, self.prefixes)
                if route is not None:
                    self.sites[-1].route = {**route, "handler": d.name, "line": d.lineno}
                if isinstance(dec.func, ast.Attribute):
                    self.expr(dec.func.value)
                for a in dec.args:
                    self.expr(a, True)
                for k in dec.keywords:
                    self.expr(k.value, True)
            else:
                self._site("decorate", dec)
                if isinstance(dec, ast.Attribute):
                    self.expr(dec.value)

    def function(self, d: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        if self.in_function:
            self._visit_decorators(d)
            self.arguments(d.args)
            self.type_expr(d.returns)
            for s in d.body:
                self.stmt(s)
            return
        owner = self.in_class
        node = self._def_node(d, "method" if owner else "function")
        info = self.defs[node.id]
        receiver = None
        if owner:
            for dec in info.decorators:
                kind = METHOD_KINDS.get(dec.rsplit(".", 1)[-1])
                if kind:
                    node.method_kind = kind
                elif dec.endswith((".setter", ".deleter", ".getter")):
                    node.method_kind = "property"
            positional = [*d.args.posonlyargs, *d.args.args]
            if node.method_kind != "static" and positional:
                receiver = positional[0].arg
        node.reads, node.writes, node.global_write = variable_access(d, self.module_vars, receiver)

        saved = (self.enclosing, self.in_function, self.in_class)
        self.enclosing = node.id
        self._visit_decorators(d)
        self.arguments(d.args)
        self.type_expr(d.returns)
        self.in_function, self.in_class = True, None
        self.qual.append(d.name)
        for s in d.body:
            self.stmt(s)
        self.qual.pop()
        self.enclosing, self.in_function, self.in_class = saved

    def klass(self, d: ast.ClassDef) -> None:
        if self.in_function:
            self._visit_decorators(d)
            for b in d.bases:
                self.expr(b, True)
            for s in d.body:
                self.stmt(s)
            return
        is_data = any(name.rsplit(".", 1)[-1] == "dataclass" for name in (
            ast.unparse(dec.func if isinstance(dec, ast.Call) else dec) for dec in d.decorator_list
        )) or any(_last_name(b) in DATA_BASES for b in d.bases)
        node = self._def_node(d, "dataclass" if is_data else "class")
        info = self.defs[node.id]
        info.bases = [ast.unparse(b) for b in d.bases]
        info.fields = self._class_fields(d)
        if is_data:
            node.fields = info.fields

        saved = (self.enclosing, self.in_class)
        self.enclosing = node.id
        self._visit_decorators(d)
        for b in d.bases:
            target = b.value if isinstance(b, ast.Subscript) else b
            self._site("inherit", b, target)
            if isinstance(b, ast.Subscript):
                self.type_expr(b.slice)
        for k in d.keywords:
            self.expr(k.value, True)
        self.in_class = node
        self.qual.append(d.name)
        for s in d.body:
            self.stmt(s)
        self.qual.pop()
        self.enclosing, self.in_class = saved

    @staticmethod
    def _class_fields(d: ast.ClassDef) -> list[dict[str, str | None]]:
        fields: list[dict[str, str | None]] = []
        for s in d.body:
            if isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name):
                fields.append({"name": s.target.id, "type": ast.unparse(s.annotation)})
            elif isinstance(s, ast.Assign):
                for t in s.targets:
                    for name in _assigned_targets(t):
                        if not name.id.startswith("_"):
                            fields.append({"name": name.id, "type": None})
        return fields

    # 변수 접근

    def access(self) -> None:
        """레포의 모듈 변수와 이름이 같은 식별자가 쓰인 위치마다 읽음·바꿈 지점을 만든다.

        함수 안에서는 그 함수가 묶는 지역 이름과 지역 이름에서 시작하는 속성 접근을 건너뛴다. 다른 지점이 이미
        언어 서버에 묻는 위치에는 만들지 않는다.
        """
        found: dict[tuple[int, int], tuple[str, str, ast.Name | ast.Attribute]] = {}
        self._scan(self.tree.body, self.module.id, set(), set(), [], False, found)
        asked = {(s.request_line, s.request_col) for s in self.sites if not s.dynamic}
        for pos in sorted(found.keys() - asked):
            kind, self.enclosing, e = found[pos]
            self._site(kind, e)
        self.enclosing = self.module.id

    def _scan(
        self,
        roots: Iterable[ast.AST],
        enclosing: str,
        local: set[str],
        declared_global: set[str],
        qual: list[str],
        in_function: bool,
        found: dict[tuple[int, int], tuple[str, str, ast.Name | ast.Attribute]],
    ) -> None:
        """`roots` 아래를 훑는다. 함수 밖에서 만난 함수와 클래스는 그 정의의 노드를 `enclosing`으로 삼아 따로 훑는다."""
        stack = list(roots)
        while stack:
            node = stack.pop()
            if not in_function and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                node_id = f"{self.file.module_id}:{'.'.join([*qual, node.name])}"
                self._scan(ast.iter_child_nodes(node), node_id, *_function_names(node), qual, True, found)
            elif not in_function and isinstance(node, ast.ClassDef):
                inner = [*qual, node.name]
                node_id = f"{self.file.module_id}:{'.'.join(inner)}"
                self._scan(ast.iter_child_nodes(node), node_id, _class_names(node), set(), inner, False, found)
            else:
                self._access(node, enclosing, local, declared_global, found)
                stack.extend(ast.iter_child_nodes(node))

    def _access(
        self,
        node: ast.AST,
        enclosing: str,
        local: set[str],
        declared_global: set[str],
        found: dict[tuple[int, int], tuple[str, str, ast.Name | ast.Attribute]],
    ) -> None:
        """식 하나가 변수를 읽거나 바꾸는 위치를 `found`에 담는다. 같은 위치의 읽음과 바꿈은 바꿈으로 둔다."""
        names = self.repo_variables

        def put(kind: str, e: ast.Name | ast.Attribute) -> None:
            pos = _request_pos(e)
            if kind == "write" or pos not in found:
                found[pos] = (kind, enclosing, e)

        def free(e: ast.expr) -> bool:
            """모듈 변수와 이름이 같은 이름이거나 속성 접근의 끝 이름이고, 지역 이름에서 시작하지 않는다."""
            if isinstance(e, ast.Name):
                return e.id in names and e.id not in local
            root = _root_name(e)
            return isinstance(e, ast.Attribute) and e.attr in names and root is not None and root.id not in local

        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load):
                if free(node):
                    put("read", node)
            elif node.id in declared_global and node.id in names:
                put("write", node)
        elif isinstance(node, (ast.Attribute, ast.Subscript)):
            written = isinstance(node.ctx, (ast.Store, ast.Del))
            if free(node):
                put("write" if written else "read", node)
            inner = node.value
            while written and isinstance(inner, (ast.Name, ast.Attribute, ast.Subscript)):
                if free(inner):
                    put("write", inner)
                if isinstance(inner, ast.Name):
                    break
                inner = inner.value
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr in MUTATORS and free(func.value):
                put("write", func.value)

    def run(self) -> FileFacts:
        for s in self.tree.body:
            self.stmt(s)
        if self.repo_variables:
            self.access()
        variables = [v for v in self.variables if v.node_id not in self.defs]
        return FileFacts(self.file, self.nodes, self.defs, self.sites, variables=variables)


def defined_names(text: str) -> list[str]:
    """본문이 정의한 함수와 클래스의 이름. 함수 안에 중첩한 정의도 넣고, 문법 오류가 있거나 식이 깊은 파일은 빈 목록이다."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, RecursionError):
        return []
    defs = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
    return sorted({node.name for node in ast.walk(tree) if isinstance(node, defs)})


def assigned_names(text: str) -> list[str]:
    """본문이 모듈 수준에서 대입한 이름. 모듈 수준의 함수나 클래스와 이름이 같으면 넣지 않고, 문법 오류가 있거나 식이 깊은 파일은 빈 목록이다."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, RecursionError):
        return []
    defs = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
    defined = {stmt.name for stmt in _module_statements(tree.body) if isinstance(stmt, defs)}
    return sorted({v.name for v in module_variables(tree, "")} - defined)


def read_source(repo: RepoFiles, file: SourceFile) -> str:
    return repo.abs_path(file.path).read_bytes().decode("utf-8-sig", errors="replace")


def extract(
    file: SourceFile, text: str, repo_names: frozenset[str], repo_variables: frozenset[str] = frozenset()
) -> FileFacts:
    """`repo_names`는 레포 전체의 정의 이름이고 `repo_variables`는 레포 전체의 모듈 변수 이름이다.

    문법 오류가 있거나 식이 깊어 재귀 한도를 넘는 파일은 `error`를 적은 정의 없는 파일로 낸다.
    """
    try:
        return _Extractor(file, text, ast.parse(text, filename=file.path), repo_names, repo_variables).run()
    except SyntaxError as exc:
        error = f"{exc.msg} (줄 {exc.lineno})"
    except RecursionError:
        error = "식이 너무 깊다"
    facts = _Extractor(file, text, ast.Module(body=[], type_ignores=[]), repo_names, repo_variables).run()
    facts.error = error
    return facts


def extract_repo(repo: RepoFiles) -> list[FileFacts]:
    """레포 전체의 정의 이름과 모듈 변수 이름을 먼저 모은 뒤 파일마다 extract를 실행한다."""
    texts = {f.path: read_source(repo, f) for f in repo.files}
    repo_names = frozenset(name for text in texts.values() for name in defined_names(text))
    repo_variables = frozenset(name for text in texts.values() for name in assigned_names(text))
    return [extract(f, texts[f.path], repo_names, repo_variables) for f in repo.files]
