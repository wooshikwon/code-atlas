import json
import logging
import subprocess
import sys

from code_atlas.settings import Settings

WRITER = """
import sys
from code_atlas.settings import Settings

settings = Settings(sys.argv[1])
for round in range(40):
    settings.opened(f"/repos/{sys.argv[2]}-{round % 4}")
    settings.keep_tool(sys.argv[2], f"/bin/{round}")
"""


def test_missing_file_is_an_empty_settings_and_reading_writes_nothing(tmp_path):
    settings = Settings(tmp_path / "config" / "settings.json")
    assert settings.repos() == [] and settings.python("/repos/a") is None and settings.tool("git") is None
    assert not (tmp_path / "config").exists()


def test_opened_repos_come_latest_first_and_keep_the_chosen_python(tmp_path):
    path = tmp_path / "config" / "settings.json"
    settings = Settings(path)
    settings.opened("/repos/a", "/usr/bin/python3")
    settings.opened("/repos/b")
    assert [(r.root, r.python) for r in settings.repos()] == [("/repos/b", None), ("/repos/a", "/usr/bin/python3")]

    settings.opened("/repos/a")
    found = Settings(path).repos()
    assert [(r.root, r.python) for r in found] == [("/repos/a", "/usr/bin/python3"), ("/repos/b", None)]
    assert found[0].opened >= found[1].opened
    assert settings.python("/repos/a") == "/usr/bin/python3" and settings.python("/repos/b") is None

    settings.opened("/repos/a", "/opt/python")
    assert settings.python("/repos/a") == "/opt/python"
    settings.forget("/repos/a")
    assert [r.root for r in settings.repos()] == ["/repos/b"] and settings.python("/repos/a") is None
    assert [p.name for p in path.parent.iterdir()] == ["settings.json"]


def test_tool_paths_are_kept_and_removed(tmp_path):
    settings = Settings(tmp_path / "settings.json")
    settings.keep_tool("claude", "/opt/bin/claude")
    settings.opened("/repos/a")
    assert settings.tool("claude") == "/opt/bin/claude" and settings.tool("git") is None
    assert json.loads(settings.path.read_text())["tools"] == {"claude": "/opt/bin/claude"}
    settings.keep_tool("claude", None)
    assert settings.tool("claude") is None and [r.root for r in settings.repos()] == ["/repos/a"]


def test_unreadable_file_is_moved_aside_and_settings_start_empty(tmp_path, caplog):
    path = tmp_path / "settings.json"
    for broken in ("{not json", '["a list"]', '{"repos": [{"python": null}]}', '{"repos": [{"root": "/a", "opened": "어제"}]}'):
        path.write_text(broken)
        path.with_name("settings.json.broken").unlink(missing_ok=True)
        with caplog.at_level(logging.WARNING, logger="code_atlas.settings"):
            assert Settings(path).repos() == []
        assert not path.exists() and path.with_name("settings.json.broken").read_text() == broken

    settings = Settings(path)
    settings.opened("/repos/a")
    assert [r.root for r in settings.repos()] == ["/repos/a"]


def test_unwritable_folder_leaves_a_warning_and_no_error(tmp_path, caplog):
    blocked = tmp_path / "file"
    blocked.write_text("")
    settings = Settings(blocked / "settings.json")
    with caplog.at_level(logging.WARNING, logger="code_atlas.settings"):
        settings.opened("/repos/a")
    assert "쓰지 못했다" in caplog.text and settings.repos() == []


def test_two_processes_writing_together_leave_a_readable_file(tmp_path):
    path = tmp_path / "settings.json"
    writers = [subprocess.Popen([sys.executable, "-c", WRITER, str(path), name]) for name in ("claude", "git")]
    assert [w.wait(timeout=30) for w in writers] == [0, 0]
    assert not path.with_name("settings.json.broken").exists()
    assert len(Settings(path).repos()) >= 4
    assert [p.name for p in tmp_path.iterdir()] == ["settings.json"]
