import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

FIXTURE = Path(__file__).parent / "fixtures" / "sample_repo"

collect_ignore_glob = ["fixtures/*"]


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
    """프로세스 묶음에 남은 프로세스가 없다. 끝난 프로세스가 거둬질 때까지 `within`초 기다린다."""
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return True
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
