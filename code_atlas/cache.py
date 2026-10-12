"""파일의 추출 결과와 지점의 판정을 레포마다 SQLite 파일 하나에 담는다.

추출 결과는 파일 경로와 본문 해시로 찾으므로 시점이 달라도 본문이 같으면 다시 쓴다. 지점의 판정은 다른 파일과
가상환경에 따라 달라지므로 시점마다 따로 두고, 환경 지문이 다르면 쓰지 않는다. 어느 지점을 다시 물을지와 언어 서버는
이 모듈이 모른다.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import threading
import time
import zlib
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

from .collect import RepoFiles, SourceFile, disk_path
from .extract import DefInfo, FileFacts, VarInfo
from .model import Node, Site

logger = logging.getLogger(__name__)

ANALYZER_VERSION = 3  # extract·resolve·graph의 판정이 달라지는 변경마다 올린다
SCHEMA_VERSION = 3  # 표와 `body`의 모양이 달라지는 변경마다 올린다
CACHE_DIR = Path.home() / ".cache" / "code-atlas"
LOCK_TIMEOUT = 5.0
PROBE_TIMEOUT = 5.0
_PROBE = "import json, sys; print(json.dumps([sys.version, sys.path]))"
_INSTALLED = (".dist-info", ".egg-info", ".pth")
_TABLES = {
    "meta": "key TEXT PRIMARY KEY, value TEXT NOT NULL",
    "facts": "path TEXT NOT NULL, text_hash TEXT NOT NULL, known TEXT NOT NULL, body BLOB NOT NULL, "
    "PRIMARY KEY (path, text_hash)",
    "snapshots": "name TEXT PRIMARY KEY, env TEXT NOT NULL, saved TEXT NOT NULL",
    "answers": "snapshot TEXT NOT NULL, path TEXT NOT NULL, text_hash TEXT NOT NULL, known TEXT NOT NULL, "
    "body BLOB NOT NULL, PRIMARY KEY (snapshot, path)",
}


@dataclass
class Stored:
    """파일 하나의 추출 결과와 그 결과를 낸 입력의 해시.

    `known`은 레포 전체의 정의 이름과 모듈 변수 이름 가운데 이 파일 본문에 나오는 이름의 해시이고, `names`는 이 파일이
    정의한 이름, `variables`는 이 파일이 모듈 수준에서 대입한 이름이다.
    """

    text_hash: str
    known: str
    facts: FileFacts
    names: list[str]
    variables: list[str]


@dataclass
class Answers:
    """파일 하나의 지점 판정. `sites`는 추출 결과의 지점 순서대로 (상태, 대상 노드 id, 선 종류)다.

    `origins`는 대상이 된 외부 노드 id의 origin이고, `imports`는 이 파일이 import하는 레포 파일의 경로다.
    `late`는 언어 서버가 두 번 물어도 응답하지 않아 미확인으로 둔 지점의 번호다.
    """

    text_hash: str
    known: str
    sites: list[tuple[str, str | None, str | None]]
    origins: dict[str, str]
    imports: list[str]
    late: list[int]


def _installed(folder: str) -> list[str]:
    try:
        with os.scandir(folder) as entries:
            return sorted(e.name for e in entries if e.name.endswith(_INSTALLED))
    except OSError:
        return []


def environment(python: str, files: RepoFiles) -> str:
    """지점의 판정을 바꾸는 환경의 지문.

    basedpyright 버전, 인터프리터의 실제 경로와 `sys.version`, `sys.path`의 폴더마다 설치된 패키지의 이름 목록,
    소스 루트, `extra_paths`를 해시한다. 인터프리터를 실행하지 못하면 인터프리터의 수정 시각으로 대신한다.
    """
    exe = os.path.realpath(shutil.which(python) or python)
    try:
        out = subprocess.run([python, "-c", _PROBE], capture_output=True, text=True, timeout=PROBE_TIMEOUT, check=True)
        version, folders = json.loads(out.stdout)
        interpreter = [version, [[folder, _installed(folder)] for folder in folders if folder]]
    except (OSError, subprocess.SubprocessError, ValueError):
        try:
            interpreter = [os.stat(exe).st_mtime_ns]
        except OSError:
            interpreter = []
    parts = [metadata.version("basedpyright"), exe, interpreter, files.source_root, files.extra_paths]
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()


def _pack(value: dict) -> bytes:
    return zlib.compress(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(), 1)


def _unpack(body: bytes) -> dict:
    return json.loads(zlib.decompress(body))


def _plain(obj, kind: type) -> dict:
    """dataclass `kind`의 필드만 담은 dict. 안쪽 값은 복사하지 않는다."""
    return {name: getattr(obj, name) for name in kind.__dataclass_fields__}


def _body(stored: Stored) -> dict:
    facts = stored.facts
    return {
        "file": _plain(facts.file, SourceFile),
        "nodes": [_plain(n, Node) for n in facts.nodes],
        "defs": {name: _plain(d, DefInfo) for name, d in facts.defs.items()},
        "sites": [_plain(s, Site) for s in facts.sites],
        "error": facts.error,
        "variables": [_plain(v, VarInfo) for v in facts.variables],
        "names": stored.names,
        "assigned": stored.variables,
    }


def _node(fields: dict) -> Node:
    node = Node(**fields)
    if node.range is not None:
        node.range = tuple(node.range)
    return node


def _variable(fields: dict) -> VarInfo:
    var = VarInfo(**fields)
    var.range = tuple(var.range)
    var.targets = [tuple(target) for target in var.targets]
    var.value = tuple(var.value) if var.value is not None else None
    var.maker = tuple(var.maker) if var.maker is not None else None
    return var


def _facts(body: dict) -> FileFacts:
    return FileFacts(
        file=SourceFile(**body["file"]),
        nodes=[_node(n) for n in body["nodes"]],
        defs={name: DefInfo(**d) for name, d in body["defs"].items()},
        sites=[Site(**s) for s in body["sites"]],
        error=body["error"],
        variables=[_variable(v) for v in body["variables"]],
    )


def _set_wal(db: sqlite3.Connection) -> None:
    """WAL 방식으로 바꾼다. 다른 연결이 같은 때에 바꾸고 있으면 SQLite가 잠금 대기 없이 거절하므로 `LOCK_TIMEOUT` 동안 다시 한다."""
    deadline = time.monotonic() + LOCK_TIMEOUT
    while True:
        try:
            db.execute("PRAGMA journal_mode=WAL")
            return
        except sqlite3.OperationalError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.01)


class Cache:
    """레포 하나의 캐시 파일과 그 파일에 열어 둔 연결 하나.

    판 번호나 레포 루트가 `meta`와 다르면 표를 비우고, 파일을 읽지 못하면 지우고 새로 만든다. 읽지 못한 행은 없는 행으로
    다루고, 쓰지 못한 저장은 경고만 남긴다. WAL 방식의 파일은 마지막 연결을 닫을 때마다 로그를 본 파일에 옮기므로,
    연결을 읽기마다 새로 열지 않고 하나를 잠금으로 번갈아 쓴다.
    """

    def __init__(self, root: Path, directory: Path | None = None):
        self.root = str(disk_path(root))
        name = f"analysis-{hashlib.sha256(self.root.encode()).hexdigest()[:16]}.db"
        self.path = Path(directory or CACHE_DIR) / name
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        try:
            self._db = self._open()
        except sqlite3.OperationalError:
            raise
        except sqlite3.DatabaseError:
            for suffix in ("", "-wal", "-shm"):
                Path(f"{self.path}{suffix}").unlink(missing_ok=True)
            self._db = self._open()

    def _open(self) -> sqlite3.Connection:
        """연결을 열고, 표가 지금 판 번호와 레포 루트로 만든 것이 아니면 한 트랜잭션으로 지우고 새로 만든다."""
        meta = {"schema": str(SCHEMA_VERSION), "analyzer": str(ANALYZER_VERSION), "root": self.root}
        db = sqlite3.connect(self.path, timeout=LOCK_TIMEOUT, isolation_level="IMMEDIATE", check_same_thread=False)
        try:
            _set_wal(db)
            with db:
                db.execute("BEGIN IMMEDIATE")
                made = {name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
                if "meta" not in made or dict(db.execute("SELECT key, value FROM meta").fetchall()) != meta:
                    for name in _TABLES:
                        db.execute(f"DROP TABLE IF EXISTS {name}")
                    for name, columns in _TABLES.items():
                        db.execute(f"CREATE TABLE {name} ({columns})")
                    db.executemany("INSERT INTO meta (key, value) VALUES (?, ?)", meta.items())
        except BaseException:
            db.close()
            raise
        return db

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def facts(self, path: str, text_hash: str) -> Stored | None:
        """그 본문에서 낸 추출 결과. `known`이 지금 값과 같은지는 부르는 쪽이 확인한다."""
        try:
            with self._lock:
                row = self._db.execute(
                    "SELECT known, body FROM facts WHERE path = ? AND text_hash = ?", (path, text_hash)
                ).fetchone()
            if row is None:
                return None
            body = _unpack(row[1])
            return Stored(text_hash, row[0], _facts(body), body["names"], body["assigned"])
        except (sqlite3.Error, zlib.error, ValueError, KeyError, TypeError):
            logger.warning("캐시에서 추출 결과를 읽지 못했다: %s", path, exc_info=True)
            return None

    def answers(self, snapshot: str, env: str) -> dict[str, Answers]:
        """그 시점의 파일별 판정. 시점이 없거나 저장한 때의 환경 지문이 `env`와 다르면 빈 dict다."""
        try:
            with self._lock:
                rows = self._db.execute(
                    "SELECT a.path, a.text_hash, a.known, a.body FROM answers a JOIN snapshots s ON s.name = a.snapshot "
                    "WHERE s.name = ? AND s.env = ?",
                    (snapshot, env),
                ).fetchall()
            found: dict[str, Answers] = {}
            for path, text_hash, known, packed in rows:
                body = _unpack(packed)
                sites = [(status, target, edge) for status, target, edge in body["sites"]]
                found[path] = Answers(text_hash, known, sites, body["origins"], body["imports"], body["late"])
            return found
        except (sqlite3.Error, zlib.error, ValueError, KeyError, TypeError):
            logger.warning("캐시에서 판정을 읽지 못했다: %s", snapshot, exc_info=True)
            return {}

    def save(self, snapshot: str, env: str, facts: dict[str, Stored], answers: dict[str, Answers]) -> None:
        """한 트랜잭션으로 `facts`의 추출 결과를 더하고 그 시점의 판정을 `answers`로 바꾼다.

        어느 시점의 판정도 가리키지 않는 추출 결과는 지운다. `facts`에는 새로 추출한 파일만 줘도 된다.
        """
        fact_rows = [(path, s.text_hash, s.known, _pack(_body(s))) for path, s in facts.items()]
        answer_rows = [
            (
                snapshot,
                path,
                a.text_hash,
                a.known,
                _pack({"sites": a.sites, "origins": a.origins, "imports": a.imports, "late": a.late}),
            )
            for path, a in answers.items()
        ]
        try:
            with self._lock, self._db as db:
                db.executemany(
                    "INSERT OR REPLACE INTO facts (path, text_hash, known, body) VALUES (?, ?, ?, ?)", fact_rows
                )
                db.execute(
                    "INSERT OR REPLACE INTO snapshots (name, env, saved) VALUES (?, ?, ?)",
                    (snapshot, env, time.strftime("%Y-%m-%dT%H:%M:%S%z")),
                )
                db.execute("DELETE FROM answers WHERE snapshot = ?", (snapshot,))
                db.executemany(
                    "INSERT INTO answers (snapshot, path, text_hash, known, body) VALUES (?, ?, ?, ?, ?)", answer_rows
                )
                db.execute(
                    "DELETE FROM facts WHERE NOT EXISTS (SELECT 1 FROM answers a "
                    "WHERE a.path = facts.path AND a.text_hash = facts.text_hash)"
                )
        except sqlite3.Error:
            logger.warning("캐시에 저장하지 못했다: %s", self.path, exc_info=True)
