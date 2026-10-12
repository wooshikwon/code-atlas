"""과거 커밋 하나를 레포 밖 폴더에 꺼내 분석한다.

`Snapshots.at`이 `git.export`로 꺼낸 폴더를 `analyze.refresh`에 넘기고, 분석이 끝나면 세션을 닫고 폴더를 지운다.
캐시에 그 커밋의 판정이 있으면 언어 서버 없이 조립하고, 없으면 받은 분석 결과 가운데 바뀐 파일이 가장 적은 결과에서
증분으로 분석한다. 결과가 어떻게 견줘지고 HTTP로 나가는지는 모르고, 작업 중인 상태의 세션과 분석 태스크를 쓰지 않는다.
"""

from __future__ import annotations

import asyncio
import hashlib
import shutil
from collections.abc import Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass
from pathlib import Path

from . import cache as caching
from . import git
from .analyze import Analyzed, Progress, refresh
from .cache import Cache, environment
from .collect import RepoFiles, collect, disk_path
from .lsp import Session

HELD = 2  # 메모리에 두는 시점의 수. 비교 하나가 쓰는 기준과 대상이다


@dataclass
class _Running:
    task: asyncio.Task
    waiting: int = 0


async def _finished(call: Callable, *args):
    """`call`을 다른 스레드에서 부르고, 기다리는 동안 취소되면 그 호출이 끝난 뒤에 취소를 올린다."""
    running = asyncio.ensure_future(asyncio.to_thread(call, *args))
    try:
        return await asyncio.shield(running)
    except asyncio.CancelledError:
        await asyncio.gather(running, return_exceptions=True)
        raise


class Snapshots:
    """레포 하나의 시점별 분석 결과와 그 분석이 쓰는 꺼낸 폴더.

    꺼낸 폴더는 `{directory}/snapshots/{레포 루트 해시 16자}/{커밋 해시}`이고 `directory`를 주지 않으면 분석 캐시의
    폴더다. 만들 때 앞 실행이 남긴 그 레포의 폴더를 지운다. `python`은 원본 레포를 분석하는 인터프리터의 절대 경로다.
    """

    def __init__(self, root: Path, python: str, cache: Cache | None, directory: Path | None = None):
        self.root = disk_path(root)
        self.python = python
        self.cache = cache
        key = hashlib.sha256(str(self.root).encode()).hexdigest()[:16]
        self.directory = Path(directory or caching.CACHE_DIR) / "snapshots" / key
        self._held: dict[str, Analyzed] = {}  # 커밋 해시 → 결과. 마지막에 쓴 시점이 뒤에 온다
        self._running: dict[str, _Running] = {}
        shutil.rmtree(self.directory, ignore_errors=True)

    def held(self, commit: str) -> Analyzed | None:
        """메모리에 둔 그 커밋의 결과. 없으면 None이다."""
        return self._held.get(commit)

    async def at(
        self, commit: str, near: list[Analyzed], report: Callable[[Progress], None] = lambda progress: None
    ) -> Analyzed:
        """그 커밋의 분석 결과. `near`는 증분의 바탕으로 쓸 후보이고 작업 중인 상태의 결과와 `at`이 낸 결과를 받는다.

        같은 커밋을 다시 받으면 메모리의 결과를 돌려주고, 함께 들어온 같은 커밋의 요청은 한 번만 분석한다. 기다리는
        요청이 모두 취소되면 분석을 멈춘다. 결과의 `files.root`는 지운 폴더이므로 `stale()`을 부르지 않는다.
        """
        if commit in self._held:
            self._held[commit] = self._held.pop(commit)
            return self._held[commit]
        running = self._running.get(commit)
        if running is None:
            running = self._running[commit] = _Running(asyncio.ensure_future(self._analyzed(commit, near, report)))
        running.waiting += 1
        try:
            return await asyncio.shield(running.task)
        finally:
            running.waiting -= 1
            if running.waiting == 0:
                del self._running[commit]
                if not running.task.done():
                    running.task.cancel()
                    await asyncio.gather(running.task, return_exceptions=True)

    async def _analyzed(self, commit: str, near: list[Analyzed], report: Callable[[Progress], None]) -> Analyzed:
        dest = self.directory / commit
        try:
            await _finished(shutil.rmtree, dest, True)
            await _finished(git.export, self.root, commit, dest)
            previous = await asyncio.to_thread(self._nearest, commit, dest, near)
            async with AsyncExitStack() as opened:

                async def started(files: RepoFiles, env: str) -> Session:
                    return await opened.enter_async_context(Session(files.root, self.python, files.extra_paths))

                analyzed = await refresh(
                    dest,
                    self.python,
                    started,
                    previous=previous,
                    cache=self.cache,
                    snapshot=commit,
                    origin=self.root,
                    report=report,
                )
        finally:
            await _finished(shutil.rmtree, dest, True)
        self._held[commit] = analyzed
        while len(self._held) > HELD:
            del self._held[next(iter(self._held))]
        return analyzed

    def _nearest(self, commit: str, dest: Path, near: list[Analyzed]) -> Analyzed | None:
        """증분의 바탕. 캐시에 그 커밋의 판정이 지금 환경 지문으로 있으면 None이고, 없으면 `near` 가운데 바뀐 `.py`가 가장 적은 결과다."""
        env = environment(self.python, collect(dest))
        if self.cache is not None and commit in self.cache.snapshots(env):
            return None
        commits = {id(analyzed): held for held, analyzed in self._held.items()}
        found: tuple[int, Analyzed] | None = None
        for analyzed in near:
            if analyzed.env != env or not analyzed.answers:
                continue
            if id(analyzed) in commits:
                other = commits[id(analyzed)]
            elif analyzed.files.root == self.root:
                other = git.WORKTREE
            else:
                continue
            count = len(git.changed(self.root, commit, other))
            if found is None or count < found[0]:
                found = (count, analyzed)
        return found[1] if found is not None else None

    def close(self) -> None:
        """돌고 있는 분석을 멈추고 남은 꺼낸 폴더를 지운다."""
        for running in self._running.values():
            running.task.cancel()
        shutil.rmtree(self.directory, ignore_errors=True)
