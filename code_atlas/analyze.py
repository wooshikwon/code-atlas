"""collect·extract·lsp·resolve·graph를 차례로 부르는 분석 진입점."""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from . import venv
from .collect import RepoFiles, collect
from .extract import FileFacts, extract_repo, read_source
from .graph import build
from .lsp import Location, Session
from .model import Analysis, Site
from .resolve import resolve

logger = logging.getLogger(__name__)

CONCURRENCY = 32


class PythonNotFound(Exception):
    pass


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


async def _locate(repo: RepoFiles, facts: list[FileFacts], texts: dict[str, str], python: str) -> dict[int, list[Location]]:
    sites = [s for f in facts for s in f.sites]
    async with Session(repo.root, python, repo.extra_paths) as session:
        session.open_files(texts)
        await session.wait_ready(_probe(facts))
        return await _request_all(session, sites)


def analyze(repo: str | Path, python: str | None = None) -> tuple[Analysis, RepoFiles]:
    started = time.monotonic()
    python = python or venv.find(repo)
    if python is None:
        raise PythonNotFound(f"{repo}에서 가상환경을 찾지 못했다. --python으로 인터프리터 경로를 지정한다.")
    files = collect(repo)
    facts = extract_repo(files)
    texts = {f.path: read_source(files, f) for f in files.files}
    locations = asyncio.run(_locate(files, facts, texts, python))
    analysis = build(files, facts, resolve(facts, locations, files.root), texts)
    analysis.stats["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return analysis, files
