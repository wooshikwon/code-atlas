from code_atlas.collect import collect, collected, find_source_root, is_test_path, module_id


def test_collect_skips_ignored_and_venv(sample_repo):
    repo = collect(sample_repo)
    paths = [f.path for f in repo.files]
    assert "ignored_dir/skip.py" not in paths
    assert "src/app/schema.gen.py" not in paths
    assert not any(p.startswith("env/") for p in paths)
    assert "src/app/core.py" in paths


def test_collected_judges_paths_like_collect(sample_repo):
    (sample_repo / ".tools").mkdir()
    paths = [
        "src/app/core.py",
        "src/app/late.py",
        "src/app/notes.md",
        "src/app/schema.gen.py",
        "ignored_dir/skip.py",
        "ignored_dir/deep/skip.py",
        "env/lib/site.py",
        ".tools/hidden.py",
        "src/__pycache__/x.py",
    ]
    assert collected(sample_repo, paths) == {"src/app/core.py", "src/app/late.py"}
    assert {f.path for f in collect(sample_repo).files} >= {"src/app/core.py"}
    assert collected(sample_repo, []) == set()


def test_collect_source_root_and_ids(sample_repo):
    repo = collect(sample_repo)
    assert repo.source_root == "src"
    ids = {f.path: f.module_id for f in repo.files}
    assert ids["src/app/__init__.py"] == "app"
    assert ids["src/app/plugins/base.py"] == "app.plugins.base"
    assert ids["tests/test_core.py"] == "tests.test_core"
    assert "src/app/plugins" in repo.packages


def test_collect_pyproject(sample_repo):
    repo = collect(sample_repo)
    assert repo.scripts == ["app.cli:main"]
    assert repo.extra_paths == ["src"]


def test_test_flags(sample_repo):
    flags = {f.path: f.test for f in collect(sample_repo).files}
    assert flags["tests/conftest.py"] and flags["tests/test_core.py"]
    assert not flags["src/app/core.py"]


def test_is_test_path():
    assert is_test_path("pkg/test_x.py")
    assert is_test_path("pkg/x_test.py")
    assert is_test_path("conftest.py")
    assert is_test_path("test/helpers.py")
    assert not is_test_path("pkg/testing.py")


def test_find_source_root():
    assert find_source_root(["src/a/x.py", "tests/test_x.py"]) == "src"
    assert find_source_root(["setup.py", "src/a/x.py"]) == ""
    assert find_source_root(["a/x.py", "b/y.py"]) == ""


def test_module_id():
    assert module_id("src/a/__init__.py", "src") == "a"
    assert module_id("src/id_map.py", "src") == "id_map"
    assert module_id("tests/test_x.py", "src") == "tests.test_x"
    assert module_id("__init__.py", "") == "__init__"
