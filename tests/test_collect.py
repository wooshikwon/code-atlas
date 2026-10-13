from code_atlas import collect as collecting
from code_atlas.collect import collect, collected, config_texts, disk_path, find_source_root, is_test_path, listed, module_id, others


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
    assert listed(sample_repo, paths) == {"src/app/core.py", "src/app/late.py", "src/app/notes.md"}


def test_others_are_the_files_collect_leaves_out(sample_repo):
    (sample_repo / "docs").mkdir()
    (sample_repo / "docs" / "guide.md").write_text("# 안내\n")
    (sample_repo / "ignored_dir" / "skip.json").write_text("{}\n")
    (sample_repo / ".tools").mkdir()
    (sample_repo / ".tools" / "hidden.yml").write_text("a: 1\n")
    found = others(sample_repo)
    assert {"docs/guide.md", "pyproject.toml"} <= set(found) and found == sorted(found)
    assert not any(p.endswith(".py") or p.startswith(("ignored_dir/", "env/", ".tools/")) for p in found)
    assert listed(sample_repo, found) == set(found)


def test_config_texts_read_config_files_like_collect(sample_repo, monkeypatch):
    (sample_repo / "conf").mkdir()
    (sample_repo / "conf" / "run.yaml").write_text("target: app.core.helper\n")
    (sample_repo / "setup.cfg").write_text("[metadata]\n")
    (sample_repo / "notes.md").write_text("target: app.core.spare\n")
    (sample_repo / "ignored_dir" / "skip.json").write_text("{}\n")
    (sample_repo / "env" / "lib" / "site.ini").write_text("[x]\n")
    (sample_repo / ".tools").mkdir()
    (sample_repo / ".tools" / "hidden.yml").write_text("a: 1\n")
    pyproject = (sample_repo / "pyproject.toml").read_text()
    assert sorted(config_texts(sample_repo)) == sorted(["target: app.core.helper\n", "[metadata]\n", pyproject])

    monkeypatch.setattr(collecting, "CONFIG_LIMIT", len(pyproject.encode()) - 1)
    assert sorted(config_texts(sample_repo)) == ["[metadata]\n", "target: app.core.helper\n"]


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


def test_disk_path_follows_symlinks_and_keeps_missing_paths(sample_repo, tmp_path):
    link = tmp_path / "link"
    link.symlink_to(sample_repo)
    assert disk_path(link) == sample_repo.resolve()
    assert disk_path(link / "src/app/core.py") == (sample_repo / "src/app/core.py").resolve()
    assert collect(link).root == collect(sample_repo).root
    assert disk_path(tmp_path / "missing" / "a.py") == (tmp_path / "missing" / "a.py").resolve()


def test_disk_path_uses_the_names_written_on_disk(sample_repo, tmp_path):
    shouted = tmp_path / "SAMPLE_REPO"
    if shouted.exists():
        # 대소문자를 구분하지 않는 파일 시스템: 대소문자가 다른 경로가 디스크의 이름으로 바뀐다.
        assert disk_path(shouted / "SRC/APP/Core.py") == (sample_repo / "src/app/core.py").resolve()
        assert collect(shouted).root == collect(sample_repo).root
    else:
        # 대소문자를 구분하는 파일 시스템: 대소문자가 다른 경로는 다른 파일이므로 그대로 둔다.
        assert disk_path(shouted / "SRC/APP/Core.py") == (shouted / "SRC/APP/Core.py").resolve()
        shouted.mkdir()
        assert disk_path(shouted) != disk_path(sample_repo)
