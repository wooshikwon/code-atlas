import shutil
from pathlib import Path

import pytest

FIXTURE = Path(__file__).parent / "fixtures" / "sample_repo"

collect_ignore_glob = ["fixtures/*"]


@pytest.fixture
def sample_repo(tmp_path: Path) -> Path:
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
