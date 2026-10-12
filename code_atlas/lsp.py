"""basedpyright 언어 서버 세션과 열 단위 변환.

extract가 내는 열은 UTF-8 바이트 단위이고 LSP는 UTF-16 단위를 쓴다. 두 단위의
변환은 이 모듈의 `to_utf16`·`to_utf8`만 한다.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import uuid
from dataclasses import dataclass
from importlib.util import find_spec
from pathlib import Path

from lsprotocol import types
from pygls.lsp.client import LanguageClient
from pygls.uris import to_fs_path

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 10.0
SHUTDOWN_TIMEOUT = 5.0
STOP_TIMEOUT = 5.0


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


def _server_command() -> list[str]:
    """언어 서버를 띄우는 명령. `nodejs_wheel`이 실은 `node`로 `basedpyright` 패키지의 서버 스크립트를 직접 실행한다.

    두 경로를 설치된 패키지에서 구하므로 설치한 폴더를 옮겨도 같은 명령이 나온다.
    """
    node = Path(find_spec("nodejs_wheel").origin).parent / "bin" / "node"
    script = Path(find_spec("basedpyright").origin).parent / "langserver.index.js"
    return [str(node), str(script), "--stdio"]


class Session:
    """basedpyright 프로세스 묶음 하나의 수명. `async with`로 띄우고 닫는다.

    언어 서버를 새 세션에서 띄워 프로세스 묶음으로 다룬다.
    """

    def __init__(self, root: Path, python: str | None, extra_paths: list[str]):
        self.root = Path(root).resolve()
        self.python = python
        self.extra_paths = [str((self.root / p).resolve()) for p in extra_paths]
        self.client = LanguageClient("code-atlas", "0.1.0")
        self._lines: dict[str, list[str]] = {}
        self._opened: dict[str, tuple[int, str]] = {}  # 레포 루트 기준 경로 → 서버에 알린 판 번호와 본문
        self._synced = False  # `sync_files`를 한 번이라도 불렀다
        self._answered = 0.0  # 서버가 마지막으로 요청에 응답한 때(이벤트 루프 시각)
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
        await self.client.start_io(*_server_command(), cwd=str(self.root), start_new_session=True)
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
                process_id=os.getpid(),
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

    def sync_files(self, texts: dict[str, str]) -> None:
        """세션이 연 파일을 레포 루트 기준 경로와 본문의 표에 맞춘다.

        새 파일은 didOpen, 본문이 달라진 파일은 didChange, 표에 없는 파일은 didClose로 알린다. 생기거나 없어진 파일은
        서버가 import를 다시 찾도록 `workspace/didChangeWatchedFiles`로도 알린다.
        """
        events: list[types.FileEvent] = []
        for rel in [r for r in self._opened if r not in texts]:
            path = self.root / rel
            del self._opened[rel]
            self._lines.pop(str(path), None)
            self.client.text_document_did_close(
                types.DidCloseTextDocumentParams(text_document=types.TextDocumentIdentifier(uri=path.as_uri()))
            )
            events.append(types.FileEvent(uri=path.as_uri(), type=types.FileChangeType.Deleted))
        for rel, text in texts.items():
            path = self.root / rel
            version, opened = self._opened.get(rel, (0, None))
            if opened == text:
                continue
            self._opened[rel] = (version + 1, text)
            self._lines[str(path)] = text.splitlines()
            if opened is None:
                self.client.text_document_did_open(
                    types.DidOpenTextDocumentParams(
                        text_document=types.TextDocumentItem(
                            uri=path.as_uri(), language_id="python", version=version + 1, text=text
                        )
                    )
                )
                if self._synced:
                    events.append(types.FileEvent(uri=path.as_uri(), type=types.FileChangeType.Created))
            else:
                self.client.text_document_did_change(
                    types.DidChangeTextDocumentParams(
                        text_document=types.VersionedTextDocumentIdentifier(uri=path.as_uri(), version=version + 1),
                        content_changes=[types.TextDocumentContentChangeWholeDocument(text=text)],
                    )
                )
        if events:
            self.client.workspace_did_change_watched_files(types.DidChangeWatchedFilesParams(changes=events))
        self._synced = True

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
        """요청을 보내 응답을 기다린다.

        서버는 요청을 하나씩 처리하므로 앞 요청이 오래 걸리면 뒤 요청은 차례를 기다린다. 서버가 어느 요청에도
        `timeout`초 동안 응답하지 않으면 `$/cancelRequest`를 보내고 `asyncio.TimeoutError`를 낸다.
        """
        loop = asyncio.get_running_loop()
        msg_id = str(uuid.uuid4())
        sent = loop.time()
        response = asyncio.wrap_future(self.client.protocol.send_request(method, params, msg_id=msg_id))
        # 취소한 요청에 늦게 오는 응답과 오류도 서버의 응답으로 받아 둔다.
        response.add_done_callback(self._note_answer)
        while True:
            remaining = max(sent, self._answered) + timeout - loop.time()
            if remaining <= 0:
                self.client.cancel_request(types.CancelParams(id=msg_id))
                raise asyncio.TimeoutError
            done, _ = await asyncio.wait([response], timeout=remaining)
            if done:
                return response.result()

    def _note_answer(self, response: asyncio.Future) -> None:
        if not response.cancelled():
            response.exception()
            self._answered = asyncio.get_running_loop().time()

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
        """레포 안 정의를 가리키는 지점에 정의 위치를 한 번 물어 응답을 기다린다."""
        if probe is None:
            return
        try:
            await self.definition(*probe)
        except asyncio.TimeoutError:
            logger.warning("basedpyright readiness probe timed out")
