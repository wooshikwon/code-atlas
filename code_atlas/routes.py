"""웹 프레임워크의 라우트 데코레이터를 알아보는 표와 그 데코레이터의 인자에서 읽는 주소·메서드.

데코레이터가 라우트인지는 언어 서버가 답한 정의의 패키지로 정한다. 받는 변수의 이름은 보지 않는다.
"""

from __future__ import annotations

import ast

WEBSOCKET = "WS"
_HTTP = {name: (name.upper(),) for name in ("get", "post", "put", "patch", "delete", "head", "options", "trace")}
# 패키지 → 데코레이터 이름 → 메서드. None은 `methods=` 인자가 정하고 인자가 없으면 GET이다.
FRAMEWORKS: dict[str, dict[str, tuple[str, ...] | None]] = {
    "fastapi": {**_HTTP, "api_route": None, "route": None, "websocket": (WEBSOCKET,), "websocket_route": (WEBSOCKET,)},
    "starlette": {"route": None, "websocket_route": (WEBSOCKET,)},
    "flask": {**{name: _HTTP[name] for name in ("get", "post", "put", "patch", "delete")}, "route": None},
}
ROUTE_NAMES = frozenset(name for names in FRAMEWORKS.values() for name in names)
# 앞 주소를 받는 라우터의 생성자 이름 → (앞 주소 인자 이름, 앞 주소와 주소 사이에 `/` 하나를 두는지)
ROUTERS: dict[str, tuple[str, bool]] = {"APIRouter": ("prefix", False), "Blueprint": ("url_prefix", True)}
_PATH_KEYWORDS = ("path", "rule")


def _keyword(call: ast.Call, name: str) -> ast.expr | None:
    return next((k.value for k in call.keywords if k.arg == name), None)


def _literal(e: ast.expr | None) -> str | None:
    return e.value if isinstance(e, ast.Constant) and isinstance(e.value, str) else None


def prefixes(tree: ast.Module) -> dict[str, str | None]:
    """파일에서 `ROUTERS`의 생성자 호출을 대입한 이름 → 앞 주소.

    앞 주소 인자가 없으면 빈 글이고, 문자열 상수가 아니거나 같은 이름에 다른 앞 주소를 대입했으면 None이다.
    """
    found: dict[str, str | None] = {}
    for stmt in ast.walk(tree):
        if not (isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name)):
            continue
        call = stmt.value
        if not isinstance(call, ast.Call) or not isinstance(call.func, (ast.Name, ast.Attribute)):
            continue
        router = ROUTERS.get(call.func.id if isinstance(call.func, ast.Name) else call.func.attr)
        if router is None:
            continue
        given = _keyword(call, router[0])
        prefix = "" if given is None else _literal(given)
        if prefix is not None and prefix != "" and router[1]:
            prefix = prefix.rstrip("/") + "/"
        name = stmt.targets[0].id
        found[name] = prefix if found.get(name, prefix) == prefix else None
    return found


def declared(dec: ast.expr, known: dict[str, str | None]) -> dict | None:
    """데코레이터가 `ROUTE_NAMES`의 이름을 속성으로 부르는 호출이면 그 이름 name, 주소 path, `methods=`의 메서드 methods.

    주소는 첫 인자나 `path=`·`rule=` 인자의 문자열 상수에 받는 이름의 앞 주소(`prefixes`가 낸 `known`)를 붙인 글이고,
    어느 하나를 읽지 못하면 None이다.
    methods는 인자가 없으면 None, 문자열 상수의 목록이 아니면 빈 목록이다.
    """
    if not (isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.func.attr in ROUTE_NAMES):
        return None
    given = dec.args[0] if dec.args else next((v for v in (_keyword(dec, k) for k in _PATH_KEYWORDS) if v is not None), None)
    path = _literal(given)
    prefix = known.get(dec.func.value.id, "") if isinstance(dec.func.value, ast.Name) else ""
    if path is not None and prefix:
        path = prefix + path.lstrip("/") if prefix.endswith("/") else prefix + path
    methods = _keyword(dec, "methods")
    listed: list[str] | None = None
    if methods is not None:
        items = methods.elts if isinstance(methods, (ast.List, ast.Tuple, ast.Set)) else []
        names = [_literal(item) for item in items]
        listed = [] if not names or None in names else [name.upper() for name in names]
    return {"name": dec.func.attr, "path": None if prefix is None else path, "methods": listed}


def judged(declared: dict, package: str) -> list[str] | None:
    """`package`의 정의로 답한 데코레이터가 라우트이면 그 메서드 목록, 아니면 None. 메서드를 읽지 못한 라우트는 빈 목록이다."""
    names = FRAMEWORKS.get(package)
    if names is None or declared["name"] not in names:
        return None
    fixed = names[declared["name"]]
    if fixed is not None:
        return list(fixed)
    return ["GET"] if declared["methods"] is None else declared["methods"]
