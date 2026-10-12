"""대상 레포의 git 이력과 변경을 읽는다.

git 명령 실행과 출력 해석은 이 모듈만 한다. 부르는 명령은 `rev-parse`, `symbolic-ref`, `log`, `status`, `diff`,
`merge-base`, `archive`, `show`이고 모두 `_run` 하나를 지난다. `git status`는 `GIT_OPTIONAL_LOCKS=0`으로, `git diff`는
`diff.autoRefreshIndex=false`로 인덱스를 다시 쓰지 않게 하므로 대상 레포는 바뀌지 않는다. `git archive`의 출력은
레포 밖 폴더에만 푼다. 경로는 모두 레포 루트 기준 posix 경로이고, 레포 루트가 git 저장소의 하위 폴더면 그 폴더 안의
파일만 낸다. 분석 결과와 캐시, 어느 시점을 견주는지는 모른다.
"""

from __future__ import annotations

import io
import os
import re
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path

from .collect import collected, disk_path

GIT_TIMEOUT = 5.0
ARCHIVE_TIMEOUT = 60.0

WORKTREE = "worktree"

MODIFIED = "modified"
ADDED = "added"
DELETED = "deleted"
RENAMED = "renamed"
UNCHANGED = "unchanged"

_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
_OLD_FILE = "--- a/"
_NEW_FILE = "+++ b/"
_FIELD = "%x00"
_LOG_FORMAT = f"--format=%H{_FIELD}%P{_FIELD}%ct{_FIELD}%D{_FIELD}%s%x01"
_DECORATED = ("refs/heads", "refs/tags", "refs/remotes")
_STATES = {"A": ADDED, "D": DELETED, "R": RENAMED}
_DIFF = ("--relative", "-M", "--no-color", "--no-ext-diff", "--no-textconv")


@dataclass
class Commit:
    hash: str
    parents: list[str]
    time: int  # 커밋한 때의 유닉스 시각(초)
    subject: str
    refs: list[str]  # 브랜치·태그 이름. 원격 브랜치는 `origin/main` 꼴


@dataclass
class Changed:
    status: str  # added·deleted·modified·renamed
    path: str  # 대상 쪽 경로. 삭제된 파일은 기준 쪽 경로
    old: str | None = None  # 이름이 바뀌기 전 경로


@dataclass
class Hunk:
    """`git diff -U0`의 토막 하나. 기준 쪽 줄 범위가 삭제된 줄이고 대상 쪽 줄 범위가 추가된 줄이다."""

    old_start: int
    old_count: int
    new_start: int
    new_count: int


def _run(root: Path, *args: str, timeout: float = GIT_TIMEOUT) -> bytes | None:
    """레포 루트에서 git 명령을 부른다. git이 없거나, 시간 안에 끝나지 않거나, 종료 코드가 0이 아니면 None이다."""
    try:
        done = subprocess.run(
            ["git", "-C", str(root), "-c", "core.quotepath=false", "-c", "diff.autoRefreshIndex=false", *args],
            capture_output=True,
            timeout=timeout,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout if done.returncode == 0 else None


def _git(root: Path, *args: str) -> str | None:
    out = _run(root, *args)
    return out.decode("utf-8", errors="replace") if out is not None else None


def _commit(root: Path, name: str) -> str | None:
    out = _git(root, "rev-parse", "--verify", "--quiet", f"{name}^{{commit}}")
    return out.strip() if out else None


def head(root: Path) -> str | None:
    """지금 커밋의 해시. git 저장소가 아니거나 커밋이 없으면 None이다."""
    return _commit(root, "HEAD")


def branch(root: Path) -> str | None:
    """지금 브랜치 이름. git 저장소가 아니거나 브랜치 없이 커밋을 직접 가리키면 None이다."""
    out = _git(root, "symbolic-ref", "--short", "--quiet", "HEAD")
    return out.strip() if out else None


def default_branch(root: Path) -> str | None:
    """`origin/HEAD`가 가리키는 브랜치의 커밋 해시. 없으면 로컬 `main`, `master`의 커밋이고 그것도 없으면 None이다."""
    for name in ("refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"):
        found = _commit(root, name)
        if found is not None:
            return found
    return None


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


def _refs(decoration: str) -> list[str]:
    """`%D`의 브랜치·태그 이름. `HEAD ->`와 `tag:`를 떼고 `HEAD`와 원격의 `HEAD`는 뺀다."""
    found: list[str] = []
    for name in decoration.split(", "):
        name = name.removeprefix("HEAD -> ").removeprefix("tag: ")
        if name and name != "HEAD" and not name.endswith("/HEAD"):
            found.append(name)
    return found


def commits(root: Path, skip: int, limit: int) -> list[Commit]:
    """로컬 브랜치, 원격 브랜치, 태그, 지금 커밋에서 닿는 커밋을 날짜 순서로 `skip`번째부터 `limit`개. 읽지 못하면 빈 목록이다."""
    out = _git(
        root,
        "log",
        "--branches",
        "--tags",
        "--remotes",
        "HEAD",
        "--date-order",
        "--no-show-signature",
        *(f"--decorate-refs={ref}" for ref in _DECORATED),
        f"--skip={skip}",
        f"--max-count={limit}",
        _LOG_FORMAT,
    )
    found: list[Commit] = []
    for entry in (out or "").split("\x01"):
        fields = entry.lstrip("\n").split("\0")
        if len(fields) == 5:
            commit, parents, time, decoration, subject = fields
            found.append(Commit(commit, parents.split(), int(time), subject, _refs(decoration)))
    return found


def committed(root: Path, commit: str) -> int | None:
    """그 커밋을 커밋한 때의 유닉스 시각(초). 커밋이 없으면 None이다."""
    out = _git(root, "log", "--max-count=1", "--no-show-signature", "--format=%ct", commit, "--")
    return int(out) if out and out.strip().isdigit() else None


def is_ancestor(root: Path, old: str, new: str) -> bool:
    """`old`가 `new`의 조상이거나 같은 커밋이다."""
    return _run(root, "merge-base", "--is-ancestor", old, new) is not None


def merge_base(root: Path, a: str, b: str) -> str | None:
    """두 커밋이 갈라진 커밋의 해시. 공통 조상이 없으면 None이다."""
    out = _git(root, "merge-base", a, b)
    return out.strip() if out else None


def _ends(base: str, target: str) -> list[str]:
    return [base] if target == WORKTREE else [base, target]


def _untracked(root: Path, known: set[str]) -> list[str]:
    """추적하지 않는 `.py` 파일 가운데 `known`에 없는 경로."""
    states = status(root) or {}
    return sorted(p for p, state in states.items() if state == ADDED and p.endswith(".py") and p not in known)


def _patched(root: Path, base: str, target: str) -> dict[str, list[Hunk]]:
    """`git diff -U0`가 낸 `.py` 파일마다의 토막. 키는 대상 쪽 경로이고 삭제된 파일은 기준 쪽 경로다."""
    out = _git(
        root, "diff", "-U0", *_DIFF, "--src-prefix=a/", "--dst-prefix=b/", *_ends(base, target), "--", "*.py"
    )
    found: dict[str, list[Hunk]] = {}
    old: str | None = None
    current: list[Hunk] | None = None
    for line in (out or "").splitlines():
        if line.startswith("diff --git "):
            old = current = None
        elif current is None:
            if line.startswith(_OLD_FILE):
                old = line[len(_OLD_FILE) :].rstrip("\t")
            elif line.startswith(_NEW_FILE):
                current = found.setdefault(line[len(_NEW_FILE) :].rstrip("\t"), [])
            elif line == "+++ /dev/null" and old is not None:
                current = found.setdefault(old, [])
        elif (m := _HUNK.match(line)) is not None:
            current.append(Hunk(int(m[1]), int(m[2] or 1), int(m[3]), int(m[4] or 1)))
    return found


def changed(root: Path, base: str, target: str) -> list[Changed]:
    """두 시점 사이에 바뀐 분석 대상 `.py` 파일. `target`이 `WORKTREE`면 디스크의 파일과 견주고 추적하지 않는 파일을 added로 더한다.

    `collect`가 모으지 않는 경로는 뺀다. 이름이 바뀐 파일의 한쪽 경로만 분석 대상이면 그쪽의 추가나 삭제로 낸다.
    """
    out = _git(root, "diff", "--name-status", "-z", *_DIFF, *_ends(base, target), "--", "*.py")
    fields = (out or "").split("\0")
    found: list[Changed] = []
    i = 0
    while i + 1 < len(fields):
        state = _STATES.get(fields[i][:1], MODIFIED)
        if state == RENAMED:
            found.append(Changed(RENAMED, fields[i + 2], fields[i + 1]))
            i += 3
        else:
            found.append(Changed(state, fields[i + 1]))
            i += 2
    if target == WORKTREE:
        # 인덱스를 다시 쓰지 않으므로 수정 시각만 바뀐 파일도 수정으로 나온다. 줄이 달라진 파일만 남긴다.
        differing = _patched(root, base, target)
        found = [c for c in found if c.status != MODIFIED or c.path in differing]
        found.extend(Changed(ADDED, path) for path in _untracked(root, {c.path for c in found}))
    kept = collected(root, [p for c in found for p in (c.path, c.old) if p is not None])
    result: list[Changed] = []
    for c in found:
        if c.old is not None and c.path in kept and c.old in kept:
            result.append(c)
        elif c.path in kept:
            result.append(Changed(ADDED if c.old is not None else c.status, c.path))
        elif c.old in kept:
            result.append(Changed(DELETED, c.old))
    return sorted(result, key=lambda c: c.path)


def _lines(file: Path) -> int:
    try:
        data = file.read_bytes()
    except OSError:
        return 0
    return data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)


def hunks(root: Path, base: str, target: str) -> dict[str, list[Hunk]]:
    """분석 대상 `.py` 파일마다 두 시점 사이의 토막. 키는 대상 쪽 경로이고 삭제된 파일은 기준 쪽 경로다.

    `target`이 `WORKTREE`면 디스크의 파일과 견주고, 추적하지 않는 파일은 파일의 줄 수 전체를 추가된 줄로 낸다.
    줄이 달라지지 않은 파일(이름만 바뀐 파일, 빈 파일)은 키가 없다. 읽지 못하면 빈 dict다.
    """
    found = _patched(root, base, target)
    if target == WORKTREE:
        for path in _untracked(root, set(found)):
            count = _lines(root / path)
            if count:
                found[path] = [Hunk(0, 0, 1, count)]
    kept = collected(root, list(found))
    return {path: found[path] for path in sorted(kept)}


def export(root: Path, commit: str, dest: Path) -> None:
    """그 커밋의 파일을 `git archive`로 읽어 `dest`에 푼다. `dest`가 레포 루트 아래면 `ValueError`다.

    레포 루트가 git 저장소의 하위 폴더면 그 폴더 안의 파일만 푼다. `dest` 밖을 가리키는 멤버는 풀지 않는다.
    읽지 못하면 `OSError`다.
    """
    if disk_path(dest).is_relative_to(disk_path(root)):
        raise ValueError(f"꺼낼 폴더가 레포 안이다: {dest}")
    out = _run(root, "archive", "--format=tar", commit, timeout=ARCHIVE_TIMEOUT)
    if out is None:
        raise OSError(f"git archive가 커밋을 읽지 못했다: {commit}")
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(out)) as tar:
        for member in tar:
            try:
                tar.extract(member, dest, filter="data")
            except tarfile.FilterError:
                continue


def show(root: Path, commit: str, path: str) -> str | None:
    """그 커밋에 든 파일의 본문. 커밋이나 파일이 없으면 None이다."""
    out = _run(root, "show", "--no-textconv", f"{commit}:./{path}")
    return out.decode("utf-8-sig", errors="replace") if out is not None else None
