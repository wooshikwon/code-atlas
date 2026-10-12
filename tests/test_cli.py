import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

import pytest

from conftest import group_ended

from code_atlas import cli
from code_atlas.analyze import PythonNotFound, require_python

# 언어 서버를 띄우면 그 pid를 출력한다. 인자가 "serve"가 아니면 분석을 끝내지 않고, "analyze"면 `code-atlas analyze`를 돌린다.
SERVE = """
import asyncio, sys
from code_atlas import cli
from code_atlas.lsp import Session

entered, wait_ready = Session.__aenter__, Session.wait_ready

async def started(self):
    await entered(self)
    print("pid", self.client._server.pid, flush=True)
    return self

async def ready(self, probe):
    if sys.argv[3] != "serve":
        await asyncio.Event().wait()
    await wait_ready(self, probe)

Session.__aenter__, Session.wait_ready = started, ready
if sys.argv[3] == "analyze":
    sys.exit(cli.main(["analyze", sys.argv[1], "--python", sys.executable]))
sys.exit(cli.main([sys.argv[1], "--no-open", "--port", sys.argv[2], "--python", sys.executable]))
"""

# `code-atlas`를 `sys.argv[2:]`로 돌리고 언어 서버를 띄우면 그 pid를 출력한다. 첫 인자가 "later"면 첫 분석 뒤의 준비 확인이 끝나지 않는다.
HOSTED = """
import asyncio, sys
from code_atlas import cli
from code_atlas.lsp import Session

entered, wait_ready = Session.__aenter__, Session.wait_ready
asked = []

async def started(self):
    await entered(self)
    print("pid", self.client._server.pid, flush=True)
    return self

async def ready(self, probe):
    asked.append(probe)
    if sys.argv[1] == "later" and len(asked) > 1:
        await asyncio.Event().wait()
    await wait_ready(self, probe)

Session.__aenter__, Session.wait_ready = started, ready
sys.exit(cli.main(sys.argv[2:]))
"""
ORIGIN = "tauri://localhost"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.mark.parametrize(
    ("mode", "signals"),
    [("hang", 1), ("hang", 2), ("serve", 1), ("analyze", 1)],
    ids=["분석 중 한 번", "분석 중 두 번", "분석 뒤 한 번", "analyze 명령"],
)
def test_sigint_ends_the_server_and_the_language_server(sample_repo, tmp_path, mode, signals):
    env = {**os.environ, "HOME": str(tmp_path), "PATH": f"{os.path.dirname(sys.executable)}:/usr/bin:/bin"}
    server = subprocess.Popen(
        [sys.executable, "-c", SERVE, str(sample_repo), str(free_port()), mode],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        if mode != "analyze":
            assert "주소:" in server.stdout.readline()  # 분석을 기다리지 않고 서버가 뜬다
        pid = int(server.stdout.readline().split()[1])
        if mode == "serve":
            assert server.stdout.readline().startswith("노드 ")
        for _ in range(signals):
            server.send_signal(signal.SIGINT)
            time.sleep(0.3)
        server.wait(timeout=5)
    finally:
        server.kill()
        _, errors = server.communicate()
    assert group_ended(pid)
    # 두 번째 신호가 인터프리터를 정리하는 동안 도착하면 프로세스가 SIGINT로 끝난다.
    assert server.returncode in ((130,) if signals == 1 else (130, -signal.SIGINT))
    if signals == 1:
        assert "Traceback" not in errors


def test_analyze_prints_the_unused_count_only_in_the_summary(sample_repo, capsys):
    assert cli.main(["analyze", str(sample_repo), "--python", sys.executable]) == 0
    summary = capsys.readouterr().out.splitlines()
    assert summary[0].startswith("노드 ") and summary[1:] == ["미사용 후보 4개"]

    assert cli.main(["analyze", str(sample_repo), "--python", sys.executable, "--json"]) == 0
    printed = capsys.readouterr().out
    assert set(json.loads(printed)) == {"nodes", "edges", "sites", "errors", "stats"}
    assert "미사용 후보" not in printed


def test_serve_parser_reads_style_guide_option():
    assert cli._serve_parser().parse_args(["repo", "--style-guide", "guide.md"]).style_guide == "guide.md"
    assert cli._serve_parser().parse_args(["repo"]).style_guide is None


@pytest.mark.parametrize("command", ["analyze", "serve"])
def test_missing_python_ends_before_the_analysis(sample_repo, capsys, monkeypatch, command):
    monkeypatch.setattr(cli, "analyze", lambda *args, **options: pytest.fail("분석을 시작했다"))
    monkeypatch.setattr(cli, "create_app", lambda *args, **options: pytest.fail("서버를 만들었다"))
    missing = str(sample_repo / "no" / "python")
    argv = ["analyze", str(sample_repo)] if command == "analyze" else [str(sample_repo), "--no-open", "--port", str(free_port())]
    with pytest.raises(SystemExit) as exit:
        cli.main([*argv, "--python", missing])
    assert exit.value.code == 2
    assert missing in capsys.readouterr().err


def test_require_python_accepts_an_executable_and_rejects_other_paths(sample_repo):
    assert require_python(sample_repo, sys.executable) == sys.executable
    for path in (str(sample_repo / "pyproject.toml"), str(sample_repo), "no-such-python-command"):
        with pytest.raises(PythonNotFound):
            require_python(sample_repo, path)


def hosted(tmp_path, mode: str, *args: str) -> subprocess.Popen:
    """`--hosted --port 0`으로 띄운 서버. 설정 파일과 캐시는 임시 폴더에 둔다."""
    env = {**os.environ, "HOME": str(tmp_path), "PATH": f"{os.path.dirname(sys.executable)}:/usr/bin:/bin"}
    return subprocess.Popen(
        [sys.executable, "-c", HOSTED, mode, "--hosted", "--port", "0", "--origin", ORIGIN, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )


def fetch(url: str, method: str = "GET", origin: str | None = None) -> tuple[int, dict, dict]:
    """상태 코드, 응답 머리, JSON 본문."""
    request = urllib.request.Request(url, method=method, headers={"Origin": origin} if origin else {})
    try:
        with urllib.request.urlopen(request, timeout=10) as answer:
            return answer.status, dict(answer.headers), json.loads(answer.read() or "null")
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), json.loads(error.read() or "null")


def test_hosted_server_prints_its_address_and_ends_when_stdin_closes(tmp_path):
    server = hosted(tmp_path, "serve")
    try:
        printed = json.loads(server.stdout.readline())  # 브라우저를 열지 않고 주소 한 줄만 쓴다
        url = printed["url"]
        assert list(printed) == ["url"] and url.startswith("http://127.0.0.1:") and not url.endswith(":0")
        code, headers, status = fetch(f"{url}/api/status", origin=ORIGIN)
        assert (code, status["phase"], status["session"]) == (200, "idle", 1)
        assert headers["access-control-allow-origin"] == ORIGIN
        assert "access-control-allow-origin" not in fetch(f"{url}/api/status", origin="http://example.com")[1]
        code, headers, _ = fetch(f"{url}/api/repos", origin=ORIGIN)
        assert (code, headers["access-control-allow-origin"]) == (200, ORIGIN)
        assert server.poll() is None
        server.stdin.close()
        assert server.wait(timeout=5) == 0
        assert server.stdout.read() == ""
    finally:
        server.kill()
        server.communicate()


def test_hosted_server_ends_with_a_request_waiting_and_leaves_no_language_server(sample_repo, tmp_path):
    server = hosted(tmp_path, "later", str(sample_repo), "--python", sys.executable)
    try:
        url = json.loads(server.stdout.readline())["url"]
        pid = int(server.stdout.readline().split()[1])
        deadline = time.monotonic() + 30
        while fetch(f"{url}/api/status")[2]["revision"] == 0 and time.monotonic() < deadline:
            time.sleep(0.05)
        core = sample_repo / "src" / "app" / "core.py"
        core.write_text(core.read_text() + "\n\ndef added():\n    return helper(1)\n")

        def reload() -> None:
            try:
                fetch(f"{url}/api/reload", "POST")
            except (OSError, ValueError):  # 서버가 끝나면서 응답을 끊는다
                pass

        waiting = threading.Thread(target=reload, daemon=True)
        waiting.start()
        time.sleep(0.5)
        assert waiting.is_alive() and not group_ended(pid, within=0.1)
        started = time.monotonic()
        server.stdin.close()
        assert server.wait(timeout=10) == 0
        assert time.monotonic() - started < 8
    finally:
        server.kill()
        server.communicate()
    assert group_ended(pid)


def test_language_server_ends_by_itself_after_the_server_is_killed(sample_repo, tmp_path):
    server = hosted(tmp_path, "serve", str(sample_repo), "--python", sys.executable)
    try:
        url = json.loads(server.stdout.readline())["url"]
        pid = int(server.stdout.readline().split()[1])
        deadline = time.monotonic() + 30
        while fetch(f"{url}/api/status")[2]["lsp"] != "ready" and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not group_ended(pid, within=0.1)
        server.kill()  # SIGKILL. 서버가 세션을 닫지 못한다
        server.wait(timeout=5)
        assert group_ended(pid, within=10)
    finally:
        server.kill()
        server.communicate()


def test_serve_parser_takes_no_repo_and_the_hosted_options():
    bare = cli._serve_parser().parse_args([])
    assert (bare.repo, bare.hosted, bare.origin, bare.port) == (None, False, None, cli.PORT)
    args = cli._serve_parser().parse_args(["--hosted", "--port", "0", "--origin", ORIGIN])
    assert (args.repo, args.hosted, args.origin, args.port) == (None, True, ORIGIN, 0)
