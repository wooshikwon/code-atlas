"""Claude Code CLI로 노드의 한두 문장 요약을 만들고 캐시한다.

요약은 그 컴퓨터에 로그인한 Claude Code 구독 계정으로 `claude -p`를 불러 만든다.
실행 파일 찾기, 프롬프트, 호출, 캐시는 이 모듈만 한다.
"""

from __future__ import annotations

import ast
import asyncio
import copy
import hashlib
import json
import logging
import os
import shutil
import signal
import sqlite3
import tempfile
import time
from contextlib import closing
from pathlib import Path

logger = logging.getLogger(__name__)

PROMPT_VERSION = 1
MODEL = "haiku"
GENERATE_TIMEOUT = 60.0
STATUS_TIMEOUT = 10.0
MAX_CODE = 12_000
MAX_PROCESSES = 2
CACHE_PATH = Path.home() / ".cache" / "code-atlas" / "summaries.db"

KIND_NAMES = {
    "module": "파일",
    "class": "클래스",
    "dataclass": "데이터 클래스",
    "function": "함수",
    "method": "메서드",
}

SYSTEM_PROMPT = (
    "주어진 파이썬 코드가 하는 일을 한국어 한두 문장으로 요약한다. "
    '머리말, 코드 블록, 목록 없이 요약 문장만 적고, 문장은 "~한다"체로 끝낸다.'
)

# 도구와 사용자 설정(CLAUDE.md, 스킬, 플러그인, hook, MCP 서버)을 끄고 응답 한 번으로 끝낸다.
GENERATE_ARGS = (
    "-p",
    "--model",
    MODEL,
    "--tools",
    "",
    "--system-prompt",
    SYSTEM_PROMPT,
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "json",
)
STATUS_ARGS = ("auth", "status", "--json")


class SummaryError(Exception):
    """요약을 만들지 못한 까닭. 메시지를 그대로 사용자에게 보인다."""


def find_cli() -> str | None:
    """`PATH`와 `~/.local/bin/claude`에서 Claude Code 실행 파일을 찾는다."""
    found = shutil.which("claude")
    if found is not None:
        return found
    local = Path.home() / ".local" / "bin" / "claude"
    return str(local) if os.access(local, os.X_OK) else None


def key_of(code: str) -> str:
    """캐시 키. 프롬프트 판 번호, 모델, 코드가 같으면 같은 요약을 쓴다."""
    return hashlib.sha256(f"{PROMPT_VERSION}\n{MODEL}\n{code}".encode()).hexdigest()


def outline(source: str) -> str:
    """파일의 문서 문자열과 최상위 정의의 시그니처 목록. 구문 오류가 있거나 정의가 없는 파일은 본문을 그대로 낸다."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return source
    heads: list[str] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            head = copy.copy(node)
            head.body = [ast.Expr(ast.Constant(...))]
            head.decorator_list = []
            heads.append(ast.unparse(head).splitlines()[0])
    if not heads:
        return source
    doc = ast.get_docstring(tree)
    return "\n".join(([f'"""{doc}"""'] if doc else []) + heads)


def prompt_of(kind: str, name: str, code: str) -> str:
    return f"종류: {KIND_NAMES[kind]}\n이름: {name}\n\n코드:\n{code[:MAX_CODE]}\n"


async def _run(cli: str, args: tuple[str, ...], stdin: str, timeout: float) -> tuple[int, str, str]:
    """빈 임시 폴더에서 CLI를 띄워 종료 코드, 표준 출력, 표준 오류를 돌려준다. 시간 안에 끝나지 않으면 프로세스 묶음을 끝낸다."""
    with tempfile.TemporaryDirectory(prefix="code-atlas-summary-") as cwd:
        process = await asyncio.create_subprocess_exec(
            cli,
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            start_new_session=True,
        )
        try:
            out, err = await asyncio.wait_for(process.communicate(stdin.encode()), timeout)
        finally:
            if process.returncode is None:
                os.killpg(process.pid, signal.SIGKILL)
                await process.wait()
    return process.returncode, out.decode(errors="replace"), err.decode(errors="replace")


async def unavailable() -> str | None:
    """Claude Code CLI를 부를 수 없는 까닭. 부를 수 있으면 None이다."""
    cli = find_cli()
    if cli is None:
        return "Claude Code CLI를 찾지 못했다"
    try:
        _, out, _ = await _run(cli, STATUS_ARGS, "", STATUS_TIMEOUT)
    except (OSError, asyncio.TimeoutError):
        return "Claude Code CLI가 응답하지 않는다"
    try:
        logged_in = json.loads(out).get("loggedIn")
    except (ValueError, AttributeError):
        return None
    return "Claude Code에 로그인돼 있지 않다" if logged_in is False else None


async def generate(kind: str, name: str, code: str) -> str:
    """`claude -p`에 프롬프트를 표준 입력으로 넘겨 요약 문장을 받는다."""
    cli = find_cli()
    if cli is None:
        raise SummaryError("Claude Code CLI를 찾지 못했다")
    try:
        returncode, out, err = await _run(cli, GENERATE_ARGS, prompt_of(kind, name, code), GENERATE_TIMEOUT)
    except asyncio.TimeoutError:
        raise SummaryError(f"Claude Code CLI가 {GENERATE_TIMEOUT:.0f}초 안에 응답하지 않았다") from None
    except OSError as exc:
        raise SummaryError(f"Claude Code CLI를 띄우지 못했다: {exc}") from exc
    try:
        body = json.loads(out)
        result, failed = str(body["result"]).strip(), bool(body["is_error"])
    except (ValueError, KeyError, TypeError):
        result, failed = "", True
    if returncode != 0 or failed or not result:
        detail = result or (err.strip().splitlines() or [""])[-1][:200]
        if "Not logged in" in detail:
            raise SummaryError("Claude Code에 로그인돼 있지 않다")
        raise SummaryError(f"Claude Code CLI가 요약을 내지 못했다(종료 코드 {returncode}): {detail}")
    return result


class Cache:
    """요약을 담는 SQLite 표 하나."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._execute(
            "CREATE TABLE IF NOT EXISTS summaries (key TEXT PRIMARY KEY, summary TEXT NOT NULL, created TEXT NOT NULL)"
        )

    def _execute(self, sql: str, args: tuple = ()) -> tuple | None:
        with closing(sqlite3.connect(self.path, timeout=5)) as db, db:
            return db.execute(sql, args).fetchone()

    def get(self, key: str) -> str | None:
        row = self._execute("SELECT summary FROM summaries WHERE key = ?", (key,))
        return row[0] if row else None

    def put(self, key: str, summary: str) -> None:
        self._execute(
            "INSERT OR REPLACE INTO summaries (key, summary, created) VALUES (?, ?, ?)",
            (key, summary, time.strftime("%Y-%m-%dT%H:%M:%S%z")),
        )


class Summaries:
    """캐시와 만드는 중인 요약. 서버가 떠 있는 동안 하나다."""

    def __init__(self, path: Path | None = None):
        self.cache = Cache(path or CACHE_PATH)
        self._slots = asyncio.Semaphore(MAX_PROCESSES)
        self._making: dict[str, asyncio.Task[str]] = {}
        self._checking = asyncio.Lock()
        self._ready = False

    async def unavailable(self) -> str | None:
        """`unavailable()`과 같다. 함께 들어온 요청은 한 번만 묻고, 부를 수 있다고 확인한 뒤에는 다시 묻지 않는다."""
        async with self._checking:
            if self._ready:
                return None
            reason = await unavailable()
            self._ready = reason is None
            return reason

    def cached(self, code: str) -> str | None:
        return self.cache.get(key_of(code))

    async def make(self, kind: str, name: str, code: str, refresh: bool = False) -> str:
        """캐시에 있으면 그 요약을, 없거나 `refresh`면 새로 만든 요약을 돌려준다. 같은 코드의 요청이 겹치면 한 번만 만든다."""
        key = key_of(code)
        task = self._making.get(key)
        if task is None:
            cached = None if refresh else self.cache.get(key)
            if cached is not None:
                return cached
            task = asyncio.create_task(self._generate(key, kind, name, code))
            self._making[key] = task
            task.add_done_callback(lambda _: self._making.pop(key, None))
        return await asyncio.shield(task)

    async def _generate(self, key: str, kind: str, name: str, code: str) -> str:
        async with self._slots:
            started = time.monotonic()
            summary = await generate(kind, name, code)
            logger.info("summary %s made in %.1fs", key[:12], time.monotonic() - started)
        self.cache.put(key, summary)
        return summary
