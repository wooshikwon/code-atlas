import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

from conftest import git

from code_atlas import api, summary
from code_atlas.api import create_app
from code_atlas.summary import Summaries, SummaryError

RUN_ENGINE_CALL = {"path": "src/app/cli.py", "line": 10, "col": 21}  # 한글 문자열 뒤의 run_engine


@pytest.fixture(scope="module")
def client(module_repo, tmp_path_factory):
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(summary, "CACHE_PATH", tmp_path_factory.mktemp("cache") / "summaries.db")
        patch.setattr(summary, "find_cli", lambda: None)
        with TestClient(create_app(module_repo, sys.executable)) as client:
            yield client


@pytest.fixture
def generated(client, tmp_path, monkeypatch):
    """빈 요약 캐시로 바꾸고 `claude` 호출을 가짜로 바꾼다. 가짜가 받은 (종류, 이름, 코드)를 돌려준 목록에 담는다."""
    calls: list[tuple[str, str, str]] = []

    async def generate(kind, name, code):
        calls.append((kind, name, code))
        return f"{name} 요약 {len(calls)}"

    async def unavailable():
        return None

    monkeypatch.setattr(summary, "generate", generate)
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
    assert body["stats"]["files"] == 9
    assert body["stats"]["resolved"] + body["stats"]["unresolved"] == body["stats"]["call_sites"]


def test_tree(client):
    entries = client.get("/api/tree").json()["entries"]
    assert [e["name"] for e in entries] == ["src", "tests"]
    src, tests = entries
    assert src["node"] is None and tests["test"] and not src["test"]
    app = src["children"][0]
    assert (app["path"], app["kind"], app["node"]) == ("src/app", "dir", "app")
    assert [c["name"] for c in app["children"]][:2] == ["plugins", "__init__.py"]
    core = next(c for c in app["children"] if c["name"] == "core.py")
    assert (core["kind"], core["node"], "children" in core) == ("file", "app.core", False)
    plugins = app["children"][0]
    assert plugins["node"] == "app.plugins"


def test_graph(client):
    body = client.get("/api/graph").json()
    ids = {n["id"] for n in body["nodes"]}
    assert "app.core:Engine.start" in ids
    engine = next(n for n in body["nodes"] if n["id"] == "app.core:Engine")
    assert isinstance(engine["range"], list) and len(engine["range"]) == 2
    edge = next(e for e in body["edges"] if e["kind"] == "call" and e["target"] == "app.core:run_engine")
    assert edge["group"] == "run"
    assert edge["sites"] == [{"path": "src/app/cli.py", "line": 10, "col": 21}]


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


def test_summary_is_made_on_post_and_read_from_cache(client, generated):
    node = {"node": "app.core:run_engine"}
    assert client.get("/api/summary", params=node).json() == {"summary": None, "available": True, "reason": None}
    assert generated == []

    assert client.post("/api/summary", params=node).json() == {"summary": "run_engine 요약 1"}
    kind, name, code = generated[0]
    assert (kind, name) == ("function", "run_engine")
    assert code.startswith("def run_engine(config: Config) -> Engine:") and code.endswith("return engine")

    assert client.post("/api/summary", params=node).json() == {"summary": "run_engine 요약 1"}
    assert client.get("/api/summary", params=node).json()["summary"] == "run_engine 요약 1"
    assert len(generated) == 1

    assert client.post("/api/summary", params={**node, "refresh": "true"}).json() == {"summary": "run_engine 요약 2"}
    assert client.get("/api/summary", params=node).json()["summary"] == "run_engine 요약 2"


def test_summary_of_method_and_file(client, generated):
    client.post("/api/summary", params={"node": "app.core:Engine.start"})
    client.post("/api/summary", params={"node": "app.core"})
    (_, method_name, method_code), (file_kind, file_name, file_code) = generated
    assert method_name == "Engine.start" and method_code.lstrip().startswith("def start(self")
    assert (file_kind, file_name) == ("module", "src/app/core.py")
    assert file_code.splitlines() == [
        "def helper(value):",
        "class Engine:",
        "def run_engine(config: Config) -> Engine:",
    ]


def test_summary_reports_unavailable_cli(client, generated, monkeypatch):
    async def unavailable():
        return "Claude Code CLI를 찾지 못했다"

    monkeypatch.setattr(summary, "unavailable", unavailable)
    body = client.get("/api/summary", params={"node": "app.core:helper"}).json()
    assert body == {"summary": None, "available": False, "reason": "Claude Code CLI를 찾지 못했다"}


def test_summary_failure_is_503(client, generated, monkeypatch):
    async def generate(kind, name, code):
        raise SummaryError("Claude Code CLI가 60초 안에 응답하지 않았다")

    monkeypatch.setattr(summary, "generate", generate)
    response = client.post("/api/summary", params={"node": "app.core:helper"})
    assert response.status_code == 503
    assert response.json() == {"error": "Claude Code CLI가 60초 안에 응답하지 않았다"}
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
        {"path": "src/app/core.py", "status": "modified", "stale": False},
        {"path": "src/app/extra.py", "status": "added", "stale": False},
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
    body = changed.get("/api/changes").json()
    assert body["files"] == [
        {"path": "src/app/cli.py", "status": "deleted", "stale": True},
        {"path": "src/app/core.py", "status": "modified", "stale": False},
        {"path": "src/app/extra.py", "status": "added", "stale": True},
        {"path": "src/app/late.py", "status": "added", "stale": False},
        {"path": "src/app/models.py", "status": "modified", "stale": True},
    ]
    assert body["nodes"] == {
        "app.core": "modified",
        "app.core:helper": "modified",
        "app.extra": "added",
        "app.models": "modified",
    }


def test_changes_outside_git_are_empty(client):
    assert client.get("/api/changes").json() == {"git": False, "branch": None, "files": [], "nodes": {}}
