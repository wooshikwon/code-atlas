import os
import signal
import socket
import subprocess
import sys
import time

import pytest

from conftest import group_ended

from code_atlas import cli
from code_atlas.analyze import PythonNotFound, require_python

# 분석을 시작할 때 언어 서버의 pid를 출력한다. 인자가 "serve"가 아니면 분석을 끝내지 않고, "analyze"면 `code-atlas analyze`를 돌린다.
SERVE = """
import asyncio, sys
from code_atlas import analyze, api, cli

analyze_async = api.analyze_async

async def hooked(files, session):
    print("pid", session.client._server.pid, flush=True)
    if sys.argv[3] != "serve":
        await asyncio.Event().wait()
    return await analyze_async(files, session)

api.analyze_async = analyze.analyze_async = hooked
if sys.argv[3] == "analyze":
    sys.exit(cli.main(["analyze", sys.argv[1], "--python", sys.executable]))
sys.exit(cli.main([sys.argv[1], "--no-open", "--port", sys.argv[2], "--python", sys.executable]))
"""


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
        pid = int(server.stdout.readline().split()[1])
        if mode == "serve":
            assert "주소:" in server.stdout.readline() + server.stdout.readline()
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


def test_serve_parser_reads_style_guide_option():
    assert cli._serve_parser().parse_args(["repo", "--style-guide", "guide.md"]).style_guide == "guide.md"
    assert cli._serve_parser().parse_args(["repo"]).style_guide is None


@pytest.mark.parametrize("command", ["analyze", "serve"])
def test_missing_python_ends_before_the_analysis(sample_repo, capsys, monkeypatch, command):
    monkeypatch.setattr(cli, "analyze", lambda *args: pytest.fail("분석을 시작했다"))
    monkeypatch.setattr(cli, "create_app", lambda *args: pytest.fail("서버를 만들었다"))
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
