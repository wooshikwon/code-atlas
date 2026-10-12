import asyncio
import subprocess
import sys
from pathlib import Path

import pytest
from history import build, run
from test_refresh import judged, started

from code_atlas import git, snapshot
from code_atlas.analyze import refresh
from code_atlas.cache import Cache
from code_atlas.model import to_dict
from code_atlas.snapshot import Snapshots
from code_atlas.summary import prompt_of

LABELS = ("base", "edit", "feature", "move", "merge", "topic")


def folders(directory: Path) -> list[str]:
    return sorted(p.relative_to(directory).as_posix() for p in directory.rglob("*"))


def no_session(monkeypatch) -> None:
    def never(*args):
        pytest.fail("세션을 띄웠다")

    monkeypatch.setattr(snapshot, "Session", never)


async def worktree(repo: Path, store: Cache | None = None):
    async with started() as live:
        return await refresh(repo, sys.executable, live, cache=store)


async def full(repo: Path, commit: str, dest: Path):
    """그 커밋을 꺼낸 폴더를 캐시와 앞 결과 없이 통째로 분석한 결과."""
    git.export(repo, commit, dest)
    async with started() as live:
        return await refresh(dest, sys.executable, live)


@pytest.mark.parametrize("label", LABELS)
@pytest.mark.asyncio
async def test_incremental_and_cached_results_equal_a_full_analysis(history_repo, tmp_path, monkeypatch, label):
    repo, at = history_repo
    store = Cache(repo, tmp_path / "cache")
    current = await worktree(repo, store)
    expected = await full(repo, at[label], tmp_path / "full")

    snapshots = Snapshots(repo, sys.executable, store, tmp_path / "out")
    incremental = await snapshots.at(at[label], [current])
    assert judged(incremental) == judged(expected)
    assert incremental.texts == expected.texts
    assert at[label] in store.snapshots(incremental.env)
    assert folders(snapshots.directory) == []

    no_session(monkeypatch)
    reopened = Snapshots(repo, sys.executable, store, tmp_path / "out")
    cached = await reopened.at(at[label], [current])
    store.close()
    assert judged(cached) == judged(expected)
    assert cached.answers == incremental.answers
    assert folders(reopened.directory) == []


@pytest.mark.asyncio
async def test_cached_snapshot_survives_a_changed_worktree(history_repo, tmp_path, monkeypatch):
    repo, at = history_repo
    store = Cache(repo, tmp_path / "cache")
    current = await worktree(repo, store)
    first = await Snapshots(repo, sys.executable, store, tmp_path / "out").at(at["merge"], [current])
    (repo / "src/shop/report.py").write_text("def render(value):\n    return str(value)\n")
    (repo / "src/shop/coupons.py").unlink()
    changed = await worktree(repo, store)
    no_session(monkeypatch)
    again = await Snapshots(repo, sys.executable, store, tmp_path / "out").at(at["merge"], [changed])
    store.close()
    assert judged(again) == judged(first)


def recorded_refresh(monkeypatch) -> list:
    """`Snapshots`가 `refresh`에 넘긴 `previous`를 차례로 담는 목록."""
    used: list = []
    real = snapshot.refresh

    async def recorded(*args, previous=None, **options):
        used.append(previous)
        return await real(*args, previous=previous, **options)

    monkeypatch.setattr(snapshot, "refresh", recorded)
    return used


@pytest.mark.asyncio
async def test_snapshot_without_a_cache_or_a_usable_result_is_analyzed_whole(history_repo, tmp_path, monkeypatch):
    repo, at = history_repo
    expected = await full(repo, at["edit"], tmp_path / "full")
    used = recorded_refresh(monkeypatch)
    other = await worktree(tmp_path / "full")  # 이 레포의 작업 중인 상태도, `at`이 낸 결과도 아니다
    found = await Snapshots(repo, sys.executable, None, tmp_path / "out").at(at["edit"], [other])
    assert judged(found) == judged(expected) and used == [None]


@pytest.mark.asyncio
async def test_nearest_result_is_the_base_of_the_increment(history_repo, tmp_path, monkeypatch):
    repo, at = history_repo
    current = await worktree(repo)
    snapshots = Snapshots(repo, sys.executable, None, tmp_path / "out")
    base = await snapshots.at(at["base"], [current])
    used = recorded_refresh(monkeypatch)
    draft = await worktree(repo)
    draft.answers = {}
    await snapshots.at(at["edit"], [draft, current, base])  # base와는 파일 2개, 작업 중인 상태와는 6개가 다르다
    await snapshots.at(at["merge"], [draft, base, current])
    assert used == [base, current]


@pytest.mark.asyncio
async def test_same_commit_is_analyzed_once_and_two_commits_are_held(history_repo, tmp_path, monkeypatch):
    repo, at = history_repo
    current = await worktree(repo)
    exported: list[str] = []
    real = git.export

    def counted(root, commit, dest):
        exported.append(commit)
        real(root, commit, dest)

    monkeypatch.setattr(snapshot.git, "export", counted)
    snapshots = Snapshots(repo, sys.executable, None, tmp_path / "out")
    first, second = await asyncio.gather(snapshots.at(at["edit"], [current]), snapshots.at(at["edit"], [current]))
    assert first is second and exported == [at["edit"]]
    assert await snapshots.at(at["edit"], [current]) is first and snapshots.held(at["edit"]) is first
    await snapshots.at(at["move"], [current])
    assert await snapshots.at(at["edit"], [current]) is first
    await snapshots.at(at["base"], [current])
    assert snapshots.held(at["move"]) is None and snapshots.held(at["edit"]) is first
    assert exported == [at["edit"], at["move"], at["base"]]
    assert folders(snapshots.directory) == []


@pytest.mark.asyncio
async def test_failed_and_cancelled_analysis_leave_no_folder(history_repo, tmp_path, monkeypatch):
    repo, at = history_repo
    current = await worktree(repo)
    snapshots = Snapshots(repo, sys.executable, None, tmp_path / "out")
    with pytest.raises(OSError):
        await snapshots.at("0" * 40, [current])
    assert not snapshots.directory.exists() or folders(snapshots.directory) == []

    entered = asyncio.Event()

    async def failing(dest, *args, **options):
        assert (Path(dest) / "pyproject.toml").is_file()
        raise RuntimeError("분석하지 못했다")

    async def waiting(dest, *args, **options):
        entered.set()
        await asyncio.sleep(60)

    monkeypatch.setattr(snapshot, "refresh", failing)
    with pytest.raises(RuntimeError):
        await snapshots.at(at["edit"], [current])
    assert folders(snapshots.directory) == [] and snapshots.held(at["edit"]) is None

    monkeypatch.setattr(snapshot, "refresh", waiting)
    first = asyncio.ensure_future(snapshots.at(at["edit"], [current]))
    second = asyncio.ensure_future(snapshots.at(at["edit"], [current]))
    await entered.wait()
    assert folders(snapshots.directory) != []
    first.cancel()
    await asyncio.gather(first, return_exceptions=True)
    assert not second.done() and folders(snapshots.directory) != []  # 기다리는 요청이 남아 있으면 멈추지 않는다
    second.cancel()
    await asyncio.gather(second, return_exceptions=True)
    assert folders(snapshots.directory) == []


@pytest.mark.asyncio
async def test_leftover_folders_are_removed_on_start_and_close(history_repo, tmp_path):
    repo, at = history_repo
    first = Snapshots(repo, sys.executable, None, tmp_path / "out")
    left = first.directory / at["edit"] / "src"
    left.mkdir(parents=True)
    other = tmp_path / "out" / "snapshots" / "0123456789abcdef" / at["edit"]
    other.mkdir(parents=True)
    second = Snapshots(repo, sys.executable, None, tmp_path / "out")
    assert second.directory == first.directory and not left.exists() and other.is_dir()
    left.mkdir(parents=True)
    second.close()
    assert not second.directory.exists() and other.is_dir()


@pytest.mark.asyncio
async def test_default_folder_is_under_the_analysis_cache(history_repo):
    from code_atlas import cache

    repo, _ = history_repo
    assert Snapshots(repo, sys.executable, None).directory.parent == cache.CACHE_DIR / "snapshots"


@pytest.mark.asyncio
async def test_analysis_leaves_the_repo_as_it_was(history_repo, tmp_path):
    from test_git import git_files

    repo, at = history_repo
    store = Cache(repo, tmp_path / "cache")
    current = await worktree(repo, store)
    porcelain, refs, before = run(repo, "status", "--porcelain"), run(repo, "for-each-ref"), git_files(repo)
    listing = sorted((str(p), p.stat().st_mtime_ns) for p in repo.rglob("*") if ".git" not in p.parts)
    snapshots = Snapshots(repo, sys.executable, store, tmp_path / "out")
    await snapshots.at(at["base"], [current])
    await snapshots.at(at["topic"], [current])
    snapshots.close()
    store.close()
    assert git_files(repo) == before
    assert (run(repo, "status", "--porcelain"), run(repo, "for-each-ref")) == (porcelain, refs)
    assert sorted((str(p), p.stat().st_mtime_ns) for p in repo.rglob("*") if ".git" not in p.parts) == listing


@pytest.mark.asyncio
async def test_summary_prompts_of_a_snapshot_equal_those_of_the_same_code_in_the_worktree(history_repo, tmp_path):
    repo, at = history_repo
    current = await worktree(repo)
    past = await Snapshots(repo, sys.executable, None, tmp_path / "out").at(at["edit"], [current])
    clean = tmp_path / "clean"
    build(clean)
    run(clean, "checkout", "-q", "-f", at["edit"])
    run(clean, "clean", "-q", "-fd")
    same = await worktree(clean)
    assert past.texts == same.texts

    def prompts(analyzed) -> dict:
        nodes = {n.id: n for n in analyzed.analysis.nodes}
        return {id: prompt_of(nodes, analyzed.analysis.edges, analyzed.texts, id) for id in nodes}

    assert prompts(past) == prompts(same)
    assert sum(prompt is not None for prompt in prompts(past).values()) > 10
    assert to_dict(past.analysis)["nodes"] == to_dict(same.analysis)["nodes"]


@pytest.mark.asyncio
async def test_location_in_the_original_repo_is_left_unresolved(tmp_path):
    """가상환경이 원본 레포의 소스 폴더를 `.pth`로 걸어 두면 꺼낸 폴더에 없는 모듈을 언어 서버가 원본에서 찾는다."""
    repo = tmp_path / "lib" / "python3.12" / "history_repo"  # 표준 라이브러리의 경로 꼴이라 규칙이 없으면 외부 노드가 된다
    build(repo)
    (repo / "src" / "extras.py").write_text("def helper():\n    return 1\n")
    (repo / "src" / "shop" / "uses.py").write_text("import extras\n\n\ndef go():\n    return extras.helper()\n")
    run(repo, "add", "src/shop/uses.py")
    run(repo, "commit", "-q", "-m", "원본에만 있는 모듈을 쓴다")
    env = tmp_path / "env"
    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(env)], check=True)
    [packages] = (env / "lib").glob("python3.*/site-packages")
    (packages / "__editable__.shop.pth").write_text(f"{repo / 'src'}\n")
    python = str(env / "bin" / "python")

    async with started() as live:
        current = await refresh(repo, python, live)
    here = [s for s in current.analysis.sites if s.path == "src/shop/uses.py" and s.kind == "import"]
    assert [(s.status, s.target) for s in here] == [("resolved", "extras")]

    found = await Snapshots(repo, python, None, tmp_path / "out").at(git.head(repo), [])
    there = [s for s in found.analysis.sites if s.path == "src/shop/uses.py"]
    assert there and all(s.status == "unresolved" for s in there if s.kind in ("import", "call"))
    assert not any(n.kind == "external" for n in found.analysis.nodes)
    assert "extras" not in {n.id for n in found.analysis.nodes}
