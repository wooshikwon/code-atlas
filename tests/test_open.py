import asyncio
import json
import os
import shutil
import sqlite3
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest

from conftest import git, group_ended

from code_atlas import lsp, opening, snapshot, summary, tools
from code_atlas.api import create_app
from code_atlas.collect import any_source, disk_path
from code_atlas.settings import Settings
from code_atlas.tools import Attempt, Found

NO_PYTHON = "no-interpreter"  # 이 파일이 있는 레포는 인터프리터가 찾아지지 않는다
IDLE = {
    "phase": "idle",
    "done": 0,
    "total": 0,
    "revision": 0,
    "draft": False,
    "lsp": "starting",
    "error": None,
    "stale": {"count": 0, "paths": []},
    "compare": None,
}
READS = [
    ("GET", "/api/repo", {}),
    ("GET", "/api/tree", {}),
    ("GET", "/api/graph", {}),
    ("GET", "/api/unused", {}),
    ("GET", "/api/changes", {}),
    ("GET", "/api/file", {"path": "src/app/core.py"}),
    ("GET", "/api/hover", {"path": "src/app/cli.py", "line": 10, "col": 21}),
    ("GET", "/api/summaries", {}),
    ("GET", "/api/history", {}),
    ("POST", "/api/reload", {}),
    ("POST", "/api/close", {}),
]


def found_python(repo: Path, given: str | None = None, settings: Settings | None = None) -> Found:
    """`tools.python`의 대역. 준 경로와 저장한 경로는 실행 파일일 때만 통과하고, 그 밖에는 시험을 돌리는 인터프리터를 환경에서 찾은 것으로 낸다."""
    saved = given or (settings.python(repo) if settings is not None else None)
    attempts = []
    if saved is not None:
        passed = os.path.isfile(saved) and os.access(saved, os.X_OK)
        attempts.append(Attempt(tools.SAVED, saved, passed, "3.13.0" if passed else "없는 파일", tools.OK if passed else tools.MISSING))
        if passed:
            return Found("python", saved, "3.13.0", tools.SAVED, attempts, code=tools.OK)
    if given is not None or (Path(repo) / NO_PYTHON).exists():
        return Found("python", None, None, None, attempts)
    return Found("python", sys.executable, "3.13.0", tools.ENV, [*attempts, Attempt(tools.ENV, sys.executable, True, "3.13.0")], code=tools.OK)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    monkeypatch.setattr(tools, "python", found_python)


@asynccontextmanager
async def served(tmp_path, repo=None):
    """레포 없이(또는 `repo`를 열어) 띄운 앱과 그 앱에 요청을 보내는 클라이언트."""
    app = create_app(repo, sys.executable if repo else None, settings=Settings(tmp_path / "config" / "settings.json"))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            yield app, client


async def opened(client, repo, **body) -> int:
    answer = await client.post("/api/open", json={"path": str(repo), **body})
    assert answer.status_code == 200, answer.text
    return answer.json()["session"]


async def analysed(app) -> dict:
    """연 레포의 분석이 끝나기를 기다리고 `/api/graph`가 낼 그래프를 돌려준다."""
    await app.state.workspace.running
    return json.loads(json.dumps(app.state.workspace.graph))


def ended(session: lsp.Session) -> bool:
    return session.stopped and group_ended(session.client._server.pid)


@pytest.mark.asyncio
async def test_server_without_a_repo_is_idle_and_answers_409_to_reads(tmp_path):
    async with served(tmp_path) as (app, client):
        assert (await client.get("/api/status")).json() == {**IDLE, "session": 1}
        for method, path, params in READS:
            answer = await client.request(method, path, params=params)
            assert (answer.status_code, answer.json()) == (409, {"error": "연 레포가 없다"}), path
        assert (await client.get("/api/repos")).json() == {"repos": []}
        assert (await client.get("/api/status")).json()["session"] == 1
    assert not (tmp_path / "config").exists()


@pytest.mark.slow
@pytest.mark.asyncio
async def test_two_repos_opened_in_turn_never_mix_their_answers(sample_repo, external_repo, tmp_path):
    async with served(tmp_path, sample_repo) as (alone, _):
        expected_sample = await analysed(alone)
    async with served(tmp_path, external_repo) as (alone, _):
        expected_external = await analysed(alone)
    assert expected_sample != expected_external

    async with served(tmp_path) as (app, client):
        assert await opened(client, sample_repo) == 2
        status = (await client.get("/api/status")).json()
        assert status["phase"] != "idle" and status["session"] == 2
        assert await analysed(app) == expected_sample
        first = app.state.workspace
        session, store = await first.runner.session(), first.runner.cache
        hover = await client.get("/api/hover", params={"path": "src/app/cli.py", "line": 10, "col": 21})
        assert hover.status_code == 200 and hover.json()["range"] == [10, 21, 10, 31]

        assert await opened(client, external_repo) == 3
        assert ended(session)
        with pytest.raises(sqlite3.ProgrammingError):
            store._db.execute("SELECT 1")
        assert (await client.get("/api/status")).json()["revision"] <= 1  # 판 번호는 레포마다 다시 센다
        assert await analysed(app) == expected_external
        assert (await client.get("/api/graph")).json() == expected_external
        assert (await client.get("/api/repo")).json()["name"] == "external_repo"
        assert (await client.get("/api/file", params={"path": "src/app/core.py"})).status_code == 404
        # 닫은 레포는 응답을 기다리던 요청이 뒤늦게 세션을 요구해도 언어 서버를 다시 띄우지 않는다.
        with pytest.raises(RuntimeError):
            await first.runner.session()
        second = await app.state.workspace.runner.session()

        assert await opened(client, sample_repo) == 4
        assert ended(second)
        assert await analysed(app) == expected_sample
        assert (await client.get("/api/status")).json()["revision"] == 1  # 캐시에 판정이 있어 다시 묻지 않는다
        third = await app.state.workspace.runner.session()

        closed = await client.post("/api/close")
        assert (closed.status_code, closed.json()) == (200, {"session": 5})
        assert ended(third)
        assert (await client.get("/api/status")).json() == {**IDLE, "session": 5}
        assert (await client.get("/api/graph")).status_code == 409


@pytest.mark.slow
@pytest.mark.asyncio
async def test_opening_another_repo_cancels_the_running_analysis(sample_repo, external_repo, tmp_path, monkeypatch):
    wait_ready = lsp.Session.wait_ready

    async def held(self, probe):
        if self.root == sample_repo.resolve():
            await asyncio.Event().wait()
        await wait_ready(self, probe)

    monkeypatch.setattr(lsp.Session, "wait_ready", held)
    async with served(tmp_path, sample_repo) as (app, client):
        first = app.state.workspace
        while first.runner._session is None:
            await asyncio.sleep(0.01)
        session = first.runner._session
        assert (await client.get("/api/graph")).status_code == 503

        assert await opened(client, external_repo) == 2
        assert first.running.cancelled() and first.revision == 0 and first.closed
        assert ended(session)
        await analysed(app)
        status = (await client.get("/api/status")).json()
        assert (status["phase"], status["revision"], status["session"]) == ("ready", 1, 2)
        assert (await client.get("/api/repo")).json()["name"] == "external_repo"


@pytest.mark.slow
@pytest.mark.asyncio
async def test_reload_waiting_for_the_analysis_ends_with_409_when_the_repo_is_closed(sample_repo, tmp_path, monkeypatch):
    async with served(tmp_path, sample_repo) as (app, client):
        await analysed(app)
        wait_ready = lsp.Session.wait_ready
        waiting = asyncio.Event()

        async def held(self, probe):
            waiting.set()
            await asyncio.Event().wait()

        core = sample_repo / "src" / "app" / "core.py"
        core.write_text(core.read_text() + "\n\ndef added():\n    return helper(1)\n")
        monkeypatch.setattr(lsp.Session, "wait_ready", held)
        reloading = asyncio.ensure_future(client.post("/api/reload"))
        await waiting.wait()
        monkeypatch.setattr(lsp.Session, "wait_ready", wait_ready)
        assert (await client.post("/api/close")).status_code == 200
        answer = await reloading
        assert (answer.status_code, answer.json()) == (409, {"error": "레포를 닫아 분석을 멈췄다"})


@pytest.mark.slow
@pytest.mark.asyncio
async def test_switching_while_comparing_leaves_no_exported_folder(history_repo, sample_repo, tmp_path, monkeypatch):
    repo, at = history_repo
    started: list[lsp.Session] = []
    entered = lsp.Session.__aenter__
    wait_ready = lsp.Session.wait_ready

    async def recorded(self):
        started.append(self)
        return await entered(self)

    async def held(self, probe):
        if "snapshots" in self.root.parts:
            await asyncio.Event().wait()
        await wait_ready(self, probe)

    monkeypatch.setattr(lsp.Session, "__aenter__", recorded)
    monkeypatch.setattr(lsp.Session, "wait_ready", held)
    monkeypatch.setattr(snapshot.caching, "CACHE_DIR", tmp_path / "cache")  # 앞의 시험이 이 커밋의 판정을 캐시에 남겼다
    async with served(tmp_path, repo) as (app, client):
        await analysed(app)
        first = app.state.workspace
        comparing = asyncio.ensure_future(client.post("/api/compare", json={"base": at["base"], "target": at["edit"]}))
        while not any("snapshots" in session.root.parts for session in started):
            await asyncio.sleep(0.01)
        folder = first.snapshots.directory
        assert folder.is_dir() and (await client.get("/api/status")).json()["compare"] is not None

        assert await opened(client, sample_repo) == 2
        stopped = await comparing
        assert (stopped.status_code, stopped.json()) == (409, {"error": "레포를 닫아 비교를 멈췄다"})
        assert not folder.exists()
        assert all(ended(session) for session in started)
        assert (await client.get("/api/status")).json()["compare"] is None
        await analysed(app)
        assert (await client.get("/api/repo")).json()["name"] == "sample_repo"
    assert not folder.exists()


@pytest.mark.slow
@pytest.mark.asyncio
async def test_open_that_fails_keeps_the_open_repo(sample_repo, external_repo, tmp_path):
    empty = tmp_path / "empty"
    (empty / "docs").mkdir(parents=True)
    (empty / "docs" / "notes.md").write_text("메모\n")
    (external_repo / NO_PYTHON).write_text("")
    missing = str(tmp_path / "no" / "python")
    refused = [
        ({"path": str(tmp_path / "gone")}, f"폴더가 없다: {disk_path(tmp_path) / 'gone'}"),
        ({"path": str(sample_repo / "pyproject.toml")}, f"폴더가 없다: {disk_path(sample_repo) / 'pyproject.toml'}"),
        ({"path": str(empty)}, f"파이썬 파일이 없는 폴더는 열지 못한다: {disk_path(empty)}"),
        ({"path": str(external_repo)}, "external_repo의 Python 인터프리터를 찾지 못했다"),
        ({"path": str(external_repo), "python": missing}, f"Python 인터프리터가 아니다: {missing} (없는 파일)"),
    ]
    async with served(tmp_path, sample_repo) as (app, client):
        graph = await analysed(app)
        first = app.state.workspace
        session = await first.runner.session()
        for body, error in refused:
            answer = await client.post("/api/open", json=body)
            assert (answer.status_code, answer.json()) == (400, {"error": error})
            assert app.state.workspace is first and not first.closed and not session.stopped
            assert (await client.get("/api/status")).json()["session"] == 1
            assert (await client.get("/api/graph")).json() == graph
        assert [r["root"] for r in (await client.get("/api/repos")).json()["repos"]] == [str(disk_path(sample_repo))]

        # 직접 고른 인터프리터는 확인을 통과하면 그 레포의 값으로 저장하고, 다음에는 주지 않아도 그 값으로 연다.
        assert await opened(client, external_repo, python=sys.executable) == 2
        assert (await analysed(app)) != graph
        assert await opened(client, sample_repo) == 3
        assert await opened(client, external_repo) == 4
        assert (await client.get("/api/status")).json()["phase"] != "failed"
        listed = (await client.get("/api/repos")).json()["repos"]
        assert [(r["name"], r["python"], r["exists"]) for r in listed] == [
            ("external_repo", sys.executable, True),
            ("sample_repo", None, True),
        ]
        assert listed[0]["opened"] >= listed[1]["opened"]


@pytest.mark.slow
@pytest.mark.asyncio
async def test_repos_lists_what_was_opened_and_forgets_on_request(sample_repo, external_repo, tmp_path):
    async with served(tmp_path) as (app, client):
        await opened(client, sample_repo)
        await opened(client, external_repo)
        await client.post("/api/close")
        shutil.rmtree(sample_repo)
        listed = (await client.get("/api/repos")).json()["repos"]
        assert [(r["name"], r["exists"]) for r in listed] == [("external_repo", True), ("sample_repo", False)]

        answer = await client.delete("/api/repos", params={"root": listed[0]["root"]})
        assert answer.status_code == 200
        assert [r["name"] for r in (await client.get("/api/repos")).json()["repos"]] == ["sample_repo"]
    assert [r.root for r in Settings(tmp_path / "config" / "settings.json").repos()] == [listed[1]["root"]]


def listing(folder: Path) -> list[tuple[str, int]]:
    return sorted((str(p), p.stat().st_mtime_ns) for p in [folder, *folder.rglob("*")])


@pytest.fixture
def home(tmp_path, monkeypatch):
    """임시 폴더를 홈 폴더로 삼는다. 프로젝트 루트는 홈 폴더 아래의 조상에서만 찾는다."""
    monkeypatch.setenv("HOME", str(tmp_path))
    return disk_path(tmp_path)


def test_probe_of_a_missing_folder_and_a_folder_without_python_files(home):
    gone = opening.probe(home / "gone")
    assert (gone.path, gone.exists, gone.python_files, gone.project, gone.nested, gone.git) == (
        str(home / "gone"),
        False,
        False,
        None,
        [],
        False,
    )
    assert gone.python == Found("python", None, None, None, [])

    docs = home / "docs"
    (docs / ".hidden").mkdir(parents=True)
    (docs / ".hidden" / "skipped.py").write_text("x = 1\n")
    (docs / "env").mkdir()
    (docs / "env" / "pyvenv.cfg").write_text("home = /usr/bin\n")
    (docs / "env" / "site.py").write_text("x = 1\n")
    (docs / ".gitignore").write_text("generated/\n")
    (docs / "generated").mkdir()
    (docs / "generated" / "made.py").write_text("x = 1\n")
    (docs / "notes.md").write_text("메모\n")
    found = opening.probe(docs)
    assert (found.exists, found.python_files, found.python.attempts) == (True, False, [])
    assert not any_source(docs)
    (docs / "deep" / "er").mkdir(parents=True)
    (docs / "deep" / "er" / "one.py").write_text("x = 1\n")
    assert any_source(docs) and opening.probe(docs).python_files


def test_probe_names_the_nearest_project_above_a_subfolder(home, sample_repo):
    git(sample_repo, "init", "-q", "-b", "main")
    before = listing(sample_repo)
    inner = opening.probe(sample_repo / "src" / "app")
    assert (inner.exists, inner.python_files, inner.project, inner.nested) == (True, True, str(home / "sample_repo"), [])
    assert inner.git and inner.python.path == sys.executable
    assert listing(sample_repo) == before  # 대상 폴더에 쓰지 않는다

    # 더 가까운 조상에 표지가 있으면 그 폴더다. 고른 폴더 자신의 표지는 보지 않는다.
    (sample_repo / "src" / "pyproject.toml").write_text("[project]\nname = 'inner'\n")
    assert opening.probe(sample_repo / "src" / "app").project == str(home / "sample_repo" / "src")
    assert opening.probe(sample_repo / "src").project == str(home / "sample_repo")
    assert opening.probe(sample_repo).project is None

    # 홈 폴더와 그 위의 폴더는 프로젝트 루트로 보지 않는다.
    (home / "pyproject.toml").write_text("[project]\nname = 'home'\n")
    assert opening.probe(sample_repo).project is None


def test_probe_lists_the_repos_inside_a_folder_that_holds_several(home, sample_repo, external_repo):
    for repo in (sample_repo, external_repo):
        git(repo, "init", "-q", "-b", "main")
    (home / "notes").mkdir()
    found = opening.probe(home)
    assert (found.python_files, found.project, found.nested, found.git) == (True, None, ["external_repo", "sample_repo"], False)


def test_probe_of_a_folder_outside_git_names_no_project(home, sample_repo):
    found = opening.probe(str(sample_repo).upper() if sys.platform == "darwin" else sample_repo)
    assert found.path == str(home / "sample_repo")  # 디스크에 적힌 대소문자로 맞춘다
    assert (found.exists, found.python_files, found.project, found.nested, found.git) == (True, True, None, [], False)
    assert (found.python.path, found.python.source) == (sys.executable, tools.ENV)

    (sample_repo / NO_PYTHON).write_text("")
    assert opening.probe(sample_repo).python == Found("python", None, None, None, [])


@pytest.mark.asyncio
async def test_probe_route_answers_the_judgement_with_the_interpreter(home, sample_repo, tmp_path):
    async with served(tmp_path) as (_, client):
        answer = await client.post("/api/probe", json={"path": str(sample_repo / "src")})
        assert answer.status_code == 200
        body = answer.json()
        assert body == {
            "path": str(home / "sample_repo" / "src"),
            "exists": True,
            "python_files": True,
            "project": str(home / "sample_repo"),
            "nested": [],
            "git": False,
            "python": {
                "tool": "python",
                "path": sys.executable,
                "version": "3.13.0",
                "source": "env",
                "attempts": [{"source": "env", "path": sys.executable, "ok": True, "detail": "3.13.0", "code": "ok"}],
                "note": None,
                "auth": None,
                "prefix": None,
                "venv": None,
                "code": "ok",
            },
        }
        assert (await client.get("/api/status")).json()["session"] == 1
