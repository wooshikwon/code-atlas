"""collect·extract·lsp·resolve·graph를 차례로 부르는 분석 진입점."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from pathlib import Path

from . import venv
from .collect import RepoFiles, collect
from .extract import FileFacts, extract_repo, read_source
from .graph import build
from .lsp import REQUEST_TIMEOUT, Location, Session
from .model import Analysis, Site
from .resolve import Index, resolve

logger = logging.getLogger(__name__)

CONCURRENCY = 32
HEAD_RETRIES = 2


class PythonNotFound(Exception):
    pass


@dataclass
class Analyzed:
    """분석 결과와, 떠 있는 서버가 위치 질의와 세션 다시 열기에 쓰는 자료."""

    analysis: Analysis
    files: RepoFiles
    index: Index
    texts: dict[str, str]  # 레포 루트 기준 경로 → 본문
    stamps: dict[str, tuple[int, int] | None]  # 레포 루트 기준 경로 → 내용이 본문과 같던 때의 수정 시각과 크기
    probe: tuple[str, int, int] | None  # `Session.wait_ready`에 넘기는 지점

    def stale(self) -> set[str]:
        """분석할 때 읽은 본문과 지금 디스크의 본문이 다른 파일. 수정 시각과 크기가 그대로면 본문을 읽지 않는다."""
        found: set[str] = set()
        for path, text in self.texts.items():
            file = self.files.abs_path(path)
            stamp = _stamp(file)
            if stamp is not None and stamp == self.stamps[path]:
                continue
            try:
                same = file.read_bytes().decode("utf-8-sig", errors="replace") == text
            except OSError:
                same = False
            if same:
                self.stamps[path] = stamp
            else:
                found.add(path)
        return found


def _stamp(file: Path) -> tuple[int, int] | None:
    """파일의 수정 시각과 크기. 파일이 없으면 None이다."""
    try:
        stat = file.stat()
    except OSError:
        return None
    return stat.st_mtime_ns, stat.st_size


def require_python(repo: str | Path, python: str | None) -> str:
    python = python or venv.find(repo)
    if python is None:
        raise PythonNotFound(f"{repo}에서 가상환경을 찾지 못했다. --python으로 인터프리터 경로를 지정한다.")
    return python


def _imported_module(site: Site) -> str:
    text = site.text
    if text.startswith("from "):
        return text[len("from ") :].split(" import ", 1)[0]
    return text[len("import ") :]


def _probe(facts: list[FileFacts]) -> tuple[str, int, int] | None:
    """레포 안 모듈을 가져오는 첫 import 지점."""
    modules = {f.file.module_id for f in facts}
    for f in facts:
        for site in f.sites:
            if site.kind != "import":
                continue
            name = _imported_module(site)
            if name.startswith(".") or name in modules or name.split(".", 1)[0] in modules:
                return site.path, site.request_line, site.request_col
    return None


async def _request_all(
    session: Session, sites: list[Site], timeout: float = REQUEST_TIMEOUT
) -> tuple[dict[int, list[Location]], int]:
    """동적이 아닌 지점마다 정의 위치를 묻는다. 지점 번호별 응답과, 끝까지 응답이 없는 지점 수를 돌려준다.

    시간 제한에 걸린 지점만 다시 묻는다. 첫 묶음이 시간 제한에 걸리면 동시 요청 수를 반으로 줄여 그 지점을 다시 묻고,
    나머지 지점은 줄인 동시 요청 수로 물은 뒤 시간 제한에 걸린 지점을 한 번 더 묻는다.
    """
    found: dict[int, list[Location]] = {}

    async def ask(batch: list[int], concurrency: int) -> list[int]:
        """묶음을 물어 `found`에 응답을 담고 시간 제한에 걸린 지점을 돌려준다."""
        limit = asyncio.Semaphore(concurrency)

        async def one(i: int) -> bool:
            site = sites[i]
            async with limit:
                try:
                    found[i] = await session.definition(site.path, site.request_line, site.request_col, timeout)
                except asyncio.TimeoutError:
                    return True
                except Exception:
                    logger.debug("definition failed: %s:%s", site.path, site.request_line, exc_info=True)
                    found[i] = []
                return False

        late = await asyncio.gather(*(one(i) for i in batch))
        return [i for i, timed_out in zip(batch, late) if timed_out]

    pending = [i for i, s in enumerate(sites) if not s.dynamic]
    concurrency = CONCURRENCY
    late = await ask(pending[:concurrency], concurrency)
    for _ in range(HEAD_RETRIES):
        if not late:
            break
        concurrency = max(1, concurrency // 2)
        late = await ask(late, concurrency)
    late += await ask(pending[CONCURRENCY:], concurrency)
    if late:
        late = await ask(late, concurrency)
    for i in late:
        found[i] = []
    return found, len(late)


async def analyze_async(repo: RepoFiles, session: Session) -> Analyzed:
    """띄워 둔 세션에 레포 파일을 열고 분석한다. 세션은 닫지 않는다."""
    started = time.monotonic()
    facts = extract_repo(repo)
    stamps = {f.path: _stamp(repo.abs_path(f.path)) for f in repo.files}
    texts = {f.path: read_source(repo, f) for f in repo.files}
    probe = _probe(facts)
    session.open_files(texts)
    await session.wait_ready(probe)
    locations, timed_out = await _request_all(session, [s for f in facts for s in f.sites])
    index = Index(repo.root, facts)
    analysis = build(repo, facts, resolve(facts, locations, index), texts)
    analysis.stats["timed_out"] = timed_out
    analysis.stats["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return Analyzed(analysis, repo, index, texts, stamps, probe)


def analyze(repo: str | Path, python: str | None = None) -> tuple[Analysis, RepoFiles]:
    python = require_python(repo, python)
    files = collect(repo)

    async def run() -> Analyzed:
        async with Session(files.root, python, files.extra_paths) as session:
            return await analyze_async(files, session)

    return asyncio.run(run()).analysis, files
