import asyncio
import sqlite3
import sys

import pytest

from conftest import group_ended

from code_atlas import analyze, runner
from code_atlas.analyze import Progress, PythonNotFound
from code_atlas.runner import Runner

pytestmark = pytest.mark.slow


@pytest.mark.asyncio
async def test_run_records_progress_and_reopens_from_the_cache_without_asking(sample_repo, monkeypatch):
    first = Runner(sample_repo, sys.executable)
    seen: list[Progress] = []
    report = first._report
    monkeypatch.setattr(first, "_report", lambda progress: (seen.append(progress), report(progress)))
    assert (first.progress.phase, first.lsp, first.error) == ("collect", "starting", None)
    landed = []
    analyzed = await first.run(landed=lambda result, draft: landed.append((result, draft, first.progress.phase)))
    names = [p.phase for p in seen]
    assert sorted(set(names), key=names.index) == ["collect", "extract", "resolve", "build"]
    assert landed == [(analyzed, False, "build")]  # 결과를 넘긴 뒤에 ready가 된다
    assert first.progress == Progress("ready") and first.analyzed is analyzed
    session = await first.session()
    assert first.lsp == "ready" and not session.stopped
    await first.close()
    assert session.stopped and group_ended(session.client._server.pid)

    again = Runner(sample_repo, sys.executable)
    reopened = await again.run()
    assert again._session is None and again.lsp == "starting"  # 캐시로 조립한 결과는 세션을 기다리지 않는다
    assert reopened.answers == analyzed.answers
    sessions = await asyncio.gather(*(again.session() for _ in range(3)))
    assert sessions[0] is sessions[1] is sessions[2] and again.lsp == "ready"
    hover = await sessions[0].hover("src/app/cli.py", 10, 21)
    assert "run_engine" in hover.markdown
    store = again._cache
    await again.close()
    assert sessions[0].stopped and group_ended(sessions[0].client._server.pid)
    with pytest.raises(sqlite3.ProgrammingError):
        store._db.execute("SELECT 1")


@pytest.mark.asyncio
async def test_reload_keeps_the_session_and_reads_the_cache_only_on_the_first_run(sample_repo, monkeypatch):
    refresh = runner.refresh
    options: list[dict] = []

    async def recorded(*args, **given):
        options.append(given)
        return await refresh(*args, **given)

    monkeypatch.setattr(runner, "refresh", recorded)
    running = Runner(sample_repo, sys.executable, cache=False)
    try:
        first = await running.run()
        session = await running.session()
        core = sample_repo / "src" / "app" / "core.py"
        core.write_text(core.read_text() + "\n\ndef added():\n    return helper(1)\n")
        second = await running.run(first)
        assert [(o["previous"], o["rebuild"]) for o in options] == [(None, True), (first, False)]
        assert options[0]["cache"] is options[1]["cache"] is running._cache
        assert await running.session() is session and running.lsp == "ready"
        assert "app.core:added" in {n.id for n in second.analysis.nodes}
        line = second.texts["src/app/core.py"].splitlines().index("def added():") + 2
        [found] = await session.definition_at("src/app/core.py", line, 11)
        assert found.line == 10  # 세션의 본문이 다시 분석한 본문이다
    finally:
        await running.close()


@pytest.mark.asyncio
async def test_reload_in_a_changed_environment_asks_a_new_session(sample_repo, monkeypatch):
    running = Runner(sample_repo, sys.executable, cache=False)
    try:
        first = await running.run()
        session = await running.session()
        monkeypatch.setattr(analyze, "environment", lambda python, files: "다른 환경")
        second = await running.run(first)
        fresh = await running.session()
        assert fresh is not session and not fresh.stopped and running.lsp == "ready"
        assert session.stopped and group_ended(session.client._server.pid)
        assert second.env == "다른 환경" and second.answers == first.answers
        hover = await fresh.hover("src/app/cli.py", 10, 21)
        assert "run_engine" in hover.markdown
    finally:
        await running.close()


@pytest.mark.asyncio
async def test_failed_first_run_is_failed_and_failed_reload_goes_back_to_ready(sample_repo, monkeypatch):
    missing = Runner(sample_repo, str(sample_repo / "no" / "python"))
    with pytest.raises(PythonNotFound):
        await missing.run()
    assert missing.progress.phase == "failed" and "실행할 수 없습니다" in missing.error
    await missing.close()

    running = Runner(sample_repo, sys.executable)
    try:
        first = await running.run()
        session = await running.session()

        async def fail(repo, python, live, **given):
            (await live(first.files, first.env)).sync_files({})
            raise RuntimeError("분석이 멈췄다")

        monkeypatch.setattr(runner, "refresh", fail)
        with pytest.raises(RuntimeError):
            await running.run(first)
        assert running.progress == Progress("ready") and running.error is None and running.analyzed is first
        assert await running.session() is session and running.lsp == "ready"
        hover = await session.hover("src/app/cli.py", 10, 21)  # 세션의 본문이 앞의 결과로 돌아온다
        assert "run_engine" in hover.markdown
    finally:
        await running.close()
