import asyncio
import json
import shutil
import sqlite3
import subprocess
import sys
import time
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient

from conftest import FIXTURE, git, group_ended
from history import run as history_run

from code_atlas import api, lsp, runner, snapshot, summary
from code_atlas.api import create_app
from code_atlas.summary import Made, Subject, Summaries, SummaryError, Usage

RUN_ENGINE_CALL = {"path": "src/app/cli.py", "line": 10, "col": 21}  # 한글 문자열 뒤의 run_engine


def analysed(client: TestClient) -> TestClient:
    """분석이 끝나 다시 물을 지점이 남지 않은 결과가 들어올 때까지 기다린다."""
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        status = client.get("/api/status").json()
        assert status["phase"] != "failed", status["error"]
        if status["phase"] == "ready" and not status["draft"]:
            return client
        time.sleep(0.02)
    pytest.fail("분석이 끝나지 않았다")


def name_in(prompt: str) -> str:
    """요약 프롬프트의 `이름:` 줄에 적힌 이름."""
    return prompt.split("\n이름: ", 1)[1].split("\n", 1)[0]


@pytest.fixture(scope="module")
def client(module_repo, tmp_path_factory):
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(summary, "CACHE_PATH", tmp_path_factory.mktemp("cache") / "summaries.db")
        patch.setattr(summary, "find_cli", lambda: None)
        with TestClient(create_app(module_repo, sys.executable)) as client:
            yield analysed(client)


USED = Usage(input=2, cache_write=1487, cache_read=16411, output=527)
USAGE = {"input": 2, "cache_write": 1487, "cache_read": 16411, "output": 527}


@pytest.fixture
def generated(client, tmp_path, monkeypatch):
    """빈 요약 캐시로 바꾸고 `claude` 호출을 가짜로 바꾼다. 가짜가 받은 (시스템 프롬프트, 프롬프트)를 돌려준 목록에 담는다."""
    calls: list[tuple[str, str]] = []

    async def generate(system, prompt):
        calls.append((system, prompt))
        return Made(f"{name_in(prompt)} 요약 {len(calls)}", USED)

    async def unavailable():
        return None

    async def explain(system, prompt):
        calls.append((system, prompt))
        return Made(f"{prompt.split(chr(10) + '위치: ', 1)[1].split(chr(10), 1)[0]} 설명 {len(calls)}", USED)

    monkeypatch.setattr(summary, "generate", generate)
    monkeypatch.setattr(summary, "explain", explain)
    monkeypatch.setattr(summary, "unavailable", unavailable)
    monkeypatch.setattr(client.app.state, "summaries", Summaries(tmp_path / "summaries.db"))
    return calls


@pytest.fixture
def changed(git_repo, tmp_path):
    """커밋한 고정 레포에서 `helper`를 고치고 추적하지 않는 파일을 더한 뒤 분석한다."""
    core = git_repo / "src" / "app" / "core.py"
    core.write_text(core.read_text().replace("    return value\n", "    return value or None\n"))
    (git_repo / "src" / "app" / "extra.py").write_text("def fresh():\n    return 1\n")
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
        patch.setattr(summary, "find_cli", lambda: None)
        with TestClient(create_app(git_repo, sys.executable)) as client:
            yield analysed(client)


def test_repo(client):
    body = client.get("/api/repo").json()
    assert body["name"] == "sample_repo"
    assert body["source_root"] == "src"
    assert body["python"] == sys.executable
    assert body["stats"]["files"] == 13
    assert body["stats"]["timed_out"] == 0
    assert body["stats"]["resolved"] + body["stats"]["unresolved"] == body["stats"]["call_sites"]


def test_tree(client):
    entries = client.get("/api/tree").json()["entries"]
    assert [e["name"] for e in entries] == ["src", "tests"]
    src, tests = entries
    assert src["node"] is None and tests["test"] and not src["test"]
    app = src["children"][0]
    assert (app["path"], app["kind"], app["node"]) == ("src/app", "dir", "app")
    assert [c["name"] for c in app["children"]][:2] == ["plugins", "__init__.py"]
    assert app["children"][1]["node"] is None
    core = next(c for c in app["children"] if c["name"] == "core.py")
    assert (core["kind"], core["node"], "children" in core) == ("file", "app.core", False)
    plugins = app["children"][0]
    assert plugins["node"] == "app.plugins"


@pytest.fixture(scope="module")
def init_client(tmp_path_factory):
    """고정 레포 복사본에 소스 루트의 `__init__.py`, 정의가 있는 `plugins/__init__.py`, 그 정의를 쓰는 파일을 더해 분석한다."""
    repo = tmp_path_factory.mktemp("init") / "sample_repo"
    shutil.copytree(FIXTURE, repo)
    (repo / "src" / "__init__.py").write_text("")
    (repo / "src" / "app" / "plugins" / "__init__.py").write_text(
        "from app.models import Config\n\n\ndef version():\n    return Config('x')\n\n\n"
        "class Settings:\n    def load(self):\n        return version()\n"
    )
    (repo / "src" / "app" / "uses.py").write_text("from app.plugins import version\n\nversion()\n")
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(summary, "CACHE_PATH", tmp_path_factory.mktemp("cache") / "summaries.db")
        patch.setattr(summary, "find_cli", lambda: None)
        with TestClient(create_app(repo, sys.executable)) as client:
            yield analysed(client)


def test_init_file_rows_point_at_module_nodes_only(init_client):
    src = init_client.get("/api/tree").json()["entries"][0]
    rows = {c["name"]: c for c in src["children"]}
    assert rows["__init__.py"]["node"] == "__init__"
    app = {c["name"]: c for c in rows["app"]["children"]}
    assert app["__init__.py"]["node"] is None
    plugins = {c["name"]: c for c in app["plugins"]["children"]}
    assert (app["plugins"]["node"], plugins["__init__.py"]["node"]) == ("app.plugins", "app.plugins.__init__")


def test_init_definitions_hang_under_the_init_module(init_client):
    body = init_client.get("/api/graph").json()
    nodes = {n["id"]: n for n in body["nodes"]}
    assert (nodes["__init__"]["kind"], nodes["app"]["kind"]) == ("module", "package")
    assert (nodes["app.plugins"]["kind"], nodes["app.plugins"]["path"]) == ("package", "src/app/plugins")
    init = nodes["app.plugins.__init__"]
    assert (init["kind"], init["name"], init["parent"], init["path"]) == (
        "module",
        "__init__",
        "app.plugins",
        "src/app/plugins/__init__.py",
    )
    assert nodes["app.plugins:version"]["parent"] == "app.plugins.__init__"
    assert nodes["app.plugins:Settings.load"]["parent"] == "app.plugins:Settings"
    assert nodes["app.plugins"]["loc"] == init["loc"] + nodes["app.plugins.base"]["loc"]
    edges = {(e["kind"], e["source"], e["target"]) for e in body["edges"]}
    assert all(e["source"] in nodes and e["target"] in nodes for e in body["edges"])
    assert {
        ("import", "app.plugins.__init__", "app.models"),
        ("construct", "app.plugins:version", "app.models:Config"),
        ("call", "app.plugins:Settings.load", "app.plugins:version"),
        ("import", "app.uses", "app.plugins.__init__"),
        ("call", "app.uses", "app.plugins:version"),
    } <= edges
    target = init_client.get("/api/definition", params={"path": "src/app/uses.py", "line": 3, "col": 0}).json()
    assert [(t["path"], t["node"]) for t in target["targets"]] == [("src/app/plugins/__init__.py", "app.plugins:version")]


def test_graph(client):
    body = client.get("/api/graph").json()
    ids = {n["id"] for n in body["nodes"]}
    assert "app.core:Engine.start" in ids
    engine = next(n for n in body["nodes"] if n["id"] == "app.core:Engine")
    assert isinstance(engine["range"], list) and len(engine["range"]) == 2
    edge = next(e for e in body["edges"] if e["kind"] == "call" and e["target"] == "app.core:run_engine")
    assert edge["group"] == "run"
    assert edge["sites"] == [{"path": "src/app/cli.py", "line": 10, "col": 21}]


def test_graph_variable_nodes_and_edges(client):
    body = client.get("/api/graph").json()
    nodes = {n["id"]: n for n in body["nodes"]}
    limits = nodes["app.tables:LIMITS"]
    assert (limits["kind"], limits["parent"], limits["range"]) == ("variable", "app.tables", [9, 9])
    assert limits["value"] == {"kind": "dict", "size": 2, "text": "{'low': 1, 'high': 9}"}
    assert not limits["external_value"] and nodes["app.tables:logger"]["external_value"]
    assert (limits["reads"], limits["writes"], limits["unresolved"]) == ([], [], 0)
    engine = nodes["app.core:Engine"]
    assert engine["value"] is None and engine["external_value"] is False
    kinds = {(e["kind"], e["group"]) for e in body["edges"] if nodes[e["target"]]["kind"] == "variable"}
    assert kinds == {("read", "use"), ("write", "use")}
    edge = next(e for e in body["edges"] if e["kind"] == "write" and e["source"] == "app.lookup:reset")
    assert (edge["target"], edge["sites"]) == ("app.tables:total", [{"path": "src/app/lookup.py", "line": 14, "col": 4}])
    stats = client.get("/api/repo").json()["stats"]
    assert (stats["nodes"], stats["edges"]) == (len(body["nodes"]), len(body["edges"]))


def test_definition_of_variable_is_its_node(client):
    read = client.get("/api/definition", params={"path": "src/app/lookup.py", "line": 6, "col": 11}).json()
    assert read["targets"] == [
        {"path": "src/app/tables.py", "line": 9, "col": 0, "node": "app.tables:LIMITS", "external": None}
    ]
    # 노드가 아닌 변수의 대입 위치는 그 위치를 품은 노드로 답한다.
    banner = client.get("/api/definition", params={"path": "src/app/tables.py", "line": 21, "col": 3}).json()
    assert [(t["line"], t["node"]) for t in banner["targets"]] == [(16, "app.tables")]


def test_unused(client):
    body = client.get("/api/unused").json()
    assert body == {"definitions": 28, "candidates": ["app.core:spare", "app.models:Point", "app.models:Color", "app.shadow:announce"]}
    ids = {n["id"] for n in client.get("/api/graph").json()["nodes"]}
    assert set(body["candidates"]) <= ids and "app.core:on_stop" in ids


def test_file(client):
    body = client.get("/api/file", params={"path": "src/app/cli.py"}).json()
    assert body["path"] == "src/app/cli.py"
    assert "엔진 시작" in body["text"]


@pytest.mark.parametrize("path", ["pyproject.toml", "../etc/passwd", "ignored_dir/skip.py", "src/app/nope.py"])
def test_file_outside_analysis_is_404(client, path):
    response = client.get("/api/file", params={"path": path})
    assert response.status_code == 404
    assert "error" in response.json()


def test_unknown_api_path_is_404(client):
    response = client.get("/api/nope")
    assert response.status_code == 404
    assert "error" in response.json()


def test_hover_returns_markdown(client):
    body = client.get("/api/hover", params=RUN_ENGINE_CALL).json()
    assert "def run_engine(config: Config) -> Engine" in body["markdown"]
    assert body["markdown"].startswith("```python")
    assert body["range"] == [10, 21, 10, 31]


def test_hover_on_blank_is_null(client):
    body = client.get("/api/hover", params={"path": "src/app/cli.py", "line": 5, "col": 0}).json()
    assert body == {"markdown": None, "range": None}


def test_definition_returns_node_in_another_file(client):
    body = client.get("/api/definition", params=RUN_ENGINE_CALL).json()
    assert body["targets"] == [
        {"path": "src/app/core.py", "line": 31, "col": 4, "node": "app.core:run_engine", "external": None}
    ]


def test_definition_of_method_and_module(client):
    start = client.get("/api/definition", params={"path": "src/app/core.py", "line": 33, "col": 11}).json()
    assert [t["node"] for t in start["targets"]] == ["app.core:Engine.start"]
    module = client.get("/api/definition", params={"path": "src/app/cli.py", "line": 2, "col": 9}).json()
    assert [(t["path"], t["node"]) for t in module["targets"]] == [("src/app/core.py", "app.core")]


def test_definition_of_stdlib_name_is_external(client):
    body = client.get("/api/definition", params={"path": "src/app/core.py", "line": 21, "col": 15}).json()
    assert body["targets"]
    for target in body["targets"]:
        assert (target["path"], target["node"], target["external"]) == (None, None, "ext:os")


@pytest.mark.parametrize("route", ["/api/hover", "/api/definition"])
@pytest.mark.parametrize("path", ["pyproject.toml", "../etc/passwd", "ignored_dir/skip.py"])
def test_position_outside_analysis_is_404(client, route, path):
    response = client.get(route, params={"path": path, "line": 1, "col": 0})
    assert response.status_code == 404
    assert "error" in response.json()


def test_stopped_session_is_reopened(client, monkeypatch):
    state = client.app.state
    deadline = time.monotonic() + 10
    while client.get("/api/status").json()["lsp"] != "ready" and time.monotonic() < deadline:
        time.sleep(0.05)
    stopped = state.runner._session
    subprocess.run(["pkill", "-KILL", "-P", str(stopped.client._server.pid)], check=True)
    while not stopped.stopped and time.monotonic() < deadline:
        time.sleep(0.05)
    assert stopped.stopped

    def fail(*args):
        raise OSError("basedpyright-langserver를 띄우지 못했다")

    with monkeypatch.context() as patch:
        patch.setattr(runner, "Session", fail)
        response = client.get("/api/hover", params=RUN_ENGINE_CALL)
        assert response.status_code == 503
        assert "error" in response.json()

    body = client.get("/api/hover", params=RUN_ENGINE_CALL).json()
    assert body["range"] == [10, 21, 10, 31]
    assert state.runner._session is not stopped and not state.runner._session.stopped
    assert client.get("/api/status").json()["lsp"] == "ready"


READS = [
    ("GET", "/api/repo", {}),
    ("GET", "/api/tree", {}),
    ("GET", "/api/graph", {}),
    ("GET", "/api/unused", {}),
    ("GET", "/api/changes", {}),
    ("GET", "/api/file", {"path": "src/app/core.py"}),
    ("GET", "/api/hover", RUN_ENGINE_CALL),
    ("GET", "/api/definition", RUN_ENGINE_CALL),
    ("GET", "/api/summary", {"node": "app.core:helper"}),
    ("POST", "/api/summary", {"node": "app.core:helper"}),
    ("GET", "/api/explanations", {"path": "src/app/core.py"}),
    ("POST", "/api/explanation", {"path": "src/app/core.py", "start": 1, "end": 2}),
    ("DELETE", "/api/explanation", {"path": "src/app/core.py", "start": 1, "end": 2}),
    ("POST", "/api/reload", {}),
    ("GET", "/api/history", {}),
    ("GET", "/api/compare/stat", {"a": "worktree", "b": "0" * 40}),
    ("POST", "/api/compare", {}),
]


@pytest.mark.asyncio
async def test_server_answers_before_the_analysis_and_counts_revisions(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    release = asyncio.Event()
    wait_ready = lsp.Session.wait_ready

    async def held(self, probe):
        await release.wait()
        await wait_ready(self, probe)

    monkeypatch.setattr(lsp.Session, "wait_ready", held)
    seen = []
    app = create_app(sample_repo, sys.executable, seen.append)
    async with app.router.lifespan_context(app):
        while app.state.runner._session is None:
            await asyncio.sleep(0.01)
        code, status = await call(app, "GET", "/api/status", {})
        total = status.pop("total")
        assert code == 200 and total > 0
        assert status == {
            "phase": "resolve",
            "done": 0,
            "revision": 0,
            "draft": False,
            "lsp": "starting",
            "error": None,
            "stale": {"count": 0, "paths": []},
            "compare": None,
        }
        for method, path, params in READS:
            assert await call(app, method, path, params) == (503, {"error": "분석 중이다"}), path
        assert seen == []

        release.set()
        await app.state.running
        _, status = await call(app, "GET", "/api/status", {})
        assert (status["phase"], status["revision"], status["draft"], status["error"]) == ("ready", 1, False, None)
        assert seen == [app.state.analyzed.analysis]
        assert (await call(app, "GET", "/api/graph", {}))[0] == 200
        status, hover = await call(app, "GET", "/api/hover", RUN_ENGINE_CALL)
        assert status == 200 and hover["range"] == [10, 21, 10, 31]
        assert (await call(app, "GET", "/api/status", {}))[1]["lsp"] == "ready"


@pytest.mark.asyncio
async def test_resolve_phase_reports_the_requests_sent(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    app = create_app(sample_repo, sys.executable)
    seen = []
    async with app.router.lifespan_context(app):
        while not app.state.running.done():
            _, status = await call(app, "GET", "/api/status", {})
            seen.append((status["phase"], status["done"], status["total"]))
            await asyncio.sleep(0.005)
    resolving = [(done, total) for phase, done, total in seen if phase == "resolve"]
    assert resolving and all(0 <= done <= total for done, total in resolving)
    assert [done for done, _ in resolving] == sorted(done for done, _ in resolving)


@pytest.mark.asyncio
async def test_shutdown_during_the_analysis_ends_the_session_and_closes_the_cache(sample_repo, tmp_path, monkeypatch):
    async def held(self, probe):
        await asyncio.Event().wait()

    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(lsp.Session, "wait_ready", held)
    app = create_app(sample_repo, sys.executable)
    started = time.monotonic()
    async with app.router.lifespan_context(app):
        while app.state.runner._session is None:
            await asyncio.sleep(0.01)
        session, store = app.state.runner._session, app.state.runner._cache
    assert time.monotonic() - started < 5
    assert app.state.revision == 0 and not hasattr(app.state, "analyzed")
    assert session.stopped and group_ended(session.client._server.pid)
    with pytest.raises(sqlite3.ProgrammingError):
        store._db.execute("SELECT 1")


@pytest.mark.asyncio
async def test_failed_first_analysis_keeps_the_server_up(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    app = create_app(sample_repo, str(sample_repo / "no" / "python"))
    async with app.router.lifespan_context(app):
        await asyncio.gather(app.state.running, return_exceptions=True)
        _, status = await call(app, "GET", "/api/status", {})
        assert (status["phase"], status["revision"]) == ("failed", 0)
        assert "실행할 수 없다" in status["error"]
        assert await call(app, "GET", "/api/graph", {}) == (503, {"error": "분석 중이다"})

        code, body = await call(app, "POST", "/api/reload", {})
        assert code == 500 and "실행할 수 없다" in body["error"]
        app.state.runner.python = sys.executable
        code, body = await call(app, "POST", "/api/reload", {})
        _, status = await call(app, "GET", "/api/status", {})
        assert (code, body["name"]) == (200, sample_repo.name)
        assert (status["phase"], status["revision"], status["error"]) == ("ready", 1, None)


@pytest.mark.asyncio
async def test_cached_repo_opens_as_a_draft_and_is_replaced_after_asking(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    app = create_app(sample_repo, sys.executable)
    async with app.router.lifespan_context(app):
        await app.state.running
        full = app.state.graph

    asked = []
    definition = lsp.Session.definition

    async def counted(self, *args):
        asked.append(args)
        return await definition(self, *args)

    monkeypatch.setattr(lsp.Session, "definition", counted)
    app = create_app(sample_repo, sys.executable)
    async with app.router.lifespan_context(app):
        await app.state.running
        assert (app.state.revision, app.state.draft, asked) == (1, False, [])
        assert app.state.graph == full
        status, hover = await call(app, "GET", "/api/hover", RUN_ENGINE_CALL)
        assert status == 200 and hover["range"] == [10, 21, 10, 31]

    add_function(sample_repo)
    release = asyncio.Event()
    wait_ready = lsp.Session.wait_ready

    async def held(self, probe):
        await release.wait()
        await wait_ready(self, probe)

    monkeypatch.setattr(lsp.Session, "wait_ready", held)
    app = create_app(sample_repo, sys.executable)
    async with app.router.lifespan_context(app):
        while app.state.revision == 0:
            await asyncio.sleep(0.01)
        _, status = await call(app, "GET", "/api/status", {})
        assert (status["phase"], status["revision"], status["draft"]) == ("resolve", 1, True)
        draft = app.state.graph
        assert "app.core:added" in app.state.nodes
        assert not any(e["source"] == "app.core:added" for e in draft["edges"])
        reloading = asyncio.create_task(call(app, "POST", "/api/reload", {}))
        await asyncio.sleep(0.05)
        assert not reloading.done()

        release.set()
        assert (await reloading)[0] == 200
        _, status = await call(app, "GET", "/api/status", {})
        assert (status["phase"], status["revision"], status["draft"]) == ("ready", 2, False)
        assert any(e["source"] == "app.core:added" and e["target"] == "app.core:helper" for e in app.state.graph["edges"])


async def call(app, method: str, path: str, params: dict, gone: asyncio.Event | None = None) -> tuple[int, dict]:
    """ASGI 앱에 요청 하나를 보내 상태 코드와 JSON 본문을 받는다. `gone`이 켜지면 호출자가 연결을 끊은 것으로 알린다."""
    gone = gone or asyncio.Event()
    request = [{"type": "http.request", "body": b"", "more_body": False}]
    status: list[int] = []
    body: list[bytes] = []

    async def receive():
        if request:
            return request.pop()
        await gone.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            status.append(message["status"])
        else:
            body.append(message.get("body", b""))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": urlencode(params).encode(),
        "headers": [],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 80),
    }
    await app(scope, receive, send)
    return status[0], json.loads(b"".join(body))


@pytest.mark.asyncio
async def test_summary_waiting_for_a_slot_is_dropped_when_the_caller_disconnects(sample_repo, tmp_path, monkeypatch):
    made: list[str] = []
    release = asyncio.Event()

    async def generate(system, prompt):
        made.append(name_in(prompt))
        await release.wait()
        return Made(f"{name_in(prompt)} 요약")

    async def unavailable():
        return None

    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "generate", generate)
    monkeypatch.setattr(summary, "unavailable", unavailable)
    app = create_app(sample_repo, sys.executable)
    async with app.router.lifespan_context(app):
        await app.state.running
        names = {
            "app.core:helper": "app/core.py::helper",
            "app.core:run_engine": "app/core.py::run_engine",
            "app.core:Engine.start": "app/core.py::Engine.start",
        }
        gone = {node: asyncio.Event() for node in names}
        posts = {node: asyncio.create_task(call(app, "POST", "/api/summary", {"node": node}, gone[node])) for node in names}
        while len(made) < 2:
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.1)
        # 세 요청 가운데 어느 둘이 먼저 동시 실행 자리를 얻는지는 정해져 있지 않다.
        assert len(made) == 2
        left, kept = (node for node in names if names[node] in made)
        (late,) = (node for node in names if names[node] not in made)
        started = list(made)

        gone[left].set()
        gone[late].set()
        assert (await posts[left])[0] == (await posts[late])[0] == 499
        release.set()
        assert await posts[kept] == (200, {"summary": f"{names[kept]} 요약", "usage": None})
        await asyncio.sleep(0.1)
        assert made == started
        _, cached = await call(app, "GET", "/api/summary", {"node": left})
        assert cached["summary"] == f"{names[left]} 요약"
        _, skipped = await call(app, "GET", "/api/summary", {"node": late})
        assert skipped["summary"] is None


def test_summary_is_made_on_post_and_read_from_cache(client, generated):
    node = {"node": "app.core:run_engine"}
    assert client.get("/api/summary", params=node).json() == {"summary": None, "stale": False, "available": True, "reason": None}
    assert generated == []

    assert client.post("/api/summary", params=node).json() == {"summary": "app/core.py::run_engine 요약 1", "usage": USAGE}
    system, prompt = generated[0]
    assert system == summary.system_prompt_of(None)
    assert prompt.startswith(
        "[대상]\n종류: 함수\n이름: app/core.py::run_engine\n위치: src/app/core.py 31~35줄\n\n[코드]\ndef run_engine(config: Config) -> Engine:"
    )
    assert '- app/cli.py::main · 호출\n    9:     config = Config("x")\n    10>     label = "엔진 시작"; run_engine(config)' in prompt
    assert "- app/core.py::Engine.start\n    def start(self, label: 'Config') -> Optional[Config]:" in prompt
    assert "- app/models.py::Config: name: str, retries: int" in prompt

    assert client.post("/api/summary", params=node).json() == {"summary": "app/core.py::run_engine 요약 1", "usage": None}
    assert client.get("/api/summary", params=node).json()["summary"] == "app/core.py::run_engine 요약 1"
    assert len(generated) == 1

    assert client.post("/api/summary", params={**node, "refresh": "true"}).json() == {"summary": "app/core.py::run_engine 요약 2", "usage": USAGE}
    assert client.get("/api/summary", params=node).json()["summary"] == "app/core.py::run_engine 요약 2"


def test_summaries_list_the_lead_of_every_kept_summary(client, generated, monkeypatch):
    assert client.get("/api/summaries").json() == {"summaries": []}

    async def generate(system, prompt):
        return Made(f"{name_in(prompt)}의 요지\n\n하는 일\n첫 문단\n\n앞뒤 흐름\n둘째 문단")

    monkeypatch.setattr(summary, "generate", generate)
    client.post("/api/summary", params={"node": "app.core:run_engine"})
    client.post("/api/summary", params={"node": "app.core"})
    client.app.state.summaries.latest.put(Subject(client.app.state.repo["root"], "node", "app.core:gone", "d"), "없는 노드")
    client.post("/api/explanation", params={"path": "src/app/core.py", "start": 32, "end": 33})
    assert client.get("/api/summaries").json() == {
        "summaries": [
            {"node": "app.core", "lead": "src/app/core.py의 요지"},
            {"node": "app.core:run_engine", "lead": "app/core.py::run_engine의 요지"},
        ]
    }


def test_explanation_is_made_listed_and_deleted(client, generated):
    path = "src/app/core.py"
    span = {"path": path, "start": 32, "end": 33}
    assert client.get("/api/explanations", params={"path": path}).json() == {"explanations": []}

    made = client.post("/api/explanation", params=span).json()
    assert made == {"start": 32, "end": 33, "question": "", "text": "src/app/core.py 32~33줄 설명 1", "stale": False, "usage": USAGE}
    system, prompt = generated[0]
    assert system == summary.system_prompt_of(None, "range")
    assert "범위가 든 정의: app/core.py::run_engine (함수, 31~35줄)" in prompt
    assert "[고른 범위의 코드]\n    engine = Engine(config)\n    engine.start(config)\n" in prompt
    assert "32>     engine = Engine(config)" in prompt and "- app/core.py::Engine.start" in prompt

    client.post("/api/explanation", params={"path": path, "start": 10, "end": 11})
    client.post("/api/explanation", params={"path": "src/app/cli.py", "start": 9, "end": 10})
    listed = client.get("/api/explanations", params={"path": path}).json()["explanations"]
    assert [(e["start"], e["end"], e["text"], e["stale"]) for e in listed] == [
        (10, 11, "src/app/core.py 10~11줄 설명 2", False),
        (32, 33, "src/app/core.py 32~33줄 설명 1", False),
    ]
    assert all(e["created"] for e in listed)

    again = client.post("/api/explanation", params=span).json()
    assert (again["text"], again["usage"]) == ("src/app/core.py 32~33줄 설명 1", None)
    assert len(generated) == 3
    assert client.post("/api/explanation", params={**span, "refresh": "true"}).json()["text"] == "src/app/core.py 32~33줄 설명 4"

    assert client.delete("/api/explanation", params=span).json() == {"deleted": True}
    assert [e["start"] for e in client.get("/api/explanations", params={"path": path}).json()["explanations"]] == [10]


def test_explanation_is_stale_after_the_range_code_changes(client, generated):
    path = "src/app/core.py"
    client.post("/api/explanation", params={"path": path, "start": 32, "end": 33})
    texts = client.app.state.analyzed.texts
    before = texts[path]
    texts[path] = before.replace("    engine.start(config)\n", "    engine.start(None)\n")
    try:
        (listed,) = client.get("/api/explanations", params={"path": path}).json()["explanations"]
    finally:
        texts[path] = before
    assert listed["stale"] is True and listed["text"] == "src/app/core.py 32~33줄 설명 1"


def test_explanation_with_a_question_is_kept_beside_the_others_of_the_same_range(client, generated):
    path = "src/app/core.py"
    span = {"path": path, "start": 32, "end": 33}
    plain = client.post("/api/explanation", params=span).json()
    assert plain["question"] == "" and "[질문]" not in generated[0][1]

    asked = client.post("/api/explanation", params=span, json={"question": "  config가 None이면?  "}).json()
    assert (asked["question"], asked["usage"]) == ("config가 None이면?", USAGE)
    assert generated[1][0] == summary.system_prompt_of(None, "range")
    assert "[질문]\nconfig가 None이면?\n\n[내기 전에 확인]" in generated[1][1]
    assert "[고른 범위의 코드]\n    engine = Engine(config)\n    engine.start(config)\n" in generated[1][1]
    client.post("/api/explanation", params=span, json={"question": "왜 start를 부르나?"})

    listed = client.get("/api/explanations", params={"path": path}).json()["explanations"]
    assert [(e["start"], e["end"], e["question"]) for e in listed] == [
        (32, 33, ""),
        (32, 33, "config가 None이면?"),
        (32, 33, "왜 start를 부르나?"),
    ]
    assert len({e["text"] for e in listed}) == 3

    again = client.post("/api/explanation", params=span, json={"question": "config가 None이면?"}).json()
    assert again["text"] == asked["text"] and again["usage"] is None and len(generated) == 3
    remade = client.post("/api/explanation", params={**span, "refresh": "true"}, json={"question": "config가 None이면?"}).json()
    assert remade["text"] != asked["text"] and len(generated) == 4

    assert client.delete("/api/explanation", params={**span, "question": "config가 None이면?"}).json() == {"deleted": True}
    left = client.get("/api/explanations", params={"path": path}).json()["explanations"]
    assert [e["question"] for e in left] == ["", "왜 start를 부르나?"]

    between = {"base": "a" * 40, "target": "worktree", "old_start": 40, "old_end": 40}
    client.post("/api/explanation", params={**span, **between}, json={"code": "-x\n+y", "question": "왜 바꿨나?"})
    client.post("/api/explanation", params={**span, **between}, json={"code": "-x\n+y"})
    compared = client.get("/api/explanations", params={"path": path, "base": "a" * 40, "target": "worktree"}).json()["compared"]
    assert [e["question"] for e in compared] == ["왜 바꿨나?", ""]
    client.delete("/api/explanation", params={**span, **between, "question": "왜 바꿨나?"})
    compared = client.get("/api/explanations", params={"path": path, "base": "a" * 40, "target": "worktree"}).json()["compared"]
    assert [e["question"] for e in compared] == [""]


def test_explanation_of_marked_code_keeps_added_ranges_on_the_file_and_deleted_ranges_on_the_comparison(client, generated):
    path = "src/app/core.py"
    between = {"base": "a" * 40, "target": "worktree"}

    added = "     engine = Engine(config)\n+    engine.start(config)"
    made = client.post("/api/explanation", params={"path": path, "start": 32, "end": 33}, json={"code": added}).json()
    assert (made["start"], made["end"]) == (32, 33)
    assert f"[고른 범위의 코드]\n{added}\n" in generated[0][1] and "[두 시점의 비교]" in generated[0][1]
    assert [e["start"] for e in client.get("/api/explanations", params={"path": path}).json()["explanations"]] == [32]

    mixed = "-    engine = Engine()\n+    engine = Engine(config)"
    span = {"path": path, "start": 32, "end": 32, **between, "old_start": 40, "old_end": 40}
    client.post("/api/explanation", params=span, json={"code": mixed})
    assert "위치: src/app/core.py 32~32줄 (기준 시점 40~40줄)" in generated[1][1]
    gone = {"path": "src/app/old.py", "start": 0, "end": 0, **between, "old_start": 3, "old_end": 4}
    client.post("/api/explanation", params=gone, json={"code": "-def gone():\n-    return 1"})
    assert "범위가 든 정의의 전체 코드" not in generated[2][1]

    listed = client.get("/api/explanations", params={"path": path, **between}).json()
    assert [e["start"] for e in listed["explanations"]] == [32]
    (kept,) = listed["compared"]
    assert {k: kept[k] for k in ("start", "end", "old_start", "old_end", "digest")} == {
        "start": 32, "end": 32, "old_start": 40, "old_end": 40, "digest": summary.digest_of(mixed)
    }
    assert kept["text"] and kept["created"]
    assert client.get("/api/explanations", params={"path": path, "base": "b" * 40, "target": "worktree"}).json()["compared"] == []
    removed = client.get("/api/explanations", params={"path": "src/app/old.py", **between}).json()
    assert removed["explanations"] == [] and [(e["old_start"], e["start"]) for e in removed["compared"]] == [(3, 0)]

    assert client.delete("/api/explanation", params=span).json() == {"deleted": True}
    assert client.get("/api/explanations", params={"path": path, **between}).json()["compared"] == []
    assert [e["start"] for e in client.get("/api/explanations", params={"path": path}).json()["explanations"]] == [32]


@pytest.mark.parametrize(
    "params",
    [
        {"path": "src/app/core.py", "start": 32, "end": 32, "base": "a" * 40, "target": "worktree"},
        {"path": "src/app/core.py", "start": 32, "end": 32, "base": "a" * 40, "target": "worktree", "old_start": 5, "old_end": 4},
    ],
)
def test_explanation_of_a_compared_range_needs_both_points_and_the_base_lines(client, generated, params):
    assert client.post("/api/explanation", params=params, json={"code": "-x"}).status_code == 422
    assert client.post("/api/explanation", params={**params, "old_start": 4, "old_end": 5}).status_code == 422
    assert generated == []


@pytest.mark.parametrize(
    "params",
    [
        {"path": "src/app/none.py", "start": 1, "end": 2},
        {"path": "src/app/core.py", "start": 0, "end": 0},
        {"path": "src/app/core.py", "start": 33, "end": 32},
        {"path": "src/app/core.py", "start": 30, "end": 999},
    ],
)
def test_explanation_of_unknown_range_is_not_found(client, generated, params):
    assert client.post("/api/explanation", params=params).status_code == 404
    assert generated == []


def test_explanations_of_unknown_file_is_not_found(client):
    assert client.get("/api/explanations", params={"path": "src/app/none.py"}).status_code == 404


def test_summary_made_before_the_code_changed_is_returned_as_stale(client, generated):
    node = {"node": "app.core:run_engine"}
    path = "src/app/core.py"
    client.post("/api/summary", params=node)
    assert client.get("/api/summary", params=node).json()["stale"] is False

    texts = client.app.state.analyzed.texts
    before = texts[path]
    texts[path] = before.replace("    engine.start(config)\n", "    engine.start(None)\n")
    try:
        changed = client.get("/api/summary", params=node).json()
        assert (changed["summary"], changed["stale"]) == ("app/core.py::run_engine 요약 1", True)
        assert len(generated) == 1
        assert client.post("/api/summary", params=node).json() == {"summary": "app/core.py::run_engine 요약 2", "usage": USAGE}
        again = client.get("/api/summary", params=node).json()
        assert (again["summary"], again["stale"]) == ("app/core.py::run_engine 요약 2", False)
    finally:
        texts[path] = before
    back = client.get("/api/summary", params=node).json()
    assert (back["summary"], back["stale"]) == ("app/core.py::run_engine 요약 1", False)
    other = client.get("/api/summary", params={"node": "app.core:helper"}).json()
    assert (other["summary"], other["stale"]) == (None, False)


def test_summary_of_method_and_file(client, generated):
    client.post("/api/summary", params={"node": "app.core:Engine.start"})
    client.post("/api/summary", params={"node": "app.core"})
    (_, method), (_, file) = generated
    assert name_in(method) == "app/core.py::Engine.start" and "\n[코드]\n    def start(self" in method
    assert "[대상이 든 클래스]\napp/core.py::Engine\n    class Engine:" in method
    assert file.startswith(
        "[대상]\n종류: 파일\n이름: src/app/core.py\n위치: src/app/core.py\n\n[최상위 정의의 시그니처 목록]\napp/core.py::helper\n    def helper(value):\napp/core.py::Engine\n    class Engine:\n"
    )
    assert "[이 파일을 쓰는 파일과 가져다 쓰는 이름]\n- src/app/" in file
    assert "[이 파일이 쓰는 파일과 가져다 쓰는 이름]\n- src/app/models.py: app/models.py::Config" in file


@pytest.fixture
def guided(module_repo, tmp_path, monkeypatch):
    """서술 규약 문서 경로를 준 서버, 그 경로, 가짜 `claude` 호출이 받은 (시스템 프롬프트, 프롬프트) 목록."""
    guide = tmp_path / "guide.md"
    calls: list[tuple[str, str]] = []

    async def generate(system, prompt):
        calls.append((system, prompt))
        return Made("요약")

    async def unavailable():
        return None

    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "generate", generate)
    monkeypatch.setattr(summary, "unavailable", unavailable)
    with TestClient(create_app(module_repo, sys.executable, style_guide=guide)) as client:
        yield analysed(client), guide, calls


def test_summary_reports_unreadable_style_guide_and_reads_it_for_every_request(guided):
    client, guide, calls = guided
    node = {"node": "app.core:helper"}
    body = client.get("/api/summary", params=node).json()
    assert (body["summary"], body["available"]) == (None, False) and str(guide) in body["reason"]
    response = client.post("/api/summary", params=node)
    assert response.status_code == 503 and "서술 규약 문서를 읽지 못했다" in response.json()["error"]
    assert calls == []

    guide.write_text("문장은 서술어로 끝낸다.")
    assert client.get("/api/summary", params=node).json() == {"summary": None, "stale": False, "available": True, "reason": None}
    assert client.post("/api/summary", params=node).json() == {"summary": "요약", "usage": None}
    assert "<서술 규약 문서>\n문장은 서술어로 끝낸다.\n</서술 규약 문서>" in calls[0][0]
    assert client.get("/api/summary", params=node).json()["summary"] == "요약"

    guide.write_text("고친 규약")
    changed = client.get("/api/summary", params=node).json()
    assert (changed["summary"], changed["stale"]) == ("요약", True)


def test_summary_reports_unavailable_cli(client, generated, monkeypatch):
    async def unavailable():
        return "Claude Code CLI를 찾지 못했다"

    monkeypatch.setattr(summary, "unavailable", unavailable)
    body = client.get("/api/summary", params={"node": "app.core:helper"}).json()
    assert body == {"summary": None, "stale": False, "available": False, "reason": "Claude Code CLI를 찾지 못했다"}


def test_summary_failure_is_503(client, generated, monkeypatch):
    async def generate(system, prompt):
        raise SummaryError("Claude Code CLI가 120초 안에 응답하지 않았다")

    monkeypatch.setattr(summary, "generate", generate)
    response = client.post("/api/summary", params={"node": "app.core:helper"})
    assert response.status_code == 503
    assert response.json() == {"error": "Claude Code CLI가 120초 안에 응답하지 않았다"}
    assert client.get("/api/summary", params={"node": "app.core:helper"}).json()["summary"] is None


@pytest.mark.parametrize("method", ["get", "post"])
@pytest.mark.parametrize("node", ["app.core:nope", "app", "ext:os"])
def test_summary_of_unknown_or_codeless_node_is_404(client, generated, method, node):
    response = getattr(client, method)("/api/summary", params={"node": node})
    assert response.status_code == 404
    assert "error" in response.json()
    assert generated == []


def test_changes_mark_changed_definitions_and_stale_files(changed, git_repo):
    body = changed.get("/api/changes").json()
    assert (body["git"], body["branch"]) == (True, "main")
    assert body["files"] == [
        {"path": "src/app/core.py", "status": "modified", "stale": False, "test": False},
        {"path": "src/app/extra.py", "status": "added", "stale": False, "test": False},
    ]
    assert body["nodes"] == {
        "app.core": "modified",
        "app.core:helper": "modified",
        "app.extra": "added",
        "app.extra:fresh": "added",
    }

    app = git_repo / "src" / "app"
    (app / "models.py").write_text("LIMIT = 3\n" + (app / "models.py").read_text())
    (app / "extra.py").write_text("def fresh():\n    return 2\n")
    (app / "late.py").write_text("def late():\n    return 1\n")
    (app / "cli.py").unlink()
    (git_repo / "notes.md").write_text("메모\n")
    (git_repo / ".tools").mkdir()
    (git_repo / ".tools" / "hidden.py").write_text("x = 1\n")
    (git_repo / "tests" / "test_late.py").write_text("def test_late():\n    pass\n")
    body = changed.get("/api/changes").json()
    assert body["files"] == [
        {"path": "src/app/cli.py", "status": "deleted", "stale": True, "test": False},
        {"path": "src/app/core.py", "status": "modified", "stale": False, "test": False},
        {"path": "src/app/extra.py", "status": "added", "stale": True, "test": False},
        {"path": "src/app/late.py", "status": "added", "stale": True, "test": False},
        {"path": "src/app/models.py", "status": "modified", "stale": True, "test": False},
        {"path": "tests/test_late.py", "status": "added", "stale": True, "test": True},
    ]
    assert body["nodes"] == {
        "app.core": "modified",
        "app.core:helper": "modified",
        "app.extra": "added",
        "app.models": "modified",
    }
    assert "LIMIT" not in changed.get("/api/file", params={"path": "src/app/models.py"}).json()["text"]
    assert "엔진 시작" in changed.get("/api/file", params={"path": "src/app/cli.py"}).json()["text"]


def test_files_changed_after_analysis_stay_stale_after_commit(changed, git_repo):
    app = git_repo / "src" / "app"
    (app / "models.py").write_text("LIMIT = 3\n" + (app / "models.py").read_text())
    (app / "cli.py").unlink()
    (app / "core.py").write_text((app / "core.py").read_text())  # 내용은 같고 수정 시각만 바뀐다
    git(git_repo, "add", "-A")
    git(git_repo, "commit", "-q", "-m", "분석 뒤 커밋")
    body = changed.get("/api/changes").json()
    assert (body["git"], body["branch"]) == (True, "main")
    assert body["files"] == [
        {"path": "src/app/cli.py", "status": "unchanged", "stale": True, "test": False},
        {"path": "src/app/models.py", "status": "unchanged", "stale": True, "test": False},
    ]
    assert body["nodes"] == {}


def test_changes_outside_git_list_only_stale_files(client, module_repo):
    assert client.get("/api/changes").json() == {"git": False, "branch": None, "files": [], "nodes": {}}
    models = module_repo / "src" / "app" / "models.py"
    text = models.read_text()
    try:
        models.write_text("LIMIT = 3\n" + text)
        assert client.get("/api/changes").json() == {
            "git": False,
            "branch": None,
            "files": [{"path": "src/app/models.py", "status": "unchanged", "stale": True, "test": False}],
            "nodes": {},
        }
    finally:
        models.write_text(text)
    assert client.get("/api/changes").json()["files"] == []


def add_function(repo) -> None:
    """고정 레포의 `core.py` 끝에 함수 `added`를 더한다."""
    core = repo / "src" / "app" / "core.py"
    core.write_text(core.read_text() + "\n\ndef added():\n    return helper(1)\n")


@pytest.mark.asyncio
async def test_reload_replaces_the_analysis_and_keeps_the_session(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    monkeypatch.setattr(api, "STALE_MEMO", 0.0)
    app = create_app(sample_repo, sys.executable)
    async with app.router.lifespan_context(app):
        await app.state.running
        state = app.state
        before, first = state.graph, await state.runner.session()
        assert "app.core:added" not in state.nodes
        assert (await call(app, "GET", "/api/status", {}))[1]["stale"] == {"count": 0, "paths": []}
        add_function(sample_repo)
        _, changed = await call(app, "GET", "/api/changes", {})
        assert [f["path"] for f in changed["files"] if f["stale"]] == ["src/app/core.py"]
        assert (await call(app, "GET", "/api/status", {}))[1]["stale"] == {"count": 1, "paths": ["src/app/core.py"]}

        status, body = await call(app, "POST", "/api/reload", {})
        assert status == 200 and body == state.repo
        assert state.graph is not before and "app.core:added" in state.nodes
        assert any(e["source"] == "app.core:added" and e["target"] == "app.core:helper" for e in state.graph["edges"])
        _, file = await call(app, "GET", "/api/file", {"path": "src/app/core.py"})
        assert file["text"].endswith("def added():\n    return helper(1)\n")
        _, changed = await call(app, "GET", "/api/changes", {})
        assert not any(f["stale"] for f in changed["files"])
        _, status = await call(app, "GET", "/api/status", {})
        assert (status["phase"], status["revision"], status["stale"]) == ("ready", 2, {"count": 0, "paths": []})
        line = file["text"].splitlines().index("def added():") + 2
        status, found = await call(app, "GET", "/api/definition", {"path": "src/app/core.py", "line": line, "col": 11})
        assert status == 200 and found["targets"][0]["node"] == "app.core:helper"
        assert await state.runner.session() is first and not first.stopped
    assert first.stopped and group_ended(first.client._server.pid)


@pytest.mark.asyncio
async def test_status_counts_files_whose_content_changed_since_the_analysis(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    app = create_app(sample_repo, sys.executable)
    source = sample_repo / "src" / "app"

    async def stale() -> dict:
        return (await call(app, "GET", "/api/status", {}))[1]["stale"]

    async with app.router.lifespan_context(app):
        await app.state.running
        monkeypatch.setattr(api, "STALE_MEMO", 0.0)
        (source / "core.py").write_text((source / "core.py").read_text())  # 내용은 같고 수정 시각만 바뀐다
        (sample_repo / "ignored_dir" / "more.py").write_text("x = 1\n")
        (sample_repo / "notes.md").write_text("메모\n")
        assert await stale() == {"count": 0, "paths": []}

        for name in ("a", "b", "c", "d"):
            (source / f"{name}.py").write_text("x = 1\n")
        (source / "models.py").write_text("LIMIT = 3\n" + (source / "models.py").read_text())
        (source / "cli.py").unlink()
        (sample_repo / "tests" / "test_late.py").write_text("def test_late():\n    pass\n")
        assert await stale() == {
            "count": 7,
            "paths": ["src/app/a.py", "src/app/b.py", "src/app/c.py", "src/app/cli.py", "src/app/d.py"],
        }

        counted = []
        found = app.state.analyzed.stale
        monkeypatch.setattr(app.state.analyzed, "stale", lambda: counted.append(1) or found())
        monkeypatch.setattr(api, "STALE_MEMO", 60.0)
        (source / "e.py").write_text("x = 1\n")
        assert (await stale())["count"] == 7 and counted == []  # 기억 시간 안에는 다시 세지 않는다
        monkeypatch.setattr(api, "STALE_MEMO", 0.0)
        assert (await stale())["count"] == 8 and counted == [1]

        held = asyncio.Event()
        refresh = runner.refresh

        async def slow(*args, **options):
            await held.wait()
            return await refresh(*args, **options)

        monkeypatch.setattr(runner, "refresh", slow)
        reloading = asyncio.create_task(call(app, "POST", "/api/reload", {}))
        await asyncio.sleep(0.05)
        assert (await stale())["count"] == 8  # 다시 분석하는 동안에는 앞의 판을 기준으로 센다
        held.set()
        assert (await reloading)[0] == 200
        assert await stale() == {"count": 0, "paths": []}


@pytest.mark.asyncio
async def test_reloads_asked_together_analyze_once(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    refresh = runner.refresh
    runs = []

    async def counted(*args, **options):
        runs.append(options["previous"])
        return await refresh(*args, **options)

    monkeypatch.setattr(runner, "refresh", counted)
    app = create_app(sample_repo, sys.executable)
    async with app.router.lifespan_context(app):
        await app.state.running
        first = app.state.analyzed
        assert runs == [None]
        add_function(sample_repo)
        replies = await asyncio.gather(*(call(app, "POST", "/api/reload", {}) for _ in range(3)))
        assert [status for status, _ in replies] == [200, 200, 200]
        assert runs == [None, first] and "app.core:added" in app.state.nodes and app.state.revision == 2
        await call(app, "POST", "/api/reload", {})
        assert len(runs) == 3 and app.state.revision == 3


@pytest.mark.asyncio
async def test_failed_reload_keeps_the_previous_analysis(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    app = create_app(sample_repo, sys.executable)
    async with app.router.lifespan_context(app):
        await app.state.running
        state = app.state
        before, first = state.graph, await state.runner.session()
        add_function(sample_repo)

        async def fail(repo, python, session, **options):
            (await session(options["previous"].files, options["previous"].env)).sync_files({})
            raise RuntimeError("분석이 멈췄다")

        with monkeypatch.context() as patch:
            patch.setattr(runner, "refresh", fail)
            status, body = await call(app, "POST", "/api/reload", {})
        assert status == 500 and body == {"error": "다시 분석하지 못했다: 분석이 멈췄다"}
        assert state.graph is before and state.revision == 1
        _, status = await call(app, "GET", "/api/status", {})
        assert (status["phase"], status["error"]) == ("ready", None)
        status, hover = await call(app, "GET", "/api/hover", RUN_ENGINE_CALL)
        assert status == 200 and hover["range"] == [10, 21, 10, 31]
        assert await state.runner.session() is first and not first.stopped

        status, _ = await call(app, "POST", "/api/reload", {})
        assert status == 200 and "app.core:added" in state.nodes and state.revision == 2


PRICING = "src/shop/pricing.py"


@pytest.fixture(scope="module")
def history_client(module_history, tmp_path_factory):
    """이력이 있는 고정 레포를 연 서버와 단계 이름표별 커밋 해시. 시험은 레포를 고치지 않는다."""
    repo, at = module_history
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(summary, "CACHE_PATH", tmp_path_factory.mktemp("cache") / "summaries.db")
        patch.setattr(summary, "find_cli", lambda: None)
        with TestClient(create_app(repo, sys.executable)) as client:
            yield analysed(client), at


def stat(client, a: str, b: str) -> dict:
    response = client.get("/api/compare/stat", params={"a": a, "b": b})
    assert response.status_code == 200, response.json()
    return response.json()


def compared(client, base: str, target: str) -> dict:
    response = client.post("/api/compare", json={"base": base, "target": target})
    assert response.status_code == 200, response.json()
    return response.json()


def rows(entries: list[dict]) -> dict[str, dict]:
    """파일트리의 경로 → 행."""
    found: dict[str, dict] = {}
    for e in entries:
        found[e["path"]] = e
        found.update(rows(e.get("children", [])))
    return found


def test_history_lists_the_commit_graph(history_client):
    client, at = history_client
    body = client.get("/api/history").json()
    order = [at[k] for k in ("topic", "merge", "move", "feature", "edit", "base")]
    assert (body["git"], body["head"], body["branch"], body["default"]) == (True, at["merge"], "main", at["merge"])
    assert body["dirty"] is True and body["more"] is False
    assert [c["hash"] for c in body["commits"]] == order
    assert body["commits"][1] == {
        "hash": at["merge"],
        "parents": [at["move"], at["feature"]],
        "time": 1_750_014_400,
        "subject": "쿠폰을 합친다",
        "refs": ["main"],
    }
    assert body["commits"][4]["refs"] == ["v0.1"]
    page = client.get("/api/history", params={"skip": 1, "limit": 2}).json()
    assert [c["hash"] for c in page["commits"]] == order[1:3] and page["more"] is True
    assert client.get("/api/history", params={"skip": 4, "limit": 2}).json()["more"] is False


def test_stat_arranges_base_target_and_fork(history_client):
    client, at = history_client
    forward = stat(client, at["edit"], at["merge"])
    assert (forward["base"], forward["target"], forward["fork"]) == (at["edit"], at["merge"], None)
    assert stat(client, at["merge"], at["edit"]) == forward
    assert (forward["files"], forward["added"], forward["deleted"]) == (4, 9, 12)

    apart = stat(client, at["merge"], at["topic"])  # 갈라진 두 브랜치. 새 쪽이 대상이다
    assert (apart["base"], apart["target"], apart["fork"]) == (at["move"], at["topic"], at["move"])
    assert stat(client, at["topic"], at["merge"]) == apart
    assert (apart["files"], apart["added"], apart["deleted"]) == (1, 1, 1)

    dirty = stat(client, "worktree", at["merge"])
    assert (dirty["base"], dirty["target"], dirty["fork"]) == (at["merge"], "worktree", None)
    assert stat(client, at["merge"], "worktree") == dirty
    assert (dirty["files"], dirty["added"], dirty["deleted"]) == (2, 7, 0)

    aside = stat(client, at["topic"], "worktree")  # 지금 커밋의 조상이 아닌 커밋과 작업 중인 상태
    assert (aside["base"], aside["target"], aside["fork"]) == (at["move"], "worktree", at["move"])


@pytest.mark.parametrize(
    ("a", "b", "code"),
    [("worktree", "worktree", 400), ("main", "worktree", 400), ("--all", "worktree", 400), ("0" * 40, "worktree", 404)],
)
def test_stat_of_bad_moments(history_client, a, b, code):
    client, at = history_client
    a = at["edit"] if a == b == "edit" else a
    response = client.get("/api/compare/stat", params={"a": a, "b": b})
    assert response.status_code == code and "error" in response.json()
    assert client.get("/api/compare/stat", params={"a": at["edit"], "b": at["edit"]}).status_code == 400
    assert client.post("/api/compare", json={"base": "worktree", "target": at["edit"]}).status_code == 400
    assert client.post("/api/compare", json={"base": at["edit"], "target": at["edit"]}).status_code == 400
    assert client.post("/api/compare", json={"base": "0" * 40, "target": "worktree"}).status_code == 404


def test_compare_with_the_worktree_adds_deleted_nodes_edges_and_files(history_client):
    client, at = history_client
    counted = stat(client, at["edit"], "worktree")
    body = compared(client, at["edit"], "worktree")
    assert (body["base"], body["target"]) == (at["edit"], "worktree")
    assert body["revision"] == client.get("/api/status").json()["revision"]
    assert client.get("/api/status").json()["compare"] is None

    files = {f["path"]: f for f in body["files"]}
    assert len(files) == counted["files"]
    assert (sum(f["added"] for f in body["files"]), sum(f["deleted"] for f in body["files"])) == (
        counted["added"],
        counted["deleted"],
    )
    assert files["src/shop/audit.py"] == {
        "path": "src/shop/audit.py", "old": None, "status": "deleted", "added": 0, "deleted": 8, "test": False,
    }  # fmt: skip
    assert files["src/shop/inventory.py"]["old"] == "src/shop/stock.py"
    assert files["src/shop/notes.py"]["status"] == "added"

    nodes = {n["id"]: n for n in body["graph"]["nodes"]}
    live = {n["id"] for n in client.get("/api/graph").json()["nodes"]}
    changes = body["nodes"]
    assert changes["shop.audit"]["change"] == "deleted" and changes["shop.audit:log"]["change"] == "deleted"
    assert changes["shop.pricing:tax"] == {"change": "modified", "added": 2, "deleted": 0}
    assert changes["shop.notes:remind"]["change"] == "added"
    assert changes["shop.inventory:available"] == {"change": "modified", "added": 1, "deleted": 1}
    assert "shop.inventory:reserve" not in changes and "shop.stock:reserve" not in nodes
    assert set(nodes) - live == {id for id, c in changes.items() if c["change"] == "deleted" or c.get("only") == "base"}
    assert nodes["shop.audit:log"]["path"] == "src/shop/audit.py" and nodes["shop.audit:log"]["range"] == [6, 8]
    assert all(n["parent"] is None or n["parent"] in nodes for n in nodes.values())
    top = [id for id, n in nodes.items() if n["parent"] is None and n["kind"] != "external"]
    assert sum(changes[id]["added"] for id in top if id in changes) == counted["added"]

    edges = {f"{e['source']}|{e['target']}|{e['kind']}" for e in body["graph"]["edges"]}
    assert set(body["edges"]) <= edges
    assert body["edges"]["shop.orders:checkout|shop.audit:log|call"] == {"change": "deleted", "before": None}
    assert body["edges"]["shop.notes:remind|shop.report:render|call"] == {"change": "added", "before": None}
    assert "shop.orders:checkout|shop.inventory:reserve|call" not in body["edges"]  # 이름만 바뀐 파일의 정의로 가는 선

    tree = rows(body["tree"]["entries"])
    assert tree["src/shop/audit.py"]["node"] == "shop.audit" and "src/shop/stock.py" not in tree
    assert set(tree) - set(rows(client.get("/api/tree").json()["entries"])) == {"src/shop/audit.py"}
    assert body["unused"] == client.get("/api/unused").json()
    assert compared(client, at["edit"], "worktree") == body


def test_file_at_a_compared_commit(history_client):
    client, at = history_client
    compared(client, at["edit"], "worktree")
    deleted = client.get("/api/file", params={"path": "src/shop/audit.py", "at": at["edit"]}).json()
    assert deleted["text"].startswith("from shop.report import fmt\n")
    renamed = client.get("/api/file", params={"path": "src/shop/stock.py", "at": at["edit"]}).json()
    assert "LEVELS.get(item, 0) > 0" in renamed["text"]
    now = client.get("/api/file", params={"path": PRICING}).json()["text"]
    then = client.get("/api/file", params={"path": PRICING, "at": at["edit"]}).json()["text"]
    assert "amount < 0" in now and "amount < 0" not in then
    assert client.get("/api/file", params={"path": PRICING, "at": "worktree"}).json()["text"] == now
    assert client.get("/api/file", params={"path": "src/shop/audit.py"}).status_code == 404
    assert client.get("/api/file", params={"path": "src/shop/notes.py", "at": at["edit"]}).status_code == 404
    assert client.get("/api/file", params={"path": PRICING, "at": at["topic"]}).status_code == 404  # 비교에 쓰지 않은 커밋


def test_file_at_a_commit_dropped_from_memory_is_read_again(history_client):
    client, at = history_client
    compared(client, at["base"], "worktree")
    compared(client, at["edit"], at["move"])
    assert client.app.state.snapshots.held(at["base"]) is None
    old = client.get("/api/file", params={"path": PRICING, "at": at["base"]})
    assert old.status_code == 200 and "legacy_total" in old.json()["text"]


def test_compare_of_two_commits_judges_definitions_and_edges(history_client):
    client, at = history_client
    counted = stat(client, at["base"], at["edit"])
    body = compared(client, at["base"], at["edit"])
    assert (body["base"], body["target"], body["revision"]) == (at["base"], at["edit"], 0)
    changes = body["nodes"]
    assert changes["shop.pricing:rounded"]["change"] == "added"
    assert changes["shop.pricing:legacy_total"] == {"change": "deleted", "added": 0, "deleted": 2, "slot": 17}
    assert changes["shop.pricing:total"]["change"] == "modified"
    assert "shop.pricing:tax" not in changes and "shop.pricing:discount" not in changes  # 줄만 밀렸다
    assert body["edges"]["shop.pricing:total|shop.pricing:tax|call"] == {"change": None, "before": 1}
    assert body["edges"]["shop.pricing:total|shop.pricing:rounded|call"] == {"change": "added", "before": None}
    assert body["edges"]["shop.orders:refund|shop.pricing:legacy_total|call"] == {"change": "deleted", "before": None}
    assert [(f["path"], f["status"]) for f in body["files"]] == [(PRICING, "modified"), ("src/shop/orders.py", "modified")] or [
        (f["path"], f["status"]) for f in body["files"]
    ] == [("src/shop/orders.py", "modified"), (PRICING, "modified")]
    assert (sum(f["added"] for f in body["files"]), sum(f["deleted"] for f in body["files"])) == (
        counted["added"],
        counted["deleted"],
    )
    ids = {n["id"] for n in body["graph"]["nodes"]}
    assert {"shop.audit:log", "shop.stock:reserve", "shop.pricing:legacy_total"} <= ids
    assert "shop.notes:remind" not in ids and "shop.inventory:reserve" not in ids  # 작업 중인 상태에만 있다
    assert "src/shop/stock.py" in rows(body["tree"]["entries"])


def test_summaries_follow_the_shown_commit(history_client, tmp_path, monkeypatch):
    client, at = history_client
    calls: list[str] = []

    async def generate(system, prompt):
        calls.append(prompt)
        return Made(f"요약 {len(calls)}", USED)

    async def unavailable():
        return None

    monkeypatch.setattr(summary, "generate", generate)
    monkeypatch.setattr(summary, "explain", generate)
    monkeypatch.setattr(summary, "unavailable", unavailable)
    monkeypatch.setattr(client.app.state, "summaries", Summaries(tmp_path / "summaries.db"))
    past, gone, both = {"node": "shop.audit:log"}, {"node": "shop.pricing:legacy_total"}, {"node": "shop.pricing:tax"}

    client.get("/api/graph")
    assert client.get("/api/summary", params=past).status_code == 404
    compared(client, at["base"], at["edit"])  # 대상이 커밋이다. `audit.py`는 그 커밋에 있고 작업 중인 상태에 없다
    assert client.get("/api/summary", params=past).json()["summary"] is None
    made = client.post("/api/summary", params=past)
    assert made.status_code == 200 and made.json()["summary"] == "요약 1"
    assert "ENTRIES.append(fmt(amount))" in calls[0]
    assert client.post("/api/summary", params=gone).status_code == 404  # 삭제된 정의는 대상 시점에 없다
    assert client.post("/api/summary", params=both).json()["summary"] == "요약 2"
    assert "amount < 0" not in calls[1]  # 작업 중인 상태의 본문이 아니다
    assert [s["node"] for s in client.get("/api/summaries").json()["summaries"]] == ["shop.audit:log", "shop.pricing:tax"]
    explained = client.post("/api/explanation", params={"path": "src/shop/audit.py", "start": 6, "end": 8})
    assert explained.status_code == 200
    assert len(client.get("/api/explanations", params={"path": "src/shop/audit.py"}).json()["explanations"]) == 1

    client.get("/api/graph")  # 화면이 비교를 끄면 작업 중인 상태의 그래프를 다시 받는다
    assert client.get("/api/summary", params=past).status_code == 404
    assert client.get("/api/explanations", params={"path": "src/shop/audit.py"}).status_code == 404
    assert client.get("/api/summary", params=both).json() == {
        "summary": "요약 2", "stale": True, "available": True, "reason": None,
    }  # fmt: skip
    assert [s["node"] for s in client.get("/api/summaries").json()["summaries"]] == ["shop.pricing:tax"]

    compared(client, at["base"], at["edit"])
    compared(client, at["edit"], "worktree")  # 대상이 작업 중인 상태인 비교도 작업 중인 상태를 보인다
    assert client.get("/api/summary", params=past).status_code == 404


def test_compare_routes_outside_git(client):
    assert client.get("/api/history").json() == {
        "git": False, "head": None, "branch": None, "default": None, "dirty": False, "commits": [], "more": False,
    }  # fmt: skip
    assert client.get("/api/compare/stat", params={"a": "worktree", "b": "0" * 40}).status_code == 404
    assert client.post("/api/compare", json={"base": "0" * 40, "target": "worktree"}).status_code == 404
    assert client.app.state.snapshots is None


@pytest.mark.asyncio
async def test_compare_task_reports_progress_joins_and_gives_way(history_repo, tmp_path, monkeypatch):
    import httpx

    repo, at = history_repo
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    app = create_app(repo, sys.executable)
    release = asyncio.Event()
    entered: list[str] = []
    real = snapshot.Snapshots.at

    async def held(self, commit, near, report=lambda progress: None):
        entered.append(commit)
        report(api.Progress("resolve", 3, 7))
        await release.wait()
        return await real(self, commit, near, report)

    async with app.router.lifespan_context(app):
        await app.state.running
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:

            def post(base, target):
                return asyncio.ensure_future(client.post("/api/compare", json={"base": at[base], "target": target}))

            async def until(count):
                while len(entered) < count:
                    await asyncio.sleep(0.01)

            monkeypatch.setattr(snapshot.Snapshots, "at", held)
            first, same = post("edit", "worktree"), post("edit", "worktree")
            await until(1)
            await asyncio.sleep(0.05)
            assert entered == [at["edit"]]  # 같은 두 시점의 요청은 한 번만 분석한다
            assert (await client.get("/api/status")).json()["compare"] == {"phase": "resolve", "done": 3, "total": 7}
            other = post("base", "worktree")
            await until(2)
            stopped = [await first, await same]
            assert [r.status_code for r in stopped] == [409, 409] and "error" in stopped[0].json()
            assert (await client.get("/api/status")).json()["compare"] is not None  # 뒤의 비교가 돌고 있다
            release.set()
            done = await other
            assert done.status_code == 200 and done.json()["base"] == at["base"]
            assert (await client.get("/api/status")).json()["compare"] is None

            async def failing(self, commit, near, report=lambda progress: None):
                raise RuntimeError("분석이 멈췄다")

            monkeypatch.setattr(snapshot.Snapshots, "at", failing)
            failed = await client.post("/api/compare", json={"base": at["move"], "target": "worktree"})
            assert failed.status_code == 500 and failed.json() == {"error": "비교하지 못했다: 분석이 멈췄다"}
            assert (await client.get("/api/status")).json()["compare"] is None
            monkeypatch.setattr(snapshot.Snapshots, "at", real)
            again = await client.post("/api/compare", json={"base": at["move"], "target": "worktree"})
            assert again.status_code == 200
        folder = app.state.snapshots.directory
    assert not folder.exists()


@pytest.mark.asyncio
async def test_worktree_compare_waits_for_the_reload(history_repo, tmp_path, monkeypatch):
    import httpx

    repo, at = history_repo
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    app = create_app(repo, sys.executable)
    async with app.router.lifespan_context(app):
        await app.state.running
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            (repo / "src/shop/notes.py").write_text("def later():\n    return 1\n")
            reloading = asyncio.ensure_future(client.post("/api/reload"))
            await asyncio.sleep(0)
            body = (await client.post("/api/compare", json={"base": at["merge"], "target": "worktree"})).json()
            assert (await reloading).status_code == 200
            assert body["revision"] == 2 and body["nodes"]["shop.notes:later"]["change"] == "added"

            # 분석한 뒤 바뀐 파일이 있으면 다시 분석한 결과로 견준다.
            (repo / PRICING).write_text((repo / PRICING).read_text() + "\n\ndef unsaved():\n    return 0\n")
            (repo / "src/shop/fresh.py").write_text("def new():\n    return 1\n")
            counted = (await client.get("/api/compare/stat", params={"a": at["merge"], "b": "worktree"})).json()
            body = (await client.post("/api/compare", json={"base": at["merge"], "target": "worktree"})).json()
            assert body["revision"] == 3 and (await client.get("/api/status")).json()["revision"] == 3
            assert body["nodes"]["shop.pricing:unsaved"]["change"] == "added"
            assert body["nodes"]["shop.fresh:new"] == {"change": "added", "added": 2, "deleted": 0}
            assert body["nodes"]["shop"]["added"] == counted["added"] == sum(f["added"] for f in body["files"])

            # 다시 분석하지 못하면 앞의 결과로 견주고 바뀐 파일은 파일의 줄 수만 낸다.
            (repo / PRICING).write_text((repo / PRICING).read_text() + "\n\ndef later():\n    return 0\n")

            async def fail(repo, python, session, **options):
                raise RuntimeError("분석이 멈췄다")

            monkeypatch.setattr(runner, "refresh", fail)
            stale = (await client.post("/api/compare", json={"base": at["merge"], "target": "worktree"})).json()
            assert stale["revision"] == 3 and "shop.pricing:later" not in stale["nodes"]
            assert stale["nodes"]["shop.pricing"] == {"change": "modified", "added": 10, "deleted": 0}
            assert "shop.pricing:tax" not in stale["nodes"]
