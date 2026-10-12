"""고른 폴더를 레포로 열기 전에 판정한다.

`probe`가 폴더가 있는지, 분석할 `.py` 파일이 있는지, 조상에 프로젝트 루트가 있는지, 레포 여러 개를 품은 폴더인지,
인터프리터가 찾아지는지를 낸다. 대상 폴더에 쓰지 않고, 판정을 어떤 순서로 묻고 여는지는 모른다.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import git, tools
from .collect import any_source, disk_path
from .settings import Settings

PROJECT_MARKS = (".git", "pyproject.toml")


@dataclass
class Probe:
    path: str  # 디스크에 적힌 대소문자로 맞춘 절대 경로
    exists: bool
    python_files: bool  # `collect`가 모을 `.py` 파일이 하나라도 있다
    project: str | None  # 조상 가운데 `.git`이나 `pyproject.toml`이 있는 가장 가까운 폴더
    nested: list[str]  # 바로 아래 폴더 가운데 `.git`이 있는 폴더의 이름
    git: bool  # git 저장소이거나 그 하위 폴더다
    python: tools.Found  # 열 수 없는 폴더는 찾지 않으므로 시도 목록이 비어 있다


def _project(root: Path) -> str | None:
    """홈 폴더 아래의 조상 가운데 프로젝트 표지가 있는 가장 가까운 폴더. `root` 자신은 보지 않는다."""
    home = disk_path(Path.home())
    for parent in root.parents:
        if not parent.is_relative_to(home) or parent == home:
            return None
        if any((parent / mark).exists() for mark in PROJECT_MARKS):
            return str(parent)
    return None


def probe(path: str | Path, settings: Settings | None = None) -> Probe:
    root = disk_path(Path(path).expanduser())
    exists = root.is_dir()
    python_files = exists and any_source(root)
    python = tools.python(root, None, settings) if python_files else tools.Found("python", None, None, None, [])
    return Probe(
        path=str(root),
        exists=exists,
        python_files=python_files,
        project=_project(root) if exists else None,
        nested=sorted(child.name for child in root.iterdir() if (child / ".git").exists()) if exists else [],
        git=exists and (git.head(root) is not None or git.branch(root) is not None),
        python=python,
    )
