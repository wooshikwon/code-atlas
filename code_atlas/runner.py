"""분석 태스크 하나의 수명과 진행 상태, 언어 서버 세션, 분석 캐시를 맡는다.

`run`이 `analyze.refresh`를 불러 레포를 분석하고 단계와 진행 수를 `progress`에 적는다. 세션은 `refresh`가 처음 요구할 때
띄우고, 요구하지 않았으면 결과를 낸 뒤 뒤에서 띄워 그 결과의 본문을 연다. 어느 지점을 다시 묻는지와 결과가 HTTP로 어떻게
나가는지는 모른다.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from contextlib import AsyncExitStack
from pathlib import Path

from .analyze import Analyzed, Progress, open_cache, refresh, require_python
from .cache import Cache
from .collect import RepoFiles
from .lsp import Session

logger = logging.getLogger(__name__)


class Runner:
    """레포 하나를 분석하는 태스크와 그 태스크가 쓰는 세션·캐시.

    `progress.phase`는 `refresh`의 단계 이름에 ready(결과가 나옴)와 failed(첫 분석이 실패함)를 더한 값이다.
    `lsp`는 세션이 마지막 결과의 본문을 열고 준비 확인을 마쳤으면 ready, 그 전이면 starting이다.
    """

    def __init__(self, repo: str | Path, python: str | None, cache: bool = True):
        self.repo = repo
        self.python = python
        self.progress = Progress("collect")
        self.error: str | None = None
        self.lsp = "starting"
        self.analyzed: Analyzed | None = None  # 마지막으로 낸 결과. 세션이 여는 본문의 기준이다
        self._rebuild = not cache
        self._cache: Cache | None = None
        self._cache_tried = False
        self._session: Session | None = None
        self._env: str | None = None  # 세션을 띄운 때의 환경 지문
        self._sessions = AsyncExitStack()
        self._opening = asyncio.Lock()
        self._warming: asyncio.Task | None = None

    async def run(
        self, previous: Analyzed | None = None, landed: Callable[[Analyzed, bool], None] | None = None
    ) -> Analyzed:
        """레포를 분석한다. `previous`가 있으면 그 결과에서 증분으로 분석하고, 환경 지문이 그대로면 세션을 새로 띄우지 않는다.

        결과가 나올 때마다 `landed`에 결과와, 캐시의 판정으로 먼저 조립한 결과인지를 넘긴다. `progress.phase`는 마지막
        결과를 `landed`에 넘긴 뒤에 ready가 된다. 첫 분석이 실패하면 `progress.phase`가 failed가 되고 `error`에 까닭이
        남는다. 다시 분석이 실패하면 앞의 결과가 그대로이므로 ready로 돌아가고 세션의 본문을 앞의 결과로 되돌린다.
        """

        def land(analyzed: Analyzed, draft: bool) -> None:
            if landed is not None:
                landed(analyzed, draft)
            self.analyzed = analyzed

        self.error = None
        try:
            self.python = require_python(self.repo, self.python)
            if not self._cache_tried:
                self._cache_tried = True
                self._cache = open_cache(self.repo)
            analyzed = await refresh(
                self.repo,
                self.python,
                self._live,
                previous=previous,
                cache=self._cache,
                rebuild=self._rebuild and previous is None,
                report=self._report,
                drafted=lambda analyzed: land(analyzed, True),
            )
            land(analyzed, False)
        except Exception as exc:
            if previous is None:
                self.progress = Progress("failed")
                self.error = str(exc)
            else:
                self.progress = Progress("ready")
                self._warm()
            raise
        self.progress = Progress("ready")
        self._warm()
        return analyzed

    def _report(self, progress: Progress) -> None:
        self.progress = progress

    async def _live(self, files: RepoFiles, env: str) -> Session:
        """`refresh`에 넘기는 세션. 없거나 멈췄으면 띄우고, 환경 지문이 `env`와 다른 때에 띄운 세션은 닫고 새로 띄운다.

        언어 서버는 찾지 못한 import의 결과를 기억하므로 가상환경이 바뀌면 새 프로세스로 묻는다. 본문을 맞추고 준비를
        기다리는 일은 `refresh`가 한다.
        """
        async with self._opening:
            self.lsp = "starting"
            if self._session is not None and self._env != env:
                await self._sessions.aclose()
                self._session = None
            if self._session is None or self._session.stopped:
                self._session = await self._sessions.enter_async_context(
                    Session(files.root, self.python, files.extra_paths)
                )
                self._env = env
            return self._session

    def _warm(self) -> None:
        """마지막 결과의 본문을 연 세션을 뒤에서 준비한다."""
        self.lsp = "starting"
        self._warming = asyncio.create_task(self.session())
        self._warming.add_done_callback(_logged)

    async def session(self) -> Session:
        """마지막 결과의 본문을 열고 준비 확인을 마친 세션. 없거나 멈췄으면 띄우고, 함께 들어온 요청은 한 번만 띄운다."""
        async with self._opening:
            analyzed = self.analyzed
            if self._session is None or self._session.stopped:
                self.lsp = "starting"
                self._session = await self._sessions.enter_async_context(
                    Session(analyzed.files.root, self.python, analyzed.files.extra_paths)
                )
                self._env = analyzed.env
            if self.lsp != "ready":
                self._session.sync_files(analyzed.texts)
                await self._session.wait_ready(analyzed.probe)
                self.lsp = "ready"
            return self._session

    async def close(self) -> None:
        """뒤에서 준비하던 세션을 멈추고 띄운 세션과 캐시를 닫는다. 분석 태스크는 부르는 쪽이 먼저 끝낸다."""
        if self._warming is not None and not self._warming.done():
            self._warming.cancel()
            await asyncio.gather(self._warming, return_exceptions=True)
        await self._sessions.aclose()
        if self._cache is not None:
            self._cache.close()


def _logged(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception() is not None:
        logger.warning("언어 서버 세션을 준비하지 못했다: %r", task.exception())
