import os
import subprocess
import sys
import threading
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from code_atlas import shellenv, summary, tools
from code_atlas.api import create_app
from code_atlas.settings import Settings
from code_atlas.tools import ENV, KNOWN, SAVED, Attempt

VERSION = 'if [ "$1" = "--version" ]; then echo "9.8.7 (가짜)"; exit 0; fi\n'
LOGGED_IN = 'if [ "$1" = "auth" ]; then echo \'{"loggedIn": true, "authMethod": "claude.ai"}\'; exit 0; fi\n'
LOGGED_OUT = 'if [ "$1" = "auth" ]; then echo \'{"loggedIn": false, "authMethod": "none"}\'; exit 1; fi\n'


class Saved:
    """설정 파일이 `tools`에 내는 값."""

    def __init__(self, tool: dict[str, str] | None = None, python: dict[Path, str] | None = None):
        self.tools, self.pythons = tool or {}, python or {}

    def tool(self, name: str) -> str | None:
        return self.tools.get(name)

    def python(self, root: Path) -> str | None:
        return self.pythons.get(root)


def script(path: Path, body: str) -> str:
    """실행할 때마다 자기 경로 옆의 `.runs` 파일에 받은 인자를 한 줄씩 남기는 셸 스크립트."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'#!/bin/sh\necho "$*" >> "$0.runs"\n{body}')
    path.chmod(0o755)
    return str(path)


def runs(path: str | Path) -> list[str]:
    record = Path(f"{path}.runs")
    return record.read_text().splitlines() if record.exists() else []


def make_venv(folder: Path) -> str:
    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(folder)], check=True)
    return str(folder / "bin" / "python")


@pytest.fixture
def machine(tmp_path, monkeypatch):
    """`PATH`가 빈 폴더 하나이고 알려진 위치가 임시 폴더 아래인 환경. `PATH`의 폴더와 알려진 위치의 폴더를 돌려준다.

    임시 홈 폴더를 이 계정의 홈 폴더로 알려, 가짜 `claude`를 실행해도 되는 환경으로 만든다.
    """
    on_path, known = tmp_path / "path", tmp_path / "known"
    on_path.mkdir()
    (on_path / tools.KEYCHAIN_COMMAND).write_text("")
    account = SimpleNamespace(pw_dir=str(tmp_path / "home"), pw_name="tester")
    monkeypatch.setattr(tools.pwd, "getpwuid", lambda uid: account)
    monkeypatch.setenv("PATH", str(on_path))
    monkeypatch.setenv("HOME", account.pw_dir)
    monkeypatch.setenv("USER", account.pw_name)
    monkeypatch.delenv(tools.NO_CLAUDE_ENV)
    monkeypatch.setattr(
        tools,
        "PLACES",
        {"claude": (str(known / "claude"), str(known / "node" / "*" / "bin" / "claude")), "git": (str(known / "git"),)},
    )
    tools.fresh()
    yield on_path, known
    tools.fresh()


@pytest.fixture
def repo(tmp_path, machine):
    root = tmp_path / "repo"
    root.mkdir()
    return root.resolve()


def test_candidates_are_tried_in_the_order_saved_env_known(machine, tmp_path):
    on_path, known = machine
    saved = script(tmp_path / "saved" / "git", VERSION)
    script(on_path / "git", VERSION)
    script(known / "git", VERSION)

    found = tools.git(Saved({"git": saved}))
    assert (found.path, found.source, found.version) == (saved, SAVED, "9.8.7")
    assert found.attempts == [Attempt(SAVED, saved, True, "9.8.7")]
    assert runs(on_path / "git") == [] and runs(known / "git") == []  # 통과한 뒤의 후보는 실행하지 않는다

    os.remove(saved)
    found = tools.git()  # 설정을 다시 주지 않아도 저장한 경로를 읽는다
    assert (found.path, found.source) == (str(on_path / "git"), ENV)
    assert found.attempts[0] == Attempt(SAVED, saved, False, "없는 파일", tools.MISSING)

    os.remove(on_path / "git")
    assert (tools.git().path, tools.git().source) == (str(known / "git"), KNOWN)


def test_a_saved_path_that_does_not_run_leaves_its_reason_and_the_next_source_is_tried(machine, tmp_path):
    on_path, _ = machine
    not_executable = tmp_path / "saved" / "git"
    not_executable.parent.mkdir()
    not_executable.write_text("#!/bin/sh\n")
    good = script(on_path / "git", VERSION)

    found = tools.git(Saved({"git": str(not_executable)}))
    assert found.path == good
    assert found.attempts == [Attempt(SAVED, str(not_executable), False, "실행 권한 없음", tools.NOT_EXECUTABLE), Attempt(ENV, good, True, "9.8.7")]

    tools.fresh()
    found = tools.git(Saved({"git": str(tmp_path)}))
    assert found.attempts[0] == Attempt(SAVED, str(tmp_path), False, "파일이 아닙니다", tools.NOT_FILE) and found.path == good


def test_a_candidate_that_fails_the_check_command_does_not_pass(machine):
    on_path, known = machine
    failing = script(on_path / "git", "echo '첫 줄' >&2\necho '설치가 깨졌다' >&2\nexit 3\n")
    silent = script(known / "git", "exit 0\n")

    found = tools.git()
    assert found.path is None and found.version is None and found.source is None and found.code == tools.FAILED
    assert found.attempts == [
        Attempt(ENV, failing, False, "종료 코드 3: 설치가 깨졌다", tools.FAILED),
        Attempt(KNOWN, silent, False, "확인 명령의 출력을 읽지 못했습니다", tools.UNREADABLE),
    ]
    assert runs(failing) == ["--version"] and runs(silent) == ["--version"]  # 파일이 있다는 것만으로 통과시키지 않는다


@pytest.mark.slow
def test_a_candidate_that_does_not_end_in_time_is_ended_and_the_next_is_tried(machine, monkeypatch):
    on_path, known = machine
    slow = script(on_path / "git", "/bin/sleep 30\n")
    good = script(known / "git", VERSION)
    monkeypatch.setattr(tools, "GIT", replace(tools.GIT, timeout=2.0))

    started = time.monotonic()
    found = tools.git()
    assert time.monotonic() - started < 10
    assert found.path == good and found.attempts[0] == Attempt(ENV, slow, False, "2초 안에 끝나지 않았습니다", tools.TIMEOUT)


def test_the_same_file_is_tried_once(machine, monkeypatch):
    on_path, known = machine
    failing = script(on_path / "git", "exit 1\n")
    (known.parent / "link").symlink_to(on_path)
    monkeypatch.setenv("PATH", f"{on_path}:{known.parent / 'link'}:{on_path}")
    monkeypatch.setattr(tools, "PLACES", {**tools.PLACES, "git": (failing,)})

    assert tools.git().attempts == [Attempt(ENV, failing, False, "종료 코드 1", tools.FAILED)]
    assert runs(failing) == ["--version"]


def test_a_found_tool_is_not_run_again_until_its_file_changes(machine):
    on_path, known = machine
    first = script(on_path / "git", VERSION)
    second = script(known / "git", VERSION.replace("9.8.7", "1.2.3"))

    assert tools.git() is tools.git() and runs(first) == ["--version"]  # 네 값이 그대로면 프로세스를 띄우지 않는다

    script(on_path / "git", VERSION.replace("9.8.7", "9.9.0"))  # 바뀐 파일은 다시 확인한다
    assert tools.git().version == "9.9.0" and len(runs(first)) == 2

    os.remove(first)  # 지운 파일은 쓰지 않고 다음 후보를 찾는다
    found = tools.git()
    assert (found.path, found.version, found.source) == (second, "1.2.3", KNOWN)

    script(on_path / "git", VERSION)  # 찾아 둔 파일이 그대로면 앞 출처에 새로 생긴 후보를 보지 않는다
    assert tools.git().path == second
    tools.fresh("claude")
    assert tools.git().path == second
    tools.fresh("git")
    assert tools.git().path == first


def test_the_command_line_tools_stub_is_not_run_without_the_command_line_tools(machine, tmp_path, monkeypatch):
    on_path, _ = machine
    stub = script(on_path / "git", VERSION)
    xcode_select = tmp_path / "xcode-select"
    monkeypatch.setattr(tools.sys, "platform", "darwin")
    monkeypatch.setattr(tools, "CLT_STUBS", frozenset({os.path.realpath(stub)}))
    monkeypatch.setattr(tools, "XCODE_SELECT", str(xcode_select))

    script(xcode_select, "echo 'xcode-select: error: unable to get active developer directory' >&2\nexit 2\n")
    found = tools.git()
    assert found.path is None and found.attempts[0] == Attempt(ENV, stub, False, "Xcode Command Line Tools가 없습니다", tools.NO_CLT)
    assert found.code == "no_clt"  # 다른 위치의 없는 파일은 경우를 바꾸지 않는다
    assert runs(xcode_select) == ["-p"] and runs(stub) == []

    script(xcode_select, f"echo '{tmp_path / 'gone'}'\n")  # 알려 준 폴더가 없다
    assert tools.git().path is None and runs(stub) == []

    script(xcode_select, f"echo '{tmp_path}'\n")
    assert tools.git().path == stub and runs(stub) == ["--version"]


def test_claude_in_version_managers_is_found_newest_first(machine):
    _, known = machine
    for version in ("v9.11.0", "v20.1.0", "v22.17.0"):
        script(known / "node" / version / "bin" / "claude", VERSION + LOGGED_IN)
    newest = str(known / "node" / "v22.17.0" / "bin" / "claude")

    found = tools.claude()
    assert (found.path, found.source, found.version) == (newest, KNOWN, "9.8.7")
    assert found.attempts == [Attempt(KNOWN, str(known / "claude"), False, "없는 파일", tools.MISSING), Attempt(KNOWN, newest, True, "9.8.7")]

    os.remove(newest)
    assert tools.claude().path == str(known / "node" / "v20.1.0" / "bin" / "claude")


@pytest.mark.slow
def test_claude_reports_the_login_and_asks_once(machine, monkeypatch):
    on_path, _ = machine
    cli = script(on_path / "claude", VERSION + LOGGED_IN)
    found = tools.claude()
    assert (found.path, found.note, found.auth, found.code) == (cli, None, "claude.ai", tools.OK)
    assert tools.claude() is found and runs(cli) == ["--version", "auth status --json"]

    script(on_path / "claude", VERSION + LOGGED_OUT)
    found = tools.claude()
    assert (found.path, found.note, found.auth, found.code) == (cli, "Claude Code에 로그인돼 있지 않습니다", None, "not_logged_in")

    script(on_path / "claude", VERSION + 'if [ "$1" = "auth" ]; then echo "알 수 없는 명령"; exit 0; fi\n')
    found = tools.claude()  # 로그인 여부를 알려 주지 않는 CLI는 막지 않는다
    assert (found.path, found.note, found.auth) == (cli, None, None)

    script(on_path / "claude", VERSION + "/bin/sleep 30\n")
    monkeypatch.setattr(tools, "CLAUDE_TIMEOUT", 1.0)
    assert (tools.claude().note, tools.claude().code) == ("Claude Code CLI가 응답하지 않습니다", "not_answering")


@pytest.mark.slow
def test_a_process_past_its_time_limit_gets_sigterm_and_is_killed_only_after_the_grace(machine, monkeypatch):
    on_path, known = machine
    saves = script(on_path / "git", 'trap \'echo saved > "$0.saved"; exit 0\' TERM\n/bin/sleep 30 &\nwait\n')
    ignores = script(known / "git", 'trap "" TERM\necho $$ > "$0.pid"\n/bin/sleep 30 &\nwait\n/bin/sleep 30\n')
    monkeypatch.setattr(tools, "GIT", replace(tools.GIT, timeout=1.0))
    monkeypatch.setattr(tools, "TERM_GRACE", 1.0)

    started = time.monotonic()
    found = tools.git()
    assert found.path is None and [a.detail for a in found.attempts] == ["1초 안에 끝나지 않았습니다"] * 2
    assert Path(f"{saves}.saved").read_text() == "saved\n"  # SIGTERM을 받은 프로세스가 하던 일을 마치고 끝난다
    assert 3.0 <= time.monotonic() - started < 12  # SIGTERM을 무시한 프로세스는 기다린 뒤에 끝낸다
    with pytest.raises(ProcessLookupError):
        os.killpg(int(Path(f"{ignores}.pid").read_text()), 0)


def test_claude_checks_run_alone_and_other_claude_runs_wait_for_them(machine):
    on_path, _ = machine
    turns = tools.CLAUDE_TURNS
    slow = 'echo "$1 start" >> "$0.order"\n/bin/sleep 0.4\necho "$1 end" >> "$0.order"\n'
    cli = script(on_path / "claude", slow + VERSION + LOGGED_IN)

    assert turns.enter()  # 요약의 `claude -p` 하나가 도는 중
    checking = threading.Thread(target=tools.claude)
    checking.start()
    time.sleep(0.3)
    assert runs(cli) == []  # 확인 명령은 도는 `claude`가 끝나기를 기다린다
    assert not turns.enter()  # 확인 명령이 기다리는 동안 새 `claude`는 시작하지 않는다
    turns.leave()
    time.sleep(0.3)
    assert not turns.enter()  # 확인 명령이 도는 동안에도 시작하지 않는다
    checking.join()
    assert Path(f"{cli}.order").read_text().split("\n")[:4] == ["--version start", "--version end", "auth start", "auth end"]
    assert turns.enter() and turns.enter()  # 확인 명령이 없으면 둘이 함께 돈다
    turns.leave()
    turns.leave()


@pytest.mark.parametrize(
    ("change", "code", "reason"),
    [
        (lambda patch, home: patch.setenv(tools.NO_CLAUDE_ENV, "1"), "disabled", "환경 변수 CODE_ATLAS_NO_CLAUDE가 켜져 있습니다"),
        (lambda patch, home: patch.setattr(tools.shellenv, "_reading", object()), "shell_pending", "로그인 셸의 환경을 읽는 중입니다"),
        (lambda patch, home: patch.delenv("HOME"), "home_mismatch", "환경의 HOME이 이 계정의 홈 폴더({home})가 아닙니다"),
        (lambda patch, home: patch.setenv("HOME", "/tmp"), "home_mismatch", "환경의 HOME이 이 계정의 홈 폴더({home})가 아닙니다"),
        (lambda patch, home: patch.setenv("USER", "other"), "user_mismatch", "환경의 USER가 이 계정의 이름(tester)이 아닙니다"),
        (lambda patch, home: patch.setenv("PATH", f"{home}/nowhere"), "no_keychain_command", "환경의 PATH에 security가 없습니다"),
    ],
    ids=["꺼 둠", "로그인 셸을 읽는 중", "HOME 없음", "다른 HOME", "다른 USER", "security 없는 PATH"],
)
def test_claude_is_not_run_in_an_environment_that_differs_from_the_login(machine, tmp_path, monkeypatch, change, code, reason):
    on_path, known = machine
    monkeypatch.setattr(tools.sys, "platform", "darwin")
    cli = script(on_path / "claude", VERSION + LOGGED_IN)
    script(known / "claude", VERSION + LOGGED_IN)
    assert tools.claude().path == cli and len(runs(cli)) == 2

    change(monkeypatch, tmp_path / "home")
    detail = f"확인하지 못함: {reason.format(home=tmp_path / 'home')}"
    found = tools.claude()
    assert (found.path, found.version, found.note, found.code) == (None, None, None, code)
    assert found.attempts == [Attempt(ENV, None, False, detail, code)] and tools.last("claude") is found
    assert tools.attempt("claude", cli) == Attempt(SAVED, cli, False, detail, code)
    assert len(runs(cli)) == 2 and runs(known / "claude") == []  # 찾아 둔 경로도 다른 위치의 후보도 실행하지 않는다


def test_a_test_without_a_fake_claude_runs_no_claude():
    found = tools.claude()
    assert found.path is None and tools.PLACES["claude"] == ()
    assert found.attempts == [Attempt(ENV, None, False, "확인하지 못함: 환경 변수 CODE_ATLAS_NO_CLAUDE가 켜져 있습니다", tools.DISABLED)]
    assert not any(os.path.exists(os.path.join(folder, "claude")) for folder in os.environ["PATH"].split(os.pathsep))


def test_claude_without_user_in_the_environment_runs_as_the_account(machine, monkeypatch):
    on_path, _ = machine
    cli = script(on_path / "claude", VERSION + LOGGED_IN)
    monkeypatch.delenv("USER")
    assert tools.claude().path == cli


def test_python_is_found_in_the_virtual_environments_of_the_repo(repo):
    assert tools.python(repo).path is None and tools.python(repo).attempts == [] and tools.python(repo).code == "not_found"

    other = make_venv(repo / "env-b")
    (repo / "empty").mkdir()
    (repo / "broken").mkdir()
    (repo / "broken" / "pyvenv.cfg").write_text("home = /nowhere\n")
    found = tools.python(repo)
    assert (found.path, found.source, found.venv, found.prefix) == (other, ENV, True, str(repo / "env-b"))
    assert found.version == ".".join(map(str, sys.version_info[:3]))
    assert found.attempts[0] == Attempt(ENV, str(repo / "broken" / "bin" / "python"), False, "없는 파일", tools.MISSING)

    plain = make_venv(repo / "venv")
    dotted = make_venv(repo / ".venv")  # 두 가상환경의 바탕 인터프리터가 같아도 따로 본다
    tools.fresh()
    assert tools.python(repo).path == dotted
    os.remove(dotted)
    assert tools.python(repo).path == plain


def test_python_does_not_fall_back_to_an_interpreter_on_path(repo, tmp_path, monkeypatch):
    held = Path(make_venv(tmp_path / "held")).parent
    monkeypatch.setenv("PATH", str(held))
    found = tools.python(repo)
    assert found.path is None and found.attempts == []
    assert [(f.source, f.path) for f in tools.interpreters()] == [(ENV, str(held / "python3"))]


def test_python_saved_for_the_repo_comes_first_and_a_broken_one_leaves_its_reason(repo, tmp_path):
    venv = make_venv(repo / ".venv")
    chosen = make_venv(tmp_path / "chosen")
    settings = Saved(python={repo: chosen})
    found = tools.python(repo, settings=settings)
    assert (found.path, found.source) == (chosen, SAVED)

    os.remove(chosen)
    found = tools.python(repo)
    assert (found.path, found.source) == (venv, ENV)
    assert found.attempts[0] == Attempt(SAVED, chosen, False, "없는 파일", tools.MISSING)
    assert tools.python(tmp_path).path is None  # 저장한 경로는 그 레포에만 쓴다


@pytest.mark.parametrize(
    ("marker", "content", "manager", "answer"),
    [
        ("poetry.lock", "", "poetry", "echo 'Creating virtualenv'\necho '{env}'\n"),
        (".python-version", "3.12.4\n", "pyenv", "echo '{env}:/other/prefix'\n"),
        ("environment.yml", "channels:\n  - defaults\nname: atlas-env  # 주석\n", "conda", "echo '{{\"envs\": [\"/x/base\", \"{env}\"]}}'\n"),
    ],
)
def test_python_is_asked_of_the_manager_the_marker_file_names(repo, machine, tmp_path, marker, content, manager, answer):
    on_path, _ = machine
    env = tmp_path / "managed" / "atlas-env"
    interpreter = make_venv(env)
    (repo / marker).write_text(content)

    found = tools.python(repo)
    assert found.path is None
    assert found.attempts == [Attempt(KNOWN, None, False, f"{marker}: PATH에 {manager}가 없습니다", tools.MANAGER_MISSING)]

    asked = script(on_path / manager, f'pwd > "$0.cwd"\n{answer.format(env=env)}')
    found = tools.python(repo)
    assert (found.path, found.source, found.venv) == (interpreter, KNOWN, True)
    assert Path(f"{asked}.cwd").read_text().strip() == str(repo)  # 관리자는 레포 루트에서 묻는다

    venv = make_venv(repo / ".venv")  # 레포 안의 가상환경이 통과하면 관리자에게 묻지 않는다
    tools.fresh()
    before = len(runs(asked))
    assert tools.python(repo).path == venv and len(runs(asked)) == before


def test_python_records_a_manager_that_fails_or_names_no_environment(repo, machine):
    on_path, _ = machine
    (repo / "poetry.lock").write_text("")
    (repo / "environment.yml").write_text("dependencies:\n  - python\n")
    script(on_path / "poetry", "echo '가상환경이 없다' >&2\nexit 1\n")
    script(on_path / "conda", "echo '{\"envs\": [\"/x/base\"]}'\n")

    assert tools.python(repo).attempts == [
        Attempt(KNOWN, None, False, "poetry.lock: `poetry env info -p` 명령이 실패했습니다(종료 코드 1: 가상환경이 없다)", tools.MANAGER_FAILED),
        Attempt(KNOWN, None, False, "environment.yml: `conda env list --json` 명령이 이 레포의 환경을 알려 주지 않았습니다", tools.MANAGER_NO_ENV),
    ]


def test_python_given_on_the_command_line_is_the_only_candidate(repo, machine, tmp_path):
    on_path, _ = machine
    venv = make_venv(repo / ".venv")
    chosen = make_venv(tmp_path / "chosen")

    assert (tools.python(repo, chosen).path, tools.python(repo, chosen).source) == (chosen, SAVED)
    assert tools.python(repo).path == venv  # 준 값은 그 호출에만 쓴다

    (on_path / "python9").symlink_to(chosen)
    assert tools.python(repo, "python9").path == str(on_path / "python9")

    for given, detail in (
        ("no-such-python", "PATH에 없는 이름"),
        (str(tmp_path / "no" / "python"), "없는 파일"),
        (str(repo), "파일이 아닙니다"),
        ("/bin/ls", None),
    ):
        found = tools.python(repo, given)
        assert found.path is None and len(found.attempts) == 1 and found.attempts[0].source == SAVED
        assert detail is None or found.attempts[0].detail == detail
    assert tools.python(repo, "/bin/ls").attempts[0].detail.startswith("종료 코드 ")


def test_probe_reads_what_the_interpreter_tells(tmp_path):
    told = tools.probe(sys.executable)
    assert (told["version"], told["prefix"], told["executable"]) == (sys.version, sys.prefix, sys.executable)
    assert set(told["path"]) >= {path for path in sys.path if path.endswith("site-packages")}
    assert tools.probe(str(tmp_path / "no-python")) is None and tools.probe("/bin/ls") is None


def test_interpreters_lists_what_path_and_the_managers_hold(machine, tmp_path, monkeypatch):
    on_path, _ = machine
    assert tools.interpreters() == []

    in_pyenv = Path(make_venv(tmp_path / "pyenv" / "versions" / "3.12.4"))
    in_conda = make_venv(tmp_path / "conda-a")
    in_uv = Path(make_venv(tmp_path / "uv" / "cpython-3.12"))
    monkeypatch.setenv("PATH", f"{on_path}:{in_pyenv.parent}")  # `PATH`의 것과 pyenv가 가진 것의 `sys.prefix`가 같다
    script(on_path / "python", "exit 1\n")
    script(on_path / "pyenv", f"echo '{tmp_path / 'pyenv'}'\n")
    script(on_path / "conda", f"echo '{{\"envs\": [\"{tmp_path / 'conda-a'}\", \"{tmp_path / 'gone'}\"]}}'\n")
    script(on_path / "uv", f"echo '{tmp_path / 'uv'}'\n")

    found = tools.interpreters()
    assert [(f.source, f.path) for f in found] == [
        (ENV, str(in_pyenv.parent / "python3")),
        (KNOWN, in_conda),
        (KNOWN, str(in_uv.parent / "python3")),
    ]
    assert all(f.tool == "python" and f.venv and f.version and f.attempts[0].ok for f in found)
    assert found[0].prefix == str(tmp_path / "pyenv" / "versions" / "3.12.4")


@pytest.fixture
def served(machine, tmp_path, monkeypatch):
    """연 레포 없이 뜬 서버와 그 서버의 설정 파일."""
    monkeypatch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
    settings = Settings(tmp_path / "config" / "settings.json")
    with TestClient(create_app(settings=settings)) as client:
        yield client, settings


def test_tools_route_gives_what_was_found_and_check_looks_again(served, machine, monkeypatch):
    client, _ = served
    on_path, known = machine
    git = script(on_path / "git", VERSION)
    monkeypatch.setattr(shellenv, "last", shellenv.ShellEnv("/bin/zsh", True, "", 1.5, {"PATH": "/x"}))

    found = client.get("/api/tools").json()
    assert found["shell"] == {"shell": "/bin/zsh", "ok": True, "detail": "", "seconds": 1.5}
    assert (found["git"]["path"], found["git"]["source"], found["git"]["version"]) == (git, ENV, "9.8.7")
    assert found["claude"]["path"] is None and found["claude"]["attempts"][0]["detail"] == "없는 파일"
    assert (found["claude"]["code"], found["claude"]["attempts"][0]["code"], found["git"]["code"]) == ("not_found", "missing", "ok")
    assert found["python"] is None  # 연 레포가 없습니다

    cli = script(known / "claude", VERSION + LOGGED_OUT)
    assert client.get("/api/tools").json()["git"]["path"] == git and len(runs(git)) == 1
    found = client.post("/api/tools/check").json()
    assert (found["claude"]["path"], found["claude"]["note"]) == (cli, "Claude Code에 로그인돼 있지 않습니다")
    assert found["claude"]["code"] == "not_logged_in"
    assert len(runs(git)) == 2


def test_a_chosen_tool_is_saved_only_when_it_passes_and_is_forgotten_on_delete(served, machine, tmp_path):
    client, settings = served
    on_path, _ = machine
    on_path_git = script(on_path / "git", VERSION)
    chosen = script(tmp_path / "chosen" / "git", VERSION.replace("9.8.7", "1.2.3"))
    broken = script(tmp_path / "broken" / "git", "exit 2\n")

    refused = client.put("/api/tools/git", json={"path": broken})
    assert refused.status_code == 400 and settings.tool("git") is None
    assert refused.json()["attempt"] == {"source": SAVED, "path": broken, "ok": False, "detail": "종료 코드 2", "code": "failed"}
    assert refused.json()["code"] == "failed"
    assert client.put("/api/tools/python", json={"path": chosen}).status_code == 404

    saved = client.put("/api/tools/git", json={"path": chosen}).json()
    assert (saved["path"], saved["source"], saved["version"]) == (chosen, SAVED, "1.2.3")
    assert settings.tool("git") == chosen and tools.git().path == chosen

    found = client.delete("/api/tools/git").json()
    assert (found["path"], found["source"]) == (on_path_git, ENV) and settings.tool("git") is None


def test_interpreters_route_and_the_answer_check(served, machine, tmp_path, monkeypatch):
    client, _ = served
    on_path, _ = machine
    held = Path(make_venv(tmp_path / "held")).parent
    monkeypatch.setenv("PATH", f"{on_path}:{held}")
    found = client.get("/api/interpreters").json()["found"]
    assert [(f["path"], f["venv"]) for f in found] == [(str(held / "python3"), True)]

    assert client.post("/api/tools/claude/ask").json()["detail"] == "Claude Code CLI를 찾지 못했습니다"
    answer = """printf '%s\\n' '{"is_error": false, "result": "예"}'\n"""
    cli = script(on_path / "claude", VERSION + LOGGED_IN + answer)
    asked = client.post("/api/tools/claude/ask").json()
    assert (asked["ok"], asked["detail"]) == (True, "") and runs(cli)[-1].startswith("-p ")
    script(on_path / "claude", VERSION + LOGGED_IN + "echo '망에 닿지 못했다' >&2\nexit 7\n")
    asked = client.post("/api/tools/claude/ask").json()
    assert asked["ok"] is False and "종료 코드 7" in asked["detail"] and "망에 닿지 못했다" in asked["detail"]


@pytest.mark.slow
def test_opening_repos_runs_claude_twice_in_all(served, machine, sample_repo):
    client, _ = served
    on_path, _ = machine
    cli = script(on_path / "claude", VERSION + LOGGED_IN)

    def opened() -> None:
        assert client.post("/api/open", json={"path": str(sample_repo), "python": sys.executable}).status_code == 200
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and not (runs(cli) and client.get("/api/status").json()["phase"] == "ready"):
            time.sleep(0.1)
        for node in ("app.core", "app.cli"):
            assert client.get("/api/summary", params={"node": node}).json()["available"] is True

    assert runs(cli) == []  # 서버가 뜰 때는 실행하지 않는다
    opened()
    assert runs(cli) == ["--version", "auth status --json"]
    opened()
    client.get("/api/tools")
    assert runs(cli) == ["--version", "auth status --json"]  # 레포를 다시 열어도, 요약을 물어도 더 실행하지 않는다

