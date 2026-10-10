import shutil

from conftest import FIXTURE, git

from code_atlas import changes
from code_atlas.changes import branch, hunks, status

CORE = "src/app/core.py"


def edit(repo, path, old, new):
    file = repo / path
    text = file.read_text()
    assert old in text
    file.write_text(text.replace(old, new))


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
    assert hunks(git_repo) == {}
    assert branch(git_repo) == "main"


def test_hunks_give_changed_added_and_removed_lines(git_repo):
    edit(git_repo, CORE, "    return value\n", "    return value or None\n")
    edit(git_repo, CORE, "        self.calls += 1\n", "")
    edit(git_repo, CORE, "    return engine\n", "    print(handlers)\n    print(config)\n    return engine\n")
    (git_repo / "README.md").write_text("설명\n")
    (git_repo / "src/app/new.py").write_text("x = 1\n")
    assert hunks(git_repo) == {CORE: [(11, 11), (19, 20), (34, 35)]}


def test_hunks_of_removed_lines_cover_the_line_before_and_after(git_repo):
    path = "src/app/cached.py"
    (git_repo / path).write_text(
        "import functools\n\n\n"
        "@functools.cache\ndef first():\n    return 1\n\n\n"
        "def second():\n    return 2\n\n\n"
        "def third():\n    return 3\n"
    )
    git(git_repo, "add", path)
    git(git_repo, "commit", "-q", "-m", "더함")

    edit(git_repo, path, "@functools.cache\n", "")
    assert hunks(git_repo) == {path: [(3, 4)]}  # 4번 줄이 `def first():`다

    edit(git_repo, path, "def second():\n    return 2\n\n\n", "")
    [_, (before, after)] = hunks(git_repo)[path]
    assert (before, after) == (7, 8)  # 8번 줄이 `def third():`다

    edit(git_repo, path, "import functools\n", "")
    assert hunks(git_repo)[path][0] == (1, 1)


def test_hunks_skip_deleted_files_and_include_staged_changes(git_repo):
    (git_repo / "src/app/models.py").unlink()
    edit(git_repo, "src/app/cli.py", "    Loud().run()\n", "    Loud().run()\n    Loud().run()\n")
    git(git_repo, "add", "src/app/cli.py")
    assert hunks(git_repo) == {"src/app/cli.py": [(13, 13)]}


def test_paths_are_relative_to_a_root_below_the_git_top(git_repo):
    edit(git_repo, CORE, "    return value\n", "    return value or None\n")
    (git_repo / "src/app/한글.py").write_text("x = 1\n")
    (git_repo / "tests/extra.py").write_text("x = 1\n")
    root = git_repo / "src"
    assert status(root) == {"app/core.py": "modified", "app/한글.py": "added"}
    assert hunks(root) == {"app/core.py": [(11, 11)]}


def test_repo_without_commits_has_only_added_files(tmp_path):
    repo = tmp_path / "sample_repo"
    shutil.copytree(FIXTURE, repo)
    git(repo, "init", "-q", "-b", "trunk")
    git(repo, "add", "src/app/core.py")
    found = status(repo)
    assert found[CORE] == "added" and found["src/app/cli.py"] == "added"
    assert set(found.values()) == {"added"}
    assert hunks(repo) == {}
    assert branch(repo) == "trunk"


def test_detached_head_has_no_branch(git_repo):
    git(git_repo, "checkout", "-q", "--detach")
    assert branch(git_repo) is None
    assert status(git_repo) == {}


def test_outside_git_everything_is_none(sample_repo):
    assert status(sample_repo) is None
    assert hunks(sample_repo) is None
    assert branch(sample_repo) is None


def test_missing_git_is_none(git_repo, monkeypatch):
    monkeypatch.setenv("PATH", str(git_repo / "nowhere"))
    assert status(git_repo) is None
    assert hunks(git_repo) is None


def test_slow_git_is_none(git_repo, tmp_path, monkeypatch):
    fake = tmp_path / "bin" / "git"
    fake.parent.mkdir()
    fake.write_text("#!/bin/sh\nexec sleep 5\n")
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", str(fake.parent), prepend=":")
    monkeypatch.setattr(changes, "GIT_TIMEOUT", 0.2)
    assert status(git_repo) is None


def test_reading_does_not_write_the_index(git_repo):
    index = git_repo / ".git" / "index"
    core = git_repo / CORE
    core.write_text(core.read_text())  # 내용은 같고 수정 시각만 바뀐다
    before = (index.read_bytes(), index.stat().st_mtime_ns)
    assert status(git_repo) == {}
    assert hunks(git_repo) == {}
    assert (index.read_bytes(), index.stat().st_mtime_ns) == before
    assert not (git_repo / ".git" / "index.lock").exists()
