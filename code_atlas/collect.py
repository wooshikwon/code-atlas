"""레포에서 분석할 `.py` 파일을 모으고 소스 루트·테스트 코드·진입점 설정을 판정한다."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import pathspec

SKIP_DIRS = {"__pycache__", "node_modules", "site-packages"}
TEST_DIRS = {"tests", "test"}


@dataclass
class SourceFile:
    path: str  # 레포 루트 기준 posix 경로
    module_id: str  # 소스 루트 기준 점 경로. `__init__.py`는 패키지 경로
    test: bool
    is_init: bool


@dataclass
class RepoFiles:
    root: Path
    source_root: str  # 레포 루트 기준 경로. 레포 루트 자신이면 ""
    files: list[SourceFile]
    packages: list[str]  # `.py` 파일을 품은 폴더의 레포 루트 기준 경로
    scripts: list[str] = field(default_factory=list)  # `[project.scripts]` 대상 "모듈:함수"
    extra_paths: list[str] = field(default_factory=list)  # `[tool.pytest.ini_options].pythonpath`

    def abs_path(self, path: str) -> Path:
        return self.root / path


def is_test_path(path: str) -> bool:
    parts = path.split("/")
    name = parts[-1]
    if any(p in TEST_DIRS for p in parts[:-1]):
        return True
    return name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py"


def module_id(path: str, source_root: str) -> str:
    rel = path
    if source_root and path.startswith(source_root + "/"):
        rel = path[len(source_root) + 1 :]
    parts = rel[: -len(".py")].split("/")
    if parts[-1] == "__init__" and len(parts) > 1:
        parts = parts[:-1]
    return ".".join(parts)


def find_source_root(paths: list[str]) -> str:
    if any("/" not in p for p in paths):
        return ""
    tops = {p.split("/", 1)[0] for p in paths}
    tops -= TEST_DIRS
    return tops.pop() if len(tops) == 1 else ""


def _load_gitignore(root: Path) -> pathspec.PathSpec:
    gitignore = root / ".gitignore"
    lines = gitignore.read_text(encoding="utf-8").splitlines() if gitignore.is_file() else []
    return pathspec.GitIgnoreSpec.from_lines(lines)


def _walk(root: Path, ignore: pathspec.PathSpec) -> list[str]:
    found: list[str] = []
    stack = [root]
    while stack:
        current = stack.pop()
        for entry in sorted(current.iterdir()):
            rel = entry.relative_to(root).as_posix()
            if entry.is_dir():
                if entry.name.startswith(".") or entry.name in SKIP_DIRS:
                    continue
                if (entry / "pyvenv.cfg").exists() or ignore.match_file(rel + "/"):
                    continue
                stack.append(entry)
            elif entry.suffix == ".py" and not ignore.match_file(rel):
                found.append(rel)
    return sorted(found)


def _read_pyproject(root: Path) -> tuple[list[str], list[str]]:
    pyproject = root / "pyproject.toml"
    if not pyproject.is_file():
        return [], []
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    scripts = list(data.get("project", {}).get("scripts", {}).values())
    pythonpath = data.get("tool", {}).get("pytest", {}).get("ini_options", {}).get("pythonpath", [])
    if isinstance(pythonpath, str):
        pythonpath = pythonpath.split()
    return scripts, list(pythonpath)


def collect(repo: str | Path) -> RepoFiles:
    root = Path(repo).resolve()
    paths = _walk(root, _load_gitignore(root))
    source_root = find_source_root(paths)
    files = [
        SourceFile(
            path=p,
            module_id=module_id(p, source_root),
            test=is_test_path(p),
            is_init=p.endswith("/__init__.py") or p == "__init__.py",
        )
        for p in paths
    ]
    packages = sorted({"/".join(p.split("/")[:i]) for p in paths for i in range(1, p.count("/") + 1)})
    scripts, extra_paths = _read_pyproject(root)
    return RepoFiles(root, source_root, files, packages, scripts, extra_paths)
