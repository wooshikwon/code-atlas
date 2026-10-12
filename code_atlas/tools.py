"""`claude`, `git`, 대상 레포의 파이썬 인터프리터를 찾는다.

세 도구를 같은 규칙으로 찾는다. 후보를 저장한 경로, 환경, 알려진 위치 순서로 만들고, 후보마다 확인 명령을 실제로
실행해 처음 통과한 것을 쓰며, 시도한 후보를 모두 기록한다. 도구마다 다른 것은 후보를 내는 함수와 확인 명령뿐이다.
통과한 경로는 파일의 (장치, inode, 수정 시각, 크기)와 함께 메모리에 두고, 그 네 값이 그대로인 동안에는 프로세스를
띄우지 않는다. 도구가 내는 결과의 뜻(요약, 커밋 목록)과 화면은 모른다.

설정 파일에서는 저장한 경로만 읽는다. `settings.tool("claude")`·`settings.tool("git")`이 사용자가 고른 실행 파일의
경로를, `settings.python(root)`가 그 레포 루트에 고른 인터프리터의 경로를 내고 없으면 None이다. 서버는 설정 객체
하나를 끝까지 쓰므로 마지막으로 받은 객체를 기억해, `settings` 없이 부른 호출(`git.py`, `summary.py`)도 저장한 경로를 읽는다.
"""

from __future__ import annotations

import glob
import json
import os
import pwd
import re
import signal
import subprocess
import sys
import threading
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from . import shellenv
from .collect import disk_path

if TYPE_CHECKING:
    from .settings import Settings

SAVED = "saved"
ENV = "env"
KNOWN = "known"

# `Attempt.code`와 `Found.code`의 값. 화면은 이 값으로 경우를 가르고 `detail`과 `note`는 보이기만 한다.
OK = "ok"  # 확인을 통과했다
NOT_FOUND = "not_found"  # Found만: 후보가 없거나 후보의 파일이 모두 없다
MISSING = "missing"  # 없는 파일
NOT_FILE = "not_file"  # 파일이 아니다
NOT_EXECUTABLE = "not_executable"  # 실행 권한 없음
NO_CLT = "no_clt"  # Xcode Command Line Tools가 없어 껍데기 파일을 실행하지 않았다
TIMEOUT = "timeout"  # 확인 명령이 시간 안에 끝나지 않았다
SPAWN_FAILED = "spawn_failed"  # 확인 명령을 띄우지 못했다
FAILED = "failed"  # 확인 명령이 0이 아닌 종료 코드로 끝났다
UNREADABLE = "unreadable"  # 확인 명령의 출력에서 판을 읽지 못했다
NOT_ON_PATH = "not_on_path"  # `--python`에 준 이름이 `PATH`에 없다
MANAGER_MISSING = "manager_missing"  # 표지 파일이 가리키는 관리자가 `PATH`에 없다
MANAGER_FAILED = "manager_failed"  # 관리자 명령이 실패했거나 시간 안에 끝나지 않았다
MANAGER_NO_ENV = "manager_no_env"  # 관리자 명령이 이 레포의 환경을 알려 주지 않았다
DISABLED = "disabled"  # `CODE_ATLAS_NO_CLAUDE`가 켜져 있어 `claude`를 실행하지 않았다
SHELL_PENDING = "shell_pending"  # 로그인 셸의 환경을 읽는 중이라 `claude`를 실행하지 않았다
HOME_MISMATCH = "home_mismatch"  # 환경의 `HOME`이 계정의 홈 폴더가 아니라 `claude`를 실행하지 않았다
USER_MISMATCH = "user_mismatch"  # 환경의 `USER`가 계정의 이름이 아니라 `claude`를 실행하지 않았다
NO_KEYCHAIN_COMMAND = "no_keychain_command"  # 환경의 `PATH`에 `security`가 없어 `claude`를 실행하지 않았다
NOT_LOGGED_IN_CODE = "not_logged_in"  # Found만: `claude`가 로그인돼 있지 않다
NOT_ANSWERING_CODE = "not_answering"  # Found만: `claude auth status`가 응답하지 않았다
# 파일이나 명령이 그 위치에 없다는 기록. 이것만 있는 결과는 `not_found`다.
_ABSENT = frozenset({MISSING, NOT_ON_PATH, MANAGER_MISSING, MANAGER_NO_ENV})

# 확인 명령의 시간 제한. 이 Mac에서 잰 값은 `claude --version` 0.14초, `claude auth status` 0.82초, `git --version`
# 0.10초, `xcode-select -p` 0.09초, pyenv shim을 거친 인터프리터 0.2초 안쪽, 관리자 명령 가운데 가장 느린
# `poetry env info -p`와 `conda env list --json`이 0.9초다. 느린 디스크와 처음 실행을 감안해 잰 값의 열 배 이상을 둔다.
CLAUDE_TIMEOUT = 10.0
GIT_TIMEOUT = 5.0  # `git.py`가 git 명령 하나에 두는 값과 같다
PROBE_TIMEOUT = 5.0
MANAGER_TIMEOUT = 10.0

# 시간 제한에 걸린 프로세스에 SIGTERM을 보낸 뒤 SIGKILL을 보내기까지 기다리는 시간. Claude Code CLI가 키체인에 한 번
# 쓰는 명령(`security -i`)에 두는 시간 제한이 2초이므로, 쓰는 중인 토큰 저장 한 번과 잠금 파일 정리가 끝날 시간의
# 두 배 남짓을 둔다. 언어 서버를 닫을 때 기다리는 `lsp.SHUTDOWN_TIMEOUT`과 같은 값이다.
TERM_GRACE = 5.0

STATUS_ARGS = ("auth", "status", "--json")
# 값이 있으면 `claude`를 어떤 인자로도 실행하지 않는다.
NO_CLAUDE_ENV = "CODE_ATLAS_NO_CLAUDE"
UNCHECKED = "확인하지 못함"
# Claude Code CLI가 macOS에서 자격 증명을 읽고 쓸 때 `PATH`에서 이름으로 찾아 실행하는 명령
KEYCHAIN_COMMAND = "security"
NOT_LOGGED_IN = "Claude Code에 로그인돼 있지 않습니다"
NOT_ANSWERING = "Claude Code CLI가 응답하지 않습니다"

# Xcode Command Line Tools가 없으면 실행할 때 설치 창을 띄우는 macOS의 껍데기 파일
CLT_STUBS = frozenset({"/usr/bin/git", "/usr/bin/python3"})
XCODE_SELECT = "/usr/bin/xcode-select"
NO_CLT_DETAIL = "Xcode Command Line Tools가 없습니다"

# 출처 ③의 알려진 위치. `*`가 든 경로는 판 번호가 높은 순서로 편다.
PLACES: dict[str, tuple[str, ...]] = {
    "claude": (
        "~/.local/bin/claude",  # 공식 설치 스크립트
        "/opt/homebrew/bin/claude",  # Homebrew(Apple Silicon)와 그 Node의 npm 전역
        "/usr/local/bin/claude",  # Homebrew(Intel)와 npm 전역
        "~/.volta/bin/claude",
        "~/.asdf/shims/claude",
        "~/.nvm/versions/node/*/bin/claude",
    ),
    "git": ("/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"),
}

_PROBE = (
    "import json, sys; print(json.dumps({'version': sys.version, 'info': list(sys.version_info[:3]), "
    "'prefix': sys.prefix, 'base_prefix': sys.base_prefix, 'executable': sys.executable, 'path': sys.path}))"
)
_VERSION = re.compile(r"\d+(?:\.\d+)+")
_NUMBER = re.compile(r"\d+")
_CONDA_NAME = re.compile(r"^name:\s*['\"]?([^\s'\"#]+)", re.MULTILINE)


@dataclass
class Attempt:
    """후보 하나를 시도한 기록."""

    source: str  # saved·env·known
    path: str | None  # 후보의 경로. 경로를 내지 못한 시도(관리자 명령이 없음)는 None이다
    ok: bool
    detail: str  # 판 번호나 통과하지 못한 까닭
    code: str = OK  # 통과하지 못한 경우를 가리키는 값. 통과했으면 ok


@dataclass
class Found:
    """도구 하나를 찾은 결과."""

    tool: str  # claude·git·python
    path: str | None  # 확인을 통과한 경로. 없으면 None
    version: str | None
    source: str | None  # 통과한 후보의 출처
    attempts: list[Attempt]
    note: str | None = None  # 경로는 통과했지만 쓰지 못하는 까닭(로그인돼 있지 않다)
    auth: str | None = None  # claude만: CLI가 알려 준 로그인 방법
    prefix: str | None = None  # python만: sys.prefix
    venv: bool | None = None  # python만: 가상환경인지
    # 도구를 쓸 수 있으면 ok, 로그인돼 있지 않으면 not_logged_in·not_answering. 경로가 없으면 없는 파일이 아닌 첫 기록의
    # code이고, 그런 기록이 없으면 not_found다
    code: str = NOT_FOUND


@dataclass(frozen=True)
class _Tool:
    """도구마다 다른 확인 명령. `read`는 명령의 표준 출력에서 `Found`에 적을 값을 읽고, 읽지 못하면 None을 낸다.

    `turns`가 있으면 확인 명령을 그 차례 안에서 혼자 실행한다.
    """

    name: str
    args: tuple[str, ...]
    timeout: float
    read: Callable[[str], dict[str, object] | None]
    turns: Turns | None = None


class Turns:
    """한 실행 파일을 띄우는 차례. 확인 명령은 혼자 돌고, 그 밖의 호출은 확인 명령이 없는 동안에만 돈다.

    `claude`의 `--version`과 `auth status`는 `alone` 안에서 실행하고, 요약의 `claude -p`는 `enter`가 참을 낸 뒤에
    실행해 끝나면 `leave`를 부른다. 확인 명령이 기다리는 동안에는 `enter`가 거짓을 내므로 확인 명령이 밀리지 않는다.
    """

    def __init__(self) -> None:
        self._changed = threading.Condition()
        self._alone = False
        self._waiting = 0
        self._entered = 0

    @contextmanager
    def alone(self) -> Iterator[None]:
        with self._changed:
            self._waiting += 1
            try:
                self._changed.wait_for(lambda: not self._alone and self._entered == 0)
            finally:
                self._waiting -= 1
            self._alone = True
        try:
            yield
        finally:
            with self._changed:
                self._alone = False
                self._changed.notify_all()

    def enter(self) -> bool:
        with self._changed:
            if self._alone or self._waiting:
                return False
            self._entered += 1
            return True

    def leave(self) -> None:
        with self._changed:
            self._entered -= 1
            self._changed.notify_all()


@dataclass(frozen=True)
class _Candidate:
    """확인할 후보. `detail`이 있으면 실행하지 않고 그 까닭으로 기록한다."""

    source: str
    path: str | None
    detail: str = ""
    code: str = OK


_settings: Settings | None = None
_memory: dict[tuple[str, str | None], tuple[Found, tuple[int, int, int, int], str | None]] = {}
_last: dict[tuple[str, str | None], Found] = {}  # 도구마다 마지막으로 찾은 결과. 통과하지 못한 결과도 둔다
_locks: dict[tuple[str, str | None], threading.Lock] = {}
_guard = threading.Lock()


def _execute(command: list[str], timeout: float, cwd: str | None) -> tuple[int, str, str]:
    """자기 프로세스 묶음으로 명령을 띄워 종료 코드, 표준 출력, 표준 오류를 낸다.

    시간 안에 끝나지 않으면 묶음에 SIGTERM을 보내고, `TERM_GRACE`가 지나도 남아 있으면 SIGKILL을 보낸다.
    """
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        start_new_session=True,
    )
    try:
        out, err = process.communicate(timeout=timeout)
    finally:
        if process.poll() is None:
            for sent in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(process.pid, sent)
                    process.wait(TERM_GRACE)
                except ProcessLookupError:
                    pass
                except subprocess.TimeoutExpired:
                    continue
                break
            process.wait()
            process.stdout.close()
            process.stderr.close()
    return process.returncode, out.decode(errors="replace"), err.decode(errors="replace")


def _last_line(text: str) -> str:
    return (text.strip().splitlines() or [""])[-1][:200]


def _failure(code: int, err: str) -> str:
    last = _last_line(err)
    return f"종료 코드 {code}: {last}" if last else f"종료 코드 {code}"


def _has_clt() -> bool:
    """`xcode-select -p`가 종료 코드 0으로 끝나고 알려 준 폴더가 있다."""
    try:
        code, out, _ = _execute([XCODE_SELECT, "-p"], GIT_TIMEOUT, "/")
    except (OSError, subprocess.TimeoutExpired):
        return False
    return code == 0 and os.path.isdir(out.strip())


def _try(tool: _Tool, source: str, path: str, cwd: str) -> tuple[Attempt, dict[str, object] | None]:
    """후보 하나를 확인 명령으로 실행한다. 통과하면 기록과 `Found`에 적을 값을, 아니면 기록과 None을 낸다."""

    def failed(code: str, detail: str) -> tuple[Attempt, None]:
        return Attempt(source, path, False, detail, code), None

    if not os.path.exists(path):
        return failed(MISSING, "없는 파일")
    if not os.path.isfile(path):
        return failed(NOT_FILE, "파일이 아닙니다")
    if not os.access(path, os.X_OK):
        return failed(NOT_EXECUTABLE, "실행 권한 없음")
    if sys.platform == "darwin" and os.path.realpath(path) in CLT_STUBS and not _has_clt():
        return failed(NO_CLT, NO_CLT_DETAIL)
    try:
        if tool.turns is not None:
            with tool.turns.alone():
                code, out, err = _execute([path, *tool.args], tool.timeout, cwd)
        else:
            code, out, err = _execute([path, *tool.args], tool.timeout, cwd)
    except subprocess.TimeoutExpired:
        return failed(TIMEOUT, f"{tool.timeout:g}초 안에 끝나지 않았습니다")
    except OSError as exc:
        return failed(SPAWN_FAILED, f"실행하지 못했습니다: {exc.strerror or exc}")
    if code != 0:
        return failed(FAILED, _failure(code, err))
    fields = tool.read(out)
    if fields is None:
        return failed(UNREADABLE, "확인 명령의 출력을 읽지 못했습니다")
    return Attempt(source, path, True, str(fields["version"])), fields


def _stamp(path: str) -> tuple[int, int, int, int] | None:
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_size


def _identity(path: str) -> str:
    """같은 후보를 가리는 값. 폴더의 실제 경로와 파일 이름이다.

    파일까지 따라가면 가상환경 둘의 `bin/python`이 같은 바탕 인터프리터로 모여 하나만 남는다.
    """
    folder, name = os.path.split(os.path.abspath(path))
    return os.path.join(os.path.realpath(folder), name)


def _find(
    tool: _Tool,
    candidates: Callable[[], Iterable[_Candidate]],
    *,
    repo: str | None = None,
    given: str | None = None,
    finish: Callable[[Found], None] | None = None,
) -> Found:
    """도구 하나를 찾는다. 세 도구가 모두 이 함수를 지난다.

    메모리에 통과한 값이 있고 그 파일의 네 값이 그대로면 그 값을 낸다. `given`은 메모리의 값을 찾을 때 준 값이나
    그때 통과한 경로와 같아야 한다. 아니면 후보를 차례로 실행해 처음 통과한 것을 쓰고, 그 뒤 후보는 만들지도
    실행하지도 않는다. `finish`는 통과한 결과를 메모리에 두기 전에 한 번 부른다.
    """
    key = (tool.name, repo)
    with _guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        kept = _memory.get(key)
        if kept is not None:
            found, stamp, asked = kept
            if given in (asked, found.path) and _stamp(found.path) == stamp:
                return found
            _memory.pop(key, None)
        found = Found(tool.name, None, None, None, [])
        seen: set[str] = set()
        for candidate in candidates():
            if candidate.path is None or candidate.detail:
                found.attempts.append(Attempt(candidate.source, candidate.path, False, candidate.detail, candidate.code))
                continue
            identity = _identity(candidate.path)
            if identity in seen:
                continue
            seen.add(identity)
            stamp = _stamp(candidate.path)
            attempt, fields = _try(tool, candidate.source, candidate.path, repo or "/")
            found.attempts.append(attempt)
            if fields is None or stamp is None:
                continue
            found.path, found.source, found.code = candidate.path, candidate.source, OK
            for name, value in fields.items():
                setattr(found, name, value)
            if finish is not None:
                finish(found)
            _memory[key] = (found, stamp, given)
            break
        if found.path is None:
            found.code = next((a.code for a in found.attempts if a.code not in _ABSENT), NOT_FOUND)
        _last[key] = found
        return found


def _on_path(name: str) -> Iterator[str]:
    """환경의 `PATH`에 든 폴더 순서대로 그 이름의 파일."""
    for folder in os.environ.get("PATH", "").split(os.pathsep):
        path = os.path.join(os.path.abspath(folder), name) if folder else ""
        if path and os.path.isfile(path):
            yield path


def _places(name: str) -> Iterator[str]:
    for pattern in PLACES[name]:
        pattern = os.path.expanduser(pattern)
        if not glob.has_magic(pattern):
            yield pattern
            continue
        matches = glob.glob(pattern)
        yield from sorted(matches, key=lambda p: [int(n) for n in _NUMBER.findall(p)], reverse=True) or [pattern]


def _named(name: str) -> Callable[[], Iterator[_Candidate]]:
    """이름 하나로 찾는 도구의 후보. 저장한 경로, `PATH`, 알려진 위치 순서다."""

    def candidates() -> Iterator[_Candidate]:
        saved = _settings.tool(name) if _settings is not None else None
        if saved:
            yield _Candidate(SAVED, saved)
        for path in _on_path(name):
            yield _Candidate(ENV, path)
        for path in _places(name):
            yield _Candidate(KNOWN, path)

    return candidates


def _version(out: str) -> dict[str, object] | None:
    found = _VERSION.search(out)
    return {"version": found[0]} if found is not None else None


def _probed(out: str) -> dict | None:
    """`_PROBE`의 출력. 표준 출력의 마지막 줄만 읽는다."""
    try:
        told = json.loads(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return None
    if not isinstance(told, dict) or not {"version", "info", "prefix", "base_prefix", "executable", "path"} <= set(told):
        return None
    return told


def _interpreter(out: str) -> dict[str, object] | None:
    told = _probed(out)
    if told is None:
        return None
    return {
        "version": ".".join(str(part) for part in told["info"]),
        "prefix": told["prefix"],
        "venv": told["prefix"] != told["base_prefix"],
    }


# code-atlas가 띄우는 `claude` 프로세스의 차례. 로그인 여부를 읽는 호출과 다른 `claude` 프로세스가 겹치지 않는다.
CLAUDE_TURNS = Turns()
CLAUDE = _Tool("claude", ("--version",), CLAUDE_TIMEOUT, _version, CLAUDE_TURNS)
GIT = _Tool("git", ("--version",), GIT_TIMEOUT, _version)
PYTHON = _Tool("python", ("-c", _PROBE), PROBE_TIMEOUT, _interpreter)


def _claude_refused() -> tuple[str, str] | None:
    """지금 환경에서 `claude`를 실행하지 않는 경우의 code와 까닭. 실행해도 되면 None이다.

    Claude Code CLI는 자격 증명을 키체인 항목 하나에 두고, 계정 이름을 `USER`에서, 설정 폴더를 `HOME`에서 읽으며,
    `security`를 `PATH`에서 찾는다. 이 값이 사용자의 로그인 환경과 다른 프로세스가 CLI를 실행하면 CLI가 다른 항목을
    읽거나 쓰므로, 로그인 환경과 같다고 확인한 환경에서만 실행한다.
    """
    refused = None
    account = pwd.getpwuid(os.getuid())
    if os.environ.get(NO_CLAUDE_ENV):
        refused = DISABLED, f"환경 변수 {NO_CLAUDE_ENV}가 켜져 있습니다"
    elif shellenv.reading():
        refused = SHELL_PENDING, "로그인 셸의 환경을 읽는 중입니다"
    elif os.environ.get("HOME") != account.pw_dir:
        refused = HOME_MISMATCH, f"환경의 HOME이 이 계정의 홈 폴더({account.pw_dir})가 아닙니다"
    elif os.environ.get("USER", account.pw_name) != account.pw_name:
        refused = USER_MISMATCH, f"환경의 USER가 이 계정의 이름({account.pw_name})이 아닙니다"
    elif sys.platform == "darwin" and next(_on_path(KEYCHAIN_COMMAND), None) is None:
        refused = NO_KEYCHAIN_COMMAND, f"환경의 PATH에 {KEYCHAIN_COMMAND}가 없습니다"
    return (refused[0], f"{UNCHECKED}: {refused[1]}") if refused is not None else None


def _login(found: Found) -> None:
    """`claude auth status`로 로그인 여부와 로그인 방법을 읽어 `note`와 `auth`에 적는다."""
    try:
        with CLAUDE_TURNS.alone():
            code, out, _ = _execute([found.path, *STATUS_ARGS], CLAUDE_TIMEOUT, "/")
    except (OSError, subprocess.TimeoutExpired):
        found.note, found.code = NOT_ANSWERING, NOT_ANSWERING_CODE
        return
    try:
        told = json.loads(out)
    except ValueError:
        told = None
    if not isinstance(told, dict):
        told = {}
    if code == 1 or told.get("loggedIn") is False:
        found.note, found.code = NOT_LOGGED_IN, NOT_LOGGED_IN_CODE
    elif isinstance(told.get("authMethod"), str):
        found.auth = told["authMethod"]


def _venvs(root: Path) -> list[str]:
    """레포 루트 바로 아래에서 `pyvenv.cfg`가 든 폴더의 인터프리터. `.venv`, `venv`, 그 밖의 이름 순서다."""
    try:
        with os.scandir(root) as entries:
            names = sorted(e.name for e in entries if os.path.isfile(os.path.join(e.path, "pyvenv.cfg")))
    except OSError:
        return []
    first = [name for name in (".venv", "venv") if name in names]
    return [str(root / name / "bin" / "python") for name in [*first, *(n for n in names if n not in first)]]


def _poetry(root: Path, out: str) -> list[str]:
    return [line for line in out.strip().splitlines()[-1:] if line]


def _pyenv(root: Path, out: str) -> list[str]:
    return [prefix for prefix in out.strip().split(":")[:1] if prefix]


def _conda(root: Path, out: str) -> list[str]:
    """`conda env list --json`의 환경 가운데 `environment.yml`의 `name`과 폴더 이름이 같은 것."""
    try:
        name = _CONDA_NAME.search((root / "environment.yml").read_text(encoding="utf-8", errors="replace"))
        envs = json.loads(out)["envs"]
    except (OSError, ValueError, KeyError, TypeError):
        return []
    return [env for env in envs if name is not None and isinstance(env, str) and os.path.basename(env) == name[1]]


# 레포의 표지 파일, 그 파일이 가리키는 관리자에게 묻는 명령, 명령의 출력에서 환경 폴더를 읽는 함수
MANAGERS: tuple[tuple[str, tuple[str, ...], Callable[[Path, str], list[str]]], ...] = (
    ("poetry.lock", ("poetry", "env", "info", "-p"), _poetry),
    (".python-version", ("pyenv", "prefix"), _pyenv),
    ("environment.yml", ("conda", "env", "list", "--json"), _conda),
)


def _ask(command: tuple[str, ...], cwd: str) -> tuple[str | None, str, str]:
    """관리자 명령을 환경의 `PATH`에서 이름으로 찾아 실행한다. 표준 출력과, 출력을 받지 못한 경우의 code와 까닭을 낸다."""
    shown = " ".join(command)
    exe = next(_on_path(command[0]), None)
    if exe is None:
        return None, MANAGER_MISSING, f"PATH에 {command[0]}가 없습니다"
    try:
        code, out, err = _execute([exe, *command[1:]], MANAGER_TIMEOUT, cwd)
    except subprocess.TimeoutExpired:
        return None, MANAGER_FAILED, f"`{shown}` 명령이 {MANAGER_TIMEOUT:g}초 안에 끝나지 않았습니다"
    except OSError as exc:
        return None, MANAGER_FAILED, f"`{shown}` 명령을 실행하지 못했습니다: {exc.strerror or exc}"
    if code != 0:
        return None, MANAGER_FAILED, f"`{shown}` 명령이 실패했습니다({_failure(code, err)})"
    return out, OK, ""


def _managed(root: Path) -> Iterator[_Candidate]:
    """레포의 표지 파일이 가리키는 관리자에게 물은 환경의 인터프리터."""
    for marker, command, prefixes in MANAGERS:
        if not (root / marker).is_file():
            continue
        out, code, why = _ask(command, str(root))
        if out is None:
            yield _Candidate(KNOWN, None, f"{marker}: {why}", code)
            continue
        folders = prefixes(root, out)
        if not folders:
            shown = " ".join(command)
            yield _Candidate(KNOWN, None, f"{marker}: `{shown}` 명령이 이 레포의 환경을 알려 주지 않았습니다", MANAGER_NO_ENV)
        for folder in folders:
            yield _Candidate(KNOWN, os.path.join(folder, "bin", "python"))


def _given(given: str) -> _Candidate:
    """`--python`에 준 값. 경로가 아니라 이름이면 환경의 `PATH`에서 찾는다."""
    if os.sep in given:
        return _Candidate(SAVED, os.path.abspath(os.path.expanduser(given)))
    path = next(_on_path(given), None)
    return _Candidate(SAVED, path) if path is not None else _Candidate(SAVED, given, "PATH에 없는 이름", NOT_ON_PATH)


def _use(settings: Settings | None) -> None:
    global _settings
    if settings is not None:
        _settings = settings


def claude(settings: Settings | None = None) -> Found:
    """Claude Code CLI. 찾은 뒤 로그인 여부를 확인해 `note`와 `auth`에 적는다.

    `_claude_refused`가 까닭을 내는 환경에서는 후보를 실행하지 않고, 그 까닭을 적은 기록 하나와 경로 없는 결과를 낸다.
    `claude auth status`는 찾을 때 한 번만 실행한다. 다시 실행하는 때는 `fresh`를 부른 뒤와 실행 파일이 바뀐 뒤다.
    """
    _use(settings)
    refused = _claude_refused()
    if refused is not None:
        fresh(CLAUDE.name)
        found = Found(CLAUDE.name, None, None, None, [Attempt(ENV, None, False, refused[1], refused[0])], code=refused[0])
        _last[(CLAUDE.name, None)] = found
        return found
    return _find(CLAUDE, _named("claude"), finish=_login)


def git(settings: Settings | None = None) -> Found:
    _use(settings)
    return _find(GIT, _named("git"))


def python(repo: Path, given: str | None = None, settings: Settings | None = None) -> Found:
    """레포의 인터프리터. 레포마다 따로 찾고 전역 인터프리터는 후보에 넣지 않는다.

    `given`은 `--python`에 준 값이다. 사용자가 그 실행에 쓸 인터프리터를 정한 것이므로 후보가 그것 하나이고,
    확인을 통과하지 못하면 다른 출처로 가지 않는다.
    """
    _use(settings)
    root = disk_path(repo)

    def candidates() -> Iterator[_Candidate]:
        if given is not None:
            yield _given(given)
            return
        saved = _settings.python(root) if _settings is not None else None
        if saved:
            yield _Candidate(SAVED, saved)
        for path in _venvs(root):
            yield _Candidate(ENV, path)
        yield from _managed(root)

    return _find(PYTHON, candidates, repo=str(root), given=given)


def attempt(tool: str, path: str) -> Attempt:
    """사용자가 직접 고른 `claude`·`git` 실행 파일 하나를 확인 명령으로 실행한 기록."""
    refused = _claude_refused() if tool == CLAUDE.name else None
    if refused is not None:
        return Attempt(SAVED, path, False, refused[1], refused[0])
    return _try({CLAUDE.name: CLAUDE, GIT.name: GIT}[tool], SAVED, os.path.abspath(os.path.expanduser(path)), "/")[0]


def probe(python: str) -> dict | None:
    """인터프리터가 알려 준 `sys.version`(version), `sys.path`(path), `sys.prefix`(prefix) 등. 실행하지 못하면 None이다.

    이 프로세스의 작업 폴더에서 실행하므로, `PYTHONPATH`의 상대 경로는 어느 레포를 묻든 같은 폴더가 된다.
    """
    try:
        code, out, _ = _execute([python, *PYTHON.args], PYTHON.timeout, None)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return _probed(out) if code == 0 else None


def _listed() -> Iterator[_Candidate]:
    """고를 수 있는 인터프리터의 후보. 환경의 `PATH`에 든 것과 pyenv·conda·uv가 가진 것이다."""
    for name in ("python3", "python"):
        for path in _on_path(name):
            yield _Candidate(ENV, path)
    root, *_ = _ask(("pyenv", "root"), "/")
    if root is not None:
        for path in sorted(glob.glob(os.path.join(glob.escape(root.strip()), "versions", "*", "bin", "python"))):
            yield _Candidate(KNOWN, path)
    envs, *_ = _ask(("conda", "env", "list", "--json"), "/")
    if envs is not None:
        try:
            folders = [env for env in json.loads(envs)["envs"] if isinstance(env, str)]
        except (ValueError, KeyError, TypeError):
            folders = []
        for folder in folders:
            yield _Candidate(KNOWN, os.path.join(folder, "bin", "python"))
    held, *_ = _ask(("uv", "python", "dir"), "/")
    if held is not None:
        for path in sorted(glob.glob(os.path.join(glob.escape(held.strip()), "*", "bin", "python3"))):
            yield _Candidate(KNOWN, path)


def interpreters() -> list[Found]:
    """인터프리터를 고르는 화면의 후보. 확인을 통과한 것만 내고, `sys.prefix`가 같은 것은 처음 나온 것만 남긴다."""
    found: list[Found] = []
    seen: set[str] = set()
    prefixes: set[object] = set()
    for candidate in _listed():
        identity = _identity(candidate.path)
        if identity in seen:
            continue
        seen.add(identity)
        attempt, fields = _try(PYTHON, candidate.source, candidate.path, "/")
        if fields is None or fields["prefix"] in prefixes:
            continue
        prefixes.add(fields["prefix"])
        found.append(Found(PYTHON.name, candidate.path, source=candidate.source, attempts=[attempt], code=OK, **fields))
    return found


def last(tool: str) -> Found | None:
    """`claude`·`git`을 마지막으로 찾은 결과. 아무것도 실행하지 않는다. 찾은 적이 없으면 None이다."""
    return _last.get((tool, None))


def fresh(tool: str | None = None) -> None:
    """메모리의 값을 버린다. `tool`을 주지 않으면 모든 도구의 값을 버린다."""
    for kept in (_memory, _last):
        for key in list(kept):
            if tool is None or key[0] == tool:
                kept.pop(key, None)
