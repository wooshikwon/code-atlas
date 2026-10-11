import asyncio
import json
import shutil
import subprocess
import sys
import time
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient

from conftest import FIXTURE, git, group_ended

from code_atlas import api, summary
from code_atlas.api import create_app
from code_atlas.summary import Summaries, SummaryError

RUN_ENGINE_CALL = {"path": "src/app/cli.py", "line": 10, "col": 21}  # 한글 문자열 뒤의 run_engine


def name_in(prompt: str) -> str:
    """요약 프롬프트의 `이름:` 줄에 적힌 이름."""
    return prompt.split("\n이름: ", 1)[1].split("\n", 1)[0]


@pytest.fixture(scope="module")
def client(module_repo, tmp_path_factory):
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(summary, "CACHE_PATH", tmp_path_factory.mktemp("cache") / "summaries.db")
        patch.setattr(summary, "find_cli", lambda: None)
        with TestClient(create_app(module_repo, sys.executable)) as client:
            yield client


@pytest.fixture
def generated(client, tmp_path, monkeypatch):
    """빈 요약 캐시로 바꾸고 `claude` 호출을 가짜로 바꾼다. 가짜가 받은 (시스템 프롬프트, 프롬프트)를 돌려준 목록에 담는다."""
    calls: list[tuple[str, str]] = []

    async def generate(system, prompt):
        calls.append((system, prompt))
        return f"{name_in(prompt)} 요약 {len(calls)}"

    async def unavailable():
        return None

    async def explain(system, prompt):
        calls.append((system, prompt))
        return f"{prompt.split(chr(10) + '위치: ', 1)[1].split(chr(10), 1)[0]} 설명 {len(calls)}"

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
            yield client


def test_repo(client):
    body = client.get("/api/repo").json()
    assert body["name"] == "sample_repo"
    assert body["source_root"] == "src"
    assert body["python"] == sys.executable
    assert body["stats"]["files"] == 10
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
            yield client


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


def test_unused(client):
    body = client.get("/api/unused").json()
    assert body == {"definitions": 21, "candidates": ["app.core:spare", "app.models:Point", "app.models:Color", "app.shadow:announce"]}
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
    stopped = state.session
    subprocess.run(["pkill", "-KILL", "-P", str(stopped.client._server.pid)], check=True)
    deadline = time.monotonic() + 10
    while not stopped.stopped and time.monotonic() < deadline:
        time.sleep(0.05)
    assert stopped.stopped

    def fail(*args):
        raise OSError("basedpyright-langserver를 띄우지 못했다")

    with monkeypatch.context() as patch:
        patch.setattr(api, "Session", fail)
        response = client.get("/api/hover", params=RUN_ENGINE_CALL)
        assert response.status_code == 503
        assert "error" in response.json()

    body = client.get("/api/hover", params=RUN_ENGINE_CALL).json()
    assert body["range"] == [10, 21, 10, 31]
    assert state.session is not stopped and not state.session.stopped


@pytest.mark.asyncio
async def test_cancelled_start_ends_the_session_and_leaves_the_app_empty(sample_repo, monkeypatch):
    sessions = []

    async def analyze_async(files, session):
        sessions.append(session)
        app.state.starting.get_loop().call_soon(app.state.starting.cancel)
        await asyncio.Event().wait()

    monkeypatch.setattr(api, "analyze_async", analyze_async)
    app = create_app(sample_repo, sys.executable)
    started = time.monotonic()
    async with app.router.lifespan_context(app):
        assert not hasattr(app.state, "analyzed")
    assert time.monotonic() - started < 5
    [session] = sessions
    assert session.stopped and group_ended(session.client._server.pid)


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
        return f"{name_in(prompt)} 요약"

    async def unavailable():
        return None

    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "generate", generate)
    monkeypatch.setattr(summary, "unavailable", unavailable)
    app = create_app(sample_repo, sys.executable)
    async with app.router.lifespan_context(app):
        nodes = ["app.core:helper", "app.core:run_engine", "app.core:Engine.start"]
        gone = [asyncio.Event() for _ in nodes]
        posts = [
            asyncio.create_task(call(app, "POST", "/api/summary", {"node": node}, left))
            for node, left in zip(nodes, gone)
        ]
        await asyncio.sleep(0.1)
        assert made == ["app/core.py::helper", "app/core.py::run_engine"]

        gone[0].set()
        gone[2].set()
        assert (await posts[0])[0] == (await posts[2])[0] == 499
        release.set()
        assert await posts[1] == (200, {"summary": "app/core.py::run_engine 요약"})
        await asyncio.sleep(0.1)
        assert made == ["app/core.py::helper", "app/core.py::run_engine"]
        _, cached = await call(app, "GET", "/api/summary", {"node": nodes[0]})
        assert cached["summary"] == "app/core.py::helper 요약"
        _, skipped = await call(app, "GET", "/api/summary", {"node": nodes[2]})
        assert skipped["summary"] is None


def test_summary_is_made_on_post_and_read_from_cache(client, generated):
    node = {"node": "app.core:run_engine"}
    assert client.get("/api/summary", params=node).json() == {"summary": None, "stale": False, "available": True, "reason": None}
    assert generated == []

    assert client.post("/api/summary", params=node).json() == {"summary": "app/core.py::run_engine 요약 1"}
    system, prompt = generated[0]
    assert system == summary.system_prompt_of(None)
    assert prompt.startswith(
        "[대상]\n종류: 함수\n이름: app/core.py::run_engine\n위치: src/app/core.py 31~35줄\n\n[코드]\ndef run_engine(config: Config) -> Engine:"
    )
    assert '- app/cli.py::main · 호출\n    9:     config = Config("x")\n    10>     label = "엔진 시작"; run_engine(config)' in prompt
    assert "- app/core.py::Engine.start\n    def start(self, label: 'Config') -> Optional[Config]:" in prompt
    assert "- app/models.py::Config: name: str, retries: int" in prompt

    assert client.post("/api/summary", params=node).json() == {"summary": "app/core.py::run_engine 요약 1"}
    assert client.get("/api/summary", params=node).json()["summary"] == "app/core.py::run_engine 요약 1"
    assert len(generated) == 1

    assert client.post("/api/summary", params={**node, "refresh": "true"}).json() == {"summary": "app/core.py::run_engine 요약 2"}
    assert client.get("/api/summary", params=node).json()["summary"] == "app/core.py::run_engine 요약 2"


def test_explanation_is_made_listed_and_deleted(client, generated):
    path = "src/app/core.py"
    span = {"path": path, "start": 32, "end": 33}
    assert client.get("/api/explanations", params={"path": path}).json() == {"explanations": []}

    made = client.post("/api/explanation", params=span).json()
    assert made == {"start": 32, "end": 33, "text": "src/app/core.py 32~33줄 설명 1", "stale": False}
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

    assert client.post("/api/explanation", params=span).json()["text"] == "src/app/core.py 32~33줄 설명 1"
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


@pytest.mark.parametrize(
    "params",
    [
        {"path": "src/app/none.py", "start": 1, "end": 2},
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
        assert client.post("/api/summary", params=node).json() == {"summary": "app/core.py::run_engine 요약 2"}
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
        return "요약"

    async def unavailable():
        return None

    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "generate", generate)
    monkeypatch.setattr(summary, "unavailable", unavailable)
    with TestClient(create_app(module_repo, sys.executable, style_guide=guide)) as client:
        yield client, guide, calls


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
    assert client.post("/api/summary", params=node).json() == {"summary": "요약"}
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
        {"path": "src/app/late.py", "status": "added", "stale": False, "test": False},
        {"path": "src/app/models.py", "status": "modified", "stale": True, "test": False},
        {"path": "tests/test_late.py", "status": "added", "stale": False, "test": True},
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
async def test_reload_replaces_the_analysis_and_ends_the_previous_session(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    app = create_app(sample_repo, sys.executable)
    async with app.router.lifespan_context(app):
        state = app.state
        before, first = state.graph, state.session
        assert "app.core:added" not in state.nodes
        add_function(sample_repo)
        _, changed = await call(app, "GET", "/api/changes", {})
        assert [f["path"] for f in changed["files"] if f["stale"]] == ["src/app/core.py"]

        status, body = await call(app, "POST", "/api/reload", {})
        assert status == 200 and body == state.repo
        assert state.graph is not before and "app.core:added" in state.nodes
        assert any(e["source"] == "app.core:added" and e["target"] == "app.core:helper" for e in state.graph["edges"])
        _, file = await call(app, "GET", "/api/file", {"path": "src/app/core.py"})
        assert file["text"].endswith("def added():\n    return helper(1)\n")
        _, changed = await call(app, "GET", "/api/changes", {})
        assert not any(f["stale"] for f in changed["files"])
        assert state.session is not first and not state.session.stopped
        assert first.stopped and group_ended(first.client._server.pid)
        status, hover = await call(app, "GET", "/api/hover", RUN_ENGINE_CALL)
        assert status == 200 and hover["range"] == [10, 21, 10, 31]
        last = state.session
    assert last.stopped and group_ended(last.client._server.pid)


@pytest.mark.asyncio
async def test_reloads_asked_together_analyze_once(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    analyze_async = api.analyze_async
    runs = []

    async def counted(files, session):
        runs.append(session)
        return await analyze_async(files, session)

    monkeypatch.setattr(api, "analyze_async", counted)
    app = create_app(sample_repo, sys.executable)
    async with app.router.lifespan_context(app):
        assert len(runs) == 1
        add_function(sample_repo)
        replies = await asyncio.gather(*(call(app, "POST", "/api/reload", {}) for _ in range(3)))
        assert [status for status, _ in replies] == [200, 200, 200]
        assert len(runs) == 2 and "app.core:added" in app.state.nodes
        await call(app, "POST", "/api/reload", {})
        assert len(runs) == 3


@pytest.mark.asyncio
async def test_failed_reload_keeps_the_previous_analysis(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    monkeypatch.setattr(summary, "find_cli", lambda: None)
    app = create_app(sample_repo, sys.executable)
    async with app.router.lifespan_context(app):
        state = app.state
        before, first = state.graph, state.session
        add_function(sample_repo)
        opened = []

        async def fail(files, session):
            opened.append(session)
            raise RuntimeError("분석이 멈췄다")

        with monkeypatch.context() as patch:
            patch.setattr(api, "analyze_async", fail)
            status, body = await call(app, "POST", "/api/reload", {})
        assert status == 500 and body == {"error": "다시 분석하지 못했다: 분석이 멈췄다"}
        assert state.graph is before and state.session is first and not first.stopped
        [session] = opened
        assert session.stopped and group_ended(session.client._server.pid)
        status, hover = await call(app, "GET", "/api/hover", RUN_ENGINE_CALL)
        assert status == 200 and hover["range"] == [10, 21, 10, 31]

        status, _ = await call(app, "POST", "/api/reload", {})
        assert status == 200 and "app.core:added" in state.nodes
