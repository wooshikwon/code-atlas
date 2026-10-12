"""HTTP 경로를 메모리의 분석 결과와 미사용 후보, 언어 서버 세션, 요약 캐시, git 변경 내용, 시점 비교에 연결하고, 빌드한 프론트엔드를 같은 포트에서 서빙한다.

서버는 레포 하나를 열어 두거나 연 레포 없이 뜬다. 연 레포에 묶인 상태는 `Workspace` 하나에 모여 있고, `POST /api/open`과
`POST /api/close`가 앞의 레포에 묶인 태스크와 세션을 닫은 뒤 그 객체를 통째로 바꾸며 `session`을 센다. 고른 폴더의
판정은 `opening`이, 연 레포의 목록은 `settings`가, `claude`·`git`·인터프리터를 찾는 일은 `tools`가 맡는다.

서버는 분석을 기다리지 않고 뜬다. 레포를 열면 `Runner`로 분석 태스크를 띄우고, 태스크가 낸 결과를 `install` 한 곳에서
응답이 읽는 상태에 넣으며 판 번호를 센다. 결과가 없는 동안 `/api/status`가 단계와 진행 수를 알리고 분석 결과를 읽는
경로는 503을, 연 레포가 없으면 409를 낸다. `POST /api/reload`는 앞의 결과에서 증분으로 다시 분석한다. 세션과 분석
캐시는 `Runner`가 맡고 레포를 닫을 때와 서버가 내려갈 때 닫는다.

시점 비교는 두 시점의 이름(커밋 해시나 `worktree`)을 받아 기준과 대상을 정리하고, 비교 태스크 하나가 `Snapshots`로 과거
시점을 분석한 뒤 `compare.compare`의 판정을 응답으로 만든다. 요약 경로는 마지막 비교의 대상이 커밋인 동안 그 시점의
분석 결과를 읽는다. 판정 규칙과 git 출력의 형식은 모른다.
"""

from __future__ import annotations

import asyncio
import json
import platform
import re
import threading
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import asdict, astuple, dataclass, field, replace
from functools import partial
from importlib import metadata
from pathlib import Path
from typing import TypeVar

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from . import compare, git, opening, shellenv, tools
from .analyze import Analyzed, Progress
from .collect import RepoFiles, SourceFile, any_source, collected, disk_path, is_test_path, module_id
from .extract import FileFacts, extract
from .lsp import Location, Session, to_utf8
from .model import Analysis, Node, to_dict
from .resolve import EXTERNAL_PREFIX, external_of
from .runner import Runner
from .settings import Settings
from .snapshot import Snapshots
from .summary import (
    MAX_QUESTION,
    Made,
    Subject,
    Summaries,
    SummaryError,
    answering,
    asked_name,
    compared_name,
    compared_spans,
    digest_of,
    lead_of,
    prompt_of,
    range_code,
    range_prompt_of,
)

HOST = "127.0.0.1"
PORT = 8766
DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"
# 빌드 명령이 앱에 묶은 `code_atlas` 옆에 적는 파일. 레포의 커밋 해시 `commit`과 빌드한 날 `built`가 들어 있다.
BUILD_FILE = Path(__file__).with_name("_build.json")
LSP_TIMEOUT = 3.0
# `/api/status`가 분석 뒤 바뀐 파일을 다시 세기까지 앞의 값을 돌려주는 시간. 한 번 세는 데 파일 251개인 레포에서 13ms,
# 1,033개에서 44ms, 2,141개(다른 파일도 많은 torch 폴더)에서 0.33초가 들었다. 1초에 한 번으로 묶으면 가장 큰 경우에도
# 세는 일이 스레드 하나의 3분의 1을 넘지 않고, 화면이 2초 안쪽 주기로 물을 때 저장한 뒤 3초 안에 수가 바뀐다.
STALE_MEMO = 1.0
STALE_LISTED = 5  # `stale.paths`에 싣는 경로 수. 화면의 말풍선이 이름 다섯 개와 "외 k개"를 적는다

NOT_STALE: dict = {"count": 0, "paths": []}
HISTORY_PAGE = 200  # `/api/history`가 한 번에 내는 줄 수의 기본값
_HASH = re.compile(r"[0-9a-f]{40}")

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


def _target(loc: Location, analyzed: Analyzed, nodes: dict[str, Node]) -> dict:
    """정의 위치 하나를 응답 항목으로 바꾼다. 분석 대상 파일이면 노드 id를, 그 밖이면 외부 모듈 id를 넣는다.

    위치가 변수 노드의 대입 대상이면 그 변수 노드 id를, 그 밖의 위치는 그 위치를 품은 가장 안쪽 노드 id를 넣는다.
    """
    index = analyzed.index
    rel = index.relative(loc.path)
    node = index.enclosing(rel, loc.line, loc.col) if rel is not None else None
    if node is not None:
        lines = analyzed.texts[rel].splitlines()
        if loc.line <= len(lines):
            named = index.names.get((rel, loc.line, to_utf8(lines[loc.line - 1], loc.col)))
            if named in nodes and nodes[named].kind == "variable":
                node = named
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


class Ends(BaseModel):
    """`POST /api/compare`의 본문. `/api/compare/stat`이 돌려준 기준과 대상이다."""

    base: str
    target: str


def _facts(analyzed: Analyzed) -> dict[str, FileFacts]:
    return {path: stored.facts for path, stored in analyzed.stored.items()}


def _counted(hunks: dict[str, list[git.Hunk]]) -> tuple[int, int]:
    """토막의 추가된 줄 수와 삭제된 줄 수의 합."""
    found = [h for file in hunks.values() for h in file]
    return sum(h.new_count for h in found), sum(h.old_count for h in found)


def _change(change: compare.NodeChange) -> dict:
    found: dict = {"change": change.change, "added": change.added, "deleted": change.deleted}
    if change.slot is not None:
        found["slot"] = change.slot
    if change.only is not None:
        found["only"] = change.only
    return found


@dataclass
class Workspace:
    """연 레포 하나에 묶인 상태. 레포를 열 때 새로 만들고 닫을 때 통째로 버린다."""

    runner: Runner
    running: asyncio.Task | None = None  # 분석 태스크
    closed: bool = False
    revision: int = 0
    draft: bool = False
    analyzed: Analyzed | None = None
    nodes: dict[str, Node] = field(default_factory=dict)
    repo: dict | None = None
    tree: dict | None = None
    graph: dict | None = None
    unused: dict | None = None
    stale: tuple[Analyzed | None, float, dict] = (None, 0.0, NOT_STALE)
    snapshots: Snapshots | None = None  # 첫 비교가 만드는 `Snapshots`
    comparing: tuple[tuple[str, str], asyncio.Task] | None = None  # ((기준, 대상), 비교 태스크)
    compare: Progress | None = None  # 비교할 시점을 분석하는 단계와 진행 수
    compared: tuple[tuple, bytes] | None = None  # (기준, 대상, 판 번호, 바뀐 파일, 토막, 분석 뒤 바뀐 파일)과 그 응답
    shown: tuple[str, Analyzed, dict[str, Node]] | None = None  # 마지막 비교의 대상이 커밋이면 (커밋 해시, 분석 결과, 노드)
    seen: set[str] = field(default_factory=set)  # 이 레포를 연 동안 비교에 쓴 커밋
    # (`HEAD` 해시, 경로) → 그 커밋의 추출 결과와 본문
    heads: dict[tuple[str, str], tuple[FileFacts, str] | None] = field(default_factory=dict)


class Folder(BaseModel):
    """`POST /api/probe`의 본문."""

    path: str


class Chosen(BaseModel):
    """`PUT /api/tools/{tool}`의 본문. 사용자가 직접 고른 실행 파일의 경로다."""

    path: str


class Opening(BaseModel):
    """`POST /api/open`의 본문. `python`은 인터프리터를 고르는 화면에서 고른 경로다."""

    path: str
    python: str | None = None


def create_app(
    repo: str | Path | None = None,
    python: str | None = None,
    on_ready: Callable[[Analysis], None] | None = None,
    style_guide: Path | None = None,
    cache: bool = True,
    settings: Settings | None = None,
    origin: str | None = None,
) -> FastAPI:
    """앱을 만든다. `repo`를 주지 않으면 연 레포 없이 뜬다. `on_ready`는 레포마다 첫 분석 결과가 나올 때 한 번 불린다.

    `cache`가 거짓이면 `repo`의 첫 분석이 캐시를 읽지 않는다. `settings`를 주지 않으면 연 레포의 목록을 읽지도 쓰지도
    않는다. `origin`을 주면 그 출처의 화면이 보내는 요청을 받는다.
    """

    def install(state: Workspace, analyzed: Analyzed, draft: bool) -> None:
        """분석 결과를 응답이 읽는 상태에 한꺼번에 넣고 판 번호를 1 늘린다. 응답이 쓰는 분석 결과는 이 함수만 바꾼다."""
        analysis, files = analyzed.analysis, analyzed.files
        state.analyzed = analyzed
        state.nodes = {n.id: n for n in analysis.nodes}
        state.repo = {
            "name": files.root.name,
            "root": str(files.root),
            "source_root": files.source_root,
            "python": state.runner.python,
            "stats": analysis.stats,
        }
        state.tree = {"entries": _tree(files, analysis)}
        state.graph = {
            "nodes": [to_dict(n) for n in analysis.nodes],
            "edges": [to_dict(e) for e in analysis.edges],
        }
        state.unused = to_dict(analyzed.unused)
        state.draft = draft
        state.stale = (analyzed, 0.0, NOT_STALE)
        state.revision += 1
        if state.revision == 1 and on_ready is not None:
            on_ready(analysis)

    async def begin(state: Workspace) -> None:
        """레포를 연 뒤의 첫 분석. 캐시로 조립한 결과가 먼저 나오면 그 결과를 넣고, 다시 물은 뒤의 결과로 한 번 더 바꾼다."""
        await state.runner.run(landed=partial(install, state))
        await app.state.summaries.unavailable()

    async def reload(state: Workspace) -> None:
        """앞의 결과에서 증분으로 다시 분석해 결과를 바꾼다. 분석이 끝날 때까지 앞의 결과로 답한다."""
        await state.runner.run(state.analyzed, partial(install, state))

    def start(state: Workspace, chosen: str | None = None) -> None:
        """레포의 첫 분석을 띄우고 연 레포의 목록에 적는다. `chosen`은 사용자가 직접 고른 인터프리터이고 그 레포의 값으로 저장한다."""
        state.running = asyncio.create_task(begin(state))
        # 실패한 까닭은 `/api/status`가 알린다.
        state.running.add_done_callback(lambda task: task.cancelled() or task.exception())
        if settings is not None:
            settings.opened(disk_path(state.runner.repo), chosen)

    async def shut(state: Workspace) -> None:
        """레포에 묶인 분석 태스크와 비교 태스크를 멈추고 시점 분석, 세션, 분석 캐시를 닫는다."""
        state.closed = True
        tasks = [task for task in (state.running, state.comparing and state.comparing[1]) if task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if state.snapshots is not None:
            state.snapshots.close()
        await state.runner.close()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.summaries = Summaries(style_guide=style_guide)
        if app.state.workspace is not None:
            start(app.state.workspace)
        try:
            yield
        finally:
            async with switching:
                closing = [app.state.summaries.close()]
                if app.state.workspace is not None:
                    closing.append(shut(app.state.workspace))
                await asyncio.gather(*closing)

    app = FastAPI(title="code-atlas", lifespan=lifespan)
    if origin is not None:
        app.add_middleware(CORSMiddleware, allow_origins=[origin], allow_methods=["*"], allow_headers=["*"])
    app.state.workspace = Workspace(Runner(repo, python, cache)) if repo is not None else None
    app.state.session = 1  # 레포를 열거나 닫을 때마다 1씩 는다
    switching = asyncio.Lock()  # 열기와 닫기의 차례
    counting = threading.Lock()

    def analysed() -> Workspace:
        """분석 결과를 읽는 경로의 공통 의존 함수. 연 레포를 돌려준다. 연 레포가 없으면 409를, 결과가 아직 없으면 503을 낸다."""
        state = opened()
        if state.revision == 0:
            raise HTTPException(status_code=503, detail="분석 중입니다")
        return state

    def opened() -> Workspace:
        state = app.state.workspace
        if state is None:
            raise HTTPException(status_code=409, detail="연 레포가 없습니다")
        return state

    ready = Depends(analysed)

    def stale(state: Workspace) -> dict:
        """지금 판을 분석한 뒤 내용이 바뀐 파일, 생긴 파일, 없어진 파일의 수와 앞의 경로 `STALE_LISTED`개.

        `STALE_MEMO`초 안에 다시 물으면 앞의 값을 돌려준다. 수정 시각과 크기가 그대로인 파일은 읽지 않는다.
        """
        with counting:
            analyzed, counted, found = state.stale
            if analyzed is None or time.monotonic() - counted < STALE_MEMO:
                return found
            try:
                paths = sorted(analyzed.stale())
            except OSError:
                return found
            found = {"count": len(paths), "paths": paths[:STALE_LISTED]}
            if state.stale[0] is analyzed:
                state.stale = (analyzed, time.monotonic(), found)
            return found

    def shown(state: Workspace) -> tuple[Analyzed, dict[str, Node]]:
        """지금 보이는 시점의 분석 결과와 노드. 마지막 비교의 대상이 커밋이면 그 시점이고 그 밖에는 작업 중인 상태다."""
        held = state.shown
        return (held[1], held[2]) if held is not None else (state.analyzed, state.nodes)

    async def ask(state: Workspace, path: str, request: Callable[[Session], Awaitable[T]]) -> T:
        if path not in state.analyzed.texts:
            raise HTTPException(status_code=404, detail=f"분석 대상 파일이 아닙니다: {path}")
        try:
            return await request(await state.runner.session())
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"언어 서버가 응답하지 않습니다: {exc!r}") from exc

    @app.exception_handler(HTTPException)
    def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    @app.get("/api/status")
    def get_status() -> dict:
        """분석의 단계와 진행 수, 결과 판 번호, 언어 서버의 상태, 지금 판을 분석한 뒤 바뀐 파일, 레포를 열고 닫은 횟수.

        연 레포가 없으면 단계가 idle이다.
        """
        state = app.state.workspace
        if state is None:
            progress, lsp, error = Progress("idle"), "starting", None
        else:
            progress, lsp, error = state.runner.progress, state.runner.lsp, state.runner.error
        return {
            "phase": progress.phase,
            "done": progress.done,
            "total": progress.total,
            "revision": state.revision if state is not None else 0,
            "draft": state is not None and state.draft,
            "lsp": lsp,
            "error": error,
            "stale": stale(state) if state is not None else NOT_STALE,
            "compare": asdict(state.compare) if state is not None and state.compare is not None else None,
            "session": app.state.session,
        }

    @app.get("/api/about")
    def get_about() -> dict:
        """이 서버의 판. 앱에 묶인 실행이면 빌드한 레포의 커밋 해시와 빌드한 날이 있고, 그 밖에는 둘 다 없다."""
        try:
            build = json.loads(BUILD_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            build = {}
        return {
            "commit": build.get("commit"),
            "built": build.get("built"),
            "python": platform.python_version(),
            "basedpyright": metadata.version("basedpyright"),
        }

    @app.post("/api/probe")
    async def post_probe(folder: Folder) -> dict:
        """고른 폴더를 레포로 열기 전의 판정. 폴더를 읽지 못하면 까닭을 적은 400이다."""
        tools.fresh(tools.PYTHON.name)
        try:
            return asdict(await asyncio.to_thread(opening.probe, folder.path, settings))
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"폴더를 읽지 못했습니다: {exc}") from exc

    def openable(target: Opening) -> tuple[Path, str]:
        """열 폴더의 루트와 확인을 통과한 인터프리터. 열지 못하는 폴더와 인터프리터는 까닭을 적은 400이다."""
        root = disk_path(Path(target.path).expanduser())
        try:
            if not root.is_dir():
                raise HTTPException(status_code=400, detail=f"폴더가 없습니다: {root}")
            if not any_source(root):
                raise HTTPException(status_code=400, detail=f"파이썬 파일이 없는 폴더는 열지 못합니다: {root}")
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"폴더를 읽지 못했습니다: {exc}") from exc
        tools.fresh(tools.PYTHON.name)
        found = tools.python(root, target.python, settings)
        if target.python is not None and found.source != tools.SAVED:
            reason = next((attempt.detail for attempt in found.attempts if attempt.source == tools.SAVED), "실행하지 못했습니다")
            raise HTTPException(status_code=400, detail=f"Python 인터프리터가 아닙니다: {target.python} ({reason})")
        if found.path is None:
            raise HTTPException(status_code=400, detail=f"{root.name}의 Python 인터프리터를 찾지 못했습니다")
        return root, found.path

    @app.post("/api/open")
    async def post_open(target: Opening) -> dict:
        """폴더를 레포로 연다. 앞의 레포를 닫은 뒤 새 레포의 첫 분석을 띄우고, 분석을 기다리지 않고 응답한다.

        폴더가 없거나 `.py` 파일이 없거나 인터프리터가 확인을 통과하지 못하면 앞의 레포를 그대로 두고 까닭을 적은 400을 낸다.
        `python`은 확인을 통과하면 그 레포의 인터프리터로 저장한다.
        """
        async with switching:
            root, python = await asyncio.to_thread(openable, target)
            if app.state.workspace is not None:
                await shut(app.state.workspace)
            app.state.workspace = Workspace(Runner(root, python))
            start(app.state.workspace, python if target.python is not None else None)
            app.state.session += 1
            return {"session": app.state.session}

    @app.post("/api/close")
    async def post_close() -> dict:
        """연 레포를 닫는다. 그 레포에 묶인 태스크와 세션이 끝난 뒤에 응답한다."""
        async with switching:
            await shut(opened())
            app.state.workspace = None
            app.state.session += 1
            return {"session": app.state.session}

    @app.get("/api/repos")
    def get_repos() -> dict:
        """연 적이 있는 레포. 마지막으로 연 레포가 앞이고, 폴더가 없어진 레포는 `exists`가 거짓이다."""
        found = settings.repos() if settings is not None else []
        return {
            "repos": [
                {"root": r.root, "name": Path(r.root).name, "python": r.python, "opened": r.opened, "exists": Path(r.root).is_dir()}
                for r in found
            ]
        }

    @app.delete("/api/repos")
    def delete_repo(root: str) -> dict:
        if settings is not None:
            settings.forget(root)
        return {"deleted": True}

    def found_tools() -> dict:
        """로그인 셸에서 읽은 환경의 결과와 `claude`, `git`, 연 레포의 인터프리터를 찾은 결과."""
        state: Workspace | None = app.state.workspace
        shell = shellenv.last
        return {
            "shell": {k: v for k, v in asdict(shell).items() if k != "env"} if shell is not None else None,
            "claude": asdict(tools.claude(settings)),
            "git": asdict(tools.git(settings)),
            "python": asdict(tools.python(Path(state.runner.repo), state.runner.python, settings)) if state is not None else None,
        }

    def named(tool: str) -> Callable[[Settings | None], tools.Found]:
        """직접 고르는 도구를 찾는 함수. 그 밖의 이름은 404다."""
        finders = {tools.CLAUDE.name: tools.claude, tools.GIT.name: tools.git}
        if tool not in finders:
            raise HTTPException(status_code=404, detail=f"직접 고르는 도구가 아닙니다: {tool}")
        return finders[tool]

    @app.get("/api/tools")
    def get_tools() -> dict:
        return found_tools()

    @app.post("/api/tools/check")
    def check_tools() -> dict:
        """찾아 둔 값을 버리고 다시 찾는다."""
        tools.fresh()
        return found_tools()

    @app.post("/api/tools/claude/ask")
    async def ask_claude() -> dict:
        """`claude -p`가 답하는지 요청 하나로 확인한다. 화면의 `응답 확인`을 누를 때만 부른다."""
        ok, seconds, detail = await answering()
        return {"ok": ok, "seconds": seconds, "detail": detail}

    @app.put("/api/tools/{tool}")
    def put_tool(tool: str, chosen: Chosen):
        """직접 고른 실행 파일을 확인 명령으로 실행해 통과하면 저장한다. 통과하지 못하면 시도 기록을 적은 400이다."""
        find = named(tool)
        if settings is None:
            raise HTTPException(status_code=400, detail="설정 파일을 쓰지 않는 실행이라 경로를 저장하지 못합니다")
        tried = tools.attempt(tool, chosen.path)
        if not tried.ok:
            return JSONResponse(
                status_code=400,
                content={"error": f"실행하지 못했습니다: {tried.path} ({tried.detail})", "code": tried.code, "attempt": asdict(tried)},
            )
        settings.keep_tool(tool, tried.path)
        tools.fresh(tool)
        return asdict(find(settings))

    @app.delete("/api/tools/{tool}")
    def delete_tool(tool: str) -> dict:
        """저장한 경로를 지우고 다시 찾는다."""
        find = named(tool)
        if settings is not None:
            settings.keep_tool(tool, None)
        tools.fresh(tool)
        return asdict(find(settings))

    @app.get("/api/interpreters")
    def get_interpreters() -> dict:
        """인터프리터를 고르는 화면의 후보."""
        return {"found": [asdict(found) for found in tools.interpreters()]}

    @app.get("/api/repo")
    def get_repo(state: Workspace = ready) -> dict:
        return state.repo

    @app.post("/api/reload")
    async def post_reload(state: Workspace = Depends(opened)) -> dict:
        """레포를 다시 분석하고 새 `/api/repo` 값을 돌려준다. 분석하는 중에 들어온 요청은 그 분석이 끝나기를 함께 기다린다.

        분석하지 못하면 앞의 분석 결과를 그대로 두고 까닭을 적은 500을 돌려준다. 첫 분석이 실패해 결과가 없으면 첫 분석을 다시 한다.
        기다리는 동안 레포를 닫으면 409를 돌려준다.
        """
        if state.closed:
            raise HTTPException(status_code=409, detail="레포를 닫았습니다")
        if state.revision == 0:
            if not state.running.done():
                analysed()
            state.runner.progress = Progress("collect")
            state.running = asyncio.create_task(begin(state))
        elif state.running.done():
            state.running = asyncio.create_task(reload(state))
        running = state.running
        try:
            await asyncio.shield(running)
        except asyncio.CancelledError:
            if not running.cancelled():
                raise
            raise HTTPException(status_code=409, detail="레포를 닫아 분석을 멈췄습니다") from None
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"다시 분석하지 못했습니다: {exc}") from exc
        return state.repo

    @app.get("/api/tree")
    def get_tree(state: Workspace = ready) -> dict:
        return state.tree

    @app.get("/api/graph")
    def get_graph(state: Workspace = ready) -> dict:
        """작업 중인 상태의 그래프. 화면이 비교를 끄고 이 그래프로 돌아오므로 지금 보이는 시점도 작업 중인 상태로 되돌린다."""
        state.shown = None
        return state.graph

    @app.get("/api/file")
    async def get_file(path: str, at: str | None = None, state: Workspace = ready) -> dict:
        """분석할 때 읽은 본문. `at`이 커밋 해시면 그 커밋의 본문이고, 이번 실행에서 비교에 쓴 커밋만 받는다."""
        if at is None or at == git.WORKTREE:
            analyzed: Analyzed = state.analyzed
        elif at not in state.seen:
            raise HTTPException(status_code=404, detail=f"비교에 쓴 커밋이 아닙니다: {at}")
        else:
            analyzed = snapshots(state).held(at) or await snapshots(state).at(at, [state.analyzed])
        if path not in analyzed.texts:
            raise HTTPException(status_code=404, detail=f"분석 대상 파일이 아닙니다: {path}")
        return {"path": path, "text": analyzed.texts[path]}

    def snapshots(state: Workspace) -> Snapshots:
        if state.closed:
            raise HTTPException(status_code=409, detail="레포를 닫았습니다")
        if state.snapshots is None:
            state.snapshots = Snapshots(state.analyzed.files.root, state.runner.python, state.runner.cache)
        return state.snapshots

    def moment(name: str) -> str:
        """시점의 이름(40자 커밋 해시나 `worktree`)인지 확인한다."""
        if name != git.WORKTREE and _HASH.fullmatch(name) is None:
            raise HTTPException(status_code=400, detail=f"시점의 이름이 아닙니다: {name}")
        return name

    def versioned(state: Workspace, *moments: str) -> tuple[Path, str]:
        """레포 루트와 지금 커밋의 해시. 커밋이 있는 git 저장소가 아니거나 `moments`의 커밋이 없으면 404를 낸다."""
        root = state.analyzed.files.root
        head = git.head(root)
        if head is None:
            raise HTTPException(status_code=404, detail="커밋이 있는 git 저장소가 아닙니다")
        for name in moments:
            if name != git.WORKTREE and git.committed(root, name) is None:
                raise HTTPException(status_code=404, detail=f"없는 커밋입니다: {name}")
        return root, head

    def arranged(state: Workspace, a: str, b: str) -> tuple[str, str, str | None]:
        """고른 두 시점을 (기준, 대상, 갈라진 커밋)으로 정리한다.

        조상 관계면 조상 쪽이 기준이고, 아니면 두 시점이 갈라진 커밋이 기준이며 새 쪽이 대상이다. 작업 중인 상태는
        늘 대상이고 조상 관계는 지금 커밋으로 본다.
        """
        if a == b:
            raise HTTPException(status_code=400, detail="같은 시점을 골랐습니다")
        root, head = versioned(state, a, b)
        picked = b if a == git.WORKTREE else a
        other = head if git.WORKTREE in (a, b) else b
        target = git.WORKTREE if git.WORKTREE in (a, b) else None
        if git.is_ancestor(root, picked, other):
            return picked, target or other, None
        if target is None and git.is_ancestor(root, other, picked):
            return other, picked, None
        fork = git.merge_base(root, picked, other)
        if fork is None:
            raise HTTPException(status_code=400, detail="두 시점에 공통 조상이 없습니다")
        newer = max((picked, other), key=lambda commit: (git.committed(root, commit) or 0, commit))
        return fork, target or newer, fork

    @app.get("/api/history")
    def get_history(skip: int = Query(0, ge=0), limit: int = Query(HISTORY_PAGE, ge=1, le=1000), state: Workspace = ready) -> dict:
        """커밋 그래프의 `skip`번째 줄부터 `limit`줄. git 저장소가 아니면 `git`이 거짓이고 목록이 비어 있다."""
        root = state.analyzed.files.root
        states = git.status(root)
        if states is None:
            return {"git": False, "head": None, "branch": None, "default": None, "dirty": False, "commits": [], "more": False}
        head = git.head(root)
        found = git.commits(root, skip, limit + 1)
        return {
            "git": True,
            "head": head,
            "branch": git.branch(root),
            "default": git.default_branch(root),
            "dirty": head is not None and bool(collected(root, [path for path in states if path.endswith(".py")])),
            "commits": [asdict(commit) for commit in found[:limit]],
            "more": len(found) > limit,
        }

    @app.get("/api/compare/stat")
    def get_stat(a: str, b: str, state: Workspace = ready) -> dict:
        """고른 두 시점의 기준·대상·갈라진 커밋과, 그 사이에 바뀐 분석 대상 `.py` 파일의 수와 줄 수."""
        base, target, fork = arranged(state, moment(a), moment(b))
        root = state.analyzed.files.root
        added, deleted = _counted(git.hunks(root, base, target))
        return {
            "base": base,
            "target": target,
            "fork": fork,
            "files": len(git.changed(root, base, target)),
            "added": added,
            "deleted": deleted,
        }

    def unsaved(analyzed: Analyzed) -> set[str]:
        """분석한 뒤 본문이 바뀐 파일, 생긴 파일, 없어진 파일의 경로."""
        try:
            return analyzed.stale()
        except OSError:
            return set()

    def answer(
        base: str,
        target: str,
        revision: int,
        before: Analyzed,
        after: Analyzed,
        files: list[git.Changed],
        hunks: dict[str, list[git.Hunk]],
        skip: set[str],
    ) -> bytes:
        """두 시점의 분석 결과를 견줘 `POST /api/compare`의 응답 본문(JSON)을 만든다. 파일트리에는 삭제된 파일과 폴더를 더한다."""
        result = compare.compare(
            before.analysis, _facts(before), before.texts, after.analysis, _facts(after), after.texts, files, hunks, skip
        )
        listed = {f.path for f in after.files.files}
        gone = {f["path"] for f in result.files if f["status"] == git.DELETED} - listed
        files_with_gone = replace(after.files, files=[*after.files.files, *(f for f in before.files.files if f.path in gone)])
        body = {
            "base": base,
            "target": target,
            "revision": revision,
            "graph": {"nodes": [to_dict(n) for n in result.nodes], "edges": [to_dict(e) for e in result.edges]},
            "tree": {"entries": _tree(files_with_gone, replace(after.analysis, nodes=result.nodes))},
            "nodes": {node: _change(change) for node, change in result.node_changes.items()},
            "edges": {key: asdict(change) for key, change in result.edge_changes.items()},
            "files": [
                {**f, "hunks": [astuple(h) for h in hunks.get(f["path"], [])], "test": is_test_path(f["path"])}
                for f in result.files
            ],
            "unused": to_dict(after.unused),
        }
        return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()

    async def compared(state: Workspace, base: str, target: str) -> bytes:
        """두 시점을 분석하고 견준 응답. 대상이 커밋이면 대상을 먼저 분석하고 기준을 그 결과에서 증분으로 분석한다.

        대상이 작업 중인 상태면 돌고 있는 분석이 끝나기를 기다리고, 분석한 뒤 바뀐 파일이 있으면 다시 분석해 그 결과를
        쓴다. 다시 분석하지 못하면 앞의 결과를 쓰고 바뀐 파일은 파일의 상태와 줄 수만 낸다. 진행 수는
        `state.compare`에 적는다.
        """
        mine = asyncio.current_task()

        def report(progress: Progress | None) -> None:
            if state.comparing is not None and state.comparing[1] is mine:
                state.compare = progress

        report(Progress("collect"))
        try:
            root = state.analyzed.files.root
            if target == git.WORKTREE:
                if state.running.done() and await asyncio.to_thread(unsaved, state.analyzed):
                    state.running = asyncio.create_task(reload(state))
                await asyncio.gather(asyncio.shield(state.running), return_exceptions=True)
                after, revision = state.analyzed, state.revision
                near = [after]
            else:
                after, revision = await snapshots(state).at(target, [state.analyzed], report), 0
                near = [state.analyzed, after]
            before = await snapshots(state).at(base, near, report)
            report(Progress("build"))
            files, hunks, skip = await asyncio.gather(
                asyncio.to_thread(git.changed, root, base, target),
                asyncio.to_thread(git.hunks, root, base, target),
                asyncio.to_thread(unsaved, after) if target == git.WORKTREE else asyncio.sleep(0, set()),
            )
            key = (base, target, revision, files, hunks, skip)
            if state.compared is None or state.compared[0] != key:
                body = await asyncio.to_thread(answer, base, target, revision, before, after, files, hunks, skip)
                state.compared = (key, body)
            state.seen.update(name for name in (base, target) if name != git.WORKTREE)
            state.shown = None if target == git.WORKTREE else (target, after, {n.id: n for n in after.analysis.nodes})
            return state.compared[1]
        finally:
            report(None)

    @app.post("/api/compare")
    async def post_compare(ends: Ends, state: Workspace = ready) -> Response:
        """기준과 대상을 견준 그래프와 변경 내용. 두 시점의 분석이 끝난 뒤에 응답한다.

        같은 두 시점의 요청이 분석 중에 다시 오면 그 분석이 끝나기를 함께 기다리고, 다른 두 시점의 요청이 오면 앞의
        분석을 멈추고 앞의 요청에 409를 돌려준다. 기다리는 동안 레포를 닫아도 409다. 분석하지 못하면 까닭을 적은 500을 돌려준다.
        """
        base, target = moment(ends.base), moment(ends.target)
        if base == git.WORKTREE or base == target:
            raise HTTPException(status_code=400, detail="기준은 대상과 다른 커밋이어야 합니다")
        await asyncio.to_thread(versioned, state, base, target)
        current = state.comparing
        if current is None or current[0] != (base, target) or current[1].done():
            if current is not None:
                current[1].cancel()
            task = asyncio.create_task(compared(state, base, target))
            task.add_done_callback(lambda task: task.cancelled() or task.exception())
            state.comparing = current = ((base, target), task)
        try:
            return Response(await asyncio.shield(current[1]), media_type="application/json")
        except asyncio.CancelledError:
            if not current[1].cancelled():
                raise
            if state.comparing is current:
                raise HTTPException(status_code=409, detail="레포를 닫아 비교를 멈췄습니다") from None
            raise HTTPException(status_code=409, detail="다른 두 시점의 비교가 시작되어 이 비교를 멈췄습니다") from None
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"비교하지 못했습니다: {exc}") from exc

    @app.get("/api/hover")
    async def get_hover(path: str, line: int = Query(ge=1), col: int = Query(ge=0), state: Workspace = ready) -> dict:
        hover = await ask(state, path, lambda session: session.hover(path, line, col, LSP_TIMEOUT))
        if hover is None:
            return {"markdown": None, "range": None}
        return {"markdown": hover.markdown, "range": hover.range}

    @app.get("/api/definition")
    async def get_definition(path: str, line: int = Query(ge=1), col: int = Query(ge=0), state: Workspace = ready) -> dict:
        locations = await ask(state, path, lambda session: session.definition_at(path, line, col, LSP_TIMEOUT))
        return {"targets": [_target(loc, state.analyzed, state.nodes) for loc in locations]}

    def summarized(state: Workspace, node_id: str) -> str:
        """노드 id를 설명을 만들 프롬프트로 바꾼다."""
        analyzed, nodes = shown(state)
        prompt = prompt_of(nodes, analyzed.analysis.edges, analyzed.texts, node_id)
        if prompt is None:
            raise HTTPException(status_code=404, detail=f"요약할 노드가 아닙니다: {node_id}")
        return prompt

    @app.get("/api/summary")
    async def get_summary(node: str, state: Workspace = ready) -> dict:
        prompt = summarized(state, node)
        summaries: Summaries = app.state.summaries
        reason = await summaries.unavailable()
        summary, stale = summaries.kept(prompt, Subject(state.repo["root"], "node", node))
        return {"summary": summary, "stale": stale, "available": reason is None, "reason": reason, "code": summaries.code}

    @app.get("/api/summaries")
    def get_summaries(state: Workspace = ready) -> dict:
        """노드마다 남겨 둔 가장 최근 요약의 요지. 지금 보이는 시점의 분석 결과에 있는 노드만 담는다."""
        kept = app.state.summaries.latest.listed(state.repo["root"], "node")
        _, nodes = shown(state)
        found = [{"node": k.name, "lead": lead_of(k.text)} for k in kept if k.name in nodes]
        return {"summaries": sorted(found, key=lambda s: s["node"])}

    async def made(request: Request, making: Awaitable[Made]) -> Made:
        """설명을 다 만들 때까지 기다린다. 호출자가 먼저 연결을 끊으면 기다리기를 그만둔다."""
        task = asyncio.ensure_future(making)
        gone = asyncio.ensure_future(_disconnected(request))
        try:
            done, _ = await asyncio.wait({task, gone}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            gone.cancel()
            task.cancel()
        if task not in done:
            raise HTTPException(status_code=499, detail="호출자가 연결을 끊었습니다")
        try:
            return task.result()
        except SummaryError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/api/summary")
    async def make_summary(request: Request, node: str, refresh: bool = False, state: Workspace = ready) -> dict:
        subject = Subject(state.repo["root"], "node", node)
        summary = await made(request, app.state.summaries.make(summarized(state, node), refresh, "node", subject))
        return {"summary": summary.text, "usage": summary.usage and asdict(summary.usage)}

    def between(base: str | None, target: str | None, old_start: int | None, old_end: int | None) -> tuple[int, int] | None:
        """두 시점의 비교에 묶는 범위면 기준 시점의 줄 범위. 두 시점과 기준 시점의 줄 가운데 일부만 왔으면 422다."""
        given = [base, target, old_start, old_end]
        if all(value is None for value in given):
            return None
        if None in given or old_start > old_end:
            raise HTTPException(status_code=422, detail="base, target, old_start, old_end를 함께 넘겨야 합니다")
        return old_start, old_end

    def explained(
        state: Workspace,
        path: str,
        start: int,
        end: int,
        code: str | None = None,
        base: str | None = None,
        target: str | None = None,
        old: tuple[int, int] | None = None,
        question: str = "",
    ) -> tuple[str, Subject]:
        """파일의 줄 범위를 설명을 만들 프롬프트와, 그 설명을 남길 대상으로 바꾼다. `question`은 그 범위를 두고 적은 질문이고 없으면 빈 글이다.

        `code`는 두 시점을 엮은 문서에서 고른 범위의 표시 붙은 본문이다. `old`가 있으면 삭제된 줄이 든 범위이고 설명을 그 두
        시점의 비교에 묶는다. 없으면 대상 시점의 파일과 줄 범위에 묶는다.
        """
        analyzed, nodes = shown(state)
        prompt = range_prompt_of(
            nodes, analyzed.analysis.edges, analyzed.texts, path, start, end, code, old, question or None
        )
        if prompt is None:
            raise HTTPException(status_code=404, detail=f"설명할 코드 범위가 아닙니다: {path} {start}~{end}줄")
        root = state.repo["root"]
        if old is not None:
            name = asked_name(compared_name(base, target, path, old, (start, end)), question)
            return prompt, Subject(root, "compared", name, digest_of(code), question)
        digest = digest_of(range_code(analyzed.texts, path, start, end))
        return prompt, Subject(root, "range", asked_name(f"{path}:{start}-{end}", question), digest, question)

    @app.get("/api/explanations")
    def get_explanations(path: str, base: str | None = None, target: str | None = None, state: Workspace = ready) -> dict:
        """파일에 남겨 둔 코드 범위 설명. 설명을 만든 뒤 그 줄 범위의 코드가 달라졌으면 `stale`이 참이다.

        같은 줄 범위에 질문이 다른 설명이 여럿이면 만든 순서로 담고, `question`은 그 설명의 질문(없으면 빈 글)이다.

        `base`와 `target`을 넘기면 그 두 시점의 비교에 묶어 둔 설명을 `compared`에 함께 담는다. 그 설명의 `digest`는 설명을
        만든 때의 표시 붙은 본문의 지문이고, 지금 본문과 같은지는 그 본문을 가진 화면이 가린다. 두 시점을 넘기면 대상 시점에 없는
        파일도 404가 아니다.
        """
        analyzed, _ = shown(state)
        latest = app.state.summaries.latest
        root = state.repo["root"]
        if path not in analyzed.texts and (base is None or target is None):
            raise HTTPException(status_code=404, detail=f"분석 대상 파일이 아닙니다: {path}")
        found = []
        for kept in latest.listed(root, "range") if path in analyzed.texts else []:
            file, _, span = kept.name.partition("?")[0].rpartition(":")
            if file != path:
                continue
            start, end = (int(n) for n in span.split("-"))
            code = range_code(analyzed.texts, path, start, end)
            stale = code is None or digest_of(code) != kept.digest
            lines = {"start": start, "end": end, "question": kept.question}
            found.append({**lines, "text": kept.text, "stale": stale, "created": kept.created})
        listed = {"explanations": sorted(found, key=lambda e: (e["start"], e["end"]))}
        if base is None or target is None:
            return listed
        compared = []
        for kept in latest.listed(root, "compared"):
            spans = compared_spans(kept.name.partition("?")[0], base, target, path)
            if spans is not None:
                (old_start, old_end), (start, end) = spans
                lines = {"start": start, "end": end, "old_start": old_start, "old_end": old_end, "question": kept.question}
                compared.append({**lines, "text": kept.text, "digest": kept.digest, "created": kept.created})
        return {**listed, "compared": sorted(compared, key=lambda e: (e["old_start"], e["old_end"], e["start"]))}

    @app.post("/api/explanation")
    async def make_explanation(
        request: Request,
        path: str,
        start: int = Query(ge=0),
        end: int = Query(ge=0),
        refresh: bool = False,
        base: str | None = None,
        target: str | None = None,
        old_start: int | None = Query(None, ge=1),
        old_end: int | None = Query(None, ge=1),
        code: str | None = Body(None, embed=True),
        question: str | None = Body(None, embed=True),
        state: Workspace = ready,
    ) -> dict:
        """코드 범위의 설명을 만든다. 두 시점을 엮은 문서에서 고른 범위에 바뀐 줄이 있으면 본문 `code`에 표시 붙은 본문이 온다.

        본문 `question`에 그 범위를 두고 적은 질문이 오면 설명 대신 그 질문의 답을 만들고, 같은 범위의 다른 질문과 따로 남긴다.

        삭제된 줄이 든 범위는 두 시점과 기준 시점의 줄(`old_start`, `old_end`)이 함께 오고, `start`와 `end`는 대상 시점의
        줄이며 그 범위에 대상 시점의 줄이 없으면 둘 다 0이다.
        """
        old = between(base, target, old_start, old_end)
        if old is not None and code is None:
            raise HTTPException(status_code=422, detail="두 시점의 비교에 묶는 범위는 표시 붙은 본문 code를 넘겨야 합니다")
        asked = (question or "").strip()[:MAX_QUESTION]
        prompt, subject = explained(state, path, start, end, code, base, target, old, asked)
        explanation = await made(request, app.state.summaries.make(prompt, refresh, "range", subject))
        lines = {"start": start, "end": end, "question": asked}
        return {**lines, "text": explanation.text, "stale": False, "usage": explanation.usage and asdict(explanation.usage)}

    @app.delete("/api/explanation")
    def delete_explanation(
        path: str,
        start: int = Query(ge=0),
        end: int = Query(ge=0),
        base: str | None = None,
        target: str | None = None,
        old_start: int | None = Query(None, ge=1),
        old_end: int | None = Query(None, ge=1),
        question: str = "",
        state: Workspace = ready,
    ) -> dict:
        old = between(base, target, old_start, old_end)
        latest = app.state.summaries.latest
        if old is None:
            latest.delete(state.repo["root"], "range", asked_name(f"{path}:{start}-{end}", question))
        else:
            name = asked_name(compared_name(base, target, path, old, (start, end)), question)
            latest.delete(state.repo["root"], "compared", name)
        return {"deleted": True}

    def at_head(state: Workspace, head: str, path: str, source_root: str) -> tuple[FileFacts, str] | None:
        """`HEAD`에 든 파일의 추출 결과와 본문. (`HEAD` 해시, 경로)로 기억하고 `HEAD`가 바뀌면 앞의 것을 버린다."""
        key = (head, path)
        heads = state.heads
        if key not in heads:
            for old in [k for k in heads if k[0] != head]:
                del heads[old]
            text = git.show(state.analyzed.files.root, head, path)
            is_init = path == "__init__.py" or path.endswith("/__init__.py")
            file = SourceFile(path, module_id(path, source_root), is_test_path(path), is_init)
            heads[key] = (extract(file, text, frozenset()), text) if text is not None else None
        return heads[key]

    @app.get("/api/changes")
    def get_changes(state: Workspace = ready) -> dict:
        """마지막 커밋 뒤에 바뀐 파일과 정의. 정의의 판정은 `HEAD`와 작업 중인 상태를 견준 `compare.definitions`의 것이다."""
        analyzed: Analyzed = state.analyzed
        root = analyzed.files.root
        stale = analyzed.stale()
        found = git.status(root)
        states = {path: state for path, state in (found or {}).items() if path.endswith(".py")}
        fresh = [p for p, state in states.items() if state != git.DELETED and p not in analyzed.texts]
        for path in set(fresh) - collected(root, fresh):
            del states[path]
        head = git.head(root) if any(state != git.DELETED for state in states.values()) else None
        if head is not None:
            files, hunks = git.changed(root, head, git.WORKTREE), git.hunks(root, head, git.WORKTREE)
        else:
            files, hunks = [git.Changed(git.ADDED, p) for p, state in states.items() if state == git.ADDED], {}
        committed = {
            path: found_at
            for path in (c.old or c.path for c in files if c.status != git.ADDED)
            if (found_at := at_head(state, head, path, analyzed.files.source_root)) is not None
        }
        changes, _ = compare.definitions(
            {path: facts for path, (facts, _) in committed.items()},
            list(state.nodes.values()),
            {path: text for path, (_, text) in committed.items()},
            analyzed.texts,
            files,
            hunks,
            stale,
        )
        nodes: dict[str, str] = {}
        for node in state.nodes.values():
            status = states.get(node.path)
            if status is None or status == git.DELETED:
                continue
            # 파일의 노드는 늘 `git status`의 상태로 넣고, 그 안의 정의는 `HEAD`의 정의와 견준 판정으로 넣는다.
            if node.kind in ("module", "package"):
                nodes[node.id] = status
            elif (change := changes.get(node.id)) is not None and change.change in (git.ADDED, git.MODIFIED):
                nodes[node.id] = change.change
        for path in stale:
            states.setdefault(path, git.UNCHANGED)
        return {
            "git": found is not None,
            "branch": git.branch(root) if found is not None else None,
            "files": [
                {"path": path, "status": state, "stale": path in stale, "test": is_test_path(path)}
                for path, state in sorted(states.items())
            ],
            "nodes": nodes,
        }

    @app.get("/api/unused")
    def get_unused(state: Workspace = ready) -> dict:
        return state.unused

    @app.get("/{path:path}", include_in_schema=False)
    def get_static(path: str) -> FileResponse:
        """dist 안의 파일을 돌려주고, 파일이 아닌 경로는 index.html로 넘긴다. /api 아래는 넘기지 않는다."""
        index = DIST_DIR / "index.html"
        if path == "api" or path.startswith("api/") or not index.is_file():
            raise HTTPException(status_code=404, detail=f"없는 경로입니다: /{path}")
        target = (DIST_DIR / path).resolve()
        if target.is_file() and target.is_relative_to(DIST_DIR.resolve()):
            return FileResponse(target)
        return FileResponse(index)

    return app
