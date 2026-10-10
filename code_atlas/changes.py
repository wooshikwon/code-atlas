"""마지막 커밋(`HEAD`) 뒤에 바뀐 파일과 줄 범위를 git에서 읽는다.

git 명령 실행과 출력 해석은 이 모듈만 한다. 읽기 명령만 부르고, `git status`는 `GIT_OPTIONAL_LOCKS=0`으로,
`git diff`는 `diff.autoRefreshIndex=false`로 인덱스를 다시 쓰지 않게 하므로 대상 레포는 바뀌지 않는다.
경로는 모두 레포 루트 기준 posix 경로다.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

GIT_TIMEOUT = 5.0

MODIFIED = "modified"
ADDED = "added"
DELETED = "deleted"
UNCHANGED = "unchanged"

_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
_NEW_FILE = "+++ b/"


def _git(root: Path, *args: str) -> str | None:
    """레포 루트에서 git 명령을 부른다. git이 없거나, 시간 안에 끝나지 않거나, 종료 코드가 0이 아니면 None이다."""
    try:
        done = subprocess.run(
            ["git", "-C", str(root), "-c", "core.quotepath=false", "-c", "diff.autoRefreshIndex=false", *args],
            capture_output=True,
            timeout=GIT_TIMEOUT,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout.decode("utf-8", errors="replace") if done.returncode == 0 else None


def _state(index: str, worktree: str) -> str | None:
    """`git status`의 두 글자를 상태로 바꾼다. 커밋에도 디스크에도 없는 파일은 None이다."""
    if worktree == "D":
        return None if index == "A" else DELETED
    if index == "D":
        return DELETED
    return ADDED if index in "A?" else MODIFIED


def status(root: Path) -> dict[str, str] | None:
    """경로별 상태(modified·added·deleted). git 저장소가 아니거나 git이 없으면 None이다.

    스테이징한 새 파일과 추적하지 않는 파일은 added다. 이름을 바꾼 파일은 새 경로가 added, 옛 경로가 deleted다.
    레포 루트가 git 저장소의 하위 폴더면 그 폴더 안의 파일만 낸다.
    """
    prefix = _git(root, "rev-parse", "--show-prefix")
    if prefix is None:
        return None
    out = _git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ".")
    if out is None:
        return None
    skip = len(prefix.strip()) + 3  # 상태 두 글자와 빈칸, git 최상위 폴더에서 레포 루트까지의 경로
    found: dict[str, str] = {}
    for entry in out.split("\0"):
        state = _state(entry[0], entry[1]) if len(entry) > skip else None
        if state is None:
            continue
        path = entry[skip:]
        # 인덱스에서만 지운 파일은 삭제 줄과 추적하지 않는 파일 줄로 두 번 나온다.
        found[path] = MODIFIED if found.get(path) == DELETED and state == ADDED else state
    return found


def hunks(root: Path) -> dict[str, list[tuple[int, int]]] | None:
    """`.py` 파일마다 `HEAD`와 달라진 줄 범위(지금 파일의 1부터 세는 시작 줄과 끝 줄).

    줄이 지워지기만 한 곳은 지워진 줄 바로 앞 줄과 뒤 줄을 범위로 낸다.
    커밋이 없는 저장소는 빈 dict이고, git 저장소가 아니거나 git이 없으면 None이다.
    """
    if _git(root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}") is None:
        return None if _git(root, "rev-parse", "--git-dir") is None else {}
    out = _git(
        root,
        "diff",
        "-U0",
        "--relative",
        "--no-renames",
        "--no-color",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "HEAD",
        "--",
        "*.py",
    )
    if out is None:
        return None
    found: dict[str, list[tuple[int, int]]] = {}
    ranges: list[tuple[int, int]] | None = None
    for line in out.splitlines():
        if line.startswith("diff --git "):
            ranges = None
        elif ranges is None:
            if line.startswith(_NEW_FILE):
                ranges = found.setdefault(line[len(_NEW_FILE) :].rstrip("\t"), [])
        elif (m := _HUNK.match(line)) is not None:
            start, count = int(m[1]), int(m[2] or 1)
            ranges.append((start, start + count - 1) if count else (max(start, 1), start + 1))
    return found


def branch(root: Path) -> str | None:
    """지금 브랜치 이름. git 저장소가 아니거나 브랜치 없이 커밋을 직접 가리키면 None이다."""
    out = _git(root, "symbolic-ref", "--short", "--quiet", "HEAD")
    return out.strip() if out else None
