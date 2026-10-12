import ast

from code_atlas.collect import SourceFile
from code_atlas.extract import extract
from code_atlas.lsp import Location
from code_atlas.resolve import Index, resolve_site
from code_atlas.routes import declared, judged, prefixes

SERVICE = """\
from fastapi import APIRouter, FastAPI
from flask import Blueprint

API = "/api"
app = FastAPI()
items = APIRouter(prefix="/items")
named = APIRouter(prefix=API)
bp = Blueprint("bp", __name__, url_prefix="/shop/")
twice = APIRouter(prefix="/a")
twice = APIRouter(prefix="/b")


@app.get("/top")
def top(): ...


@items.post("/{item_id}")
@items.get("")
def item(): ...


@named.put("/x")
def under_a_named_prefix(): ...


@twice.get("/x")
def under_two_prefixes(): ...


@bp.route("/cart", methods=["get", "POST"])
def cart(): ...


@app.api_route(path="/kw", methods=METHODS)
def unread_methods(): ...


@app.delete(API + "/y")
def computed_path(): ...


@app.websocket("/ws")
def socket(): ...


@app.exception_handler(ValueError)
def not_a_route_name(): ...


@app.get
def not_a_call(): ...


def create_app():
    @app.get("/health")
    def health(): ...
"""


def routes_of(text: str) -> list[dict]:
    file = SourceFile(path="src/pkg/web.py", module_id="pkg.web", test=False, is_init=False)
    return [s.route | {"enclosing": s.enclosing} for s in extract(file, text, frozenset()).sites if s.route is not None]


def test_prefixes_come_from_router_constructors_assigned_once():
    assert prefixes(ast.parse(SERVICE)) == {"items": "/items", "named": None, "bp": "/shop/", "twice": None}


def test_decorate_sites_carry_the_declared_route():
    found = {(r["handler"], r["name"]): (r["path"], r["methods"], r["line"], r["enclosing"]) for r in routes_of(SERVICE)}
    assert found == {
        ("top", "get"): ("/top", None, 14, "pkg.web:top"),
        ("item", "post"): ("/items/{item_id}", None, 19, "pkg.web:item"),
        ("item", "get"): ("/items", None, 19, "pkg.web:item"),
        ("under_a_named_prefix", "put"): (None, None, 23, "pkg.web:under_a_named_prefix"),
        ("under_two_prefixes", "get"): (None, None, 27, "pkg.web:under_two_prefixes"),
        ("cart", "route"): ("/shop/cart", ["GET", "POST"], 31, "pkg.web:cart"),
        ("unread_methods", "api_route"): ("/kw", [], 35, "pkg.web:unread_methods"),
        ("computed_path", "delete"): (None, None, 39, "pkg.web:computed_path"),
        ("socket", "websocket"): ("/ws", None, 43, "pkg.web:socket"),
        ("health", "get"): ("/health", None, 56, "pkg.web:create_app"),
    }


def test_the_answering_package_decides_whether_a_declared_route_is_one():
    def route(name, methods=None):
        return {"name": name, "path": "/x", "methods": methods}

    assert judged(route("get"), "fastapi") == ["GET"]
    assert judged(route("websocket"), "fastapi") == ["WS"]
    assert judged(route("api_route"), "fastapi") == ["GET"]
    assert judged(route("api_route", ["GET", "POST"]), "fastapi") == ["GET", "POST"]
    assert judged(route("route", []), "flask") == []
    assert judged(route("patch"), "flask") == ["PATCH"]
    assert judged(route("route"), "starlette") == ["GET"]
    assert judged(route("get"), "starlette") is None  # starlette에는 `get` 데코레이터가 없다
    assert judged(route("head"), "flask") is None
    assert judged(route("get"), "requests") is None
    assert declared(ast.parse("x.get('/a')").body[0].value, {})["path"] == "/a"


def test_a_decorator_answered_inside_a_framework_package_is_external_to_that_package():
    file = SourceFile(path="src/pkg/web.py", module_id="pkg.web", test=False, is_init=False)
    facts = extract(file, SERVICE, frozenset())
    site = next(s for s in facts.sites if s.route is not None and s.route["handler"] == "cart")
    index = Index("/repo", [facts])
    externals = {}
    answered = resolve_site(site, [Location("/venv/lib/python3.13/site-packages/flask/sansio/scaffold.py", 336, 8)], index, externals)
    assert (answered.status, answered.target, answered.route["path"]) == ("external", "ext:flask", "/shop/cart")
    assert judged(answered.route, answered.target.removeprefix("ext:")) == ["GET", "POST"]
