"""파일 하나의 ast에서 노드와 관계 후보 지점을 뽑는다.

대상을 확인하지 않는다. 지점마다 언어 서버에 정의 위치를 물을 위치만 정하고,
대상 확인과 선 조립은 resolve·graph가 맡는다.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field

from .collect import RepoFiles, SourceFile
from .model import Node, Site

DATA_BASES = {"NamedTuple", "TypedDict", "Enum", "IntEnum", "StrEnum", "Flag", "IntFlag", "BaseModel"}
METHOD_KINDS = {
    "property": "property",
    "cached_property": "property",
    "staticmethod": "static",
    "classmethod": "class",
}
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
class FileFacts:
    file: SourceFile
    nodes: list[Node]
    defs: dict[str, DefInfo]
    sites: list[Site]
    error: str | None = None


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


def _assigned_names(target: ast.expr) -> list[str]:
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [n for el in target.elts for n in _assigned_names(el)]
    if isinstance(target, ast.Starred):
        return _assigned_names(target.value)
    return []


def module_variables(tree: ast.Module) -> set[str]:
    """모듈 최상위에서 대입한 이름. 함수·클래스 본문은 들어가지 않는다."""
    names: set[str] = set()
    stack: list[ast.stmt] = list(tree.body)
    while stack:
        stmt = stack.pop()
        if isinstance(stmt, ast.Assign):
            names.update(n for t in stmt.targets for n in _assigned_names(t))
        elif isinstance(stmt, (ast.AnnAssign, ast.AugAssign)):
            names.update(_assigned_names(stmt.target))
        elif isinstance(stmt, (ast.For, ast.AsyncFor)):
            names.update(_assigned_names(stmt.target))
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        for child in ast.iter_child_nodes(stmt):
            if isinstance(child, ast.stmt):
                stack.append(child)
            elif isinstance(child, ast.ExceptHandler):
                stack.extend(child.body)
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


def variable_access(
    fn: ast.FunctionDef | ast.AsyncFunctionDef, module_vars: set[str], receiver: str | None
) -> tuple[list[str], list[str], bool]:
    """함수 본문이 읽고 바꾸는 모듈 변수와 receiver 속성, `global` 선언 여부를 구한다."""
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
    def __init__(self, file: SourceFile, text: str, tree: ast.Module, repo_names: frozenset[str]):
        self.file = file
        self.lines = text.splitlines()
        self.line_bytes = [line.encode() for line in self.lines]
        self.tree = tree
        self.repo_names = repo_names
        self.bound: set[str] = set()
        self.module_vars = module_variables(tree)
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
        f = self.file
        kind = "package" if f.is_init and f.module_id != "__init__" else "module"
        node = Node(
            id=f.module_id,
            kind=kind,
            name=f.module_id.rsplit(".", 1)[-1],
            parent=f.module_id.rsplit(".", 1)[0] if "." in f.module_id else None,
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
            id=f"{self.module.id}:{qual}",
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
            )
        )

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
                    for name in _assigned_names(t):
                        if not name.startswith("_"):
                            fields.append({"name": name, "type": None})
        return fields

    def run(self) -> FileFacts:
        for s in self.tree.body:
            self.stmt(s)
        return FileFacts(self.file, self.nodes, self.defs, self.sites)


def _top_level_names(tree: ast.Module) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
    return names


def read_source(repo: RepoFiles, file: SourceFile) -> str:
    return repo.abs_path(file.path).read_bytes().decode("utf-8-sig", errors="replace")


def extract(file: SourceFile, text: str, repo_names: frozenset[str]) -> FileFacts:
    try:
        tree = ast.parse(text, filename=file.path)
    except SyntaxError as exc:
        empty = ast.Module(body=[], type_ignores=[])
        facts = _Extractor(file, text, empty, repo_names).run()
        facts.error = f"{exc.msg} (줄 {exc.lineno})"
        return facts
    return _Extractor(file, text, tree, repo_names).run()


def extract_repo(repo: RepoFiles) -> list[FileFacts]:
    """레포 전체 정의 이름을 먼저 모은 뒤 파일마다 extract를 실행한다."""
    texts = {f.path: read_source(repo, f) for f in repo.files}
    names: set[str] = set()
    for f in repo.files:
        try:
            names |= _top_level_names(ast.parse(texts[f.path]))
        except SyntaxError:
            pass
    repo_names = frozenset(names)
    return [extract(f, texts[f.path], repo_names) for f in repo.files]
