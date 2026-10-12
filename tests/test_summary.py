import asyncio
import json
import os
import time

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

import pytest

from code_atlas import summary, tools
from code_atlas.model import Edge, Node, SiteRef
from code_atlas.summary import Cache, Made, Summaries, SummaryError, Usage

MADE = "설정을 받아 엔진을 만들고 시작한다.\n\n하는 일\n엔진을 만든다.\n\n앞뒤 흐름\n`main`이 호출한다."

VERSION = 'if [ "$1" = "--version" ]; then echo "2.1.288 (Claude Code)"; exit 0; fi\n'
OK = """
if [ "$1" = "auth" ]; then echo '{"loggedIn": true}'; exit 0; fi
cat > "$RECORD/stdin"
pwd > "$RECORD/cwd"
for arg in "$@"; do printf '%s\\n' "$arg"; done > "$RECORD/args"
echo run >> "$RECORD/runs"
printf '%s\\n' '{"is_error": false, "result": "\\n설정을 받아 엔진을 만들고 시작한다.\\n\\n**하는 일**\\n엔진을 만든다.\\n\\n## 앞뒤 흐름\\n`main`이 호출한다.\\n", "usage": {"input_tokens": 2, "cache_creation_input_tokens": 1487, "cache_read_input_tokens": 16411, "output_tokens": 527, "service_tier": "standard"}}'
"""
USAGE = ', "usage": {"input_tokens": 2, "cache_creation_input_tokens": 1487, "cache_read_input_tokens": 16411, "output_tokens": 527, "service_tier": "standard"}'
USED = Usage(input=2, cache_write=1487, cache_read=16411, output=527)
ONE_SENTENCE = """printf '%s\\n' '{"is_error": false, "result": "한 문장 요약이다."}'\n"""
SLOW = """if [ "$1" = "auth" ]; then echo '{"loggedIn": true}'; exit 0; fi\nsleep 30\n"""
FAILING = "echo '인증 서버에 닿지 못했다' >&2\nexit 3\n"
LOGGED_OUT = """
if [ "$1" = "auth" ]; then echo '{"loggedIn": false}'; exit 1; fi
echo '{"is_error": true, "result": "Not logged in · Please run /login"}'
exit 1
"""


@pytest.fixture
def fake_cli(tmp_path, monkeypatch):
    """임시 폴더에 가짜 `claude` 셸 스크립트를 두고 `PATH`와 홈 폴더를 그 폴더로 돌린다. 스크립트가 받은 값은 돌려준 폴더에 남는다.

    스크립트는 `--version`에 판 번호를 답하고 그 밖의 인자는 받은 본문대로 처리한다.
    """
    bin_dir, record = tmp_path / "bin", tmp_path / "record"
    bin_dir.mkdir()
    record.mkdir()
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("RECORD", str(record))
    monkeypatch.delenv(tools.NO_CLAUDE_ENV)
    monkeypatch.setattr(tools, "_claude_refused", lambda: None)

    def install(body: str):
        script = bin_dir / "claude"
        script.write_text("#!/bin/sh\n" + VERSION + body)
        script.chmod(0o755)
        return record

    return install


def test_find_cli_gives_only_a_cli_that_passed_the_check(fake_cli, tmp_path):
    assert summary.find_cli() is None
    fake_cli(OK)
    cli = tmp_path / "bin" / "claude"
    assert summary.find_cli() == str(cli)
    cli.write_text("#!/bin/sh\nexit 1\n")
    assert summary.find_cli() is None


@pytest.mark.asyncio
async def test_generate_sends_system_prompt_as_argument_and_prompt_on_stdin(fake_cli):
    record = fake_cli(OK)
    system = "첫 줄\n둘째 줄 '따옴표' \"큰따옴표\" $HOME"
    prompt = "[대상]\n종류: 함수\n이름: run_engine\n"
    assert await summary.generate(system, prompt) == Made(MADE, USED)

    assert (record / "stdin").read_text() == prompt
    args = (record / "args").read_text()
    assert args.startswith(f"-p\n--model\nsonnet\n--tools\n\n--system-prompt\n{system}\n--safe-mode\n")
    assert {"--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"} <= set(args.split("\n"))
    cwd = (record / "cwd").read_text().strip()
    assert cwd != os.getcwd() and not os.path.exists(cwd)


@pytest.mark.asyncio
async def test_generate_passes_a_system_prompt_as_long_as_the_style_guide_limit(fake_cli):
    record = fake_cli(OK)
    await summary.generate("가" * (summary.MAX_STYLE_GUIDE // 3), "x")
    assert (record / "args").read_text().count("가") == summary.MAX_STYLE_GUIDE // 3


@pytest.mark.asyncio
async def test_generate_rejects_result_without_three_parts(fake_cli):
    fake_cli(ONE_SENTENCE)
    with pytest.raises(SummaryError, match="세 부분"):
        await summary.generate("s", "p")


def test_shaped_normalizes_marks_and_joins_lead():
    raw = "  요지 첫 줄\n둘째 줄\n\n### 하는 일:\n문단 하나.\n\n문단 둘.\n**앞뒤 흐름**\n\n흐름 문단.\n"
    assert summary.shaped(raw) == "요지 첫 줄 둘째 줄\n\n하는 일\n문단 하나.\n문단 둘.\n\n앞뒤 흐름\n흐름 문단."
    for broken in (
        "요지만 있다.",
        "요지.\n\n하는 일\n문단.",
        "하는 일\n문단.\n\n앞뒤 흐름\n문단.",
        "요지.\n\n앞뒤 흐름\n문단.\n\n하는 일\n문단.",
    ):
        with pytest.raises(SummaryError):
            summary.shaped(broken)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "usage",
    [
        "",
        ', "usage": null',
        ', "usage": {"input_tokens": 2, "output_tokens": 527}',
        ', "usage": {"input_tokens": "2", "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 527}',
    ],
)
async def test_generate_without_readable_usage_still_gives_the_summary(fake_cli, usage):
    fake_cli(OK.replace(USAGE, usage))
    assert await summary.generate("s", "p") == Made(MADE, None)


@pytest.mark.asyncio
async def test_generate_times_out_and_ends_process(fake_cli, monkeypatch):
    fake_cli(SLOW)
    monkeypatch.setattr(summary, "GENERATE_TIMEOUT", 0.3)
    started = time.monotonic()
    with pytest.raises(SummaryError, match="응답하지 않았습니다"):
        await summary.generate("s", "p")
    assert time.monotonic() - started < 5


@pytest.mark.asyncio
async def test_generate_past_its_time_limit_lets_the_cli_finish_on_sigterm(fake_cli, tmp_path, monkeypatch):
    record = fake_cli(
        """if [ "$1" = "auth" ]; then echo '{"loggedIn": true}'; exit 0; fi
trap 'echo saved > "$RECORD/saved"; exit 0' TERM
sleep 30 &
wait
"""
    )
    monkeypatch.setattr(summary, "GENERATE_TIMEOUT", 0.5)
    with pytest.raises(SummaryError, match="응답하지 않았습니다"):
        await summary.generate("s", "p")
    assert (record / "saved").read_text() == "saved\n"
    assert tools.CLAUDE_TURNS.enter()  # 끝난 호출이 차례를 돌려준다
    tools.CLAUDE_TURNS.leave()


@pytest.mark.asyncio
async def test_closing_the_summaries_ends_the_running_cli_with_sigterm(fake_cli, tmp_path):
    record = fake_cli(
        """if [ "$1" = "auth" ]; then echo '{"loggedIn": true}'; exit 0; fi
echo started > "$RECORD/started"
trap 'echo saved > "$RECORD/saved"; exit 0' TERM
sleep 30 &
wait
"""
    )
    summaries = Summaries(tmp_path / "summaries.db")
    making = asyncio.create_task(summaries.make("프롬프트"))
    while not (record / "started").exists():
        await asyncio.sleep(0.05)
    started = time.monotonic()
    await summaries.close()
    assert time.monotonic() - started < 4 and (record / "saved").read_text() == "saved\n"
    with pytest.raises(asyncio.CancelledError):
        await making


@pytest.mark.asyncio
async def test_generate_reports_nonzero_exit(fake_cli):
    fake_cli(FAILING)
    with pytest.raises(SummaryError, match="종료 코드 3.*인증 서버에 닿지 못했다"):
        await summary.generate("s", "p")


@pytest.mark.asyncio
async def test_generate_reports_logged_out(fake_cli):
    fake_cli(LOGGED_OUT)
    with pytest.raises(SummaryError, match="로그인돼 있지 않습니다"):
        await summary.generate("s", "p")


@pytest.mark.asyncio
async def test_generate_without_cli(fake_cli):
    with pytest.raises(SummaryError, match="찾지 못했습니다"):
        await summary.generate("s", "p")


@pytest.mark.asyncio
async def test_unavailable_reasons(fake_cli):
    assert await summary.unavailable() == "Claude Code CLI를 찾지 못했습니다"
    fake_cli(LOGGED_OUT)
    assert await summary.unavailable() == "Claude Code에 로그인돼 있지 않습니다"
    fake_cli(OK)
    assert await summary.unavailable() is None


@pytest.mark.asyncio
async def test_unavailable_asks_the_login_once_however_often_it_is_asked(fake_cli, tmp_path):
    counted = 'echo "$1" >> "$RECORD/calls"\n'
    fake_cli(counted + LOGGED_OUT)
    for _ in range(5):
        assert await summary.unavailable() == "Claude Code에 로그인돼 있지 않습니다"
    assert (tmp_path / "record" / "calls").read_text().split() == ["auth"]

    tools.fresh("claude")  # 화면의 `다시 확인`
    fake_cli(counted + OK)
    assert await summary.unavailable() is None and await summary.unavailable() is None
    assert (tmp_path / "record" / "calls").read_text().split() == ["auth", "auth"]


def test_cache_get_and_put(tmp_path):
    path = tmp_path / "nested" / "summaries.db"
    cache = Cache(path)
    assert cache.get("k") is None
    cache.put("k", "첫 요약")
    assert cache.get("k") == "첫 요약"
    cache.put("k", "새 요약")
    assert Cache(path).get("k") == "새 요약"
    assert Cache(path).get("other") is None


def test_key_changes_with_prompt_system_prompt_and_prompt_version(monkeypatch):
    key = summary.key_of("system", "def f(): ...")
    assert key == summary.key_of("system", "def f(): ...") and len(key) == 64
    assert key != summary.key_of("system", "def f(): pass")
    assert key != summary.key_of("system 2", "def f(): ...")
    assert summary.key_of("a\nb", "c") != summary.key_of("a", "b\nc")
    monkeypatch.setattr(summary, "PROMPT_VERSION", summary.PROMPT_VERSION + 1)
    assert key != summary.key_of("system", "def f(): ...")


def test_find_style_guide_reads_option_then_environment(tmp_path, monkeypatch):
    monkeypatch.delenv(summary.STYLE_GUIDE_ENV, raising=False)
    assert summary.find_style_guide(None) is None
    monkeypatch.setenv(summary.STYLE_GUIDE_ENV, str(tmp_path / "env.md"))
    assert summary.find_style_guide(None) == tmp_path / "env.md"
    assert summary.find_style_guide(str(tmp_path / "option.md")) == tmp_path / "option.md"
    monkeypatch.setenv("HOME", str(tmp_path))
    assert summary.find_style_guide("~/guide.md") == tmp_path / "guide.md"


def test_system_prompt_holds_whole_style_guide_or_builtin(tmp_path):
    builtin = summary.system_prompt_of(None)
    assert builtin.startswith(summary.PROMPT_INTRO) and builtin.endswith(summary.PROMPT_RULES)
    assert summary.BUILTIN_STYLE_GUIDE in builtin
    guide = tmp_path / "guide.md"
    guide.write_text("# 규약\n\n첫 규칙.\n" + "둘째 규칙.\n" * 300)
    given = summary.system_prompt_of(guide)
    assert given.startswith(summary.PROMPT_INTRO) and given.endswith(summary.PROMPT_RULES)
    assert f"<서술 규약 문서>\n{guide.read_text().strip()}\n</서술 규약 문서>" in given
    assert summary.BUILTIN_STYLE_GUIDE not in given


def test_system_prompt_reports_unreadable_style_guide(tmp_path):
    with pytest.raises(SummaryError, match="읽지 못했습니다.*missing.md"):
        summary.system_prompt_of(tmp_path / "missing.md")
    with pytest.raises(SummaryError, match="읽지 못했습니다"):
        summary.system_prompt_of(tmp_path)
    empty = tmp_path / "empty.md"
    empty.write_text(" \n")
    with pytest.raises(SummaryError, match="비어 있습니다"):
        summary.system_prompt_of(empty)
    big = tmp_path / "big.md"
    big.write_text("가" * summary.MAX_STYLE_GUIDE)
    with pytest.raises(SummaryError, match="넘습니다"):
        summary.system_prompt_of(big)


def test_outline_lists_signatures_docstrings_and_methods():
    source = (
        '"""엔진 모듈."""\nimport os\n\n@cache\ndef helper(value,\n           other=1) -> int:\n'
        '    """값을 돌려준다.\n\n    둘째 문단.\n    """\n    return value\n\n'
        "class Engine(Base):\n    def start(self):\n        pass\n\n    async def stop(self, now: bool):\n        pass\n"
    )
    assert summary.outline(source, "pkg/engine.py").splitlines() == [
        "pkg/engine.py::helper",
        "    def helper(value, other=1) -> int:",
        '    """값을 돌려준다."""',
        "pkg/engine.py::Engine",
        "    class Engine(Base):",
        "    pkg/engine.py::Engine.start",
        "        def start(self):",
        "    pkg/engine.py::Engine.stop",
        "        async def stop(self, now: bool):",
    ]
    assert summary.outline("LIMIT = 3\n", "a.py") == "LIMIT = 3\n"
    assert summary.outline("def broken(:\n    pass\n", "a.py") == "def broken(:\n    pass\n"


CORE = '''"""엔진을 만들고 돌린다.

둘째 문단.
"""
from models import Config

LIMIT = compute(
    3)

def helper(value,
           other=1):
    """값을 그대로 돌려준다.

    둘째 문단은 넣지 않는다.
    """
    return value


class Engine:
    """설정으로 도는 엔진."""

    def start(self, label):
        return helper(label)

    def stop(self):
        return os.getpid() + LIMIT


def run_engine(config: Config) -> Engine:
    engine = Engine(config)
    engine.start(config)
    return engine
'''
CLI = """from core import run_engine


def main():
    config = load()
    engine = run_engine(config)
    return engine


run_engine(None)
"""
MODELS = "class Config:\n    name: str\n    retries: int = 3\n"
TEXTS = {"src/core.py": CORE, "src/cli.py": CLI, "src/models.py": MODELS, "tests/test_core.py": "run_engine(1)\n"}


def node(node_id, kind, path, span, parent=None, **more):
    return Node(node_id, kind, node_id.rsplit(":", 1)[-1].rsplit(".", 1)[-1], parent, path, span, 0, **more)


NODES = {
    n.id: n
    for n in [
        node("core", "module", "src/core.py", (1, 32)),
        node("core:helper", "function", "src/core.py", (10, 16)),
        node("core:Engine", "class", "src/core.py", (19, 26)),
        node("core:Engine.start", "method", "src/core.py", (22, 23), parent="core:Engine"),
        node(
            "core:Engine.stop",
            "method",
            "src/core.py",
            (25, 26),
            parent="core:Engine",
            unresolved=1,
            reads=["LIMIT", "self.config"],
        ),
        node("core:run_engine", "function", "src/core.py", (29, 32)),
        node("cli", "module", "src/cli.py", (1, 10), entry=True),
        node("cli:main", "function", "src/cli.py", (4, 7)),
        node("models", "module", "src/models.py", (1, 3)),
        node(
            "models:Config",
            "dataclass",
            "src/models.py",
            (1, 3),
            fields=[{"name": "name", "type": "str"}, {"name": "retries", "type": "int"}, {"name": "RED", "type": None}],
        ),
        node("tests.test_core", "module", "tests/test_core.py", (1, 1), test=True),
        node("ext:os", "external", None, None),
    ]
}


def edge(kind, source, target, *lines):
    return Edge("run", kind, source, target, [SiteRef(NODES[source].path, line, 0) for line in lines])


EDGES = [
    edge("import", "tests.test_core", "core", 1),
    edge("call", "tests.test_core", "core:run_engine", 1),
    edge("import", "cli", "core", 1),
    edge("call", "cli:main", "core:run_engine", 6),
    edge("call", "cli", "core:run_engine", 10),
    edge("type", "core:run_engine", "models:Config", 29),
    edge("construct", "core:run_engine", "core:Engine", 30),
    edge("call", "core:run_engine", "core:Engine.start", 31),
    edge("call", "core:Engine.start", "core:helper", 23),
    edge("call", "core:Engine.stop", "ext:os", 26),
    edge("import", "core", "models", 5),
    edge("import", "core", "ext:os", 5),
]


def sections(prompt: str) -> dict[str, str]:
    """프롬프트를 `[구획 이름]`마다 나눈다."""
    found: dict[str, str] = {}
    for block in ("\n" + prompt).split("\n[")[1:]:
        title, _, body = block.partition("]\n")
        found[title] = body.strip("\n")
    return found


def test_prompt_of_function_holds_code_callers_callees_and_data_fields():
    got = sections(summary.prompt_of(NODES, EDGES, TEXTS, "core:run_engine"))
    assert got["대상"] == "종류: 함수\n이름: core.py::run_engine\n위치: src/core.py 29~32줄"
    assert got["코드"] == "\n".join(CORE.splitlines()[28:32])
    assert got["대상이 든 파일의 문서 문자열"] == "엔진을 만들고 돌린다.\n\n둘째 문단."
    assert got["대상을 호출하는 쪽"].splitlines() == [
        "- cli.py::main · 호출",
        "    5:     config = load()",
        "    6>     engine = run_engine(config)",
        "    7:     return engine",
        "- src/cli.py의 최상위 코드 · 호출",
        "    9: ",
        "    10> run_engine(None)",
        "- tests/test_core.py의 최상위 코드 · 호출",
        "    1> run_engine(1)",
    ]
    assert got["대상이 호출하는 쪽"].splitlines() == [
        "- core.py::Engine",
        "    class Engine:",
        '    """설정으로 도는 엔진."""',
        "- core.py::Engine.start",
        "    def start(self, label):",
    ]
    assert got["대상이 쓰는 데이터 클래스와 필드"] == "- models.py::Config: name: str, retries: int, RED"
    assert got["내기 전에 확인"] == summary.PROMPT_TAIL.split("\n", 1)[1].strip("\n")
    assert not {"진입점", "분석기가 대상을 확인하지 못한 호출", "대상이 읽고 바꾸는 모듈 변수의 정의"} & set(got)


def test_prompt_of_method_holds_owner_class_externals_and_unresolved_calls():
    got = sections(summary.prompt_of(NODES, EDGES, TEXTS, "core:Engine.stop"))
    assert got["대상"].splitlines()[:2] == ["종류: 메서드", "이름: core.py::Engine.stop"]
    assert got["대상이 든 클래스"] == 'core.py::Engine\n    class Engine:\n    """설정으로 도는 엔진."""'
    assert got["대상을 호출하는 쪽"] == got["대상이 호출하는 쪽"] == "없음"
    assert got["대상이 호출하는 외부 패키지"] == "os"
    assert got["대상이 읽고 바꾸는 모듈 변수의 정의"] == "LIMIT = compute(\n    3)"
    assert got["분석기가 대상을 확인하지 못한 호출"].startswith("1곳")

    start = sections(summary.prompt_of(NODES, EDGES, TEXTS, "core:Engine.start"))
    assert start["대상이 호출하는 쪽"].splitlines() == [
        "- core.py::helper",
        "    def helper(value, other=1):",
        '    """값을 그대로 돌려준다."""',
    ]


def test_prompt_of_class_gathers_calls_of_its_methods():
    got = sections(summary.prompt_of(NODES, EDGES, TEXTS, "core:Engine"))
    assert [line for line in got["대상을 호출하는 쪽"].splitlines() if line.startswith("- ")] == [
        "- core.py::run_engine · 생성",
        "- core.py::run_engine → core.py::Engine.start · 호출",
    ]
    assert got["대상이 읽고 바꾸는 모듈 변수의 정의"] == "LIMIT = compute(\n    3)"
    assert got["대상이 호출하는 쪽"].splitlines()[0] == "- core.py::helper"
    assert "Engine.start" not in got["대상이 호출하는 쪽"]
    assert got["대상이 호출하는 외부 패키지"] == "os"


def test_prompt_of_file_holds_outline_and_files_on_both_sides():
    got = sections(summary.prompt_of(NODES, EDGES, TEXTS, "core"))
    assert got["대상"] == "종류: 파일\n이름: src/core.py\n위치: src/core.py"
    assert got["최상위 정의의 시그니처 목록"] == summary.outline(CORE, "core.py")
    assert got["파일의 문서 문자열"].startswith("엔진을 만들고 돌린다.")
    assert got["이 파일을 쓰는 파일과 가져다 쓰는 이름"].splitlines() == [
        "- src/cli.py: core.py::run_engine",
        "- tests/test_core.py: core.py::run_engine",
    ]
    assert got["이 파일이 쓰는 파일과 가져다 쓰는 이름"] == "- src/models.py: models.py::Config"
    assert got["이 파일이 쓰는 외부 패키지"] == "os"
    entry = sections(summary.prompt_of(NODES, EDGES, TEXTS, "cli"))
    assert entry["진입점"].startswith("분석기가 대상을 진입점으로 판정했다")
    assert entry["이 파일을 쓰는 파일과 가져다 쓰는 이름"] == "없음"


@pytest.mark.parametrize("node_id", ["nope", "ext:os", "core:nope"])
def test_prompt_of_unknown_or_codeless_node_is_none(node_id):
    assert summary.prompt_of(NODES, EDGES, TEXTS, node_id) is None


def test_prompt_of_caps_callers_and_callees_and_counts_the_rest():
    nodes = dict(NODES)
    edges = list(EDGES)
    for i in range(30):
        nodes[f"many:f{i}"] = node(f"many:f{i}", "function", "src/many.py", (i + 1, i + 1), test=i >= 20)
        edges.append(Edge("run", "call", f"many:f{i}", "core:helper", [SiteRef("src/many.py", i + 1, 0)]))
        edges.append(Edge("run", "call", "core:helper", f"many:f{i}", [SiteRef("src/core.py", 16, 0)]))
    texts = {**TEXTS, "src/many.py": "".join(f"def f{i}(): helper()\n" for i in range(30))}
    got = sections(summary.prompt_of(nodes, edges, texts, "core:helper"))
    callers = got["대상을 호출하는 쪽"].splitlines()
    assert sum(line.startswith("- ") for line in callers) == 12
    assert callers[-1] == "외 19곳(테스트 코드 10곳)"
    callees = got["대상이 호출하는 쪽"].splitlines()
    assert sum(line.startswith("- ") for line in callees) == 20 and callees[-1] == "외 10개"


def test_prompt_of_drops_docs_then_context_lines_then_code_at_the_limit(monkeypatch):
    full = summary.prompt_of(NODES, EDGES, TEXTS, "core:run_engine")
    monkeypatch.setattr(summary, "MAX_PROMPT", len(full) - 1)
    without_docs = summary.prompt_of(NODES, EDGES, TEXTS, "core:run_engine")
    assert '"""설정으로 도는 엔진."""' not in without_docs and "5:     config = load()" in without_docs
    monkeypatch.setattr(summary, "MAX_PROMPT", len(without_docs) - 1)
    without_context = summary.prompt_of(NODES, EDGES, TEXTS, "core:run_engine")
    assert "config = load()" not in without_context and "6>     engine = run_engine(config)" in without_context
    monkeypatch.setattr(summary, "MAX_PROMPT", len(without_context) - 1)
    cut = summary.prompt_of(NODES, EDGES, TEXTS, "core:run_engine")
    assert len(cut) <= len(without_context) - 1
    assert sections(cut)["코드"].endswith("(이하 생략)") and "대상을 호출하는 쪽" in sections(cut)


def test_prompt_of_cuts_code_at_limit():
    texts = {**TEXTS, "src/core.py": CORE + "def big():\n" + "    x = 1\n" * 5000}
    nodes = {**NODES, "core:big": node("core:big", "function", "src/core.py", (33, 5033))}
    code = sections(summary.prompt_of(nodes, EDGES, texts, "core:big"))["코드"]
    assert code.endswith("\n(이하 생략)") and len(code) == summary.MAX_CODE + len("\n(이하 생략)")


@pytest.mark.asyncio
async def test_make_generates_once_for_overlapping_requests_and_caches(fake_cli, tmp_path):
    record = fake_cli(OK)
    summaries = Summaries(tmp_path / "summaries.db")
    prompt = "def f(): ..."
    assert summaries.cached(prompt) is None
    results = await asyncio.gather(*(summaries.make(prompt) for _ in range(3)))
    assert set(results) == {Made(MADE, USED)}
    assert (record / "runs").read_text().count("run") == 1

    assert await summaries.make(prompt) == Made(MADE, None)
    assert Summaries(tmp_path / "summaries.db").cached(prompt) == MADE
    assert (record / "runs").read_text().count("run") == 1

    assert await summaries.make(prompt, refresh=True) == Made(MADE, USED)
    assert (record / "runs").read_text().count("run") == 2


@pytest.mark.asyncio
async def test_make_does_not_cache_failure(fake_cli, tmp_path):
    fake_cli(FAILING)
    summaries = Summaries(tmp_path / "summaries.db")
    with pytest.raises(SummaryError):
        await summaries.make("def f(): ...")
    assert summaries.cached("def f(): ...") is None
    fake_cli(OK)
    assert await summaries.make("def f(): ...") == Made(MADE, USED)


@pytest.mark.asyncio
async def test_make_runs_two_processes_at_most(tmp_path, monkeypatch):
    running = peak = 0

    async def generate(system, prompt):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.05)
        running -= 1
        return Made(json.dumps(prompt))

    monkeypatch.setattr(summary, "generate", generate)
    summaries = Summaries(tmp_path / "summaries.db")
    await asyncio.gather(*(summaries.make(f"def f{i}(): ...") for i in range(6)))
    assert peak == summary.MAX_PROCESSES == 2


@pytest.mark.asyncio
async def test_make_waiting_for_a_slot_is_dropped_when_every_caller_leaves(tmp_path, monkeypatch):
    made: list[str] = []
    release = asyncio.Event()

    async def generate(system, prompt):
        made.append(prompt)
        await release.wait()
        return Made(f"{prompt} 요약")

    monkeypatch.setattr(summary, "generate", generate)
    summaries = Summaries(tmp_path / "summaries.db")
    running = [asyncio.create_task(summaries.make(f"def f{i}(): ...")) for i in range(2)]
    waiting = [asyncio.create_task(summaries.make("def late(): ...")) for _ in range(2)]
    await asyncio.sleep(0.01)
    assert made == ["def f0(): ...", "def f1(): ..."]

    running[0].cancel()
    waiting[0].cancel()
    await asyncio.sleep(0.01)
    assert not waiting[1].done()
    waiting[1].cancel()
    await asyncio.sleep(0.01)
    release.set()
    assert await running[1] == Made("def f1(): ... 요약")
    await asyncio.sleep(0.01)
    assert made == ["def f0(): ...", "def f1(): ..."]
    assert summaries.cached("def f0(): ...") == "def f0(): ... 요약"
    assert summaries.cached("def late(): ...") is None

    assert await summaries.make("def late(): ...") == Made("def late(): ... 요약")
    assert len(made) == 3


@pytest.mark.asyncio
async def test_style_guide_is_read_for_every_summary_and_changes_the_key(fake_cli, tmp_path):
    record = fake_cli(OK)
    guide = tmp_path / "guide.md"
    guide.write_text("첫 규약")
    summaries = Summaries(tmp_path / "summaries.db", guide)
    await summaries.make("def f(): ...")
    assert "첫 규약" in (record / "args").read_text() and summaries.cached("def f(): ...") == MADE

    guide.write_text("고친 규약")
    assert summaries.cached("def f(): ...") is None
    await summaries.make("def f(): ...")
    assert "고친 규약" in (record / "args").read_text()
    assert (record / "runs").read_text().count("run") == 2
    assert Summaries(tmp_path / "summaries.db").cached("def f(): ...") is None


@pytest.mark.asyncio
async def test_unreadable_style_guide_makes_no_summary_and_gives_the_reason(fake_cli, tmp_path):
    record = fake_cli(OK)
    summaries = Summaries(tmp_path / "summaries.db", tmp_path / "missing.md")
    assert "서술 규약 문서를 읽지 못했습니다" in await summaries.unavailable()
    assert summaries.cached("def f(): ...") is None
    with pytest.raises(SummaryError, match="서술 규약 문서를 읽지 못했습니다"):
        await summaries.make("def f(): ...")
    assert not (record / "runs").exists()

    (tmp_path / "missing.md").write_text("규약")
    assert await summaries.unavailable() is None


@pytest.mark.asyncio
async def test_summaries_asks_login_until_available(fake_cli, tmp_path):
    summaries = Summaries(tmp_path / "summaries.db")
    assert await summaries.unavailable() == "Claude Code CLI를 찾지 못했습니다"
    fake_cli(OK)
    assert await summaries.unavailable() is None
    fake_cli(LOGGED_OUT)
    assert await summaries.unavailable() is None


def test_system_prompt_of_range_holds_range_rules_and_shares_notation_rules():
    system = summary.system_prompt_of(None, "range")
    assert system.startswith(summary.RANGE_INTRO) and system.endswith(summary.RANGE_RULES)
    assert summary.NOTATION_RULES in system and summary.NOTATION_RULES in summary.system_prompt_of(None)
    assert "하는 일\n{문단 하나에서 셋}" not in system


def test_enclosing_picks_the_innermost_definition_or_the_file():
    assert summary.enclosing(NODES, "src/core.py", 22, 23).id == "core:Engine.start"
    assert summary.enclosing(NODES, "src/core.py", 20, 23).id == "core:Engine"
    assert summary.enclosing(NODES, "src/core.py", 3, 5).id == "core"
    assert summary.enclosing(NODES, "src/missing.py", 1, 1) is None


def test_range_prompt_of_holds_range_code_numbered_definition_and_flow():
    prompt = summary.range_prompt_of(NODES, EDGES, TEXTS, "src/core.py", 30, 31)
    found = sections(prompt)
    assert found["대상"] == (
        "종류: 코드 범위\n위치: src/core.py 30~31줄\n범위가 든 정의: core.py::run_engine (함수, 29~32줄)"
    )
    assert found["고른 범위의 코드"] == "    engine = Engine(config)\n    engine.start(config)"
    assert found["범위가 든 정의의 시그니처"] == "def run_engine(config: Config) -> Engine:"
    assert found["범위가 든 정의의 전체 코드"] == (
        "29: def run_engine(config: Config) -> Engine:\n30>     engine = Engine(config)\n"
        "31>     engine.start(config)\n32:     return engine"
    )
    assert "- cli.py::main · 호출" in found["대상을 호출하는 쪽"]
    assert "- core.py::Engine.start\n    def start(self, label):" in found["대상이 호출하는 쪽"]
    assert prompt.endswith(summary.RANGE_TAIL)


def test_range_prompt_of_top_level_code_has_no_flow_and_bad_ranges_are_none():
    found = sections(summary.range_prompt_of(NODES, EDGES, TEXTS, "src/cli.py", 9, 10))
    assert found["대상"].endswith("범위가 든 정의: src/cli.py의 최상위 코드")
    assert "범위가 든 정의의 시그니처" not in found and "대상을 호출하는 쪽" not in found
    assert found["범위가 든 정의의 전체 코드"].endswith("10> run_engine(None)")
    for path, start, end in [("src/core.py", 31, 30), ("src/core.py", 30, 99), ("src/none.py", 1, 1), ("src/core.py", 27, 28)]:
        assert summary.range_prompt_of(NODES, EDGES, TEXTS, path, start, end) is None


def test_range_prompt_of_marked_code_holds_the_marks_and_what_they_mean():
    marked = " def run_engine(config: Config) -> Engine:\n-    engine = Engine()\n+    engine = Engine(config)"
    prompt = summary.range_prompt_of(NODES, EDGES, TEXTS, "src/core.py", 29, 30, marked, (40, 41))
    found = sections(prompt)
    assert found["대상"].startswith("종류: 코드 범위\n위치: src/core.py 29~30줄 (기준 시점 40~41줄)\n범위가 든 정의: core.py::run_engine")
    assert found["두 시점의 비교"] == f"{summary.MARKED_NOTE} {summary.MARKED_WHOLE}".split("\n", 1)[1]
    assert found["고른 범위의 코드"] == marked
    assert "30>     engine = Engine(config)" in found["범위가 든 정의의 전체 코드"] and "대상을 호출하는 쪽" in found
    assert prompt.endswith(summary.RANGE_TAIL + summary.MARKED_TAIL)

    added = summary.range_prompt_of(NODES, EDGES, TEXTS, "src/core.py", 30, 30, "+    engine = Engine(config)")
    assert sections(added)["대상"].startswith("종류: 코드 범위\n위치: src/core.py 30~30줄\n") and "[두 시점의 비교]" in added


def test_range_prompt_of_a_range_without_target_lines_holds_only_the_marked_code():
    marked = "-def gone():\n-    return 1"
    prompt = summary.range_prompt_of(NODES, EDGES, TEXTS, "src/old.py", 0, 0, marked, (3, 4))
    found = sections(prompt)
    assert found["대상"] == "종류: 코드 범위\n위치: src/old.py 기준 시점 3~4줄. 대상 시점에는 없는 줄이다"
    assert found["두 시점의 비교"] == summary.MARKED_NOTE.split("\n", 1)[1] and found["고른 범위의 코드"] == marked
    assert "범위가 든 정의의 전체 코드" not in found and prompt.endswith(summary.RANGE_TAIL + summary.MARKED_TAIL)
    assert summary.range_prompt_of(NODES, EDGES, TEXTS, "src/old.py", 0, 0, " \n", (3, 4)) is None
    assert summary.range_prompt_of(NODES, EDGES, TEXTS, "src/core.py", 0, 0, marked) is None
    assert summary.range_prompt_of(NODES, EDGES, TEXTS, "src/core.py", 30, 99, marked, (3, 4)) is None


def test_range_prompt_of_a_question_holds_it_in_its_own_section_before_the_checklist():
    plain = summary.range_prompt_of(NODES, EDGES, TEXTS, "src/core.py", 30, 31)
    asked = summary.range_prompt_of(NODES, EDGES, TEXTS, "src/core.py", 30, 31, question="config가 None이면 어떻게 되나?")
    assert "[질문]" not in plain and plain.endswith(summary.RANGE_TAIL)
    found = sections(asked)
    assert found["질문"] == "config가 None이면 어떻게 되나?"
    assert found["고른 범위의 코드"] == sections(plain)["고른 범위의 코드"]
    assert asked.endswith(f"[질문]\nconfig가 None이면 어떻게 되나?\n\n{summary.QUESTION_TAIL}")
    assert "첫 문장이 질문의 답인가" in summary.QUESTION_TAIL and summary.QUESTION_TAIL != summary.RANGE_TAIL
    long = summary.range_prompt_of(NODES, EDGES, TEXTS, "src/core.py", 30, 31, question="가" * 5000)
    assert len(sections(long)["질문"]) == summary.MAX_QUESTION
    marked = summary.range_prompt_of(NODES, EDGES, TEXTS, "src/old.py", 0, 0, "-x = 1", (3, 3), "왜 지웠나?")
    assert marked.endswith(f"[질문]\n왜 지웠나?\n\n{summary.QUESTION_TAIL}{summary.MARKED_TAIL}")
    system = summary.system_prompt_of(None, "range")
    assert "`[질문]` 구획" in summary.RANGE_INTRO and "`[질문]` 구획이 있으면" in system


def test_asked_name_differs_by_question_and_latest_keeps_the_question(tmp_path):
    name = "src/core.py:30-31"
    assert summary.asked_name(name, "") == name
    first, second = summary.asked_name(name, "왜?"), summary.asked_name(name, "어떻게?")
    assert first != second and first.partition("?")[0] == name and first == summary.asked_name(name, "왜?")
    latest = summary.Latest(tmp_path / "summaries.db")
    latest.put(summary.Subject("/repo", "range", name, "d"), "설명")
    latest.put(summary.Subject("/repo", "range", first, "d", "왜?"), "답 1")
    latest.put(summary.Subject("/repo", "range", second, "d", "어떻게?"), "답 2")
    assert [(k.question, k.text) for k in latest.listed("/repo", "range")] == [("", "설명"), ("왜?", "답 1"), ("어떻게?", "답 2")]
    assert latest.get("/repo", "range", first).question == "왜?"


def test_latest_reads_a_table_made_before_the_question_column_as_notes_without_a_question(tmp_path):
    path = tmp_path / "summaries.db"
    with closing(sqlite3.connect(path)) as db, db:
        db.execute(
            "CREATE TABLE latest (repo TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL, "
            "text TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY (repo, kind, name))"
        )
        db.execute("INSERT INTO latest VALUES ('/repo', 'range', 'src/core.py:1-2', 'd', '옛 설명', '2026-01-01T00:00:00+0900')")
    latest = summary.Latest(path)
    assert [(k.name, k.text, k.question) for k in latest.listed("/repo", "range")] == [("src/core.py:1-2", "옛 설명", "")]
    latest.put(summary.Subject("/repo", "range", "src/core.py:1-2?ab", "d", "왜?"), "답")
    assert len(summary.Latest(path).listed("/repo", "range")) == 2


def test_latest_opened_by_several_servers_at_once_adds_the_question_column_once(tmp_path):
    path = tmp_path / "summaries.db"
    with closing(sqlite3.connect(path)) as db, db:
        db.execute(
            "CREATE TABLE latest (repo TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL, "
            "text TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY (repo, kind, name))"
        )
    with ThreadPoolExecutor(8) as pool:
        opened = list(pool.map(lambda _: summary.Latest(path), range(8)))
    assert all(latest.listed("/repo", "range") == [] for latest in opened)


def test_compared_name_is_read_back_for_the_same_two_points_and_file():
    name = summary.compared_name("aaa", "worktree", "src/core.py", (3, 4), (0, 0))
    assert summary.compared_spans(name, "aaa", "worktree", "src/core.py") == ((3, 4), (0, 0))
    assert summary.compared_spans(name, "aaa", "bbb", "src/core.py") is None
    assert summary.compared_spans(name, "aaa", "worktree", "src/core") is None
    assert summary.compared_spans("aaa..worktree:src/core.py:x-4:0-0", "aaa", "worktree", "src/core.py") is None


def test_range_prompt_of_cuts_a_long_definition_around_the_range():
    lines = ["def big():", *(f"    x{n} = {'1' * 40}" for n in range(2, 2001))]
    texts = {**TEXTS, "src/big.py": "\n".join(lines)}
    nodes = {**NODES, "big": node("big", "module", "src/big.py", (1, 2000)), "big:big": node("big:big", "function", "src/big.py", (1, 2000))}
    whole = sections(summary.range_prompt_of(nodes, EDGES, texts, "src/big.py", 1000, 1001))["범위가 든 정의의 전체 코드"].splitlines()
    assert whole[0] == "(앞 줄 생략)" and whole[-1] == "(뒤 줄 생략)"
    assert whole[1].startswith("940: ") and whole[-2].startswith("1061: ") and "1000>     x1000" in "\n".join(whole)


def test_plain_joins_paragraph_lines_and_rejects_empty_text():
    assert summary.plain("\n 첫 문단이다. \n\n\n둘째 문단이다.\n") == "첫 문단이다.\n둘째 문단이다."
    with pytest.raises(SummaryError):
        summary.plain(" \n ")


def test_latest_keeps_one_text_per_subject(tmp_path):
    latest = summary.Latest(tmp_path / "deep" / "summaries.db")
    first = summary.Subject("/repo", "range", "src/core.py:30-31", "d1")
    assert latest.get("/repo", "range", first.name) is None
    latest.put(first, "설명 1")
    latest.put(summary.Subject("/repo", "range", "src/cli.py:1-2", "d2"), "설명 2")
    latest.put(summary.Subject("/other", "range", first.name, "d3"), "다른 레포")
    kept = summary.Latest(tmp_path / "deep" / "summaries.db").get("/repo", "range", first.name)
    assert (kept.text, kept.digest) == ("설명 1", "d1") and kept.created
    latest.put(summary.Subject("/repo", "range", first.name, "d4"), "설명 3")
    assert sorted((k.name, k.text, k.digest) for k in latest.listed("/repo", "range")) == [
        ("src/cli.py:1-2", "설명 2", "d2"),
        ("src/core.py:30-31", "설명 3", "d4"),
    ]
    latest.delete("/repo", "range", first.name)
    assert [k.name for k in latest.listed("/repo", "range")] == ["src/cli.py:1-2"]
    assert latest.get("/other", "range", first.name).text == "다른 레포"


@pytest.mark.asyncio
async def test_make_of_range_uses_range_system_prompt_plain_text_and_keeps_latest(fake_cli, tmp_path):
    record = fake_cli(OK.replace("**하는 일**", "둘째 문단이다.").replace("## 앞뒤 흐름", ""))
    summaries = Summaries(tmp_path / "summaries.db")
    subject = summary.Subject("/repo", "range", "src/core.py:30-31", "d1")
    made = await summaries.make("[대상]\n종류: 코드 범위", kind="range", subject=subject)
    text = made.text
    assert made.usage == USED
    assert text == "설정을 받아 엔진을 만들고 시작한다.\n둘째 문단이다.\n엔진을 만든다.\n`main`이 호출한다."
    assert summary.system_prompt_of(None, "range") in (record / "args").read_text()
    assert summaries.latest.get("/repo", "range", subject.name).text == text

    moved = summary.Subject("/repo", "range", "src/core.py:40-41", "d1")
    assert await summaries.make("[대상]\n종류: 코드 범위", kind="range", subject=moved) == Made(text, None)
    assert (record / "runs").read_text().count("run") == 1
    assert summaries.latest.get("/repo", "range", moved.name).text == text


@pytest.mark.asyncio
async def test_kept_gives_the_latest_summary_of_a_node_as_stale_when_the_prompt_changed(fake_cli, tmp_path):
    fake_cli(OK)
    summaries = Summaries(tmp_path / "summaries.db")
    subject = summary.Subject("/repo", "node", "core:run_engine")
    assert summaries.kept("def f(): 1", subject) == (None, False)
    made = (await summaries.make("def f(): 1", subject=subject)).text
    assert summaries.kept("def f(): 1", subject) == (made, False)
    assert summaries.latest.get("/repo", "node", subject.name).digest == summary.key_of(summary.system_prompt_of(None), "def f(): 1")
    assert summaries.kept("def f(): 2", subject) == (made, True)
    assert summaries.kept("def f(): 2", summary.Subject("/repo", "node", "core:helper")) == (None, False)
    assert summaries.kept("def f(): 2", summary.Subject("/other", "node", subject.name)) == (None, False)
