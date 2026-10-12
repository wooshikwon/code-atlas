import hashlib
import importlib.util
import io
import os
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent / "scripts" / "build_app.py"
macos = pytest.mark.skipif(sys.platform != "darwin", reason="macOS의 codesign과 file을 쓴다")


@pytest.fixture
def build(tmp_path, monkeypatch):
    """빌드 명령의 모듈. 쓰는 폴더를 모두 임시 폴더로 바꾼다."""
    spec = importlib.util.spec_from_file_location("build_app", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "build_app", module)
    spec.loader.exec_module(module)
    pyembed = tmp_path / "pyembed"
    module.PYEMBED, module.PYTHON, module.STAMPS = pyembed, pyembed / "python", pyembed / "stamps"
    module.LIB = module.PYTHON / "lib" / "python3.13"
    module.SITE = module.LIB / "site-packages"
    module.DOWNLOADS = tmp_path / "downloads"
    monkeypatch.delenv(module.PYTHON_URL_ENV, raising=False)
    return module


def archive(path: Path, files: dict[str, str]) -> str:
    """`files`를 담은 tar.gz를 `path`에 만들고 SHA-256을 낸다. 값이 `-> 이름`이면 심볼릭 링크다."""
    with tarfile.open(path, "w:gz") as tar:
        for name, text in files.items():
            member = tarfile.TarInfo(f"python/{name}")
            if text.startswith("-> "):
                member.type, member.linkname = tarfile.SYMTYPE, text[3:]
                tar.addfile(member)
            else:
                member.size, member.mode = len(text.encode()), 0o755
                tar.addfile(member, io.BytesIO(text.encode()))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pinned(build, monkeypatch, sha: str) -> None:
    monkeypatch.setattr(build, "PYTHON_BUILDS", {build.platform.machine(): ("chip", sha)})


def test_archive_given_as_a_path_is_used_only_with_the_pinned_checksum(build, tmp_path, monkeypatch):
    given = tmp_path / "python.tar.gz"
    sha = archive(given, {"bin/python3": "#!/bin/sh\n"})
    monkeypatch.setenv(build.PYTHON_URL_ENV, str(given))

    pinned(build, monkeypatch, sha)
    assert build.python_archive() == given

    pinned(build, monkeypatch, "0" * 64)
    with pytest.raises(build.Failed, match="체크섬이 다르다") as refused:
        build.python_archive()
    assert "0" * 64 in refused.value.reason and sha in refused.value.reason

    monkeypatch.setenv(build.PYTHON_URL_ENV, str(tmp_path / "nowhere.tar.gz"))
    with pytest.raises(build.Failed, match="파일이 없다"):
        build.python_archive()


def test_downloaded_archive_is_kept_under_its_checksum_and_not_fetched_again(build, tmp_path, monkeypatch):
    served = tmp_path / "served.tar.gz"
    sha = archive(served, {"bin/python3": "#!/bin/sh\n"})
    pinned(build, monkeypatch, sha)
    monkeypatch.setenv(build.PYTHON_URL_ENV, served.as_uri())

    kept = build.python_archive()
    assert kept == build.DOWNLOADS / f"{sha}.tar.gz" and kept.read_bytes() == served.read_bytes()

    served.unlink()
    assert build.python_archive() == kept


def test_downloaded_archive_with_another_checksum_is_refused_and_not_kept(build, tmp_path, monkeypatch):
    served = tmp_path / "served.tar.gz"
    archive(served, {"bin/python3": "#!/bin/sh\n"})
    pinned(build, monkeypatch, "0" * 64)
    monkeypatch.setenv(build.PYTHON_URL_ENV, served.as_uri())

    with pytest.raises(build.Failed, match="체크섬이 다르다"):
        build.python_archive()
    assert list(build.DOWNLOADS.iterdir()) == []


def test_unreachable_download_fails_with_the_command_and_its_last_lines(build, tmp_path, monkeypatch):
    pinned(build, monkeypatch, "0" * 64)
    monkeypatch.setenv(build.PYTHON_URL_ENV, (tmp_path / "nowhere.tar.gz").as_uri())

    with pytest.raises(build.Failed) as failed:
        build.python_archive()
    assert failed.value.command[0] == "curl" and failed.value.net == "curl" and failed.value.tail
    assert list(build.DOWNLOADS.iterdir()) == []


def test_unpacked_tree_keeps_only_what_the_app_runs(build, tmp_path, monkeypatch):
    packed = tmp_path / "python.tar.gz"
    site = "lib/python3.13/site-packages"
    kept = {
        "bin/python3": "-> python3.13",
        "lib/python3.13/os.py": "",
        f"{site}/nodejs_wheel/bin/node": "node",
        f"{site}/basedpyright/langserver.index.js": "",
        f"{site}/basedpyright/dist/typeshed-fallback/stdlib/os.pyi": "",
    }
    dropped = {
        "bin/python3.13": "python",
        "bin/python": "-> python3.13",
        "bin/pip3": "",
        "bin/uvicorn": "",
        "include/python3.13/Python.h": "",
        "share/man/man1/python3.1": "",
        "lib/libpython3.13.dylib": "",
        "lib/libtcl9.0.dylib": "",
        "lib/tcl9.0/init.tcl": "",
        "lib/pkgconfig/python3.pc": "-> python-3.13.pc",
        "lib/python3.13/ensurepip/__init__.py": "",
        "lib/python3.13/idlelib/idle.py": "",
        "lib/python3.13/tkinter/__init__.py": "",
        "lib/python3.13/lib-dynload/_tkinter.cpython-313-darwin.so": "",
        f"{site}/pip/__init__.py": "",
        f"{site}/pip-26.0.dist-info/METADATA": "",
        f"{site}/nodejs_wheel/bin/npm": "",
        f"{site}/nodejs_wheel/include/node/node.h": "",
        f"{site}/nodejs_wheel/lib/node_modules/npm/index.js": "",
        f"{site}/nodejs_wheel/share/doc/node/gdbinit": "",
        f"{site}/basedpyright/dist/pyright-langserver.js.map": "",
    }
    archive(packed, {**kept, **dropped})
    build.unpack_python(packed)
    build.materialize()
    build.prune()

    left = {str(path.relative_to(build.PYTHON)) for path in build.PYTHON.rglob("*") if not path.is_dir()}
    assert left == set(kept)
    python = build.PYTHON / "bin" / "python3"
    assert not python.is_symlink() and python.read_text() == "python" and os.access(python, os.X_OK)


def test_unpacking_replaces_what_an_earlier_run_left(build, tmp_path):
    packed = tmp_path / "python.tar.gz"
    archive(packed, {"bin/python3": "#!/bin/sh\n"})
    stale = build.PYTHON / "lib" / "stale.py"
    stale.parent.mkdir(parents=True)
    stale.write_text("")

    build.unpack_python(packed)
    assert not stale.exists() and (build.PYTHON / "bin" / "python3").is_file()

    archive(packed, {"README": ""})
    with pytest.raises(build.Failed, match="bin/python3이 없다"):
        build.unpack_python(packed)


def test_a_step_is_skipped_only_with_the_same_input_and_redoing_it_forgets_the_later_steps(build):
    assert not build.done("npm", "a")
    for name in build.STAMPED:
        build.finish(name, "a")
    assert all(build.done(name, "a") for name in build.STAMPED)
    assert not build.done("npm", "b") and not build.done("npm", None)

    build.begin("dist")
    assert [name for name in build.STAMPED if build.done(name, "a")] == ["packages", "npm"]

    build.finish("dist", None)
    assert not (build.STAMPS / "dist").exists()


def test_revision_changes_with_uncommitted_and_untracked_files(build, tmp_path, monkeypatch):
    from conftest import git

    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setattr(build, "ROOT", repo)
    assert build.revision() == build.Revision(None, None)

    git(repo, "init", "-q")
    (repo / "a.py").write_text("x = 1\n")
    git(repo, "add", "a.py")
    git(repo, "commit", "-q", "-m", "first")
    clean = build.revision()
    assert len(clean.commit) == 40 and build.revision() == clean

    (repo / "a.py").write_text("x = 2\n")
    edited = build.revision()
    (repo / "b.py").write_text("y = 1\n")
    added = build.revision()
    assert {clean.commit} == {edited.commit, added.commit} and len({clean.state, edited.state, added.state}) == 3


def fake_tools(folder: Path, **outputs: str) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for name, output in outputs.items():
        tool = folder / name
        tool.write_text(f"#!/bin/sh\necho '{output}'\n")
        tool.chmod(0o755)


def test_rust_check_tells_how_to_install_or_update(build, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    fake_tools(tmp_path / "bin")
    missing = build.check_rust()
    assert not missing.ok and "cargo, rustc를 찾지 못했다" in missing.detail and "sh.rustup.rs" in missing.fix[0]

    fake_tools(tmp_path / ".cargo" / "bin", cargo="")
    assert "cargo/env" in build.check_rust().fix[0]

    fake_tools(tmp_path / "bin", cargo="cargo 1.89.0 (c24e10642 2026-06-23)", rustc="rustc 1.99.0 (b940084d7 2026-09-28)")
    old = build.check_rust()
    assert not old.ok and "1.90 이상" in old.detail and old.fix == ["rustup update stable"]

    fake_tools(tmp_path / "bin", cargo="cargo 1.90.0 (840b83a10 2026-07-30)")
    found = build.check_rust()
    assert found.ok and found.detail == f"cargo 1.90.0 ({tmp_path}/bin/cargo), rustc 1.99.0 ({tmp_path}/bin/rustc)"


def test_doctor_lists_every_failed_check_before_it_fails(build, capsys, monkeypatch):
    passed = build.Check("칩과 macOS", True, "arm64, macOS 26.6")
    rust = build.Check("Rust", False, "cargo를 찾지 못했다", ["rustup을 설치한다"])
    source = build.Check("묶을 Python", False, "http://127.0.0.1:9/python.tar.gz에 닿지 못했다", ["주소를 확인한다"])
    for name in ("check_machine", "check_xcode", "check_node", "check_python", "check_disk"):
        monkeypatch.setattr(build, name, lambda: passed)
    monkeypatch.setattr(build, "check_rust", lambda: rust)
    monkeypatch.setattr(build, "check_sources", lambda: [source])

    with pytest.raises(build.Failed, match="점검 2개.*Rust, 묶을 Python"):
        build.doctor()
    printed = capsys.readouterr().out
    assert "통과  칩과 macOS: arm64, macOS 26.6" in printed
    assert "실패  Rust: cargo를 찾지 못했다\n        → rustup을 설치한다" in printed
    assert "실패  묶을 Python: http://127.0.0.1:9/python.tar.gz에 닿지 못했다\n        → 주소를 확인한다" in printed


def test_unreachable_source_names_the_settings_that_change_it(build, monkeypatch):
    refused = build.reached("묶을 Python", "http://127.0.0.1:9/python.tar.gz", "curl")
    assert not refused.ok and "http://127.0.0.1:9/python.tar.gz에 닿지 못했다" in refused.detail
    assert build.PYTHON_URL_ENV in refused.fix[0] and "HTTPS_PROXY" in refused.fix[0]


def test_cargo_index_follows_the_replaced_source(build, tmp_path, monkeypatch):
    monkeypatch.setenv("CARGO_HOME", str(tmp_path))
    assert build.cargo_index() == build.CARGO_INDEX

    config = '[source.crates-io]\nreplace-with = "mirror"\n[source.mirror]\n'
    (tmp_path / "config.toml").write_text(config + 'registry = "sparse+https://crates.example.com/index/"\n')
    assert build.cargo_index() == "https://crates.example.com/index/config.json"

    (tmp_path / "config.toml").write_text(config + 'directory = "vendor"\n')
    assert build.cargo_index() is None


def test_failure_report_names_the_step_the_command_and_the_network_settings(build, capsys):
    tail = ["Collecting fastapi==0.143.0", "ERROR: Could not find a version: SSL: CERTIFICATE_VERIFY_FAILED"]
    build.report("[3/8] 의존성 설치와 정리", build.Failed("명령이 종료 코드 1로 끝났다", ["pip", "install", "a b"], tail, "pip"), resumes=True)
    printed = capsys.readouterr().err.splitlines()
    assert printed[0] == "[3/8] 의존성 설치와 정리에서 실패했다: 명령이 종료 코드 1로 끝났다"
    assert printed[1] == "  명령: pip install 'a b'" and printed[3:5] == [f"    {line}" for line in tail]
    assert "PIP_INDEX_URL" in printed[5] and printed[6] == f"  {build.RESUME}"

    build.report("[5/8] 앱 껍데기 빌드", build.Failed("명령이 종료 코드 101로 끝났다", ["cargo"], ["error[E0425]: cannot find value"], "cargo"), resumes=True)
    assert "망 문제" not in capsys.readouterr().err


def test_failed_command_keeps_its_last_lines(build):
    with pytest.raises(build.Failed, match="종료 코드 3") as failed:
        build.run([sys.executable, "-c", "print('\\n'.join(map(str, range(40)))); raise SystemExit(3)"], show=False)
    assert failed.value.tail == [str(number) for number in range(40 - build.KEPT_LINES, 40)]

    with pytest.raises(build.Failed, match="실행하지 못했다"):
        build.run(["/nonexistent/tool"], show=False)


def fake_app(path: Path, mark: str) -> Path:
    (path / "Contents" / "MacOS").mkdir(parents=True)
    (path / "Contents" / "MacOS" / "atlas").write_text(mark)
    (path / "Contents" / mark).write_text("")
    return path


def test_install_replaces_the_app_and_checks_what_it_placed(build, tmp_path, monkeypatch):
    app = fake_app(tmp_path / "build" / "Atlas.app", "new")
    destination = fake_app(tmp_path / "Applications" / "Atlas.app", "old")
    checked = []
    monkeypatch.setattr(build, "check_app", checked.append)

    build.install(app, destination)
    assert sorted(path.name for path in (destination / "Contents").iterdir()) == ["MacOS", "new"]
    assert (destination / "Contents" / "MacOS" / "atlas").read_text() == "new"
    assert checked == [destination] and [path.name for path in destination.parent.iterdir()] == ["Atlas.app"]


@macos
def test_install_leaves_a_running_app_alone(build, tmp_path):
    app = fake_app(tmp_path / "build" / "Atlas.app", "new")
    destination = fake_app(tmp_path / "Applications" / "Atlas.app", "old")
    executable = destination / "Contents" / "MacOS" / "atlas"
    executable.write_bytes(Path("/bin/sleep").read_bytes())
    executable.chmod(0o755)
    build.sign(executable)
    running = subprocess.Popen([str(executable), "30"])
    try:
        with pytest.raises(build.Failed, match="떠 있다"):
            build.install(app, destination)
    finally:
        running.kill()
        running.wait()
    assert (destination / "Contents" / "old").exists() and not build.running(destination)


@macos
def test_copied_executable_is_found_signed_and_runs(build, tmp_path):
    copied = tmp_path / "Atlas.app" / "Contents" / "Resources" / "bin" / "true"
    copied.parent.mkdir(parents=True)
    copied.write_bytes(Path("/usr/bin/true").read_bytes())
    copied.chmod(0o755)
    (copied.parent / "notes.txt").write_text("Mach-O가 아니다")
    (copied.parent / "Main.class").write_bytes(bytes.fromhex("cafebabe0000003d"))
    assert build.machos(tmp_path) == [copied]

    build.sign(copied)
    assert subprocess.run(["codesign", "--verify", "--strict", str(copied)]).returncode == 0
    assert subprocess.run([str(copied)]).returncode == 0


def test_only_adhoc_signing_is_made(build, capsys):
    assert build.main(["--sign", "developer-id"]) == 2
    assert "임시 서명만 만든다" in capsys.readouterr().err
