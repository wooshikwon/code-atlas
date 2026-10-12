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
import re
import signal
import subprocess
import sys
import threading
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .settings import Settings

SAVED = "saved"
ENV = "env"
KNOWN = "known"

# 확인 명령의 시간 제한. 이 Mac에서 잰 값은 `claude --version` 0.14초, `claude auth status` 0.82초, `git --version`
# 0.10초, `xcode-select -p` 0.09초, pyenv shim을 거친 인터프리터 0.2초 안쪽, 관리자 명령 가운데 가장 느린
# `poetry env info -p`와 `conda env list --json`이 0.9초다. 느린 디스크와 처음 실행을 감안해 잰 값의 열 배 이상을 둔다.
CLAUDE_TIMEOUT = 10.0
GIT_TIMEOUT = 5.0  # `git.py`가 git 명령 하나에 두는 값과 같다
PROBE_TIMEOUT = 5.0
MANAGER_TIMEOUT = 10.0

STATUS_ARGS = ("auth", "status", "--json")
NOT_LOGGED_IN = "Claude Code에 로그인돼 있지 않다"
NOT_ANSWERING = "Claude Code CLI가 응답하지 않는다"

# Xcode Command Line Tools가 없으면 실행할 때 설치 창을 띄우는 macOS의 껍데기 파일
CLT_STUBS = frozenset({"/usr/bin/git", "/usr/bin/python3"})
XCODE_SELECT = "/usr/bin/xcode-select"
NO_CLT = "Xcode Command Line Tools가 없다"

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


@dataclass(frozen=True)
class _Tool:
    """도구마다 다른 확인 명령. `read`는 명령의 표준 출력에서 `Found`에 적을 값을 읽고, 읽지 못하면 None을 낸다."""

    name: str
    args: tuple[str, ...]
    timeout: float
    read: Callable[[str], dict[str, object] | None]


@dataclass(frozen=True)
class _Candidate:
    """확인할 후보. `detail`이 있으면 실행하지 않고 그 까닭으로 기록한다."""

    source: str
    path: str | None
    detail: str = ""


_settings: Settings | None = None
_memory: dict[tuple[str, str | None], tuple[Found, tuple[int, int, int, int], str | None]] = {}
_locks: dict[tuple[str, str | None], threading.Lock] = {}
_guard = threading.Lock()


def _execute(command: list[str], timeout: float, cwd: str | None) -> tuple[int, str, str]:
    """자기 프로세스 묶음으로 명령을 띄워 종료 코드, 표준 출력, 표준 오류를 낸다. 시간 안에 끝나지 않으면 묶음을 끝낸다."""
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
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
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

    def failed(detail: str) -> tuple[Attempt, None]:
        return Attempt(source, path, False, detail), None

    if not os.path.exists(path):
        return failed("없는 파일")
    if not os.path.isfile(path):
        return failed("파일이 아니다")
    if not os.access(path, os.X_OK):
        return failed("실행 권한 없음")
    if sys.platform == "darwin" and os.path.realpath(path) in CLT_STUBS and not _has_clt():
        return failed(NO_CLT)
    try:
        code, out, err = _execute([path, *tool.args], tool.timeout, cwd)
    except subprocess.TimeoutExpired:
        return failed(f"{tool.timeout:g}초 안에 끝나지 않았다")
    except OSError as exc:
        return failed(f"실행하지 못했다: {exc.strerror or exc}")
    if code != 0:
        return failed(_failure(code, err))
    fields = tool.read(out)
    if fields is None:
        return failed("확인 명령의 출력을 읽지 못했다")
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

    메모리에 통과한 값이 있고 그 파일의 네 값이 그대로면 그 값을 낸다. 아니면 후보를 차례로 실행해 처음 통과한
    것을 쓰고, 그 뒤 후보는 만들지도 실행하지도 않는다. `finish`는 통과한 결과를 메모리에 두기 전에 한 번 부른다.
    """
    key = (tool.name, repo)
    with _guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        kept = _memory.get(key)
        if kept is not None:
            found, stamp, asked = kept
            if asked == given and found.path is not None and _stamp(found.path) == stamp:
                return found
            _memory.pop(key, None)
        found = Found(tool.name, None, None, None, [])
        seen: set[str] = set()
        for candidate in candidates():
            if candidate.path is None or candidate.detail:
                found.attempts.append(Attempt(candidate.source, candidate.path, False, candidate.detail))
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
            found.path, found.source = candidate.path, candidate.source
            for name, value in fields.items():
                setattr(found, name, value)
            if finish is not None:
                finish(found)
            _memory[key] = (found, stamp, given)
            break
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


CLAUDE = _Tool("claude", ("--version",), CLAUDE_TIMEOUT, _version)
GIT = _Tool("git", ("--version",), GIT_TIMEOUT, _version)
PYTHON = _Tool("python", ("-c", _PROBE), PROBE_TIMEOUT, _interpreter)


def _login(found: Found) -> None:
    """`claude auth status`로 로그인 여부와 로그인 방법을 읽어 `note`와 `auth`에 적는다."""
    try:
        code, out, _ = _execute([found.path, *STATUS_ARGS], CLAUDE_TIMEOUT, "/")
    except (OSError, subprocess.TimeoutExpired):
        found.note = NOT_ANSWERING
        return
    try:
        told = json.loads(out)
    except ValueError:
        told = None
    if not isinstance(told, dict):
        told = {}
    if code == 1 or told.get("loggedIn") is False:
        found.note = NOT_LOGGED_IN
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


def _ask(command: tuple[str, ...], cwd: str) -> tuple[str | None, str]:
    """관리자 명령을 환경의 `PATH`에서 이름으로 찾아 실행한다. 표준 출력과, 출력을 받지 못한 까닭을 낸다."""
    shown = " ".join(command)
    exe = next(_on_path(command[0]), None)
    if exe is None:
        return None, f"PATH에 {command[0]}가 없다"
    try:
        code, out, err = _execute([exe, *command[1:]], MANAGER_TIMEOUT, cwd)
    except subprocess.TimeoutExpired:
        return None, f"`{shown}` 명령이 {MANAGER_TIMEOUT:g}초 안에 끝나지 않았다"
    except OSError as exc:
        return None, f"`{shown}` 명령을 실행하지 못했다: {exc.strerror or exc}"
    if code != 0:
        return None, f"`{shown}` 명령이 실패했다({_failure(code, err)})"
    return out, ""


def _managed(root: Path) -> Iterator[_Candidate]:
    """레포의 표지 파일이 가리키는 관리자에게 물은 환경의 인터프리터."""
    for marker, command, prefixes in MANAGERS:
        if not (root / marker).is_file():
            continue
        out, why = _ask(command, str(root))
        if out is None:
            yield _Candidate(KNOWN, None, f"{marker}: {why}")
            continue
        folders = prefixes(root, out)
        if not folders:
            yield _Candidate(KNOWN, None, f"{marker}: `{' '.join(command)}` 명령이 이 레포의 환경을 알려 주지 않았다")
        for folder in folders:
            yield _Candidate(KNOWN, os.path.join(folder, "bin", "python"))


def _given(given: str) -> _Candidate:
    """`--python`에 준 값. 경로가 아니라 이름이면 환경의 `PATH`에서 찾는다."""
    if os.sep in given:
        return _Candidate(SAVED, os.path.abspath(os.path.expanduser(given)))
    path = next(_on_path(given), None)
    return _Candidate(SAVED, path) if path is not None else _Candidate(SAVED, given, "PATH에 없는 이름")


def _use(settings: Settings | None) -> None:
    global _settings
    if settings is not None:
        _settings = settings


def claude(settings: Settings | None = None) -> Found:
    """Claude Code CLI. 찾은 뒤 로그인 여부를 확인해 `note`와 `auth`에 적는다."""
    _use(settings)
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
    root = Path(repo).resolve()

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
    root, _ = _ask(("pyenv", "root"), "/")
    if root is not None:
        for path in sorted(glob.glob(os.path.join(glob.escape(root.strip()), "versions", "*", "bin", "python"))):
            yield _Candidate(KNOWN, path)
    envs, _ = _ask(("conda", "env", "list", "--json"), "/")
    if envs is not None:
        try:
            folders = [env for env in json.loads(envs)["envs"] if isinstance(env, str)]
        except (ValueError, KeyError, TypeError):
            folders = []
        for folder in folders:
            yield _Candidate(KNOWN, os.path.join(folder, "bin", "python"))
    held, _ = _ask(("uv", "python", "dir"), "/")
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
        found.append(Found(PYTHON.name, candidate.path, source=candidate.source, attempts=[attempt], **fields))
    return found


def fresh(tool: str | None = None) -> None:
    """메모리의 값을 버린다. `tool`을 주지 않으면 모든 도구의 값을 버린다."""
    for key in list(_memory):
        if tool is None or key[0] == tool:
            _memory.pop(key, None)
