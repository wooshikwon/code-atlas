"""HTTP 경로를 메모리의 분석 결과, 언어 서버 세션, 요약 캐시에 연결하고, 빌드한 프론트엔드를 같은 포트에서 서빙한다.

세션은 lifespan이 띄워 분석에 쓴 뒤 서버가 내려갈 때 닫는다.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import TypeVar

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse

from .analyze import Analyzed, analyze_async, require_python
from .collect import RepoFiles, collect
from .lsp import Location, Session
from .model import Analysis, to_dict
from .resolve import EXTERNAL_PREFIX, Index, external_of
from .summary import KIND_NAMES, Summaries, SummaryError, outline

HOST = "127.0.0.1"
PORT = 8766
DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"
LSP_TIMEOUT = 3.0

T = TypeVar("T")


def _tree(files: RepoFiles, analysis: Analysis) -> list[dict]:
    """수집한 파일과 그 조상 폴더로 파일 트리를 만든다. 폴더가 앞, 그 안은 이름 순서다."""
    node_ids = {n.id for n in analysis.nodes}
    package_of = {n.path: n.id for n in analysis.nodes if n.kind == "package" and n.path}
    root: dict = {"children": {}}
    for f in files.files:
        parts = f.path.split("/")
        current = root
        for i, name in enumerate(parts[:-1]):
            path = "/".join(parts[: i + 1])
            init = path + "/__init__.py"
            current = current["children"].setdefault(
                name,
                {
                    "path": path,
                    "name": name,
                    "kind": "dir",
                    "test": f.test,
                    "node": package_of.get(path, package_of.get(init)),
                    "children": {},
                },
            )
            current["test"] = current["test"] and f.test
        current["children"][parts[-1]] = {
            "path": f.path,
            "name": parts[-1],
            "kind": "file",
            "test": f.test,
            "node": f.module_id if f.module_id in node_ids else None,
        }
    return _entries(root["children"])


def _entries(children: dict) -> list[dict]:
    ordered = sorted(children.values(), key=lambda e: (e["kind"] != "dir", e["name"]))
    return [{**e, "children": _entries(e["children"])} if e["kind"] == "dir" else e for e in ordered]


def _target(loc: Location, index: Index) -> dict:
    """정의 위치 하나를 응답 항목으로 바꾼다. 분석 대상 파일이면 노드 id를, 그 밖이면 외부 모듈 id를 넣는다."""
    rel = index.relative(loc.path)
    node = index.enclosing(rel, loc.line, loc.col) if rel is not None else None
    if node is not None:
        return {"path": rel, "line": loc.line, "col": loc.col, "node": node, "external": None}
    external = external_of(loc.path)
    return {
        "path": None,
        "line": loc.line,
        "col": loc.col,
        "node": None,
        "external": EXTERNAL_PREFIX + external[0] if external else None,
    }


def create_app(
    repo: str | Path, python: str | None = None, on_ready: Callable[[Analysis], None] | None = None
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        files = collect(repo)
        async with AsyncExitStack() as sessions:
            session = await sessions.enter_async_context(
                Session(files.root, require_python(repo, python), files.extra_paths)
            )
            analyzed = await analyze_async(files, session)
            analysis = analyzed.analysis
            app.state.analyzed = analyzed
            app.state.session = session
            app.state.sessions = sessions
            app.state.reopening = asyncio.Lock()
            app.state.nodes = {n.id: n for n in analysis.nodes}
            app.state.summaries = Summaries()
            await app.state.summaries.unavailable()
            app.state.repo = {
                "name": files.root.name,
                "root": str(files.root),
                "source_root": files.source_root,
                "python": session.python,
                "stats": analysis.stats,
            }
            app.state.tree = {"entries": _tree(files, analysis)}
            app.state.graph = {
                "nodes": [to_dict(n) for n in analysis.nodes],
                "edges": [to_dict(e) for e in analysis.edges],
            }
            if on_ready is not None:
                on_ready(analysis)
            yield

    app = FastAPI(title="code-atlas", lifespan=lifespan)

    async def live_session() -> Session:
        """세션이 멈췄으면 새 세션을 열어 바꾼다. 함께 들어온 요청은 한 번만 다시 연다."""
        state = app.state
        async with state.reopening:
            if state.session.stopped:
                analyzed: Analyzed = state.analyzed
                session = await state.sessions.enter_async_context(
                    Session(analyzed.files.root, state.session.python, analyzed.files.extra_paths)
                )
                session.open_files(analyzed.texts)
                await session.wait_ready(analyzed.probe)
                state.session = session
        return state.session

    async def ask(path: str, request: Callable[[Session], Awaitable[T]]) -> T:
        if path not in app.state.analyzed.texts:
            raise HTTPException(status_code=404, detail=f"분석 대상 파일이 아니다: {path}")
        try:
            session = await live_session()
            return await asyncio.wait_for(request(session), LSP_TIMEOUT)
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"언어 서버가 응답하지 않는다: {exc!r}") from exc

    @app.exception_handler(HTTPException)
    def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    @app.get("/api/repo")
    def get_repo() -> dict:
        return app.state.repo

    @app.get("/api/tree")
    def get_tree() -> dict:
        return app.state.tree

    @app.get("/api/graph")
    def get_graph() -> dict:
        return app.state.graph

    @app.get("/api/file")
    def get_file(path: str) -> dict:
        analyzed: Analyzed = app.state.analyzed
        if path not in analyzed.texts:
            raise HTTPException(status_code=404, detail=f"분석 대상 파일이 아니다: {path}")
        text = analyzed.files.abs_path(path).read_bytes().decode("utf-8-sig", errors="replace")
        return {"path": path, "text": text}

    @app.get("/api/hover")
    async def get_hover(path: str, line: int = Query(ge=1), col: int = Query(ge=0)) -> dict:
        hover = await ask(path, lambda session: session.hover(path, line, col))
        if hover is None:
            return {"markdown": None, "range": None}
        return {"markdown": hover.markdown, "range": hover.range}

    @app.get("/api/definition")
    async def get_definition(path: str, line: int = Query(ge=1), col: int = Query(ge=0)) -> dict:
        locations = await ask(path, lambda session: session.definition_at(path, line, col))
        return {"targets": [_target(loc, app.state.analyzed.index) for loc in locations]}

    def summarized(node_id: str) -> tuple[str, str, str]:
        """노드 id를 요약에 넘길 종류, 이름, 코드로 바꾼다. 파일은 문서 문자열과 시그니처 목록을, 그 밖의 노드는 자기 줄 범위를 넘긴다."""
        node = app.state.nodes.get(node_id)
        text = app.state.analyzed.texts.get(node.path) if node is not None and node.kind in KIND_NAMES else None
        if text is None:
            raise HTTPException(status_code=404, detail=f"요약할 노드가 아니다: {node_id}")
        if node.kind == "module":
            return node.kind, node.path, outline(text)
        start, end = node.range
        return node.kind, node.id.partition(":")[2], "\n".join(text.splitlines()[start - 1 : end])

    @app.get("/api/summary")
    async def get_summary(node: str) -> dict:
        _, _, code = summarized(node)
        summaries: Summaries = app.state.summaries
        reason = await summaries.unavailable()
        return {"summary": summaries.cached(code), "available": reason is None, "reason": reason}

    @app.post("/api/summary")
    async def make_summary(node: str, refresh: bool = False) -> dict:
        kind, name, code = summarized(node)
        try:
            return {"summary": await app.state.summaries.make(kind, name, code, refresh)}
        except SummaryError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.get("/{path:path}", include_in_schema=False)
    def get_static(path: str) -> FileResponse:
        """dist 안의 파일을 돌려주고, 파일이 아닌 경로는 index.html로 넘긴다. /api 아래는 넘기지 않는다."""
        index = DIST_DIR / "index.html"
        if path == "api" or path.startswith("api/") or not index.is_file():
            raise HTTPException(status_code=404, detail=f"없는 경로다: /{path}")
        target = (DIST_DIR / path).resolve()
        if target.is_file() and target.is_relative_to(DIST_DIR.resolve()):
            return FileResponse(target)
        return FileResponse(index)

    return app
