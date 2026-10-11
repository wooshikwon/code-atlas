"""HTTP 경로를 메모리의 분석 결과, 언어 서버 세션, 요약 캐시, git 변경 내용에 연결하고, 빌드한 프론트엔드를 같은 포트에서 서빙한다.

세션은 lifespan이 띄워 분석에 쓴 뒤 서버가 내려갈 때 닫는다. 분석은 `app.state.starting` 태스크가 돌리고,
이 태스크를 취소하면 lifespan이 세션을 닫고 분석 결과 없이 서버가 내려가기를 기다린다.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import TypeVar

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse

from . import changes
from .analyze import Analyzed, analyze_async, require_python
from .collect import RepoFiles, collect, collected, is_test_path
from .lsp import Location, Session
from .model import Analysis, to_dict
from .resolve import EXTERNAL_PREFIX, Index, external_of
from .summary import Subject, Summaries, SummaryError, digest_of, prompt_of, range_code, range_prompt_of

HOST = "127.0.0.1"
PORT = 8766
DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"
LSP_TIMEOUT = 3.0

T = TypeVar("T")


def _tree(files: RepoFiles, analysis: Analysis) -> list[dict]:
    """수집한 파일과 그 조상 폴더로 파일 트리를 만든다. 폴더가 앞, 그 안은 이름 순서다."""
    module_of = {n.path: n.id for n in analysis.nodes if n.kind == "module"}
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
            "node": module_of.get(f.path),
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


async def _disconnected(request: Request) -> None:
    """호출자가 연결을 끊을 때까지 기다린다."""
    while (await request.receive())["type"] != "http.disconnect":
        pass


def _overlaps(span: tuple[int, int] | None, ranges: list[tuple[int, int]]) -> bool:
    return span is not None and any(start <= span[1] and span[0] <= end for start, end in ranges)


def create_app(
    repo: str | Path,
    python: str | None = None,
    on_ready: Callable[[Analysis], None] | None = None,
    style_guide: Path | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with AsyncExitStack() as sessions:

            async def start() -> tuple[Session, Analyzed]:
                files = collect(repo)
                async with AsyncExitStack() as opened:
                    session = await opened.enter_async_context(
                        Session(files.root, require_python(repo, python), files.extra_paths)
                    )
                    analyzed = await analyze_async(files, session)
                    sessions.push_async_exit(opened.pop_all())
                return session, analyzed

            app.state.starting = asyncio.create_task(start())
            try:
                session, analyzed = await app.state.starting
            except asyncio.CancelledError:
                if asyncio.current_task().cancelling():
                    raise
                yield
                return
            analysis, files = analyzed.analysis, analyzed.files
            app.state.analyzed = analyzed
            app.state.session = session
            app.state.sessions = sessions
            app.state.reopening = asyncio.Lock()
            app.state.nodes = {n.id: n for n in analysis.nodes}
            app.state.summaries = Summaries(style_guide=style_guide)
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
    app.state.starting = None

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
            return await request(await live_session())
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
        return {"path": path, "text": analyzed.texts[path]}

    @app.get("/api/hover")
    async def get_hover(path: str, line: int = Query(ge=1), col: int = Query(ge=0)) -> dict:
        hover = await ask(path, lambda session: session.hover(path, line, col, LSP_TIMEOUT))
        if hover is None:
            return {"markdown": None, "range": None}
        return {"markdown": hover.markdown, "range": hover.range}

    @app.get("/api/definition")
    async def get_definition(path: str, line: int = Query(ge=1), col: int = Query(ge=0)) -> dict:
        locations = await ask(path, lambda session: session.definition_at(path, line, col, LSP_TIMEOUT))
        return {"targets": [_target(loc, app.state.analyzed.index) for loc in locations]}

    def summarized(node_id: str) -> str:
        """노드 id를 설명을 만들 프롬프트로 바꾼다."""
        analyzed: Analyzed = app.state.analyzed
        prompt = prompt_of(app.state.nodes, analyzed.analysis.edges, analyzed.texts, node_id)
        if prompt is None:
            raise HTTPException(status_code=404, detail=f"요약할 노드가 아니다: {node_id}")
        return prompt

    @app.get("/api/summary")
    async def get_summary(node: str) -> dict:
        prompt = summarized(node)
        summaries: Summaries = app.state.summaries
        reason = await summaries.unavailable()
        return {"summary": summaries.cached(prompt), "available": reason is None, "reason": reason}

    async def made(request: Request, making: Awaitable[str]) -> str:
        """설명을 다 만들 때까지 기다린다. 호출자가 먼저 연결을 끊으면 기다리기를 그만둔다."""
        task = asyncio.ensure_future(making)
        gone = asyncio.ensure_future(_disconnected(request))
        try:
            done, _ = await asyncio.wait({task, gone}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            gone.cancel()
            task.cancel()
        if task not in done:
            raise HTTPException(status_code=499, detail="호출자가 연결을 끊었다")
        try:
            return task.result()
        except SummaryError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/api/summary")
    async def make_summary(request: Request, node: str, refresh: bool = False) -> dict:
        return {"summary": await made(request, app.state.summaries.make(summarized(node), refresh))}

    def explained(path: str, start: int, end: int) -> tuple[str, Subject]:
        """파일의 줄 범위를 설명을 만들 프롬프트와, 그 설명을 남길 대상으로 바꾼다."""
        analyzed: Analyzed = app.state.analyzed
        code = range_code(analyzed.texts, path, start, end)
        prompt = range_prompt_of(app.state.nodes, analyzed.analysis.edges, analyzed.texts, path, start, end)
        if code is None or prompt is None:
            raise HTTPException(status_code=404, detail=f"설명할 코드 범위가 아니다: {path} {start}~{end}줄")
        return prompt, Subject(app.state.repo["root"], "range", f"{path}:{start}-{end}", digest_of(code))

    @app.get("/api/explanations")
    def get_explanations(path: str) -> dict:
        """파일에 남겨 둔 코드 범위 설명. 설명을 만든 뒤 그 줄 범위의 코드가 달라졌으면 `stale`이 참이다."""
        analyzed: Analyzed = app.state.analyzed
        if path not in analyzed.texts:
            raise HTTPException(status_code=404, detail=f"분석 대상 파일이 아니다: {path}")
        found = []
        for kept in app.state.summaries.latest.listed(app.state.repo["root"], "range"):
            file, _, span = kept.name.rpartition(":")
            if file != path:
                continue
            start, end = (int(n) for n in span.split("-"))
            code = range_code(analyzed.texts, path, start, end)
            stale = code is None or digest_of(code) != kept.digest
            found.append({"start": start, "end": end, "text": kept.text, "stale": stale, "created": kept.created})
        return {"explanations": sorted(found, key=lambda e: (e["start"], e["end"]))}

    @app.post("/api/explanation")
    async def make_explanation(
        request: Request, path: str, start: int = Query(ge=1), end: int = Query(ge=1), refresh: bool = False
    ) -> dict:
        prompt, subject = explained(path, start, end)
        text = await made(request, app.state.summaries.make(prompt, refresh, "range", subject))
        return {"start": start, "end": end, "text": text, "stale": False}

    @app.delete("/api/explanation")
    def delete_explanation(path: str, start: int = Query(ge=1), end: int = Query(ge=1)) -> dict:
        app.state.summaries.latest.delete(app.state.repo["root"], "range", f"{path}:{start}-{end}")
        return {"deleted": True}

    @app.get("/api/changes")
    def get_changes() -> dict:
        analyzed: Analyzed = app.state.analyzed
        root = analyzed.files.root
        stale = analyzed.stale()
        found = changes.status(root)
        states = {path: state for path, state in (found or {}).items() if path.endswith(".py")}
        fresh = [p for p, state in states.items() if state != changes.DELETED and p not in analyzed.texts]
        for path in set(fresh) - collected(root, fresh):
            del states[path]
        ranges = (changes.hunks(root) or {}) if changes.MODIFIED in states.values() else {}
        nodes: dict[str, str] = {}
        for node in app.state.nodes.values():
            state = states.get(node.path)
            if state is None or state == changes.DELETED:
                continue
            # 파일의 노드는 늘 넣고, 그 안의 정의는 줄 범위가 분석한 본문의 것이므로 본문이 그대로일 때만 넣는다.
            if node.kind in ("module", "package") or (
                node.path not in stale
                and (state == changes.ADDED or _overlaps(node.range, ranges.get(node.path, [])))
            ):
                nodes[node.id] = state
        for path in stale:
            states.setdefault(path, changes.UNCHANGED)
        return {
            "git": found is not None,
            "branch": changes.branch(root) if found is not None else None,
            "files": [
                {"path": path, "status": state, "stale": path in stale, "test": is_test_path(path)}
                for path, state in sorted(states.items())
            ],
            "nodes": nodes,
        }

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
