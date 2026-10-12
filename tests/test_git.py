import shutil
import subprocess

import pytest
from conftest import FIXTURE, git
from history import run

from code_atlas import git as reader
from code_atlas.git import (
    WORKTREE,
    Changed,
    Commit,
    Hunk,
    branch,
    changed,
    commits,
    default_branch,
    export,
    head,
    hunks,
    is_ancestor,
    merge_base,
    show,
    status,
)

CORE = "src/app/core.py"
PRICING = "src/shop/pricing.py"
ORDERS = "src/shop/orders.py"


def edit(repo, path, old, new):
    file = repo / path
    text = file.read_text()
    assert old in text
    file.write_text(text.replace(old, new))


def git_files(repo) -> list[tuple[str, int, int]]:
    """`.git` 아래 파일의 경로, 크기, 수정 시각."""
    top = repo / ".git"
    return sorted((str(p.relative_to(top)), p.stat().st_size, p.stat().st_mtime_ns) for p in top.rglob("*"))


def numstat(repo, *ends: str) -> dict[str, tuple[int, int]]:
    out = run(repo, "-c", "core.quotepath=false", "diff", "--numstat", "-M", "-z", *ends, "--", "*.py")
    fields = out.split("\0")
    found: dict[str, tuple[int, int]] = {}
    i = 0
    while i < len(fields) and fields[i]:
        added, deleted, path = fields[i].split("\t")
        if path:
            i += 1
        else:  # 이름이 바뀐 파일은 옛 경로와 새 경로가 따로 온다
            path = fields[i + 2]
            i += 3
        found[path] = (int(added), int(deleted))
    return found


def test_status_of_modified_staged_untracked_and_deleted(git_repo):
    edit(git_repo, CORE, "    return value\n", "    return value or None\n")
    (git_repo / "src/app/staged.py").write_text("x = 1\n")
    git(git_repo, "add", "src/app/staged.py")
    (git_repo / "src/app/새 파일.py").write_text("x = 1\n")
    (git_repo / "src/app/models.py").unlink()
    git(git_repo, "rm", "-q", "src/app/cli.py")
    assert status(git_repo) == {
        CORE: "modified",
        "src/app/staged.py": "added",
        "src/app/새 파일.py": "added",
        "src/app/models.py": "deleted",
        "src/app/cli.py": "deleted",
    }


def test_status_of_rename_is_added_and_deleted(git_repo):
    git(git_repo, "mv", CORE, "src/app/engine.py")
    assert status(git_repo) == {CORE: "deleted", "src/app/engine.py": "added"}


def test_status_of_staged_change_and_index_only_removal(git_repo):
    edit(git_repo, CORE, "counter = 0\n", "counter = 1\n")
    git(git_repo, "add", CORE)
    git(git_repo, "rm", "-q", "--cached", "src/app/cli.py")
    (git_repo / "src/app/gone.py").write_text("x = 1\n")
    git(git_repo, "add", "src/app/gone.py")
    (git_repo / "src/app/gone.py").unlink()
    assert status(git_repo) == {CORE: "modified", "src/app/cli.py": "modified"}


def test_clean_repo_has_no_changes(git_repo):
    assert status(git_repo) == {}
    assert changed(git_repo, head(git_repo), WORKTREE) == []
    assert hunks(git_repo, head(git_repo), WORKTREE) == {}
    assert branch(git_repo) == "main"


def test_hunks_give_changed_added_and_removed_lines(git_repo):
    edit(git_repo, CORE, "    return value\n", "    return value or None\n")
    edit(git_repo, CORE, "        self.calls += 1\n", "")
    edit(git_repo, CORE, "    return engine\n", "    print(handlers)\n    print(config)\n    return engine\n")
    (git_repo / "README.md").write_text("설명\n")
    (git_repo / "src/app/new.py").write_text("x = 1\ny = 2")
    assert hunks(git_repo, head(git_repo), WORKTREE) == {
        CORE: [Hunk(11, 1, 11, 1), Hunk(20, 1, 19, 0), Hunk(34, 0, 34, 2)],
        "src/app/new.py": [Hunk(0, 0, 1, 2)],
    }


def test_hunks_of_deleted_files_use_the_old_path_and_include_staged_changes(git_repo):
    models = (git_repo / "src/app/models.py").read_text()
    (git_repo / "src/app/models.py").unlink()
    edit(git_repo, "src/app/cli.py", "    Loud().run()\n", "    Loud().run()\n    Loud().run()\n")
    git(git_repo, "add", "src/app/cli.py")
    assert hunks(git_repo, head(git_repo), WORKTREE) == {
        "src/app/cli.py": [Hunk(12, 0, 13, 1)],
        "src/app/models.py": [Hunk(1, models.count("\n"), 0, 0)],
    }


def test_changed_and_hunks_leave_out_files_the_analysis_skips(git_repo):
    (git_repo / ".tools").mkdir()
    (git_repo / ".tools" / "hidden.py").write_text("x = 1\n")
    (git_repo / "ignored_dir").mkdir()
    (git_repo / "ignored_dir" / "skip.py").write_text("x = 1\n")
    (git_repo / "src/app/kept.py").write_text("x = 1\n")
    git(git_repo, "add", "-A", "-f")
    git(git_repo, "commit", "-q", "-m", "더함")
    git(git_repo, "mv", "src/app/kept.py", ".tools/kept.py")
    git(git_repo, "mv", ".tools/hidden.py", "src/app/shown.py")
    first = run(git_repo, "rev-list", "--max-parents=0", "HEAD")
    assert changed(git_repo, first, head(git_repo)) == [Changed("added", "src/app/kept.py")]
    assert hunks(git_repo, first, head(git_repo)) == {"src/app/kept.py": [Hunk(0, 0, 1, 1)]}
    assert changed(git_repo, head(git_repo), WORKTREE) == [
        Changed("deleted", "src/app/kept.py"),
        Changed("added", "src/app/shown.py"),
    ]


def test_paths_are_relative_to_a_root_below_the_git_top(git_repo, tmp_path):
    first = head(git_repo)
    edit(git_repo, CORE, "    return value\n", "    return value or None\n")
    (git_repo / "tests/extra.py").write_text("x = 1\n")
    git(git_repo, "add", "-A")
    git(git_repo, "commit", "-q", "-m", "고침")
    (git_repo / "src/app/한글.py").write_text("x = 1\n")
    root = git_repo / "src"
    assert status(root) == {"app/한글.py": "added"}
    assert head(root) == head(git_repo)
    assert [c.hash for c in commits(root, 0, 10)] == [head(git_repo), first]
    assert changed(root, first, head(root)) == [Changed("modified", "app/core.py")]
    assert hunks(root, first, head(root)) == {"app/core.py": [Hunk(11, 1, 11, 1)]}
    assert changed(root, first, WORKTREE) == [Changed("modified", "app/core.py"), Changed("added", "app/한글.py")]
    assert hunks(root, first, WORKTREE)["app/한글.py"] == [Hunk(0, 0, 1, 1)]
    assert "return value\n" in show(root, first, "app/core.py")
    assert show(root, first, "src/app/core.py") is None
    export(root, first, tmp_path / "out")
    assert (tmp_path / "out" / "app" / "core.py").is_file()
    assert not (tmp_path / "out" / "pyproject.toml").exists() and not (tmp_path / "out" / "src").exists()


def test_paths_with_korean_names_and_spaces(tmp_path):
    repo = tmp_path / "한글 레포"
    (repo / "꾸러미").mkdir(parents=True)
    run(repo, "init", "-q", "--template=", "-b", "main")
    (repo / "꾸러미" / "계산 하나.py").write_text("def 더하기(a, b):\n    return a + b\n", encoding="utf-8")
    run(repo, "add", "-A")
    run(repo, "commit", "-q", "-m", "처음: 한글 제목")
    first = head(repo)
    run(repo, "mv", "꾸러미/계산 하나.py", "꾸러미/계산 둘.py")
    (repo / "꾸러미" / "계산 둘.py").write_text("def 더하기(a, b):\n    return b + a\n", encoding="utf-8")
    run(repo, "add", "-A")
    run(repo, "commit", "-q", "-m", "이름을 바꾼다", time=1_750_003_600)
    assert [c.subject for c in commits(repo, 0, 10)] == ["이름을 바꾼다", "처음: 한글 제목"]
    assert changed(repo, first, head(repo)) == [Changed("renamed", "꾸러미/계산 둘.py", "꾸러미/계산 하나.py")]
    assert hunks(repo, first, head(repo)) == {"꾸러미/계산 둘.py": [Hunk(2, 1, 2, 1)]}
    assert show(repo, first, "꾸러미/계산 하나.py").endswith("return a + b\n")
    export(repo, first, tmp_path / "out")
    assert (tmp_path / "out" / "꾸러미" / "계산 하나.py").is_file()


def test_repo_without_commits_has_only_added_files(tmp_path):
    repo = tmp_path / "sample_repo"
    shutil.copytree(FIXTURE, repo)
    git(repo, "init", "-q", "-b", "trunk")
    git(repo, "add", "src/app/core.py")
    found = status(repo)
    assert found[CORE] == "added" and found["src/app/cli.py"] == "added"
    assert set(found.values()) == {"added"}
    assert head(repo) is None and default_branch(repo) is None
    assert commits(repo, 0, 10) == []
    assert branch(repo) == "trunk"


def test_detached_head_has_no_branch(git_repo):
    git(git_repo, "checkout", "-q", "--detach")
    assert branch(git_repo) is None
    assert status(git_repo) == {}
    assert [c.refs for c in commits(git_repo, 0, 10)] == [["main"]]


def test_outside_git_nothing_is_read(sample_repo, tmp_path):
    assert status(sample_repo) is None
    assert head(sample_repo) is None and branch(sample_repo) is None and default_branch(sample_repo) is None
    assert commits(sample_repo, 0, 10) == []
    assert changed(sample_repo, "HEAD", WORKTREE) == [] and hunks(sample_repo, "HEAD", WORKTREE) == {}
    assert show(sample_repo, "HEAD", CORE) is None
    assert not is_ancestor(sample_repo, "HEAD", "HEAD") and merge_base(sample_repo, "HEAD", "HEAD") is None
    with pytest.raises(OSError):
        export(sample_repo, "HEAD", tmp_path / "out")


def test_missing_git_is_none(git_repo, monkeypatch):
    monkeypatch.setenv("PATH", str(git_repo / "nowhere"))
    assert status(git_repo) is None
    assert head(git_repo) is None
    assert commits(git_repo, 0, 10) == []


def test_slow_git_is_none(git_repo, tmp_path, monkeypatch):
    fake = tmp_path / "bin" / "git"
    fake.parent.mkdir()
    fake.write_text("#!/bin/sh\nexec sleep 5\n")
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", str(fake.parent), prepend=":")
    monkeypatch.setattr(reader, "GIT_TIMEOUT", 0.2)
    assert status(git_repo) is None


def test_reading_does_not_write_the_index(git_repo):
    index = git_repo / ".git" / "index"
    core = git_repo / CORE
    core.write_text(core.read_text())  # 내용은 같고 수정 시각만 바뀐다
    before = (index.read_bytes(), index.stat().st_mtime_ns)
    assert status(git_repo) == {}
    assert hunks(git_repo, head(git_repo), WORKTREE) == {}
    assert changed(git_repo, head(git_repo), WORKTREE) == []
    assert (index.read_bytes(), index.stat().st_mtime_ns) == before
    assert not (git_repo / ".git" / "index.lock").exists()


def test_history_builds_the_same_hashes_every_time(module_history, tmp_path, monkeypatch):
    _, hashes = module_history
    monkeypatch.setenv("GIT_AUTHOR_NAME", "다른 사람")
    monkeypatch.setenv("GIT_COMMITTER_DATE", "2001-01-01T00:00:00")
    config = tmp_path / "gitconfig"
    config.write_text("[init]\n\tdefaultBranch = trunk\n[commit]\n\tgpgsign = true\n[core]\n\thooksPath = /nowhere\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(config))
    from history import build

    assert build(tmp_path / "again") == hashes
    assert branch(tmp_path / "again") == "main"


def test_head_branch_and_default_branch(module_history):
    repo, at = module_history
    assert head(repo) == at["merge"]
    assert branch(repo) == "main"
    assert default_branch(repo) == at["merge"]


def test_default_branch_follows_origin_head(history_repo):
    repo, at = history_repo
    run(repo, "update-ref", "refs/remotes/origin/topic", at["topic"])
    run(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic")
    assert default_branch(repo) == at["topic"]
    assert sorted(commits(repo, 0, 1)[0].refs) == ["origin/topic", "topic"]
    run(repo, "branch", "-q", "-m", "main", "trunk")
    run(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
    assert default_branch(repo) is None
    run(repo, "branch", "-q", "master", at["edit"])
    assert default_branch(repo) == at["edit"]


def test_commits_come_in_date_order_with_parents_and_refs(module_history):
    repo, at = module_history
    found = commits(repo, 0, 200)
    assert [c.hash for c in found] == [at[k] for k in ("topic", "merge", "move", "feature", "edit", "base")]
    assert found[1] == Commit(at["merge"], [at["move"], at["feature"]], 1_750_014_400, "쿠폰을 합친다", ["main"])
    assert [c.refs for c in found] == [["topic"], ["main"], [], ["feature"], ["v0.1"], []]
    assert [c.parents for c in found[2:]] == [[at["edit"]], [at["edit"]], [at["base"]], []]
    assert commits(repo, 2, 2) == found[2:4]
    assert commits(repo, 6, 200) == []


def test_commits_leave_out_the_stash(history_repo):
    repo, at = history_repo
    run(repo, "stash", "-q")
    assert [c.hash for c in commits(repo, 0, 200)] == [
        at[k] for k in ("topic", "merge", "move", "feature", "edit", "base")
    ]
    assert all("stash" not in ref for c in commits(repo, 0, 200) for ref in c.refs)


def test_ancestors_and_merge_base(module_history):
    repo, at = module_history
    assert is_ancestor(repo, at["edit"], at["merge"])
    assert is_ancestor(repo, at["merge"], at["merge"])
    assert not is_ancestor(repo, at["merge"], at["edit"])
    assert not is_ancestor(repo, at["topic"], at["merge"])
    assert merge_base(repo, at["topic"], at["merge"]) == at["move"]
    assert merge_base(repo, at["feature"], at["topic"]) == at["edit"]
    assert merge_base(repo, at["base"], "0" * 40) is None


def test_changed_files_between_two_commits(module_history):
    repo, at = module_history
    assert changed(repo, at["base"], at["edit"]) == [Changed("modified", ORDERS), Changed("modified", PRICING)]
    assert changed(repo, at["edit"], at["move"]) == [
        Changed("deleted", "src/shop/audit.py"),
        Changed("renamed", "src/shop/inventory.py", "src/shop/stock.py"),
        Changed("modified", ORDERS),
    ]
    assert changed(repo, at["move"], at["merge"]) == [Changed("added", "src/shop/coupons.py")]
    assert changed(repo, at["move"], at["topic"]) == [Changed("modified", "src/shop/report.py")]
    assert changed(repo, at["merge"], at["merge"]) == []


def test_changed_files_of_the_worktree_include_untracked_files(module_history):
    repo, at = module_history
    assert changed(repo, at["merge"], WORKTREE) == [Changed("added", "src/shop/notes.py"), Changed("modified", PRICING)]
    assert changed(repo, at["move"], WORKTREE) == [
        Changed("added", "src/shop/coupons.py"),
        Changed("added", "src/shop/notes.py"),
        Changed("modified", PRICING),
    ]
    assert hunks(repo, at["merge"], WORKTREE) == {
        "src/shop/notes.py": [Hunk(0, 0, 1, 5)],
        PRICING: [Hunk(5, 0, 6, 2)],
    }


def test_hunks_read_both_sides_of_every_hunk(module_history):
    repo, at = module_history
    assert hunks(repo, at["base"], at["edit"]) == {
        ORDERS: [Hunk(2, 1, 2, 1), Hunk(24, 1, 24, 1)],
        PRICING: [Hunk(0, 0, 1, 1), Hunk(12, 3, 13, 2), Hunk(17, 2, 17, 5)],
    }
    found = hunks(repo, at["edit"], at["move"])
    assert found["src/shop/audit.py"] == [Hunk(1, 8, 0, 0)]
    assert found["src/shop/inventory.py"] == [Hunk(16, 1, 16, 1)]  # 옛 본문 `stock.py`와 견준 토막
    assert "src/shop/stock.py" not in found


@pytest.mark.parametrize("ends", [("base", "edit"), ("edit", "move"), ("base", "merge"), ("base", "topic"), ("merge",)])
def test_hunk_lines_add_up_to_numstat(module_history, ends):
    repo, at = module_history
    base, target = at[ends[0]], at[ends[1]] if len(ends) > 1 else WORKTREE
    counted = {
        path: (sum(h.new_count for h in found), sum(h.old_count for h in found))
        for path, found in hunks(repo, base, target).items()
    }
    tracked = numstat(repo, *([base] if target == WORKTREE else [base, target]))
    untracked = {"src/shop/notes.py": (5, 0)} if target == WORKTREE else {}
    assert counted == {path: n for path, n in {**tracked, **untracked}.items() if n != (0, 0)}


def test_show_reads_a_file_of_a_commit(module_history):
    repo, at = module_history
    assert show(repo, at["base"], "src/shop/audit.py").startswith("from shop.report import fmt\n")
    assert show(repo, at["merge"], "src/shop/audit.py") is None
    assert show(repo, at["merge"], PRICING).startswith("# 금액 계산\n")
    assert "amount < 0" not in show(repo, at["merge"], PRICING)  # 디스크의 본문이 아니다
    assert show(repo, "0" * 40, PRICING) is None


def test_export_unpacks_the_files_of_a_commit(module_history, tmp_path):
    repo, at = module_history
    export(repo, at["edit"], tmp_path / "edit")
    assert sorted(p.relative_to(tmp_path / "edit").as_posix() for p in (tmp_path / "edit").rglob("*") if p.is_file()) == [
        ".gitignore",
        "pyproject.toml",
        "src/shop/__init__.py",
        "src/shop/audit.py",
        "src/shop/orders.py",
        "src/shop/pricing.py",
        "src/shop/report.py",
        "src/shop/stock.py",
    ]
    assert (tmp_path / "edit" / PRICING).read_text() == show(repo, at["edit"], PRICING)
    with pytest.raises(ValueError):
        export(repo, at["edit"], repo / "build" / "edit")
    with pytest.raises(ValueError):
        export(repo, at["edit"], repo)
    with pytest.raises(OSError):
        export(repo, "0" * 40, tmp_path / "none")
    assert not (repo / "build").exists() and not (tmp_path / "none").exists()


def test_export_skips_links_that_leave_the_folder(history_repo, tmp_path):
    repo, _ = history_repo
    (repo / "out").symlink_to("/etc")
    (repo / "inside").symlink_to("src/shop")
    run(repo, "add", "out", "inside")
    run(repo, "commit", "-q", "-m", "링크")
    export(repo, head(repo), tmp_path / "out")
    assert not (tmp_path / "out" / "out").exists() and not (tmp_path / "out" / "out").is_symlink()
    assert (tmp_path / "out" / "inside" / "pricing.py").is_file()


def test_reading_leaves_the_repo_as_it_was(history_repo, tmp_path):
    repo, at = history_repo
    (repo / PRICING).write_text((repo / PRICING).read_text())  # 내용은 같고 수정 시각만 바뀐다
    porcelain = run(repo, "status", "--porcelain")
    refs = run(repo, "for-each-ref")
    before = git_files(repo)
    assert head(repo) and branch(repo) and default_branch(repo) and status(repo)
    assert commits(repo, 0, 200)
    assert is_ancestor(repo, at["edit"], at["merge"]) and merge_base(repo, at["topic"], at["merge"])
    for base, target in (("base", "merge"), ("edit", "topic")):
        assert changed(repo, at[base], at[target]) and hunks(repo, at[base], at[target])
    assert changed(repo, at["base"], WORKTREE) and hunks(repo, at["base"], WORKTREE)
    assert show(repo, at["base"], PRICING)
    export(repo, at["base"], tmp_path / "out")
    assert git_files(repo) == before
    assert run(repo, "for-each-ref") == refs
    assert run(repo, "status", "--porcelain") == porcelain


def test_every_git_call_goes_through_one_function(monkeypatch, module_history, tmp_path):
    repo, at = module_history
    called: list[str] = []
    real = subprocess.run

    def recorded(command, **options):
        called.append(command[command.index("diff.autoRefreshIndex=false") + 1])
        assert options["env"]["GIT_OPTIONAL_LOCKS"] == "0"
        return real(command, **options)

    monkeypatch.setattr(reader.subprocess, "run", recorded)
    head(repo), branch(repo), default_branch(repo), status(repo), commits(repo, 0, 5)
    is_ancestor(repo, at["edit"], at["merge"]), merge_base(repo, at["topic"], at["merge"])
    changed(repo, at["base"], WORKTREE), hunks(repo, at["base"], WORKTREE)
    show(repo, at["base"], PRICING), export(repo, at["base"], tmp_path / "out")
    assert set(called) == {"rev-parse", "symbolic-ref", "status", "log", "merge-base", "diff", "archive", "show"}
