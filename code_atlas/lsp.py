"""basedpyright 언어 서버 세션과 열 단위 변환.

extract가 내는 열은 UTF-8 바이트 단위이고 LSP는 UTF-16 단위를 쓴다. 두 단위의
변환은 이 모듈의 `to_utf16`·`to_utf8`만 한다.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

from lsprotocol import types
from pygls.lsp.client import LanguageClient
from pygls.uris import to_fs_path

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 10.0
SHUTDOWN_TIMEOUT = 5.0
STOP_TIMEOUT = 5.0
READY_TIMEOUT = 60.0
READY_INTERVAL = 0.5


def to_utf16(line: str, col_utf8: int) -> int:
    prefix = line.encode()[:col_utf8].decode(errors="ignore")
    return len(prefix.encode("utf-16-le")) // 2


def to_utf8(line: str, col_utf16: int) -> int:
    prefix = line.encode("utf-16-le")[: col_utf16 * 2].decode("utf-16-le", errors="ignore")
    return len(prefix.encode())


def markdown_of(contents) -> str:
    """LSP hover 내용의 세 형태(MarkupContent, 문자열, 언어가 붙은 코드)와 그 목록을 markdown 문자열로 바꾼다."""
    if isinstance(contents, types.MarkupContent):
        return contents.value
    if isinstance(contents, str):
        return contents
    if isinstance(contents, types.MarkedStringWithLanguage):
        return f"```{contents.language}\n{contents.value}\n```"
    return "\n\n".join(markdown_of(item) for item in contents)


@dataclass(frozen=True)
class Location:
    """정의 위치. path는 절대경로, line은 1부터 센다. col의 단위는 돌려준 메서드가 정한다."""

    path: str
    line: int
    col: int


@dataclass(frozen=True)
class Hover:
    """hover 내용. range는 (시작 줄, 시작 열, 끝 줄, 끝 열)이고 줄은 1부터, 열은 UTF-16 단위다."""

    markdown: str
    range: tuple[int, int, int, int] | None


def _server_command() -> str:
    exe = Path(sys.executable).parent / "basedpyright-langserver"
    return str(exe) if exe.exists() else "basedpyright-langserver"


class Session:
    """basedpyright 프로세스 묶음 하나의 수명. `async with`로 띄우고 닫는다.

    `basedpyright-langserver`는 node를 자식으로 띄우므로 새 세션에서 띄워 프로세스 묶음으로 다룬다.
    """

    def __init__(self, root: Path, python: str | None, extra_paths: list[str]):
        self.root = Path(root).resolve()
        self.python = python
        self.extra_paths = [str((self.root / p).resolve()) for p in extra_paths]
        self.client = LanguageClient("code-atlas", "0.1.0")
        self._lines: dict[str, list[str]] = {}
        self._register_handlers()

    def _analysis_settings(self) -> dict:
        return {
            "extraPaths": self.extra_paths,
            "autoSearchPaths": True,
            "typeCheckingMode": "off",
            "diagnosticMode": "openFilesOnly",
        }

    def _section(self, section: str | None) -> dict | None:
        analysis = self._analysis_settings()
        python = {"pythonPath": self.python} if self.python else {}
        return {
            "python": {**python, "analysis": analysis},
            "python.analysis": analysis,
            "basedpyright": {"analysis": analysis},
            "basedpyright.analysis": analysis,
        }.get(section or "", {})

    def _register_handlers(self) -> None:
        client = self.client

        @client.feature(types.WORKSPACE_CONFIGURATION)
        def configuration(params: types.ConfigurationParams):
            return [self._section(item.section) for item in params.items]

        @client.feature(types.CLIENT_REGISTER_CAPABILITY)
        def register_capability(params):
            return None

        @client.feature(types.WINDOW_WORK_DONE_PROGRESS_CREATE)
        def progress_create(params):
            return None

        @client.feature(types.WINDOW_LOG_MESSAGE)
        def log_message(params):
            logger.debug("basedpyright: %s", params.message)

        @client.feature(types.TEXT_DOCUMENT_PUBLISH_DIAGNOSTICS)
        def diagnostics(params):
            return None

        for method in ("pyright/beginProgress", "pyright/reportProgress", "pyright/endProgress"):
            client.feature(method)(lambda params: None)

    async def __aenter__(self) -> Session:
        await self.client.start_io(_server_command(), "--stdio", cwd=str(self.root), start_new_session=True)
        try:
            await self._initialize()
        except BaseException:
            await self._close(graceful=False)
            raise
        return self

    async def _initialize(self) -> None:
        server = self.client._server
        if server is not None and server.stderr is not None:
            self.client._async_tasks.append(asyncio.create_task(self._drain(server.stderr)))
        result = await self.client.initialize_async(
            types.InitializeParams(
                process_id=None,
                root_uri=self.root.as_uri(),
                workspace_folders=[types.WorkspaceFolder(uri=self.root.as_uri(), name=self.root.name)],
                capabilities=types.ClientCapabilities(
                    workspace=types.WorkspaceClientCapabilities(configuration=True),
                    text_document=types.TextDocumentClientCapabilities(
                        definition=types.DefinitionClientCapabilities(link_support=False),
                        hover=types.HoverClientCapabilities(
                            content_format=[types.MarkupKind.Markdown, types.MarkupKind.PlainText]
                        ),
                    ),
                ),
            )
        )
        # 응답에 값이 없으면 LSP 기본값인 UTF-16이다.
        logger.info("basedpyright position encoding: %s", result.capabilities.position_encoding or "utf-16")
        self.client.initialized(types.InitializedParams())

    async def __aexit__(self, exc_type, *exc) -> None:
        await self._close(graceful=exc_type is None)

    async def _close(self, graceful: bool) -> None:
        """shutdown 요청으로 닫고, 응답이 없거나 `graceful`이 거짓이면 프로세스 묶음을 끝낸다."""
        server = self.client._server
        if server is None:
            return
        graceful = graceful and not self.stopped
        if graceful:
            try:
                await asyncio.wait_for(self._shutdown(server), SHUTDOWN_TIMEOUT)
            except Exception:
                logger.debug("basedpyright shutdown failed", exc_info=True)
                graceful = False
        if not graceful:
            try:
                os.killpg(server.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(self.client.stop(), STOP_TIMEOUT)
        except asyncio.TimeoutError:
            logger.warning("basedpyright process %s did not stop", server.pid)

    async def _shutdown(self, server: asyncio.subprocess.Process) -> None:
        await self.client.shutdown_async(None)
        self.client.exit(None)
        await server.wait()

    @staticmethod
    async def _drain(stream: asyncio.StreamReader) -> None:
        while await stream.read(65536):
            pass

    @property
    def stopped(self) -> bool:
        """basedpyright 프로세스가 끝났으면 참이다. 끝난 세션에는 요청을 보내지 못한다."""
        return self.client.stopped

    def open_files(self, texts: dict[str, str]) -> None:
        """레포 루트 기준 경로와 본문을 받아 모두 didOpen으로 연다."""
        for rel, text in texts.items():
            path = self.root / rel
            self._lines[str(path)] = text.splitlines()
            self.client.text_document_did_open(
                types.DidOpenTextDocumentParams(
                    text_document=types.TextDocumentItem(
                        uri=path.as_uri(), language_id="python", version=1, text=text
                    )
                )
            )

    def _line(self, path: str, line: int) -> str:
        lines = self._lines.get(path)
        if lines is None:
            try:
                lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                lines = []
            self._lines[path] = lines
        return lines[line - 1] if 0 < line <= len(lines) else ""

    async def _request(self, method: str, params, timeout: float):
        """요청을 보내 응답을 기다린다. 시간 안에 응답이 없으면 `$/cancelRequest`를 보내고 `asyncio.TimeoutError`를 낸다."""
        msg_id = str(uuid.uuid4())
        response = asyncio.wrap_future(self.client.protocol.send_request(method, params, msg_id=msg_id))
        # 취소한 요청에 늦게 오는 응답과 오류를 받아 둔다.
        response.add_done_callback(lambda done: done.cancelled() or done.exception())
        try:
            return await asyncio.wait_for(asyncio.shield(response), timeout)
        except asyncio.TimeoutError:
            self.client.cancel_request(types.CancelParams(id=msg_id))
            raise

    async def definition(
        self, path: str, line: int, col_utf8: int, timeout: float = REQUEST_TIMEOUT
    ) -> list[Location]:
        """레포 루트 기준 경로의 1부터 세는 줄, UTF-8 바이트 열에서 정의 위치를 묻는다."""
        col_utf16 = to_utf16(self._line(str(self.root / path), line), col_utf8)
        return [
            Location(loc.path, loc.line, to_utf8(self._line(loc.path, loc.line), loc.col))
            for loc in await self.definition_at(path, line, col_utf16, timeout)
        ]

    async def definition_at(
        self, path: str, line: int, col_utf16: int, timeout: float = REQUEST_TIMEOUT
    ) -> list[Location]:
        """레포 루트 기준 경로의 1부터 세는 줄, UTF-16 열에서 정의 위치를 묻는다. 돌려주는 열도 UTF-16 단위다."""
        params = types.DefinitionParams(
            text_document=types.TextDocumentIdentifier(uri=(self.root / path).as_uri()),
            position=types.Position(line=line - 1, character=col_utf16),
        )
        result = await self._request(types.TEXT_DOCUMENT_DEFINITION, params, timeout)
        if result is None:
            return []
        items = result if isinstance(result, list) else [result]
        locations: list[Location] = []
        for item in items:
            if isinstance(item, types.LocationLink):
                uri, start = item.target_uri, item.target_selection_range.start
            else:
                uri, start = item.uri, item.range.start
            target = to_fs_path(uri)
            if target is None:
                continue
            locations.append(Location(target, start.line + 1, start.character))
        return locations

    async def hover(self, path: str, line: int, col_utf16: int, timeout: float = REQUEST_TIMEOUT) -> Hover | None:
        """레포 루트 기준 경로의 1부터 세는 줄, UTF-16 열에서 hover 내용을 묻는다."""
        params = types.HoverParams(
            text_document=types.TextDocumentIdentifier(uri=(self.root / path).as_uri()),
            position=types.Position(line=line - 1, character=col_utf16),
        )
        result = await self._request(types.TEXT_DOCUMENT_HOVER, params, timeout)
        if result is None:
            return None
        r = result.range
        return Hover(
            markdown_of(result.contents),
            (r.start.line + 1, r.start.character, r.end.line + 1, r.end.character) if r else None,
        )

    async def wait_ready(self, probe: tuple[str, int, int] | None) -> None:
        """레포 안 정의를 가리키는 지점에 응답이 올 때까지 기다린다."""
        if probe is None:
            return
        loop = asyncio.get_running_loop()
        deadline = loop.time() + READY_TIMEOUT
        while loop.time() < deadline:
            try:
                if await self.definition(*probe):
                    return
            except asyncio.TimeoutError:
                pass
            await asyncio.sleep(READY_INTERVAL)
        logger.warning("basedpyright readiness probe timed out")
