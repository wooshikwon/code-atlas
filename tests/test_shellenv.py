import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from conftest import group_ended

from code_atlas import shellenv

# 받은 명령을 그대로 실행하는 가짜 셸. `-ilc`와 명령을 인자로 받는다.
PLAIN = 'FROM_SHELL="셸이 더한 값"\nMULTI="첫 줄\n둘째 줄"\nexport FROM_SHELL MULTI\neval "$2"\n'
NOISY = (
    'printf \'\\033[1;32m어서 오세요\\033[0m {"PATH": "가짜"}\\n\'\necho "경고: 설정이 오래됐다" >&2\n'
    'FROM_SHELL="셸이 더한 값"\nexport FROM_SHELL\neval "$2"\nprintf \'\\n\\033[0m끝 }\\n\'\n'
)
HANGING = 'echo $$ > "$0.pid"\n/bin/sleep 20 &\nwait\n'
FAILING = 'echo "첫 줄" >&2\necho "설정 파일을 읽지 못했다" >&2\nexit 3\n'
# 환경을 낸 뒤에도 출력을 쥔 채 남는 프로세스를 띄운다.
LINGERING = 'eval "$2"\n/bin/sleep 15 &\n'


@pytest.fixture
def shell(tmp_path, monkeypatch):
    """사용자 계정의 셸을 임시 폴더의 가짜 `zsh`로 바꾼다. 홈 폴더도 임시 폴더다."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("ZDOTDIR", raising=False)

    def install(body: str, name: str = "zsh") -> Path:
        script = tmp_path / "shells" / name
        script.parent.mkdir(exist_ok=True)
        script.write_text("#!/bin/sh\n" + body)
        script.chmod(0o755)
        use(str(script))
        return script

    def use(path: str) -> None:
        monkeypatch.setattr(shellenv.pwd, "getpwuid", lambda uid: SimpleNamespace(pw_shell=path))

    install.use, install.home = use, home
    return install


def test_reads_the_environment_the_shell_holds(shell, monkeypatch):
    monkeypatch.setenv("FROM_APP", "앱이 받은 값")
    path = shell(PLAIN)
    got = shellenv.read()
    assert (got.shell, got.ok, got.detail) == (str(path), True, "") and got is shellenv.last
    assert got.env["FROM_SHELL"] == "셸이 더한 값" and got.env["MULTI"] == "첫 줄\n둘째 줄"
    assert got.env["FROM_APP"] == "앱이 받은 값" and got.env["HOME"] == str(shell.home)
    assert "DISABLE_AUTO_UPDATE" not in got.env  # 셸에만 넘긴 값은 읽은 환경에 남기지 않는다


def test_reads_between_the_marks_when_the_shell_prints_a_banner_and_colors(shell):
    shell(NOISY)
    got = shellenv.read()
    assert got.ok and got.env["FROM_SHELL"] == "셸이 더한 값" and got.env["PATH"] == os.environ["PATH"]


def test_a_shell_that_does_not_end_is_ended_after_the_time_limit(shell):
    path = shell(HANGING)
    started = time.monotonic()
    got = shellenv.read(timeout=1.5)
    assert 1.5 <= time.monotonic() - started < 8
    assert (got.ok, got.env) == (False, None)
    assert got.detail == "로그인 셸(zsh)이 1.5초 안에 환경을 알려 주지 않았습니다. 앱이 받은 환경과 알려진 설치 위치에서 도구를 찾습니다"
    assert group_ended(int(Path(f"{path}.pid").read_text()))


def test_a_shell_that_fails_gives_its_exit_code_and_last_line(shell):
    shell(FAILING)
    got = shellenv.read()
    assert (got.ok, got.env) == (False, None)
    assert got.detail == "로그인 셸의 출력에서 환경을 읽지 못했습니다(종료 코드 3): 설정 파일을 읽지 못했다"


def test_a_process_the_shell_leaves_behind_does_not_hold_the_reading(shell):
    shell(LINGERING)
    started = time.monotonic()
    got = shellenv.read()
    assert got.ok and time.monotonic() - started < 10


def test_a_shell_that_is_not_supported_is_not_started(shell):
    path = shell("echo run > \"$0.ran\"\n", name="tcsh")
    got = shellenv.read()
    assert (got.ok, got.env, got.seconds) == (False, None, 0.0)
    assert got.detail == "로그인 셸 tcsh은 환경을 읽지 않습니다. zsh, bash, fish를 읽습니다"
    assert not Path(f"{path}.ran").exists()

    shell.use(str(path.parent / "gone" / "zsh"))
    assert shellenv.read().detail.startswith("로그인 셸(zsh)을 띄우지 못했습니다")


@pytest.mark.parametrize(
    ("path", "config"),
    [("/bin/zsh", ".zshrc"), ("/bin/bash", ".bash_profile"), (shutil.which("fish"), ".config/fish/config.fish")],
    ids=["zsh", "bash", "fish"],
)
def test_real_shells_give_what_their_config_exports(shell, path, config, monkeypatch):
    if path is None or not os.path.exists(path):
        pytest.skip("설치돼 있지 않은 셸")
    folder = shell.home / "tools 폴더's"  # 빈칸과 작은따옴표가 든 경로에 있는 인터프리터도 셸이 실행한다
    folder.mkdir()
    (folder / "python").symlink_to(shellenv.sys.executable)
    monkeypatch.setattr(shellenv.sys, "executable", str(folder / "python"))
    export = "set -gx {} {}" if config.endswith(".fish") else "export {}={}"
    file = shell.home / config
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(
        "echo '어서 오세요'\n"
        + export.format("PATH", f'"{folder}:$PATH"')
        + "\n"
        + export.format("FROM_CONFIG", "'설정이 더한 값'")
        + "\n"
    )
    shell.use(path)
    got = shellenv.read()
    assert got.ok, got.detail
    assert got.env["FROM_CONFIG"] == "설정이 더한 값" and got.env["PATH"].split(":")[0] == str(folder)
    assert 0 < got.seconds < shellenv.TIMEOUT


def test_adopt_replaces_the_whole_environment_with_what_was_read(shell, monkeypatch):
    kept = dict(os.environ)
    try:
        assert shellenv.adopt() is None  # 읽기 시작한 적이 없으면 환경을 그대로 둔다
        assert dict(os.environ) == kept

        os.environ["ONLY_IN_APP"] = "셸이 지운 값"
        os.environ["PWD"] = "/앱의/작업 폴더"
        shell('unset ONLY_IN_APP\nFROM_SHELL="셸이 더한 값"\nexport FROM_SHELL\ncd /\neval "$2"\n')
        shellenv.start()
        got = shellenv.adopt()
        assert got is shellenv.last and got.ok
        assert "ONLY_IN_APP" not in os.environ and os.environ["FROM_SHELL"] == "셸이 더한 값"
        assert os.environ["PWD"] == "/앱의/작업 폴더"  # 셸이 프로세스마다 정하는 값은 앱의 것을 둔다
        assert shellenv.adopt() is None

        os.environ["ONLY_IN_APP"] = "남는 값"
        shell(FAILING)
        shellenv.start()
        assert not shellenv.adopt().ok and os.environ["ONLY_IN_APP"] == "남는 값"  # 읽지 못하면 받은 환경을 그대로 쓴다
    finally:
        os.environ.clear()
        os.environ.update(kept)


@pytest.mark.parametrize(("option", "started"), [("--hosted", "True"), ("--no-open", "False")])
def test_cli_starts_reading_before_its_heavy_imports_only_when_hosted(tmp_path, option, started):
    code = (
        "import sys; sys.argv[1:] = [sys.argv[1]]; from code_atlas import shellenv; from code_atlas import cli; "
        "print(shellenv._reading is not None)"
    )
    done = subprocess.run(
        [sys.executable, "-c", code, option],
        capture_output=True,
        text=True,
        env={**os.environ, "HOME": str(tmp_path)},
        timeout=60,
    )
    assert done.stdout.strip() == started, done.stderr
