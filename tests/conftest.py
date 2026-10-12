import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest
from history import build, run

FIXTURE = Path(__file__).parent / "fixtures" / "sample_repo"
CYCLE_FIXTURE = Path(__file__).parent / "fixtures" / "cycle_repo"
EXTERNAL_FIXTURE = Path(__file__).parent / "fixtures" / "external_repo"

collect_ignore_glob = ["fixtures/*"]


@pytest.fixture(scope="session", autouse=True)
def cache_dir(tmp_path_factory):
    """분석 캐시의 기본 폴더를 임시 폴더로 바꾼다. 시험은 `~/.cache/code-atlas`에 쓰지 않는다."""
    from code_atlas import cache

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(cache, "CACHE_DIR", tmp_path_factory.mktemp("analysis-cache"))
        yield


@pytest.fixture(scope="session", autouse=True)
def no_real_claude():
    """시험은 이 컴퓨터에 설치된 `claude`를 실행하지 않는다.

    알려진 위치와 `PATH`에서 `claude`가 든 폴더를 빼고, 시험이 띄우는 프로세스까지 `CODE_ATLAS_NO_CLAUDE`로 막는다.
    가짜 `claude`를 쓰는 시험은 자기 fixture에서 이 변수를 지운다.
    """
    from code_atlas import tools

    folders = os.environ.get("PATH", "").split(os.pathsep)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(tools, "PLACES", {**tools.PLACES, "claude": ()})
        patch.setenv(tools.NO_CLAUDE_ENV, "1")
        patch.setenv("PATH", os.pathsep.join(f for f in folders if not os.path.exists(os.path.join(f, "claude"))))
        yield


@pytest.fixture(autouse=True)
def forgotten_tools(monkeypatch):
    """찾아 둔 `claude`와 기억한 설정을 시험마다 버린다."""
    from code_atlas import tools

    tools.fresh(tools.CLAUDE.name)
    monkeypatch.setattr(tools, "_settings", None)


def _copy_fixture(tmp_path: Path) -> Path:
    """고정 레포를 복사하고 git에 담을 수 없는 무시 대상 파일과 가상환경 폴더를 더한다."""
    repo = tmp_path / "sample_repo"
    shutil.copytree(FIXTURE, repo)
    (repo / "ignored_dir").mkdir()
    (repo / "ignored_dir" / "skip.py").write_text("x = 1\n")
    (repo / "src" / "app" / "schema.gen.py").write_text("x = 1\n")
    venv = repo / "env"
    (venv / "lib").mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text("home = /usr/bin\n")
    (venv / "lib" / "site.py").write_text("x = 1\n")
    return repo


def git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=test", "-c", "user.email=test@example.com", *args],
        check=True,
        capture_output=True,
    )


def group_ended(pgid: int, within: float = 3.0) -> bool:
    """프로세스 묶음에 남은 프로세스가 없다. 끝난 프로세스가 거둬질 때까지 `within`초 기다린다.

    macOS는 끝났지만 아직 거둬지지 않은 프로세스만 남은 묶음에 신호를 보내면 EPERM을 낸다. 그 묶음은 거둬지면 없어지므로 계속 기다린다.
    """
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            pass
        time.sleep(0.05)
    return False


def _commit_fixture(tmp_path: Path) -> Path:
    """고정 레포를 복사해 git 저장소로 만들고 모든 파일을 커밋한다."""
    repo = tmp_path / "sample_repo"
    shutil.copytree(FIXTURE, repo)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "처음")
    return repo


@pytest.fixture
def sample_repo(tmp_path: Path) -> Path:
    return _copy_fixture(tmp_path)


@pytest.fixture
def external_repo(tmp_path: Path) -> Path:
    """외부 클래스를 상속한 클래스와 외부 클래스의 재내보내기가 있는 고정 레포의 사본."""
    return Path(shutil.copytree(EXTERNAL_FIXTURE, tmp_path / "external_repo"))


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    return _commit_fixture(tmp_path)


@pytest.fixture(scope="module")
def module_repo(tmp_path_factory) -> Path:
    return _copy_fixture(tmp_path_factory.mktemp("module"))


@pytest.fixture(scope="session")
def built_history(tmp_path_factory) -> tuple[Path, dict[str, str]]:
    """세션에 한 번 만드는 이력 고정 레포와 단계 이름표별 커밋 해시. 시험은 `_copy_history`가 낸 사본을 쓴다."""
    repo = tmp_path_factory.mktemp("built") / "history_repo"
    return repo, build(repo)


def _copy_history(built: tuple[Path, dict[str, str]], repo: Path) -> tuple[Path, dict[str, str]]:
    """만들어 둔 이력 고정 레포를 `.git`까지 복사하고 인덱스의 파일 정보를 사본에 맞춘다."""
    source, at = built
    shutil.copytree(source, repo, symlinks=True)
    run(repo, "status")
    return repo, dict(at)


@pytest.fixture
def history_repo(built_history, tmp_path: Path) -> tuple[Path, dict[str, str]]:
    """이력이 있는 고정 레포와 단계 이름표별 커밋 해시."""
    return _copy_history(built_history, tmp_path / "history_repo")


@pytest.fixture(scope="module")
def module_history(built_history, tmp_path_factory) -> tuple[Path, dict[str, str]]:
    """모듈의 시험이 함께 읽는 `history_repo`. 시험은 이 레포를 고치지 않는다."""
    return _copy_history(built_history, tmp_path_factory.mktemp("history") / "history_repo")


@pytest.fixture(scope="session")
def analyzed(tmp_path_factory):
    """고정 레포에 실제 basedpyright를 띄워 한 번 분석한 결과."""
    from code_atlas.analyze import analyze

    found = analyze(_copy_fixture(tmp_path_factory.mktemp("analyzed")), sys.executable)
    return found.analysis, found.files
