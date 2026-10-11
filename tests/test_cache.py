import hashlib
import logging
import os
import sqlite3
import subprocess
import sys
import threading
from contextlib import closing
from pathlib import Path

import pytest

import code_atlas
from code_atlas import cache
from code_atlas.cache import Answers, Cache, Stored, environment
from code_atlas.collect import collect, disk_path
from code_atlas.extract import extract_repo

ENV = "env-1"

WRITER = """
import logging, sys
from pathlib import Path
from code_atlas.cache import Answers, Cache, Stored
from code_atlas.collect import collect
from code_atlas.extract import extract_repo

class Count(logging.Handler):
    seen = 0
    def emit(self, record):
        Count.seen += 1

logging.getLogger("code_atlas.cache").addHandler(Count())
repo, directory, tag = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
store = Cache(repo, directory)
for round in range(40):
    text_hash = f"{tag}-{round}"
    facts = {f.file.path: Stored(text_hash, tag, f, [], []) for f in extract_repo(collect(repo))}
    answers = {path: Answers(text_hash, tag, [("unresolved", None, None)] * len(s.facts.sites), {}, [], []) for path, s in facts.items()}
    store.save("worktree", tag, facts, answers)
store.close()
sys.exit(Count.seen)
"""


def stored_of(repo: Path, text_hash: str = "h1", known: str = "k1") -> dict[str, Stored]:
    """고정 레포의 추출 결과. 본문 해시와 `known`은 시험이 정한 값을 쓴다."""
    return {f.file.path: Stored(text_hash, known, f, sorted(f.defs), [v.name for v in f.variables]) for f in extract_repo(collect(repo))}


def answers_of(stored: dict[str, Stored]) -> dict[str, Answers]:
    """지점마다 번갈아 레포 안, 외부, 미확인으로 지어낸 판정."""
    made = [("resolved", "app.core:run", "call"), ("external", "ext:os", "import"), ("unresolved", None, None)]
    return {
        path: Answers(
            s.text_hash, s.known, [made[i % 3] for i in range(len(s.facts.sites))], {"ext:os": "stdlib"}, ["src/app/core.py"], [0]
        )
        for path, s in stored.items()
    }


def rows(store: Cache, sql: str) -> list[tuple]:
    with closing(sqlite3.connect(store.path)) as db:
        return db.execute(sql).fetchall()


@pytest.fixture
def opened():
    """캐시를 열고 시험이 끝나면 닫는다."""
    made: list[Cache] = []

    def open_cache(root, directory=None) -> Cache:
        made.append(Cache(root, directory))
        return made[-1]

    yield open_cache
    for store in made:
        store.close()


@pytest.fixture
def saved(opened, sample_repo, tmp_path):
    """고정 레포의 추출 결과와 판정을 시점 `worktree`에 저장한 캐시."""
    store = opened(sample_repo, tmp_path / "cache")
    stored = stored_of(sample_repo)
    answers = answers_of(stored)
    store.save("worktree", ENV, stored, answers)
    return store, stored, answers


def test_file_is_named_by_repo_root_under_given_directory(opened, sample_repo, tmp_path):
    store = opened(sample_repo, tmp_path / "cache")
    digest = hashlib.sha256(str(disk_path(sample_repo)).encode()).hexdigest()[:16]
    assert store.path == tmp_path / "cache" / f"analysis-{digest}.db"
    assert store.path.exists()
    assert opened(str(sample_repo) + "/", tmp_path / "cache").path == store.path
    assert rows(store, "PRAGMA journal_mode") == [("wal",)]


def test_default_directory_is_user_cache(opened, monkeypatch, sample_repo, tmp_path):
    monkeypatch.setattr(cache, "CACHE_DIR", tmp_path / "home" / ".cache" / "code-atlas")
    assert opened(sample_repo).path.parent == tmp_path / "home" / ".cache" / "code-atlas"


def test_saved_facts_and_answers_come_back_equal(opened, saved, sample_repo):
    store, stored, answers = saved
    reopened = opened(sample_repo, store.path.parent)
    assert any(s.facts.sites and s.facts.defs for s in stored.values())
    for path, s in stored.items():
        assert reopened.facts(path, "h1") == s
    assert reopened.answers("worktree", ENV) == answers
    assert reopened.facts("src/app/core.py", "다른 해시") is None
    assert reopened.facts("없는 파일.py", "h1") is None


def test_error_of_broken_file_is_kept(opened, sample_repo, tmp_path):
    (sample_repo / "src" / "app" / "torn.py").write_text("def f(:\n")
    stored = stored_of(sample_repo)
    assert stored["src/app/torn.py"].facts.error
    store = opened(sample_repo, tmp_path / "cache")
    store.save("worktree", ENV, stored, answers_of(stored))
    assert store.facts("src/app/torn.py", "h1") == stored["src/app/torn.py"]


def test_other_analyzer_version_empties_the_file(opened, saved, sample_repo, monkeypatch):
    store, stored, _ = saved
    monkeypatch.setattr(cache, "ANALYZER_VERSION", cache.ANALYZER_VERSION + 1)
    reopened = opened(sample_repo, store.path.parent)
    assert reopened.path == store.path
    assert reopened.answers("worktree", ENV) == {}
    assert all(reopened.facts(path, "h1") is None for path in stored)
    assert rows(reopened, "SELECT value FROM meta WHERE key = 'analyzer'") == [(str(cache.ANALYZER_VERSION),)]


def test_other_schema_version_empties_the_file(opened, saved, sample_repo, monkeypatch):
    store, stored, _ = saved
    monkeypatch.setattr(cache, "SCHEMA_VERSION", cache.SCHEMA_VERSION + 1)
    reopened = opened(sample_repo, store.path.parent)
    assert reopened.answers("worktree", ENV) == {}
    assert all(reopened.facts(path, "h1") is None for path in stored)


def test_other_environment_drops_answers_only(saved):
    store, stored, answers = saved
    assert store.answers("worktree", "env-2") == {}
    assert all(store.facts(path, "h1") == s for path, s in stored.items())
    assert store.answers("worktree", ENV) == answers
    store.save("worktree", "env-2", {}, answers)
    assert store.answers("worktree", ENV) == {}
    assert store.answers("worktree", "env-2") == answers


def test_unknown_snapshot_has_no_answers(saved):
    store, _, _ = saved
    assert store.answers("0123abc", ENV) == {}


def test_save_drops_facts_no_answers_point_to(saved, sample_repo):
    store, stored, answers = saved
    path = "src/app/core.py"
    edited = {path: Stored("h2", "k1", stored[path].facts, stored[path].names, stored[path].variables)}
    store.save("worktree", ENV, edited, {**answers, path: Answers("h2", "k1", answers[path].sites, {}, [], [])})
    assert store.facts(path, "h1") is None
    assert store.facts(path, "h2") == edited[path]
    removed = "src/app/models.py"
    store.save("worktree", ENV, {}, {p: a for p, a in store.answers("worktree", ENV).items() if p != removed})
    assert store.facts(removed, "h1") is None
    assert removed not in store.answers("worktree", ENV)
    assert len(rows(store, "SELECT path FROM facts")) == len(stored) - 1


def test_snapshots_share_facts_and_keep_their_own_answers(saved):
    store, stored, answers = saved
    path = "src/app/core.py"
    commit = {p: a for p, a in answers.items() if p != "src/app/models.py"}
    store.save("0123abc", "env-commit", {}, commit)
    edited = {path: Stored("h2", "k1", stored[path].facts, stored[path].names, stored[path].variables)}
    store.save("worktree", ENV, edited, {**answers, path: Answers("h2", "k1", [], {}, [], [])})
    assert store.facts(path, "h1") == stored[path]
    assert store.facts(path, "h2") == edited[path]
    assert store.answers("0123abc", "env-commit") == commit
    assert store.answers("worktree", ENV)[path].text_hash == "h2"
    assert len(rows(store, "SELECT path FROM facts")) == len(stored) + 1


def test_two_caches_write_the_same_file_in_turn(opened, saved, sample_repo):
    first, stored, answers = saved
    second = opened(sample_repo, first.path.parent)
    other = stored_of(sample_repo, "h2", "k2")
    for _ in range(3):
        second.save("worktree", "env-2", other, answers_of(other))
        assert first.answers("worktree", "env-2") == answers_of(other)
        first.save("worktree", ENV, stored, answers)
        assert second.answers("worktree", ENV) == answers
    assert all(second.facts(path, "h1") == s for path, s in stored.items())
    assert all(second.facts(path, "h2") is None for path in other)


def test_threads_share_one_cache(saved):
    store, stored, answers = saved
    failed: list[BaseException] = []

    def work(turn: int) -> None:
        try:
            for _ in range(20):
                store.save("worktree", ENV, stored if turn % 2 else {}, answers)
                assert store.answers("worktree", ENV) == answers
                assert all(store.facts(path, "h1") == s for path, s in stored.items())
        except BaseException as exc:
            failed.append(exc)

    threads = [threading.Thread(target=work, args=(turn,)) for turn in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert failed == []


def test_two_processes_write_the_same_file_at_once(opened, sample_repo, tmp_path):
    directory = tmp_path / "cache"
    env = {"PYTHONPATH": str(Path(code_atlas.__file__).parent.parent), "HOME": str(tmp_path / "home")}
    writers = [
        subprocess.Popen([sys.executable, "-c", WRITER, str(sample_repo), str(directory), tag], env=env)
        for tag in ("a", "b")
    ]
    assert [w.wait(timeout=120) for w in writers] == [0, 0]
    store = opened(sample_repo, directory)
    (tag,) = {row[0] for row in rows(store, "SELECT env FROM snapshots")}
    answers = store.answers("worktree", tag)
    assert {(a.text_hash, a.known) for a in answers.values()} == {(f"{tag}-39", tag)}
    assert set(rows(store, "SELECT path, text_hash FROM facts")) == {(p, a.text_hash) for p, a in answers.items()}
    assert all(store.facts(path, a.text_hash) is not None for path, a in answers.items())
    assert rows(store, "PRAGMA integrity_check") == [("ok",)]
    assert not (tmp_path / "home").exists()


def test_broken_file_is_made_again(opened, saved, sample_repo):
    store, stored, answers = saved
    store.close()
    store.path.write_bytes(b"sqlite\x00\x01\x02" * 400)
    reopened = opened(sample_repo, store.path.parent)
    assert reopened.answers("worktree", ENV) == {}
    reopened.save("worktree", ENV, stored, answers)
    assert reopened.answers("worktree", ENV) == answers


def test_unreadable_row_is_a_miss(saved, caplog):
    store, stored, _ = saved
    with closing(sqlite3.connect(store.path)) as db, db:
        db.execute("UPDATE facts SET body = x'00' WHERE path = 'src/app/core.py'")
        db.execute("UPDATE answers SET body = x'00' WHERE path = 'src/app/core.py'")
    with caplog.at_level(logging.WARNING, logger="code_atlas.cache"):
        assert store.facts("src/app/core.py", "h1") is None
        assert store.facts("src/app/models.py", "h1") == stored["src/app/models.py"]
        assert store.answers("worktree", ENV) == {}
    assert len(caplog.records) == 2


def test_failed_save_leaves_the_file_as_it_was(opened, saved, sample_repo, caplog, monkeypatch):
    store, _, answers = saved
    monkeypatch.setattr(cache, "LOCK_TIMEOUT", 0.1)
    hurried = opened(sample_repo, store.path.parent)
    with closing(sqlite3.connect(store.path)) as db:
        db.execute("BEGIN IMMEDIATE")
        with caplog.at_level(logging.WARNING, logger="code_atlas.cache"):
            hurried.save("worktree", "env-2", {}, {})
        db.rollback()
    assert len(caplog.records) == 1
    assert store.answers("worktree", ENV) == answers
    hurried.save("worktree", "env-2", {}, {})
    assert store.answers("worktree", ENV) == {}


def test_environment_is_stable_and_follows_installed_packages(sample_repo, tmp_path, monkeypatch):
    files = collect(sample_repo)
    site = tmp_path / "site"
    site.mkdir()
    monkeypatch.setenv("PYTHONPATH", str(site))
    first = environment(sys.executable, files)
    assert len(first) == 64
    assert environment(sys.executable, files) == first
    (site / "notes.txt").write_text("")
    assert environment(sys.executable, files) == first
    (site / "extra-1.0.dist-info").mkdir()
    installed = environment(sys.executable, files)
    assert installed != first
    (site / "extra-1.0.dist-info").rename(site / "extra-1.1.dist-info")
    assert environment(sys.executable, files) not in (first, installed)
    (site / "linked.pth").write_text("")
    assert environment(sys.executable, files) not in (first, installed)


def test_environment_follows_source_root_extra_paths_and_checker(sample_repo, monkeypatch):
    files = collect(sample_repo)
    first = environment(sys.executable, files)
    files.extra_paths = [*files.extra_paths, "lib"]
    added = environment(sys.executable, files)
    assert added != first
    files.source_root = files.source_root + "/inner"
    moved = environment(sys.executable, files)
    assert moved not in (first, added)
    monkeypatch.setattr(cache.metadata, "version", lambda name: "0.0.0")
    assert environment(sys.executable, files) not in (first, added, moved)


def test_environment_without_runnable_interpreter_uses_its_stamp(sample_repo, tmp_path):
    files = collect(sample_repo)
    python = tmp_path / "python"
    python.write_text("#!/bin/sh\nexit 3\n")
    python.chmod(0o755)
    first = environment(str(python), files)
    assert environment(str(python), files) == first
    assert first != environment(sys.executable, files)
    os.utime(python, ns=(1, 1))
    assert environment(str(python), files) != first
    assert len(environment(str(tmp_path / "없는 인터프리터"), files)) == 64
