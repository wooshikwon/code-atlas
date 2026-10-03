"""basedpyright 언어 서버 세션과 열 단위 변환.

extract가 내는 열은 UTF-8 바이트 단위이고 LSP는 UTF-16 단위를 쓴다. 두 단위의
변환은 이 모듈의 `to_utf16`·`to_utf8`만 한다.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from dataclasses import dataclass
from pathlib import Path

from lsprotocol import types
from pygls.lsp.client import LanguageClient
from pygls.uris import to_fs_path

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 10.0
READY_TIMEOUT = 60.0
READY_INTERVAL = 0.5


def to_utf16(line: str, col_utf8: int) -> int:
    prefix = line.encode()[:col_utf8].decode(errors="ignore")
    return len(prefix.encode("utf-16-le")) // 2


def to_utf8(line: str, col_utf16: int) -> int:
    prefix = line.encode("utf-16-le")[: col_utf16 * 2].decode("utf-16-le", errors="ignore")
    return len(prefix.encode())


@dataclass(frozen=True)
class Location:
    """정의 위치. path는 절대경로, line은 1부터, col은 UTF-8 바이트 단위다."""

    path: str
    line: int
    col: int


def _server_command() -> str:
    exe = Path(sys.executable).parent / "basedpyright-langserver"
    return str(exe) if exe.exists() else "basedpyright-langserver"


class Session:
    """basedpyright 프로세스 하나의 수명. `async with`로 띄우고 닫는다."""

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
        await self.client.start_io(_server_command(), "--stdio", cwd=str(self.root))
        server = self.client._server
        if server is not None and server.stderr is not None:
            self.client._async_tasks.append(asyncio.create_task(self._drain(server.stderr)))
        await self.client.initialize_async(
            types.InitializeParams(
                process_id=None,
                root_uri=self.root.as_uri(),
                workspace_folders=[types.WorkspaceFolder(uri=self.root.as_uri(), name=self.root.name)],
                capabilities=types.ClientCapabilities(
                    workspace=types.WorkspaceClientCapabilities(configuration=True),
                    text_document=types.TextDocumentClientCapabilities(
                        definition=types.DefinitionClientCapabilities(link_support=False),
                    ),
                ),
            )
        )
        self.client.initialized(types.InitializedParams())
        return self

    async def __aexit__(self, *exc) -> None:
        try:
            await asyncio.wait_for(self.client.shutdown_async(None), 5)
            self.client.exit(None)
        except Exception:
            logger.debug("basedpyright shutdown failed", exc_info=True)
            if self.client._server is not None and self.client._server.returncode is None:
                self.client._server.kill()
        await self.client.stop()

    @staticmethod
    async def _drain(stream: asyncio.StreamReader) -> None:
        while await stream.read(65536):
            pass

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

    async def definition(self, path: str, line: int, col_utf8: int) -> list[Location]:
        """레포 루트 기준 경로의 1부터 세는 줄, UTF-8 바이트 열에서 정의 위치를 묻는다."""
        abs_path = str(self.root / path)
        params = types.DefinitionParams(
            text_document=types.TextDocumentIdentifier(uri=Path(abs_path).as_uri()),
            position=types.Position(line=line - 1, character=to_utf16(self._line(abs_path, line), col_utf8)),
        )
        result = await asyncio.wait_for(self.client.text_document_definition_async(params), REQUEST_TIMEOUT)
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
            target_line = start.line + 1
            col = to_utf8(self._line(target, target_line), start.character)
            locations.append(Location(target, target_line, col))
        return locations

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
