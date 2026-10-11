import os
import signal
import socket
import subprocess
import sys
import time

import pytest

from conftest import group_ended

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
