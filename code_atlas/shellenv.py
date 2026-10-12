"""로그인 셸에서 환경 변수를 읽는다.

Finder에서 띄운 앱은 로그인 셸의 `PATH`를 받지 않으므로, 앱 껍데기가 띄운 실행은 서버를 띄우기 전에 사용자 계정의
셸을 한 번 띄워 그 셸이 가진 환경을 읽고 자기 환경을 그 값으로 바꾼다. 도구를 찾는 순서는 모른다.
"""

from __future__ import annotations

import json
import os
import pwd
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

# VS Code가 로그인 셸의 환경을 읽을 때 두는 기본 시간 제한과 같다. 개인 Mac에서 `PATH`를 비운 프로세스가
# oh-my-zsh·nvm·pyenv·conda를 읽는 `zsh -ilc`를 띄워 잰 값은 1.4~1.5초이고, 다른 작업이 CPU를 다 쓰는 동안에는
# 4.3~4.8초였다.
TIMEOUT = 10.0
SHELLS = ("zsh", "bash", "fish")
# 표지 문자열 사이에 자기 환경을 JSON으로 쓴다. 표지 문자열은 인자로 받는다.
_PRINT = "import json, os, sys; sys.stdout.write(sys.argv[1] + json.dumps(dict(os.environ)) + sys.argv[1])"
# 셸이 프로세스마다 새로 정하는 변수. 읽은 값 대신 백엔드가 받은 값을 둔다.
_OWN = ("PWD", "OLDPWD", "SHLVL", "_")
# oh-my-zsh가 갱신할지 묻고 기다리지 않게 한다.
_QUIET = {"DISABLE_AUTO_UPDATE": "true"}


@dataclass
class ShellEnv:
    shell: str  # 셸의 경로
    ok: bool
    detail: str  # 읽지 못한 까닭. 읽었으면 빈 문자열
    seconds: float
    env: dict[str, str] | None


last: ShellEnv | None = None  # 이 프로세스가 마지막으로 읽은 결과. 읽은 적이 없으면 None이다
_reading: threading.Thread | None = None


def _last_line(text: str) -> str:
    return (text.strip().splitlines() or [""])[-1][:200]


def _run(shell: str, command: str, timeout: float) -> tuple[int | None, str, str]:
    """셸을 자기 프로세스 묶음으로 띄워 종료 코드, 표준 출력, 표준 오류를 낸다. 시간 안에 끝나지 않으면 묶음을 끝내고 종료 코드가 None이다.

    출력은 파이프가 아니라 임시 파일로 받는다. 셸 설정이 띄운 프로세스가 출력을 쥔 채 남아도 셸이 끝나면 읽는다.
    """
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        process = subprocess.Popen(
            [shell, "-ilc", command],
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=err,
            cwd=Path.home(),
            env={**os.environ, **_QUIET},
            start_new_session=True,
        )
        try:
            code: int | None = process.wait(timeout)
        except subprocess.TimeoutExpired:
            code = None
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        texts = []
        for file in (out, err):
            file.seek(0)
            texts.append(file.read().decode(errors="replace"))
    return code, texts[0], texts[1]


def _read(timeout: float) -> ShellEnv:
    shell = pwd.getpwuid(os.getuid()).pw_shell
    name = os.path.basename(shell)
    started = time.monotonic()

    def result(detail: str, env: dict[str, str] | None = None) -> ShellEnv:
        return ShellEnv(shell, env is not None, detail, round(time.monotonic() - started, 2), env)

    if name not in SHELLS:
        return result(f"로그인 셸 {name}은 환경을 읽지 않습니다. {', '.join(SHELLS)}를 읽습니다")
    mark = uuid.uuid4().hex
    try:
        code, out, err = _run(shell, shlex.join([sys.executable, "-I", "-c", _PRINT, mark]), timeout)
    except OSError as exc:
        return result(f"로그인 셸({name})을 띄우지 못했습니다: {exc.strerror or exc}")
    if code is None:
        return result(
            f"로그인 셸({name})이 {timeout:g}초 안에 환경을 알려 주지 않았습니다. "
            "앱이 받은 환경과 알려진 설치 위치에서 도구를 찾습니다"
        )
    parts = out.split(mark)
    try:
        env = json.loads(parts[1]) if len(parts) == 3 else None
    except ValueError:
        env = None
    if not isinstance(env, dict):
        said = _last_line(err)
        return result(f"로그인 셸의 출력에서 환경을 읽지 못했습니다(종료 코드 {code})" + (f": {said}" if said else ""))
    for key in (*_OWN, *_QUIET):
        env.pop(key, None)
        if key in os.environ:
            env[key] = os.environ[key]
    return result("", env)


def read(timeout: float = TIMEOUT) -> ShellEnv:
    """사용자 계정의 셸을 `-ilc`로 띄워 그 셸의 환경을 읽고 결과를 `last`에 둔다. zsh, bash, fish만 띄운다."""
    global last
    last = _read(timeout)
    return last


def start() -> None:
    """로그인 셸의 환경을 스레드에서 읽기 시작한다."""
    global _reading
    _reading = threading.Thread(target=read, daemon=True)
    _reading.start()


def reading() -> bool:
    """`start`가 시작한 읽기를 `adopt`가 아직 받지 않았다."""
    return _reading is not None


def adopt() -> ShellEnv | None:
    """`start`가 시작한 읽기를 기다리고, 읽었으면 이 프로세스의 환경을 그 값으로 통째로 바꾼다. 시작한 적이 없으면 None이다."""
    global _reading
    if _reading is None:
        return None
    _reading.join()
    _reading = None
    if last is not None and last.env is not None:
        os.environ.clear()
        os.environ.update(last.env)
    return last
