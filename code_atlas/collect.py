"""레포에서 분석할 `.py` 파일을 모으고 소스 루트·테스트 코드·진입점 설정을 판정한다. 설정 파일의 본문도 여기서 읽는다."""

from __future__ import annotations

import fcntl
import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import pathspec

SKIP_DIRS = {"__pycache__", "node_modules", "site-packages"}
TEST_DIRS = {"tests", "test"}
CONFIG_SUFFIXES = (".yaml", ".yml", ".toml", ".json", ".cfg", ".ini")
CONFIG_LIMIT = 500_000


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


def disk_path(path: str | Path) -> Path:
    """심볼릭 링크를 풀고 폴더·파일 이름을 디스크에 적힌 대소문자로 맞춘 절대 경로.

    대소문자를 구분하지 않는 파일 시스템은 대소문자가 다른 경로로 같은 파일을 열므로, 레포 루트와 언어 서버가 돌려준
    경로를 이 함수로 바꾼 뒤 비교한다. 운영체제가 연 파일의 경로를 알려 주지 않거나 파일이 없으면 심볼릭 링크만 푼다.
    """
    resolved = Path(path).resolve()
    if not hasattr(fcntl, "F_GETPATH"):
        return resolved
    try:
        fd = os.open(resolved, os.O_RDONLY)
    except OSError:
        return resolved
    try:
        return Path(os.fsdecode(fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024)).rstrip(b"\0")))
    except OSError:
        return resolved
    finally:
        os.close(fd)


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


def _skipped(root: Path, rel: str, ignore: pathspec.PathSpec) -> bool:
    """훑지 않는 폴더다. 숨긴 폴더, `SKIP_DIRS`, 가상환경, `.gitignore`에 걸린 폴더가 해당한다."""
    name = rel.rsplit("/", 1)[-1]
    if name.startswith(".") or name in SKIP_DIRS:
        return True
    return (root / rel / "pyvenv.cfg").exists() or ignore.match_file(rel + "/")


def _each(root: Path, ignore: pathspec.PathSpec, suffixes: tuple[str, ...] | None):
    """훑지 않는 폴더와 `.gitignore`에 걸린 파일을 건너뛰며 `suffixes`로 끝나는 파일의 레포 루트 기준 경로를 하나씩 낸다.

    `suffixes`가 None이면 확장자를 가리지 않는다.
    """
    stack = [root]
    while stack:
        current = stack.pop()
        for entry in sorted(current.iterdir()):
            rel = entry.relative_to(root).as_posix()
            if entry.is_dir():
                if not _skipped(root, rel, ignore):
                    stack.append(entry)
            elif (suffixes is None or entry.suffix in suffixes) and not ignore.match_file(rel):
                yield rel


def _walk(root: Path, ignore: pathspec.PathSpec, suffixes: tuple[str, ...] = (".py",)) -> list[str]:
    return sorted(_each(root, ignore, suffixes))


def any_source(root: Path) -> bool:
    """`collect`가 모을 `.py` 파일이 하나라도 있다. 첫 파일을 찾으면 더 훑지 않는다."""
    return next(_each(root, _load_gitignore(root), (".py",)), None) is not None


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


def others(root: Path) -> list[str]:
    """`collect`가 모으지 않는 파일의 레포 루트 기준 경로. 훑지 않는 폴더와 `.gitignore`는 `collect`와 같다."""
    return sorted(rel for rel in _each(root, _load_gitignore(root), None) if not rel.endswith(".py"))


def listed(root: Path, paths: list[str]) -> set[str]:
    """레포 루트 기준 경로 가운데 `collect`나 `others`가 내는 파일. 레포를 훑지 않고 경로마다 조상 폴더와 `.gitignore`만 확인한다."""
    if not paths:
        return set()
    ignore = _load_gitignore(root)
    found: set[str] = set()
    for path in paths:
        parts = path.split("/")
        folders = ("/".join(parts[:i]) for i in range(1, len(parts)))
        if not ignore.match_file(path) and not any(_skipped(root, f, ignore) for f in folders):
            found.add(path)
    return found


def collected(root: Path, paths: list[str]) -> set[str]:
    """레포 루트 기준 경로 가운데 `collect`가 모으는 파일. 레포를 훑지 않고 경로마다 조상 폴더와 `.gitignore`만 확인한다."""
    return listed(root, [path for path in paths if path.endswith(".py")])


def config_texts(root: Path) -> list[str]:
    """레포의 설정 파일 가운데 `CONFIG_LIMIT`바이트 이하인 파일의 본문. 훑지 않는 폴더와 `.gitignore`는 `collect`와 같다."""
    texts: list[str] = []
    for rel in _walk(root, _load_gitignore(root), CONFIG_SUFFIXES):
        try:
            if (root / rel).stat().st_size <= CONFIG_LIMIT:
                texts.append((root / rel).read_bytes().decode("utf-8", errors="replace"))
        except OSError:
            continue
    return texts


def collect(repo: str | Path) -> RepoFiles:
    root = disk_path(repo)
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
