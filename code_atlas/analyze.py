"""collect·extract·lsp·resolve·graph를 차례로 부르는 분석 진입점.

`refresh`가 앞의 분석 결과나 캐시의 판정에서 시작해 바뀐 파일을 가리고 다시 물을 지점을 고른다. 캐시가 비었으면 모든
파일이 바뀐 파일이므로 전체 분석이 같은 경로로 돈다.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import sqlite3
import threading
import time
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass, replace
from pathlib import Path

from . import tools
from .cache import Answers, Cache, Stored, environment
from .collect import RepoFiles, SourceFile, collect, config_texts, module_id
from .extract import FileFacts, assigned_names, defined_names, extract, read_source
from .git import WORKTREE
from .graph import build
from .lsp import REQUEST_TIMEOUT, Location, Session
from .model import Analysis, Node, Site
from .resolve import Index, Resolution, ResolvedSite, resolve_site, restore
from .unused import Unused, candidates

logger = logging.getLogger(__name__)

# basedpyright는 요청을 하나씩 처리한다. 처리 중인 요청 하나와 기다리는 요청 하나가 있으면 서버가 쉬지 않는다.
CONCURRENCY = 2
_IDENTIFIER = re.compile(r"[^\W\d]\w*")
_ALIAS = re.compile(r"([^\W\d]\w*)\s+as\s+([^\W\d]\w*)")


class PythonNotFound(Exception):
    pass


@dataclass
class Progress:
    """분석이 지금 도는 단계와 진행 수. phase는 collect·extract·resolve·build 가운데 하나다.

    done과 total은 extract에서 파일 수, resolve에서 보낸 정의 요청 수와 보낼 전체 수이고 나머지 단계에서는 0이다.
    """

    phase: str
    done: int = 0
    total: int = 0


@dataclass
class Analyzed:
    """분석 결과와, 떠 있는 서버가 위치 질의와 세션 다시 열기, 다음 증분 분석에 쓰는 자료."""

    analysis: Analysis
    files: RepoFiles
    index: Index
    texts: dict[str, str]  # 레포 루트 기준 경로 → 본문
    stamps: dict[str, tuple[int, int] | None]  # 레포 루트 기준 경로 → 내용이 본문과 같던 때의 수정 시각과 크기
    probe: tuple[str, int, int] | None  # `Session.wait_ready`에 넘기는 지점
    unused: Unused
    stored: dict[str, Stored]  # 레포 루트 기준 경로 → 추출 결과
    answers: dict[str, Answers]  # 레포 루트 기준 경로 → 지점의 판정. 다시 물을 지점이 남은 결과에서는 비어 있다
    env: str  # 판정을 낸 때의 환경 지문

    def stale(self) -> set[str]:
        """분석할 때 읽은 본문과 지금 디스크의 본문이 다른 파일, 분석 뒤에 생긴 파일, 없어진 파일.

        수정 시각과 크기가 그대로면 본문을 읽지 않는다.
        """
        found = {f.path for f in collect(self.files.root).files} - set(self.texts)
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
    """분석에 쓸 인터프리터의 경로. `tools.python`이 확인을 통과한 것을 찾지 못하면 시도한 것을 적고 분석하지 않는다."""
    found = tools.python(Path(repo), python)
    if found.path is not None:
        return found.path
    tried = "".join(f"\n  {attempt.path or attempt.source}: {attempt.detail}" for attempt in found.attempts)
    if python is None:
        raise PythonNotFound(f"{repo}에서 가상환경을 찾지 못했습니다. --python으로 인터프리터 경로를 지정해 주세요.{tried}")
    raise PythonNotFound(f"--python에 준 경로를 실행할 수 없습니다: {python}. 인터프리터의 실행 파일 경로를 지정해 주세요.{tried}")


def _imported_module(site: Site) -> str:
    text = site.text
    if text.startswith("from "):
        return text[len("from ") :].split(" import ", 1)[0]
    return text[len("import ") :]


def _named_module(site: Site, file: SourceFile) -> str:
    """import 문이 적은 모듈의 소스 루트 기준 점 경로. 상대 import는 그 파일의 패키지에서 센다."""
    name = _imported_module(site)
    rest = name.lstrip(".")
    level = len(name) - len(rest)
    if level == 0:
        return name
    package = file.module_id.split(".")
    if not file.is_init:
        package = package[:-1]
    package = package[: len(package) - (level - 1)]
    return ".".join([*package, rest] if rest else package)


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
    session: Session, sites: list[Site], timeout: float = REQUEST_TIMEOUT, asked: Callable[[], None] | None = None
) -> tuple[dict[int, list[Location]], set[int]]:
    """동적이지 않고 내장 이름으로 판정하지 않은 지점마다 정의 위치를 묻는다.

    지점 번호별 응답과, 끝까지 응답이 없는 지점의 번호를 돌려준다. 시간 제한에 걸린 지점은 한 번 다시 묻는다.
    지점 하나를 다 물을 때마다 `asked`를 부른다.
    """
    found: dict[int, list[Location]] = {}
    late: set[int] = set()
    limit = asyncio.Semaphore(CONCURRENCY)

    async def answered(i: int) -> bool:
        site = sites[i]
        for _ in range(2):
            try:
                found[i] = await session.definition(site.path, site.request_line, site.request_col, timeout)
            except asyncio.TimeoutError:
                continue
            except Exception:
                logger.debug("definition failed: %s:%s", site.path, site.request_line, exc_info=True)
            return True
        return False

    async def one(i: int) -> None:
        """지점 하나를 물어 `found`에 응답을 담는다. 두 번 모두 시간 제한에 걸리면 `late`에 번호를 넣는다."""
        found[i] = []
        async with limit:
            if not await answered(i):
                late.add(i)
        if asked is not None:
            asked()

    await asyncio.gather(*(one(i) for i, s in enumerate(sites) if not (s.dynamic or s.builtin)))
    return found, late


def _read(repo: str | Path) -> tuple[RepoFiles, dict[str, str], dict[str, tuple[int, int] | None]]:
    """분석할 파일을 모아 본문을 읽는다. (파일 목록, 경로별 본문, 경로별 수정 시각과 크기)를 돌려준다."""
    files = collect(repo)
    stamps = {f.path: _stamp(files.abs_path(f.path)) for f in files.files}
    texts = {f.path: read_source(files, f) for f in files.files}
    return files, texts, stamps


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def _extracted(
    files: RepoFiles,
    texts: dict[str, str],
    previous: Analyzed | None,
    cache: Cache | None,
    report: Callable[[Progress], None],
    halt: threading.Event,
) -> tuple[dict[str, Stored], set[str]]:
    """파일마다 추출 결과를 정한다. (경로별 추출 결과, 이번에 새로 추출한 경로)를 돌려준다.

    본문 해시가 같은 추출 결과를 앞의 분석 결과와 캐시에서 찾고, 없거나 `known`이 달라졌으면 다시 추출한다. `known`은
    레포 전체의 정의 이름과 모듈 변수 이름 가운데 그 본문에 식별자로 나오는 이름의 해시다. `extract`가 두 이름 집합에서
    쓰는 것이 그 이름뿐이므로, 다른 파일이 정의나 모듈 변수를 더하거나 지워 이 값이 달라진 파일만 다시 추출한다.
    """
    found: dict[str, Stored | None] = {}
    names: dict[str, list[str]] = {}
    variables: dict[str, list[str]] = {}
    hashes = {path: _digest(text) for path, text in texts.items()}
    for f in files.files:
        kept = previous.stored.get(f.path) if previous is not None else None
        if kept is None or kept.text_hash != hashes[f.path]:
            kept = cache.facts(f.path, hashes[f.path]) if cache is not None else None
        # 소스 루트가 바뀌면 본문이 같아도 모듈 id가 달라진다.
        found[f.path] = kept if kept is not None and kept.facts.file == f else None
        if found[f.path] is not None:
            names[f.path], variables[f.path] = found[f.path].names, found[f.path].variables
        else:
            names[f.path], variables[f.path] = defined_names(texts[f.path]), assigned_names(texts[f.path])
    repo_names = frozenset(name for defined in names.values() for name in defined)
    repo_variables = frozenset(name for assigned in variables.values() for name in assigned)
    stored: dict[str, Stored] = {}
    fresh: set[str] = set()
    for done, f in enumerate(files.files):
        if halt.is_set():
            break
        text = texts[f.path]
        written = set(_IDENTIFIER.findall(text))
        used = [sorted(repo_names & written), sorted(repo_variables & written)]
        known = hashlib.sha256("\n\n".join("\n".join(group) for group in used).encode()).hexdigest()
        kept = found[f.path]
        if kept is None or kept.known != known:
            facts = extract(f, text, repo_names, repo_variables)
            kept = Stored(hashes[f.path], known, facts, names[f.path], variables[f.path])
            fresh.add(f.path)
        stored[f.path] = kept
        report(Progress("extract", done + 1, len(files.files)))
    return stored, fresh


class _Judging:
    """파일마다 지점의 판정을 모으고 다시 물을 지점을 고른다.

    `base`의 판정이 지금 추출 결과에서 나온 파일은 판정을 그대로 쓰고 아래 네 가지 지점만 다시 묻는다. 그 밖의 파일은
    바뀐 파일이고 모든 지점을 묻는다.

    1. 판정의 대상이 바뀐 파일이나 없어진 파일의 노드인 지점
    2. 바뀐 파일이나 없어진 파일을 import로 따라 들여오는 파일의 지점 가운데 판정이 레포 안이거나 미확인인 지점
    3. 2의 파일의 지점 가운데 판정이 외부·내장이고 레포 안 정의나 다른 외부 노드로 바뀔 수 있는 지점. 물을 위치의 이름이
       바뀐 파일과 그 파일이 import로 따라 들여오는 파일이 정의하거나 모듈 수준에서 대입한 이름, 바뀐 파일이 `from … import`로 가져오는 이름,
       `as`로 그 이름에 묶은 이름 가운데 하나인 지점과, 판정이 외부인 상속 지점, 레포 모듈이나 없어진 파일의 모듈에서
       가져오는데 판정이 외부인 import 지점이다
    4. 파일이 새로 생겼을 때, 판정이 미확인인 import 지점

    그 밖의 판정이 내장·외부인 지점은 환경 지문이 같은 동안 다시 묻지 않는다.
    """

    def __init__(
        self,
        files: RepoFiles,
        texts: dict[str, str],
        stored: dict[str, Stored],
        base: dict[str, Answers],
        origin: Path | None = None,
    ):
        self.texts = texts
        self.names = {path: [*kept.names, *kept.variables] for path, kept in stored.items()}
        self.facts = {f.path: stored[f.path].facts for f in files.files}
        self.index = Index(files.root, list(self.facts.values()), origin)
        self.owner = {node.id: path for path, facts in self.facts.items() for node in facts.nodes}
        self.owner.update((var.node_id, path) for path, facts in self.facts.items() for var in facts.variables)
        self.paths = {facts.file.module_id: path for path, facts in self.facts.items()}
        self.externals: dict[str, Node] = {}
        self.sites: dict[str, list[ResolvedSite | None]] = {}  # 아직 묻지 않은 바뀐 파일의 지점은 None이다
        self.changed: set[str] = set()
        self.asked: set[tuple[str, int]] = set()  # 판정을 그대로 쓰는 파일에서 다시 물은 지점
        self.late: set[tuple[str, int]] = set()  # 두 번 물어도 응답이 없어 미확인으로 둔 지점
        self.gone = set(base) - set(self.facts)
        self._gone_modules = {module_id(path, files.source_root) for path in self.gone}
        self.added = bool(base) and not set(self.facts) <= set(base)
        self._imported = {path: sorted(base[path].imports) if path in base else [] for path in self.facts}
        self._aliases: dict[str, set[str]] | None = None  # 이름 → 레포 어느 파일에서든 `as`로 그 이름에 묶은 이름
        self._lines: dict[str, list[bytes]] = {}
        for path, facts in self.facts.items():
            kept = base.get(path)
            if kept is not None and (kept.text_hash, kept.known) == (stored[path].text_hash, stored[path].known):
                try:
                    self.sites[path] = [
                        restore(site, verdict, kept.origins, self.externals)
                        for site, verdict in zip(facts.sites, kept.sites, strict=True)
                    ]
                    self.late.update((path, i) for i in kept.late)
                    continue
                except (KeyError, TypeError, ValueError):
                    logger.warning("저장해 둔 판정이 추출 결과와 맞지 않아 다시 묻는다: %s", path)
            self.changed.add(path)
            self._imported[path] = []
            self.sites[path] = [
                resolve_site(site, [], self.index, self.externals) if site.dynamic or site.builtin else None
                for site in facts.sites
            ]

    def imports(self, path: str) -> set[str]:
        """이 파일이 import하는 레포 파일. import 문이 적은 모듈의 파일과, import 지점의 판정 대상이 든 파일이다."""
        facts = self.facts[path]
        found: set[str] = set()
        for site, judged in zip(facts.sites, self.sites[path]):
            if site.kind != "import":
                continue
            found.add(self.paths.get(_named_module(site, facts.file), path))
            if judged is not None and judged.status == "resolved":
                found.add(self.owner.get(judged.target, path))
        found.discard(path)
        return found

    def _linked(self) -> tuple[set[str], set[str]]:
        """(바뀐 파일이나 없어진 파일을 import로 따라 들여오는 파일, 바뀐 파일과 그 파일이 import로 따라 들여오는 파일).

        판정을 그대로 쓰는 파일은 저장해 둔 import 목록도 따른다.
        """
        imports = {path: self.imports(path).union(self._imported[path]) for path in self.facts}
        importers: dict[str, set[str]] = {}
        for path, found in imports.items():
            for imported in found:
                importers.setdefault(imported, set()).add(path)

        def reached(start: set[str], links: dict[str, set[str]]) -> set[str]:
            found: set[str] = set()
            queue = list(start)
            while queue:
                for path in links.get(queue.pop(), ()):
                    if path not in found:
                        found.add(path)
                        queue.append(path)
            return found

        return reached(self.changed | self.gone, importers), self.changed | reached(self.changed, imports)

    def _defined(self, paths: set[str]) -> set[str]:
        """`paths`의 파일이 정의하거나 모듈 수준에서 대입한 이름, 바뀐 파일이 `from … import`로 가져오는 이름, 레포 어느 파일에서든 `as`로 그 이름에 묶은 이름."""
        names = {name for path in paths for name in self.names.get(path, ())}
        for path in self.changed:
            for site in self.facts[path].sites:
                if site.kind == "import" and " import " in site.text:
                    names.add(site.text.rsplit(" import ", 1)[1])
        if self._aliases is None:
            self._aliases = {}
            for text in self.texts.values():
                for name, alias in _ALIAS.findall(text):
                    self._aliases.setdefault(name, set()).add(alias)
        queue = list(names)
        while queue:
            for alias in self._aliases.get(queue.pop(), ()):
                if alias not in names:
                    names.add(alias)
                    queue.append(alias)
        return names

    def _redirected(self, path: str, site: ResolvedSite, names: set[str]) -> bool:
        """판정이 외부·내장인 지점이 레포 안 정의나 다른 외부 노드로 바뀔 수 있다."""
        if site.status == "external" and site.kind == "inherit":
            return True
        if site.status == "external" and site.kind == "import":
            module = _named_module(site, self.facts[path].file)
            if module in self.paths or module in self._gone_modules:
                return True
        if path not in self._lines:
            self._lines[path] = [line.encode() for line in self.texts[path].splitlines()]
        asked = self._lines[path][site.request_line - 1][site.request_col :].decode(errors="ignore")
        name = _IDENTIFIER.match(asked)
        return name is not None and name.group() in names

    def pending(self) -> list[tuple[str, int]]:
        """다시 물을 지점 가운데 아직 묻지 않은 (경로, 지점 번호)."""
        importers, sources = self._linked() if self.changed or self.gone else (set(), set())
        names = self._defined(sources) if importers else set()
        found: list[tuple[str, int]] = []
        for path, judged in self.sites.items():
            if path in self.changed:
                found.extend((path, i) for i, site in enumerate(judged) if site is None)
                continue
            for i, site in enumerate(judged):
                if site.dynamic or site.builtin or (path, i) in self.asked:
                    continue
                moved = site.status == "resolved" and self.owner.get(site.target, path) in self.changed
                lost = site.status == "resolved" and site.target not in self.owner
                followed = path in importers and (
                    site.status in ("resolved", "unresolved") or self._redirected(path, site, names)
                )
                missing = self.added and site.kind == "import" and site.status == "unresolved"
                if moved or lost or followed or missing:
                    found.append((path, i))
        return found

    def settle(self, path: str, i: int, locations: list[Location], late: bool) -> None:
        """물은 지점의 판정을 응답 위치로 정한다. `late`는 그 지점이 두 번 물어도 응답이 없었다는 뜻이다."""
        self.sites[path][i] = resolve_site(self.facts[path].sites[i], locations, self.index, self.externals)
        (self.late.add if late else self.late.discard)((path, i))
        if path not in self.changed:
            self.asked.add((path, i))

    def resolution(self) -> Resolution:
        """지금까지의 판정. 아직 묻지 않은 지점과, 대상 노드가 없어진 지점은 미확인으로 둔다."""
        sites: list[ResolvedSite] = []
        externals: dict[str, Node] = {}
        for path, facts in self.facts.items():
            for site, judged in zip(facts.sites, self.sites[path]):
                if judged is None or (judged.status == "resolved" and judged.target not in self.owner):
                    judged = restore(site, ("unresolved", None, None), {}, externals)
                elif judged.status == "external":
                    externals.setdefault(judged.target, self.externals[judged.target])
                sites.append(judged)
        return Resolution(sites, externals)

    def answers(self, stored: dict[str, Stored]) -> dict[str, Answers]:
        found: dict[str, Answers] = {}
        for path, judged in self.sites.items():
            found[path] = Answers(
                stored[path].text_hash,
                stored[path].known,
                [(site.status, site.target, site.edge) for site in judged],
                {site.target: self.externals[site.target].origin for site in judged if site.status == "external"},
                sorted(self.imports(path)),
                sorted(i for late, i in self.late if late == path),
            )
        return found


def _assembled(
    files: RepoFiles, texts: dict[str, str], facts: list[FileFacts], resolution: Resolution
) -> tuple[Analysis, Unused]:
    """판정으로 그래프를 조립하고 미사용 후보를 판정한다. `build`가 노드를 고치므로 추출 결과의 노드는 복사해 넘긴다."""
    copies = [replace(f, nodes=[replace(node) for node in f.nodes]) for f in facts]
    analysis = build(files, copies, resolution, texts)
    return analysis, candidates(analysis, copies, texts, config_texts(files.root))


def open_cache(repo: str | Path) -> Cache | None:
    """레포의 캐시. 열지 못하면 경고를 남기고 None을 돌려줘 캐시 없이 분석하게 한다."""
    try:
        return Cache(Path(repo))
    except (OSError, sqlite3.Error):
        logger.warning("분석 캐시를 열지 못해 캐시 없이 분석한다: %s", repo, exc_info=True)
        return None


async def refresh(
    repo: str | Path,
    python: str,
    session: Session | Callable[[RepoFiles, str], Awaitable[Session]],
    *,
    previous: Analyzed | None = None,
    cache: Cache | None = None,
    rebuild: bool = False,
    snapshot: str = WORKTREE,
    origin: Path | None = None,
    report: Callable[[Progress], None] = lambda progress: None,
    drafted: Callable[[Analyzed], None] | None = None,
) -> Analyzed:
    """레포를 분석한다. `previous`가 있으면 그 판정에서, 없으면 `cache`의 `snapshot` 시점에서 시작해 달라진 만큼만 다시 묻는다.

    `session`은 띄워 둔 세션이거나, 파일 목록과 지금의 환경 지문을 받아 그 환경에서 띄운 세션을 돌려주는 함수다.
    다시 물을 지점이 없으면 세션을 쓰지 않고, 있으면 세션의 파일을 지금 본문에 맞춘 뒤 묻는다. 세션은 닫지 않는다. `rebuild`가 참이면 캐시를 읽지 않고 모든 지점을 물어 캐시를
    덮어쓴다. `snapshot`이 커밋이면 `repo`는 그 커밋을 꺼낸 폴더이고 `origin`이 원본 레포 루트다. 그 시점이 캐시에
    없으면 달라진 파일이 없어도 저장한다. 캐시의 판정으로 조립한 결과가 있고 다시 물을 지점이 남았으면 그 결과를 `drafted`로 먼저 낸다.
    `report`는 단계가 바뀌거나 진행 수가 늘 때마다 불리고, 추출 단계에서는 다른 스레드에서 불린다.
    """
    started = time.monotonic()
    halt = threading.Event()
    try:
        report(Progress("collect"))
        files, texts, stamps = await asyncio.to_thread(_read, repo)
        report(Progress("extract", 0, len(files.files)))
        (stored, fresh), env = await asyncio.gather(
            asyncio.to_thread(_extracted, files, texts, previous, None if rebuild else cache, report, halt),
            asyncio.to_thread(environment, python, files),
        )
        if previous is not None:
            base = previous.answers if previous.env == env else {}
        else:
            base = cache.answers(snapshot, env) if cache is not None and not rebuild else {}
        judging = _Judging(files, texts, stored, base, origin)
        facts = list(judging.facts.values())
        probe = _probe(facts)

        def analyzed(answers: dict[str, Answers]) -> Analyzed:
            analysis, unused = _assembled(files, texts, facts, judging.resolution())
            analysis.stats["timed_out"] = len(judging.late)
            analysis.stats["elapsed_ms"] = round((time.monotonic() - started) * 1000)
            return Analyzed(analysis, files, judging.index, texts, stamps, probe, unused, stored, answers, env)

        todo = judging.pending()
        done = 0
        if todo:
            if drafted is not None and previous is None and len(judging.changed) < len(facts):
                report(Progress("build"))
                drafted(await asyncio.to_thread(analyzed, {}))
            report(Progress("resolve", 0, len(todo)))
            live = await session(files, env) if callable(session) else session
            live.sync_files(texts)
            await live.wait_ready(probe)

        def asked() -> None:
            nonlocal done
            done += 1
            report(Progress("resolve", done, total))

        while todo:
            # import 지점의 답이 import로 따라 들여오는 파일의 범위를 바꾸므로 import 지점을 먼저 묻고 범위를 다시 구한다.
            batch = [key for key in todo if judging.facts[key[0]].sites[key[1]].kind == "import"] or todo
            total = done + len(todo)
            report(Progress("resolve", done, total))
            found, late = await _request_all(live, [judging.facts[path].sites[i] for path, i in batch], asked=asked)
            for n, (path, i) in enumerate(batch):
                judging.settle(path, i, found.get(n, []), n in late)
            todo = judging.pending()

        report(Progress("build"))
        result = await asyncio.to_thread(analyzed, judging.answers(stored))
        unsaved = (
            cache is not None
            and snapshot != WORKTREE
            and snapshot not in await asyncio.to_thread(cache.snapshots, env)
        )
        if cache is not None and (fresh or judging.changed or judging.gone or unsaved):
            await asyncio.to_thread(cache.save, snapshot, env, {path: stored[path] for path in fresh}, result.answers)
        return result
    finally:
        halt.set()


def analyze(repo: str | Path, python: str | None = None, *, cache: bool = True) -> Analyzed:
    """세션을 띄워 `refresh`를 부른다. `cache`가 거짓이면 캐시를 읽지 않고 전체를 분석해 캐시를 덮어쓴다."""
    python = require_python(repo, python)

    async def run() -> Analyzed:
        store = open_cache(repo)
        try:
            async with AsyncExitStack() as opened:

                async def started(files: RepoFiles, env: str) -> Session:
                    return await opened.enter_async_context(Session(files.root, python, files.extra_paths))

                return await refresh(repo, python, started, cache=store, rebuild=not cache)
        finally:
            if store is not None:
                store.close()

    return asyncio.run(run())
