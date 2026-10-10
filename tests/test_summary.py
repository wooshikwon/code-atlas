import asyncio
import json
import os
import time

import pytest

from code_atlas import summary
from code_atlas.summary import Cache, Summaries, SummaryError

OK = """
if [ "$1" = "auth" ]; then echo '{"loggedIn": true}'; exit 0; fi
cat > "$RECORD/stdin"
pwd > "$RECORD/cwd"
for arg in "$@"; do printf '%s\\n' "$arg"; done > "$RECORD/args"
echo run >> "$RECORD/runs"
printf '%s\\n' '{"is_error": false, "result": "\\n설정을 받아 엔진을 만들고 시작한다.\\n"}'
"""
SLOW = "sleep 30\n"
FAILING = "echo '인증 서버에 닿지 못했다' >&2\nexit 3\n"
LOGGED_OUT = """
if [ "$1" = "auth" ]; then echo '{"loggedIn": false}'; exit 1; fi
echo '{"is_error": true, "result": "Not logged in · Please run /login"}'
exit 1
"""


@pytest.fixture
def fake_cli(tmp_path, monkeypatch):
    """임시 폴더에 가짜 `claude` 셸 스크립트를 두고 `PATH`와 홈 폴더를 그 폴더로 돌린다. 스크립트가 받은 값은 돌려준 폴더에 남는다."""
    bin_dir, record = tmp_path / "bin", tmp_path / "record"
    bin_dir.mkdir()
    record.mkdir()
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("RECORD", str(record))

    def install(body: str):
        script = bin_dir / "claude"
        script.write_text("#!/bin/sh\n" + body)
        script.chmod(0o755)
        return record

    return install


def test_find_cli_reads_path_then_local_bin(tmp_path, monkeypatch):
    home = tmp_path / "home"
    local = home / ".local" / "bin" / "claude"
    local.parent.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    assert summary.find_cli() is None

    local.write_text("#!/bin/sh\n")
    assert summary.find_cli() is None
    local.chmod(0o755)
    assert summary.find_cli() == str(local)

    on_path = tmp_path / "bin" / "claude"
    on_path.parent.mkdir()
    on_path.write_text("#!/bin/sh\n")
    on_path.chmod(0o755)
    assert summary.find_cli() == str(on_path)


@pytest.mark.asyncio
async def test_generate_sends_prompt_on_stdin_and_reads_result(fake_cli):
    record = fake_cli(OK)
    code = "def run_engine(config):\n    return Engine(config)"
    assert await summary.generate("function", "run_engine", code) == "설정을 받아 엔진을 만들고 시작한다."

    assert (record / "stdin").read_text() == f"종류: 함수\n이름: run_engine\n\n코드:\n{code}\n"
    args = (record / "args").read_text().split("\n")
    assert args[:3] == ["-p", "--model", "haiku"]
    assert args[args.index("--tools") + 1] == ""
    assert args[args.index("--system-prompt") + 1] == summary.SYSTEM_PROMPT
    assert {"--safe-mode", "--strict-mcp-config", "--no-session-persistence"} <= set(args)
    cwd = (record / "cwd").read_text().strip()
    assert cwd != os.getcwd() and not os.path.exists(cwd)


@pytest.mark.asyncio
async def test_generate_cuts_code_at_limit(fake_cli):
    record = fake_cli(OK)
    await summary.generate("module", "src/app/big.py", "x" * (summary.MAX_CODE + 500))
    assert (record / "stdin").read_text().count("x") == summary.MAX_CODE


@pytest.mark.asyncio
async def test_generate_times_out_and_ends_process(fake_cli, monkeypatch):
    fake_cli(SLOW)
    monkeypatch.setattr(summary, "GENERATE_TIMEOUT", 0.3)
    started = time.monotonic()
    with pytest.raises(SummaryError, match="응답하지 않았다"):
        await summary.generate("function", "f", "def f(): ...")
    assert time.monotonic() - started < 5


@pytest.mark.asyncio
async def test_generate_reports_nonzero_exit(fake_cli):
    fake_cli(FAILING)
    with pytest.raises(SummaryError, match="종료 코드 3.*인증 서버에 닿지 못했다"):
        await summary.generate("function", "f", "def f(): ...")


@pytest.mark.asyncio
async def test_generate_reports_logged_out(fake_cli):
    fake_cli(LOGGED_OUT)
    with pytest.raises(SummaryError, match="로그인돼 있지 않다"):
        await summary.generate("function", "f", "def f(): ...")


@pytest.mark.asyncio
async def test_generate_without_cli(fake_cli):
    with pytest.raises(SummaryError, match="찾지 못했다"):
        await summary.generate("function", "f", "def f(): ...")


@pytest.mark.asyncio
async def test_unavailable_reasons(fake_cli):
    assert await summary.unavailable() == "Claude Code CLI를 찾지 못했다"
    fake_cli(LOGGED_OUT)
    assert await summary.unavailable() == "Claude Code에 로그인돼 있지 않다"
    fake_cli(OK)
    assert await summary.unavailable() is None


def test_cache_get_and_put(tmp_path):
    path = tmp_path / "nested" / "summaries.db"
    cache = Cache(path)
    assert cache.get("k") is None
    cache.put("k", "첫 요약")
    assert cache.get("k") == "첫 요약"
    cache.put("k", "새 요약")
    assert Cache(path).get("k") == "새 요약"
    assert Cache(path).get("other") is None


def test_key_changes_with_code_and_prompt_version(monkeypatch):
    key = summary.key_of("def f(): ...")
    assert key == summary.key_of("def f(): ...") and len(key) == 64
    assert key != summary.key_of("def f(): pass")
    monkeypatch.setattr(summary, "PROMPT_VERSION", summary.PROMPT_VERSION + 1)
    assert key != summary.key_of("def f(): ...")


def test_outline_lists_docstring_and_top_level_signatures():
    source = '"""엔진 모듈."""\nimport os\n\n@cache\ndef helper(value,\n           other=1) -> int:\n    return value\n\nclass Engine(Base):\n    def start(self):\n        pass\n'
    assert summary.outline(source) == '"""엔진 모듈."""\ndef helper(value, other=1) -> int:\nclass Engine(Base):'
    assert summary.outline("LIMIT = 3\n") == "LIMIT = 3\n"
    assert summary.outline("def broken(:\n    pass\n") == "def broken(:\n    pass\n"


@pytest.mark.asyncio
async def test_make_generates_once_for_overlapping_requests_and_caches(fake_cli, tmp_path):
    record = fake_cli(OK)
    summaries = Summaries(tmp_path / "summaries.db")
    code = "def f(): ..."
    assert summaries.cached(code) is None
    results = await asyncio.gather(*(summaries.make("function", "f", code) for _ in range(3)))
    assert set(results) == {"설정을 받아 엔진을 만들고 시작한다."}
    assert (record / "runs").read_text().count("run") == 1

    assert await summaries.make("function", "f", code) == results[0]
    assert Summaries(tmp_path / "summaries.db").cached(code) == results[0]
    assert (record / "runs").read_text().count("run") == 1

    await summaries.make("function", "f", code, refresh=True)
    assert (record / "runs").read_text().count("run") == 2


@pytest.mark.asyncio
async def test_make_does_not_cache_failure(fake_cli, tmp_path):
    fake_cli(FAILING)
    summaries = Summaries(tmp_path / "summaries.db")
    with pytest.raises(SummaryError):
        await summaries.make("function", "f", "def f(): ...")
    assert summaries.cached("def f(): ...") is None
    fake_cli(OK)
    assert await summaries.make("function", "f", "def f(): ...") == "설정을 받아 엔진을 만들고 시작한다."


@pytest.mark.asyncio
async def test_make_runs_two_processes_at_most(tmp_path, monkeypatch):
    running = peak = 0

    async def generate(kind, name, code):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.05)
        running -= 1
        return json.dumps(code)

    monkeypatch.setattr(summary, "generate", generate)
    summaries = Summaries(tmp_path / "summaries.db")
    await asyncio.gather(*(summaries.make("function", "f", f"def f{i}(): ...") for i in range(6)))
    assert peak == summary.MAX_PROCESSES == 2


@pytest.mark.asyncio
async def test_make_waiting_for_a_slot_is_dropped_when_every_caller_leaves(tmp_path, monkeypatch):
    made: list[str] = []
    release = asyncio.Event()

    async def generate(kind, name, code):
        made.append(code)
        await release.wait()
        return f"{code} 요약"

    monkeypatch.setattr(summary, "generate", generate)
    summaries = Summaries(tmp_path / "summaries.db")
    running = [asyncio.create_task(summaries.make("function", "f", f"def f{i}(): ...")) for i in range(2)]
    waiting = [asyncio.create_task(summaries.make("function", "f", "def late(): ...")) for _ in range(2)]
    await asyncio.sleep(0.01)
    assert made == ["def f0(): ...", "def f1(): ..."]

    running[0].cancel()
    waiting[0].cancel()
    await asyncio.sleep(0.01)
    assert not waiting[1].done()
    waiting[1].cancel()
    await asyncio.sleep(0.01)
    release.set()
    assert await running[1] == "def f1(): ... 요약"
    await asyncio.sleep(0.01)
    assert made == ["def f0(): ...", "def f1(): ..."]
    assert summaries.cached("def f0(): ...") == "def f0(): ... 요약"
    assert summaries.cached("def late(): ...") is None

    assert await summaries.make("function", "f", "def late(): ...") == "def late(): ... 요약"
    assert len(made) == 3


@pytest.mark.asyncio
async def test_summaries_asks_login_until_available(fake_cli, tmp_path):
    summaries = Summaries(tmp_path / "summaries.db")
    assert await summaries.unavailable() == "Claude Code CLI를 찾지 못했다"
    fake_cli(OK)
    assert await summaries.unavailable() is None
    fake_cli(LOGGED_OUT)
    assert await summaries.unavailable() is None
