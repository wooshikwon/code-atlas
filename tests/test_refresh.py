import asyncio
import sqlite3
import sys
from contextlib import AsyncExitStack, asynccontextmanager, closing
from pathlib import Path

import pytest

from code_atlas import analyze, cache, cli
from code_atlas.analyze import Progress, open_cache, refresh
from code_atlas.cache import Cache
from code_atlas.lsp import Session
from code_atlas.model import to_dict

# 처음 분석할 때는 `app.late`가 없어 import가 미확인이다.
USES = "from app.late import later\n\n\ndef use():\n    return later()\n"
LATE = "def later():\n    return 1\n\n\ndef config():\n    return 2\n"


def judged(analyzed) -> dict:
    """노드, 선, 지점별 판정, 파싱 오류, 미사용 후보."""
    found = to_dict(analyzed.analysis)
    return {**{k: found[k] for k in ("nodes", "edges", "sites", "errors")}, "unused": to_dict(analyzed.unused)}


def listing(repo: Path) -> list[tuple[str, int]]:
    return sorted((str(p.relative_to(repo)), p.stat().st_mtime_ns) for p in repo.rglob("*"))


@asynccontextmanager
async def started():
    """세션 하나를 처음 부를 때 띄워 돌려주는 함수. 그 세션이 보낸 정의 요청을 `asked`에 담는다."""
    async with AsyncExitStack() as stack:
        sessions: list[Session] = []

        async def start(files, env) -> Session:
            if not sessions:
                session = await stack.enter_async_context(Session(files.root, sys.executable, files.extra_paths))
                definition = session.definition

                async def counted(path, line, col, *rest):
                    start.asked.append((path, line, col))
                    return await definition(path, line, col, *rest)

                session.definition = counted
                sessions.append(session)
            return sessions[0]

        start.asked = []
        yield start


class FakeSession:
    """프로세스를 띄우지 않는 세션. 모든 정의 요청에 빈 응답을 돌려주고 받은 요청을 `asked`에 담는다."""

    def __init__(self):
        self.asked: list[tuple[str, int, int]] = []
        self.synced: list[dict[str, str]] = []

    def sync_files(self, texts):
        self.synced.append(texts)

    async def wait_ready(self, probe):
        pass

    async def definition(self, path, line, col, timeout):
        self.asked.append((path, line, col))
        return []


def at_top(repo: Path) -> None:
    core = repo / "src" / "app" / "core.py"
    core.write_text("# 모든 줄을 한 줄씩 민다\n" + core.read_text())


def rename_function(repo: Path) -> None:
    core = repo / "src" / "app" / "core.py"
    core.write_text(core.read_text().replace("run_engine", "run_motor"))


def remove_called_function(repo: Path) -> None:
    core = repo / "src" / "app" / "core.py"
    text = core.read_text()
    start, end = text.index("def run_engine"), text.index("def spare")
    core.write_text(text[:start] + text[end:])


def add_file(repo: Path) -> None:
    (repo / "src" / "app" / "late.py").write_text(LATE)


def delete_file(repo: Path) -> None:
    (repo / "src" / "app" / "plugins" / "base.py").unlink()


def rename_file(repo: Path) -> None:
    (repo / "src" / "app" / "core.py").rename(repo / "src" / "app" / "kernel.py")


def break_syntax(repo: Path) -> None:
    models = repo / "src" / "app" / "models.py"
    models.write_text(models.read_text() + "\n\ndef broken(:\n")


EDITS = {
    "본문": at_top,
    "함수 이름": rename_function,
    "다른 파일이 부르던 함수 삭제": remove_called_function,
    "파일 추가": add_file,
    "파일 삭제": delete_file,
    "파일 이름": rename_file,
    "문법 오류": break_syntax,
}


@pytest.mark.parametrize("edit", EDITS.values(), ids=EDITS.keys())
@pytest.mark.asyncio
async def test_incremental_results_equal_a_full_analysis(sample_repo, tmp_path, edit):
    (sample_repo / "src" / "app" / "uses.py").write_text(USES)
    store = Cache(sample_repo, tmp_path / "cache")
    drafts = []
    async with started() as live, started() as reopened, started() as full:
        first = await refresh(sample_repo, sys.executable, live, cache=store)
        asked_first = len(live.asked)
        edit(sample_repo)
        before = listing(sample_repo)
        from_cache = await refresh(sample_repo, sys.executable, reopened, cache=store, drafted=drafts.append)
        from_previous = await refresh(sample_repo, sys.executable, live, previous=first)
        expected = await refresh(sample_repo, sys.executable, full)
    store.close()
    assert judged(from_cache) == judged(expected)
    assert judged(from_previous) == judged(expected)
    assert len(reopened.asked) < len(full.asked)
    assert len(live.asked) - asked_first < len(full.asked)
    assert listing(sample_repo) == before

    [draft] = drafts
    nodes = {n.id for n in draft.analysis.nodes}
    assert all(e.source in nodes and e.target in nodes for e in draft.analysis.edges)
    assert draft.texts == expected.texts and draft.answers == {}


def swap(repo: Path, path: str, old: str, new: str) -> None:
    file = repo / path
    text = file.read_text()
    assert old in text
    file.write_text(text.replace(old, new))


TABLES, LOOKUP = "src/app/tables.py", "src/app/lookup.py"


def change_value(repo: Path) -> None:
    swap(repo, TABLES, 'LIMITS = {"low": 1, "high": 9}', "LIMITS = dict(low=1, high=9)")


def make_value_external(repo: Path) -> None:
    swap(repo, TABLES, "SEEN = []", 'SEEN = re.findall("a", "b")')


def add_variable(repo: Path) -> None:
    swap(repo, TABLES, "def label(name):", 'EXTRA = {"k": Config("c")}\n\n\ndef extra():\n    return EXTRA\n\n\ndef label(name):')


def remove_variable(repo: Path) -> None:
    swap(repo, TABLES, 'LIMITS = {"low": 1, "high": 9}\n', "")


def rename_variable(repo: Path) -> None:
    swap(repo, TABLES, "total", "tally")


def add_reader(repo: Path) -> None:
    swap(repo, LOOKUP, "def reset():", "def unread():\n    return tables.UNREAD\n\n\ndef reset():")


def remove_reader(repo: Path) -> None:
    swap(repo, LOOKUP, 'def lowest():\n    return LIMITS["low"]\n', "")


def start_importing(repo: Path) -> None:
    shadow = repo / "src" / "app" / "shadow.py"
    shadow.write_text("from app.tables import BANNER\n\n\n" + shadow.read_text() + "\n\ndef banner():\n    return BANNER\n")


def stop_importing(repo: Path) -> None:
    swap(repo, LOOKUP, "from app.tables import LIMITS\n", "LIMITS = {}\n")


def add_global_writer(repo: Path) -> None:
    swap(repo, TABLES, "def label(name):", "def raise_base():\n    global BASE\n    BASE += 1\n\n\ndef label(name):")


def delete_variable_file(repo: Path) -> None:
    (repo / TABLES).unlink()


VARIABLE_EDITS = {
    "변수의 값": change_value,
    "값을 만든 호출이 외부": make_value_external,
    "변수 추가": add_variable,
    "변수 삭제": remove_variable,
    "변수 이름": rename_variable,
    "읽는 함수 추가": add_reader,
    "읽는 함수 삭제": remove_reader,
    "다른 파일이 from import로 읽기 시작": start_importing,
    "다른 파일이 from import로 읽기를 그만둠": stop_importing,
    "global로 바꾸는 함수 추가": add_global_writer,
    "변수를 둔 파일 삭제": delete_variable_file,
}


def variables(analyzed) -> tuple[list, list]:
    """변수 노드와, 변수 노드에서 나가거나 변수 노드로 들어가는 선."""
    found = judged(analyzed)
    nodes = [n for n in found["nodes"] if n["kind"] == "variable"]
    ids = {n["id"] for n in nodes}
    return nodes, [e for e in found["edges"] if e["source"] in ids or e["target"] in ids]


@pytest.mark.parametrize("edit", VARIABLE_EDITS.values(), ids=VARIABLE_EDITS.keys())
@pytest.mark.asyncio
async def test_variable_nodes_and_edges_equal_a_full_analysis(sample_repo, tmp_path, edit):
    store = Cache(sample_repo, tmp_path / "cache")
    async with started() as live, started() as reopened, started() as full:
        first = await refresh(sample_repo, sys.executable, live, cache=store)
        asked_first = len(live.asked)
        edit(sample_repo)
        from_cache = await refresh(sample_repo, sys.executable, reopened, cache=store)
        from_previous = await refresh(sample_repo, sys.executable, live, previous=first)
        expected = await refresh(sample_repo, sys.executable, full)
    store.close()
    assert variables(expected) != variables(first)
    assert judged(from_cache) == judged(expected)
    assert judged(from_previous) == judged(expected)
    assert len(reopened.asked) < len(full.asked)
    assert len(live.asked) - asked_first < len(full.asked)


@pytest.mark.asyncio
async def test_script_naming_a_variable_marks_its_module_as_the_entry(sample_repo, tmp_path):
    store = Cache(sample_repo, tmp_path / "cache")
    async with started() as live, started() as reopened, started() as full:
        first = await refresh(sample_repo, sys.executable, live, cache=store)
        swap(sample_repo, "pyproject.toml", "app.cli:main", "app.tables:LIMITS")
        from_cache = await refresh(sample_repo, sys.executable, reopened, cache=store)
        from_previous = await refresh(sample_repo, sys.executable, live, previous=first)
        expected = await refresh(sample_repo, sys.executable, full)
    store.close()
    assert {n.id for n in first.analysis.nodes if n.entry} == {"app.cli", "app.cli:main"}
    assert {n.id: n.kind for n in expected.analysis.nodes if n.entry} == {"app.cli": "module", "app.tables": "module"}
    assert "app.tables:LIMITS" in {n.id for n in expected.analysis.nodes if n.kind == "variable"}
    assert judged(from_cache) == judged(expected)
    assert judged(from_previous) == judged(expected)
    assert reopened.asked == []


@pytest.mark.asyncio
async def test_variable_added_elsewhere_extracts_the_files_that_name_it_again(sample_repo):
    session = FakeSession()
    first = await refresh(sample_repo, sys.executable, session)
    # `config`를 모듈 변수로 둔다. cli.py의 main이 같은 이름의 지역 변수를 쓰고 core.py의 run_engine이 매개변수로 받는다.
    (sample_repo / "src" / "app" / "late.py").write_text("config = {}\nspare = 1\n")
    again = await refresh(sample_repo, sys.executable, session, previous=first)
    fresh = {path for path in first.stored if again.stored[path] is not first.stored[path]}
    assert fresh == {"src/app/cli.py", "src/app/core.py"}
    assert again.stored["src/app/late.py"].variables == ["config", "spare"]
    read = [(s.path, s.text) for s in again.analysis.sites if s.kind == "read" and s.text in ("config", "spare")]
    assert read == []  # 두 파일의 `config`는 지역 이름이고 `spare`는 함수 정의의 이름으로만 적혀 있다


ENCODE = "\n    def encode(self, o):\n        return ''\n"


def override_external_method(repo: Path) -> None:
    swap(repo, "pkg/base.py", '        return "x"\n', '        return "x"\n' + ENCODE)


def reexport_from_another_file(repo: Path) -> None:
    swap(repo, "pkg/__init__.py", "from .base import Thing", "from .alt import Thing")


def override_in_subclass(repo: Path) -> None:
    swap(repo, "pkg/mid.py", "class Mid(Thing):\n    pass\n", "class Mid(Thing):" + ENCODE)


def swap_parent(repo: Path) -> None:
    swap(repo, "pkg/mid.py", "from pkg.base import Thing", "from pkg.alt import Thing")


def switch_branch(repo: Path) -> None:
    reexport_from_another_file(repo)
    swap(repo, "pkg/mid.py", "class Mid(Thing):\n    pass\n", "class Mid(Thing):\n    def name(self):\n        return 'mid'\n")
    swap(repo, "pkg/far.py", "m.encode({})", "m.encode({})\n    m.name()")


def reexport_repo_class_under_external_name(repo: Path) -> None:
    swap(repo, "pkg/__init__.py", "from json import JSONDecoder as Reader", "from .alt import Thing as Reader")


def reexport_another_external_class(repo: Path) -> None:
    swap(repo, "pkg/__init__.py", "from json import JSONDecoder as Reader", "from string import Formatter as Reader")


def shadow_external_module(repo: Path) -> None:
    (repo / "json.py").write_text("VERSION = 1\n")


EXTERNAL_EDITS = {
    "외부 부모의 메서드를 덮는 메서드": override_external_method,
    "재내보내기": reexport_from_another_file,
    "자식 클래스의 메서드": override_in_subclass,
    "부모 교체": swap_parent,
    "여러 변경": switch_branch,
    "외부 클래스를 재내보내던 이름에 레포 클래스": reexport_repo_class_under_external_name,
    "재내보내는 외부 클래스 교체": reexport_another_external_class,
    "외부 모듈과 이름이 같은 파일": shadow_external_module,
}


@pytest.mark.parametrize("edit", EXTERNAL_EDITS.values(), ids=EXTERNAL_EDITS.keys())
@pytest.mark.asyncio
async def test_external_verdicts_follow_the_repo_definitions(external_repo, tmp_path, edit):
    store = Cache(external_repo, tmp_path / "cache")
    async with started() as live, started() as reopened, started() as full:
        first = await refresh(external_repo, sys.executable, live, cache=store)
        asked_first = len(live.asked)
        edit(external_repo)
        from_cache = await refresh(external_repo, sys.executable, reopened, cache=store)
        from_previous = await refresh(external_repo, sys.executable, live, previous=first)
        expected = await refresh(external_repo, sys.executable, full)
    store.close()
    assert judged(expected)["edges"] != judged(first)["edges"]
    assert judged(from_cache) == judged(expected)
    assert judged(from_previous) == judged(expected)
    assert len(reopened.asked) < len(full.asked)
    assert len(live.asked) - asked_first < len(full.asked)


def change_return_type(repo: Path) -> None:
    swap(repo, "pkg/base.py", "def make():\n    return {}", "def make():\n    return Thing()")


def delete_reexporting_file(repo: Path) -> None:
    (repo / "pkg" / "__init__.py").unlink()


# 선을 만들지 않는 지점의 판정만 남는 편집과, 그 지점의 (식, 증분 분석의 상태, 전체 분석의 상태)
KEPT_VERDICTS = {
    "반환 타입": (change_return_type, [("make().get('a')", "builtin", "unresolved")]),
    "재내보내던 파일 삭제": (
        delete_reexporting_file,
        [("Parser()", "external", "unresolved"), ("t.encode({})", "external", "unresolved")],
    ),
}


@pytest.mark.parametrize(("edit", "kept"), KEPT_VERDICTS.values(), ids=KEPT_VERDICTS.keys())
@pytest.mark.asyncio
async def test_edits_that_only_move_types_keep_the_edges_and_some_external_verdicts(external_repo, edit, kept):
    async with started() as live, started() as full:
        first = await refresh(external_repo, sys.executable, live)
        edit(external_repo)
        again = await refresh(external_repo, sys.executable, live, previous=first)
        expected = await refresh(external_repo, sys.executable, full)
    assert judged(again)["edges"] == judged(expected)["edges"]
    assert {n.id for n in again.analysis.nodes} == {n.id for n in expected.analysis.nodes}
    differ = [(a.text, a.status, b.status) for a, b in zip(again.analysis.sites, expected.analysis.sites) if a != b]
    assert sorted(differ) == sorted(kept)


@pytest.mark.asyncio
async def test_draft_leaves_the_sites_of_a_changed_file_unresolved(sample_repo, tmp_path):
    store = Cache(sample_repo, tmp_path / "cache")
    drafts = []
    async with started() as first, started() as second:
        await refresh(sample_repo, sys.executable, first, cache=store)
        at_top(sample_repo)
        done = await refresh(sample_repo, sys.executable, second, cache=store, drafted=drafts.append)
    store.close()
    [draft] = drafts
    core = [s for s in draft.analysis.sites if s.path == "src/app/core.py"]
    assert {s.status for s in core} <= {"unresolved", "builtin", "dynamic"}
    assert any(s.status == "resolved" for s in done.analysis.sites if s.path == "src/app/core.py")
    kept = [s for s in draft.analysis.sites if s.path == "src/app/models.py"]
    assert kept == [s for s in done.analysis.sites if s.path == "src/app/models.py"]


@pytest.mark.asyncio
async def test_reopening_from_the_cache_asks_nothing_and_starts_no_session(sample_repo, tmp_path):
    store = Cache(sample_repo, tmp_path / "cache")
    async with started() as first:
        fresh = await refresh(sample_repo, sys.executable, first, cache=store)

    async def never(files, env):
        pytest.fail("세션을 띄웠다")

    phases: list[Progress] = []
    drafts = []
    again = await refresh(sample_repo, sys.executable, never, cache=store, report=phases.append, drafted=drafts.append)
    store.close()
    assert judged(again) == judged(fresh)
    assert again.answers == fresh.answers and again.env == fresh.env
    assert [p.phase for p in phases if p.phase != "extract"] == ["collect", "build"] and drafts == []


@pytest.mark.asyncio
async def test_commit_snapshot_is_saved_even_when_nothing_changed(sample_repo, tmp_path):
    store = Cache(sample_repo, tmp_path / "cache")
    session = FakeSession()
    first = await refresh(sample_repo, sys.executable, session, cache=store)
    assert store.snapshots(first.env) == {"worktree"}
    asked = len(session.asked)

    again = await refresh(sample_repo, sys.executable, session, previous=first, cache=store)
    assert store.snapshots(first.env) == {"worktree"}  # 작업 중인 상태는 달라진 파일이 없으면 저장하지 않는다

    commit = "0123abc"
    past = await refresh(sample_repo, sys.executable, session, previous=again, cache=store, snapshot=commit)
    assert store.snapshots(first.env) == {"worktree", commit} and len(session.asked) == asked
    assert store.answers(commit, first.env) == past.answers == first.answers
    saved = store.path.stat().st_mtime_ns, rows_of(store)

    async def never(files, env):
        pytest.fail("세션을 띄웠다")

    reopened = await refresh(sample_repo, sys.executable, never, cache=store, snapshot=commit)
    assert judged(reopened) == judged(first)
    assert rows_of(store) == saved[1]  # 캐시에 있는 시점은 다시 저장하지 않는다
    store.close()


def rows_of(store: Cache) -> list[tuple]:
    with closing(sqlite3.connect(store.path)) as db:
        return db.execute("SELECT name, env, saved FROM snapshots ORDER BY name").fetchall()


@pytest.mark.asyncio
async def test_reloading_an_untouched_repo_asks_nothing(sample_repo):
    session = FakeSession()
    first = await refresh(sample_repo, sys.executable, session)
    asked = len(session.asked)
    again = await refresh(sample_repo, sys.executable, session, previous=first)
    assert asked > 0 and len(session.asked) == asked and len(session.synced) == 1
    assert judged(again) == judged(first)
    assert all(again.stored[path] is first.stored[path] for path in first.stored)


@pytest.mark.asyncio
async def test_progress_counts_the_requests(sample_repo):
    session = FakeSession()
    phases: list[Progress] = []
    await refresh(sample_repo, sys.executable, session, report=phases.append)
    names = [p.phase for p in phases]
    assert sorted(set(names), key=names.index) == ["collect", "extract", "resolve", "build"]
    resolve = [p for p in phases if p.phase == "resolve"]
    assert resolve[0].done == 0 and resolve[-1].done == resolve[-1].total == len(session.asked)
    extract = [p for p in phases if p.phase == "extract"]
    assert extract[-1].done == extract[-1].total == 13


@pytest.mark.asyncio
async def test_changed_environment_asks_every_site_again(sample_repo, tmp_path, monkeypatch):
    store = Cache(sample_repo, tmp_path / "cache")
    first, second, third = FakeSession(), FakeSession(), FakeSession()
    fresh = await refresh(sample_repo, sys.executable, first, cache=store)
    monkeypatch.setattr(analyze, "environment", lambda python, files: "다른 환경")
    again = await refresh(sample_repo, sys.executable, second, cache=store)
    assert second.asked == first.asked and again.env == "다른 환경"
    reloaded = await refresh(sample_repo, sys.executable, third, previous=fresh)
    assert third.asked == first.asked and judged(reloaded) == judged(fresh)
    store.close()


@pytest.mark.asyncio
async def test_unanswered_sites_stay_counted_until_their_file_is_asked_again(sample_repo, tmp_path):
    class Silent(FakeSession):
        async def definition(self, path, line, col, timeout):
            await super().definition(path, line, col, timeout)
            if path == "src/app/cli.py":
                raise asyncio.TimeoutError
            return []

    async def never(files, env):
        pytest.fail("세션을 띄웠다")

    store = Cache(sample_repo, tmp_path / "cache")
    silent, answering = Silent(), FakeSession()
    first = await refresh(sample_repo, sys.executable, silent, cache=store)
    unanswered = first.analysis.stats["timed_out"]
    assert unanswered == len({key for key in silent.asked if key[0] == "src/app/cli.py"}) > 0
    reopened = await refresh(sample_repo, sys.executable, never, cache=store)
    assert reopened.analysis.stats["timed_out"] == unanswered
    cli = sample_repo / "src" / "app" / "cli.py"
    cli.write_text("# 한 줄 민다\n" + cli.read_text())
    again = await refresh(sample_repo, sys.executable, answering, cache=store)
    store.close()
    assert again.analysis.stats["timed_out"] == 0 and len(answering.asked) >= unanswered


@pytest.mark.asyncio
async def test_rebuild_reads_nothing_from_the_cache_and_overwrites_it(sample_repo, tmp_path, monkeypatch):
    store = Cache(sample_repo, tmp_path / "cache")
    first, second = FakeSession(), FakeSession()
    await refresh(sample_repo, sys.executable, first, cache=store)
    saved = []
    monkeypatch.setattr(store, "facts", lambda *args: pytest.fail("추출 결과를 읽었다"))
    monkeypatch.setattr(store, "answers", lambda *args: pytest.fail("판정을 읽었다"))
    save = store.save
    monkeypatch.setattr(store, "save", lambda *args: (saved.append(args), save(*args)))
    await refresh(sample_repo, sys.executable, second, cache=store, rebuild=True)
    assert second.asked == first.asked
    [(snapshot, _, facts, answers)] = saved
    assert snapshot == "worktree" and len(facts) == len(answers) == 13
    store.close()


@pytest.mark.asyncio
async def test_definition_added_elsewhere_extracts_the_files_that_name_it_again(sample_repo):
    session = FakeSession()
    first = await refresh(sample_repo, sys.executable, session)
    add_file(sample_repo)  # `config`를 정의한다. cli.py가 그 이름의 변수를 인자로 넘긴다
    again = await refresh(sample_repo, sys.executable, session, previous=first)
    fresh = {path for path in first.stored if again.stored[path] is not first.stored[path]}
    assert "src/app/cli.py" in fresh and "src/app/models.py" not in fresh
    passed = [s.text for s in again.analysis.sites if s.path == "src/app/cli.py" and s.kind == "pass"]
    assert "config" in passed
    assert "config" not in [s.text for s in first.analysis.sites if s.path == "src/app/cli.py" and s.kind == "pass"]


@pytest.mark.asyncio
async def test_unreadable_cache_rows_are_analyzed_again(sample_repo, tmp_path):
    store = Cache(sample_repo, tmp_path / "cache")
    first, second = FakeSession(), FakeSession()
    fresh = await refresh(sample_repo, sys.executable, first, cache=store)
    with store._db as db:
        db.execute("UPDATE facts SET body = x'00' WHERE path = 'src/app/core.py'")
        db.execute("UPDATE answers SET body = x'00' WHERE path = 'src/app/cli.py'")
    again = await refresh(sample_repo, sys.executable, second, cache=store)
    store.close()
    assert judged(again) == judged(fresh)
    assert second.asked == first.asked  # 판정을 한 행이라도 읽지 못하면 그 시점의 판정을 쓰지 않는다


def test_broken_cache_file_and_unusable_cache_folder_still_analyze(sample_repo, tmp_path, monkeypatch):
    folder = tmp_path / "cache"
    monkeypatch.setattr(cache, "CACHE_DIR", folder)
    store = Cache(sample_repo)
    store.close()
    store.path.write_bytes(b"SQLite format 3\0" + b"\xff" * 200)
    first = analyze.analyze(sample_repo, sys.executable)
    assert first.analysis.stats["files"] == 13

    blocked = tmp_path / "blocked"
    blocked.write_text("폴더가 아니다")
    monkeypatch.setattr(cache, "CACHE_DIR", blocked)
    assert open_cache(sample_repo) is None
    again = analyze.analyze(sample_repo, sys.executable)
    assert judged(again) == judged(first)


@pytest.mark.asyncio
async def test_stale_lists_changed_new_and_removed_files(sample_repo):
    analyzed = await refresh(sample_repo, sys.executable, FakeSession())
    assert analyzed.stale() == set()
    at_top(sample_repo)
    add_file(sample_repo)
    delete_file(sample_repo)
    (sample_repo / "ignored_dir" / "more.py").write_text("x = 1\n")
    assert analyzed.stale() == {"src/app/core.py", "src/app/late.py", "src/app/plugins/base.py"}


def test_sync_files_opens_changes_and_closes(tmp_path):
    session = Session(tmp_path, sys.executable, [])
    sent: list[tuple[str, object]] = []

    class Client:
        def __getattr__(self, name):
            return lambda params: sent.append((name, params))

    session.client = Client()
    session.sync_files({"a.py": "x = 1\n", "b.py": "y = 1\n"})
    assert [name for name, _ in sent] == ["text_document_did_open"] * 2
    sent.clear()

    session.sync_files({"a.py": "x = 2\n", "c.py": "z = 1\n"})
    names = [name for name, _ in sent]
    assert names == [
        "text_document_did_close",
        "text_document_did_change",
        "text_document_did_open",
        "workspace_did_change_watched_files",
    ]
    closed, changed, opened, watched = (params for _, params in sent)
    assert closed.text_document.uri.endswith("/b.py") and opened.text_document.uri.endswith("/c.py")
    assert (changed.text_document.version, changed.content_changes[0].text) == (2, "x = 2\n")
    assert sorted((e.uri.rsplit("/", 1)[1], e.type.name) for e in watched.changes) == [("b.py", "Deleted"), ("c.py", "Created")]
    assert session._line(str(session.root / "a.py"), 1) == "x = 2"
    sent.clear()

    session.sync_files({"a.py": "x = 2\n", "c.py": "z = 1\n"})
    assert sent == []


@pytest.mark.parametrize("command", ["analyze", "serve"])
def test_no_cache_option_reaches_the_analysis(sample_repo, monkeypatch, command):
    seen = {}
    monkeypatch.setattr(cli, "analyze", lambda repo, python, **options: seen.update(options) or sys.exit(0))
    monkeypatch.setattr(cli, "create_app", lambda *args, **options: seen.update(options) or sys.exit(0))
    argv = ["analyze", str(sample_repo)] if command == "analyze" else [str(sample_repo), "--no-open", "--port", "0"]
    with pytest.raises(SystemExit):
        cli.main([*argv, "--python", sys.executable, "--no-cache"])
    assert seen["cache"] is False
