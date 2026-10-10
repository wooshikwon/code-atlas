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
from .lsp import Location, Session
from .model import Analysis, Site
from .resolve import Index, resolve

logger = logging.getLogger(__name__)

CONCURRENCY = 32


class PythonNotFound(Exception):
    pass


@dataclass
class Analyzed:
    """분석 결과와, 떠 있는 서버가 위치 질의와 세션 다시 열기에 쓰는 자료."""

    analysis: Analysis
    files: RepoFiles
    index: Index
    texts: dict[str, str]  # 레포 루트 기준 경로 → 본문
    probe: tuple[str, int, int] | None  # `Session.wait_ready`에 넘기는 지점


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


async def _request_all(session: Session, sites: list[Site]) -> dict[int, list[Location]]:
    limit = asyncio.Semaphore(CONCURRENCY)

    async def one(site: Site) -> list[Location]:
        async with limit:
            try:
                return await session.definition(site.path, site.request_line, site.request_col)
            except Exception:
                logger.debug("definition failed: %s:%s", site.path, site.request_line, exc_info=True)
                return []

    pending = [i for i, s in enumerate(sites) if not s.dynamic]
    found: dict[int, list[Location]] = {}
    for _ in range(2):
        results = await asyncio.gather(*(one(sites[i]) for i in pending))
        for i, locations in zip(pending, results):
            found[i] = locations
        pending = [i for i in pending if not found[i]]
        if not pending:
            break
    return found


async def analyze_async(repo: RepoFiles, session: Session) -> Analyzed:
    """띄워 둔 세션에 레포 파일을 열고 분석한다. 세션은 닫지 않는다."""
    started = time.monotonic()
    facts = extract_repo(repo)
    texts = {f.path: read_source(repo, f) for f in repo.files}
    probe = _probe(facts)
    session.open_files(texts)
    await session.wait_ready(probe)
    locations = await _request_all(session, [s for f in facts for s in f.sites])
    index = Index(repo.root, facts)
    analysis = build(repo, facts, resolve(facts, locations, index), texts)
    analysis.stats["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return Analyzed(analysis, repo, index, texts, probe)


def analyze(repo: str | Path, python: str | None = None) -> tuple[Analysis, RepoFiles]:
    python = require_python(repo, python)
    files = collect(repo)

    async def run() -> Analyzed:
        async with Session(files.root, python, files.extra_paths) as session:
            return await analyze_async(files, session)

    return asyncio.run(run()).analysis, files
