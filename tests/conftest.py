import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

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
def analyzed(tmp_path_factory):
    """고정 레포에 실제 basedpyright를 띄워 한 번 분석한 결과."""
    from code_atlas.analyze import analyze

    found = analyze(_copy_fixture(tmp_path_factory.mktemp("analyzed")), sys.executable)
    return found.analysis, found.files
