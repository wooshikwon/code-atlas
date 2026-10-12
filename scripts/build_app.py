"""레포를 받은 Mac에서 Atlas 앱을 만든다.

    build_app.py [--doctor] [--install] [--dmg] [--check] [--clean] [--sign adhoc]

단계는 점검, 묶을 Python 받기, 의존성 설치와 정리, 화면 빌드, 앱 껍데기 빌드, 서명, 판정, 놓기 순서다. 표준 라이브러리만 쓰므로
Python 3.12 이상이면 가상환경 없이 돈다. `--doctor`는 점검만 하고, `--check`는 만들어 둔 앱에 판정만 다시 돌린다.
`--install`은 만든 앱을 `/Applications/Atlas.app`에 놓고, `--dmg`는 `.dmg`도 만든다. `--clean`은 표식과 묶을 Python
폴더를 지우고 처음부터 한다.

내려받기는 `curl`과 이 Mac의 `pip`·`npm`·`cargo`가 하고 넷 다 이 Mac의 설정(프록시, 사내 미러, 인증서)을 따른다. 이 명령은 그
설정을 읽어 적기만 한다. 묶을 Python을 받는 주소는 환경 변수 `CODE_ATLAS_PYTHON_URL`(파일 주소나 받아 둔 파일의 경로)로
바꾸고, 어디서 받든 아래에 적어 둔 SHA-256과 같아야 쓴다. 받은 파일은 `~/.cache/code-atlas/build/`에 체크섬 이름으로 둔다.

끝난 단계는 입력의 해시를 `frontend/src-tauri/pyembed/stamps/`에 적어 두고, 다시 실행하면 입력이 같은 단계를 건너뛴다.
쓰는 곳은 `frontend/src-tauri/pyembed/`·`target/`, `frontend/node_modules/`·`dist/`, `~/.cache/code-atlas/build/`와
`--install`을 받았을 때의 `/Applications/Atlas.app`이다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
SHELL = FRONTEND / "src-tauri"
PYEMBED = SHELL / "pyembed"
PYTHON = PYEMBED / "python"
STAMPS = PYEMBED / "stamps"
REQUIREMENTS = ROOT / "scripts" / "requirements-app.txt"
APP = SHELL / "target" / "release" / "bundle" / "macos" / "Atlas.app"
DMG = SHELL / "target" / "release" / "bundle" / "dmg" / "Atlas.dmg"
DOWNLOADS = Path.home() / ".cache" / "code-atlas" / "build"
INSTALLED = Path("/Applications") / APP.name

# 묶을 Python. python-build-standalone 릴리스의 `install_only_stripped` 파일이고, 칩마다 파일 이름의 칩 이름과 SHA-256을 적는다.
PYTHON_RELEASE = "20261009"
PYTHON_VERSION = "3.13.16"
PYTHON_BUILDS = {
    "arm64": ("aarch64", "11785155d0f70e634178219c20925d8f20be00a3da4684fc4f5019dd15602ef7"),
    "x86_64": ("x86_64", "bd085c51e960f00ee33b630e2b13ac90fe90cdc3da25a0f0bc0719b1294920bf"),
}
PYTHON_URL = (
    "https://github.com/astral-sh/python-build-standalone/releases/download/"
    "{release}/cpython-{version}+{release}-{chip}-apple-darwin-install_only_stripped.tar.gz"
)
PYTHON_URL_ENV = "CODE_ATLAS_PYTHON_URL"
LIB = PYTHON / "lib" / "python{}.{}".format(*PYTHON_VERSION.split("."))
SITE = LIB / "site-packages"

MIN_PYTHON = (3, 12)
MIN_RUST = (1, 90)
MIN_MACOS = (10, 15)  # Tauri 2가 지원하는 가장 낮은 판
PIP_INDEX = "https://pypi.org/simple/"
CARGO_INDEX = "https://index.crates.io/config.json"
REACH_TIMEOUT = 15

# 개인 Mac(arm64)의 첫 빌드에서 잰 크기(MB). 이미 있는 폴더는 그 크기만큼 덜 필요하다.
BUILD_SIZES = {SHELL / "target": 1450, PYEMBED: 230, FRONTEND / "node_modules": 230, DOWNLOADS: 25}
# pip·npm·cargo가 자기 캐시에 받아 두는 크기(MB). 개인 Mac에서 cargo의 레지스트리 190, npm 60, pip가 받은 wheel 75 안팎이었다
DISK_MARGIN = 400

STEPS = ["점검", "묶을 Python 받기", "의존성 설치와 정리", "화면 빌드", "앱 껍데기 빌드", "서명", "판정", "놓기"]
# 표식마다 그 결과를 입력으로 쓰는 표식. 한 표식의 일을 다시 하면 이 표식들을 지운다.
STAMPED = {"packages": ["shell", "sign"], "npm": ["dist", "shell", "sign"], "dist": ["shell", "sign"], "shell": ["sign"], "sign": []}
KEPT_LINES = 15
# Mach-O 파일(32·64비트, 두 바이트 순서, 여러 칩을 묶은 파일)의 앞 네 바이트
MACHO_MAGICS = {bytes.fromhex(magic) for magic in ("feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca")}
RESUME = "같은 명령을 다시 실행하면 이 단계부터 이어서 한다"
NETWORK_TROUBLE = re.compile(
    r"resolve host|timed? ?out|connection (refused|reset)|could not connect|certificate|ssl|proxy|"
    r"ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|failed to (download|fetch|get)|\b407\b",
    re.IGNORECASE,
)
# 내려받는 도구마다 따르는 이 Mac의 설정
NETWORK_SETTINGS = {
    "curl": f"환경 변수 HTTPS_PROXY·HTTP_PROXY·NO_PROXY, ~/.curlrc, 묶을 Python의 주소를 바꾸는 {PYTHON_URL_ENV}",
    "pip": "pip.conf의 index-url·cert·proxy, 환경 변수 PIP_INDEX_URL·PIP_CERT",
    "npm": ".npmrc의 registry·cafile·proxy",
    "cargo": "~/.cargo/config.toml의 [source]·[http]",
}


class Failed(Exception):
    """단계 하나가 실패한 까닭. `command`와 `tail`은 실패한 명령과 그 명령이 낸 마지막 줄들이고, `net`은 그 명령이 내려받을 때 쓰는 도구다."""

    def __init__(self, reason: str, command: list | None = None, tail: list[str] | None = None, net: str | None = None):
        super().__init__(reason)
        self.reason = reason
        self.command = command
        self.tail = tail or []
        self.net = net


def run(command: list, cwd: Path | None = None, net: str | None = None, show: bool = True) -> None:
    """명령을 실행하고 출력을 그대로 보인다. 0이 아닌 값으로 끝나면 마지막 줄들을 담아 `Failed`를 낸다."""
    command = [str(part) for part in command]
    if show:
        print(f"  $ {shlex.join(command)}", flush=True)
    tail: deque[str] = deque(maxlen=KEPT_LINES)
    try:
        process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    except OSError as error:
        raise Failed("명령을 실행하지 못했다", command, [str(error)], net) from error
    with process:
        for line in process.stdout:
            tail.append(line.rstrip("\n"))
            if show:
                print(f"    {tail[-1]}", flush=True)
    if process.returncode:
        raise Failed(f"명령이 종료 코드 {process.returncode}로 끝났다", command, list(tail), net)


def read(command: list, cwd: Path | None = None) -> str | None:
    """명령의 표준 출력. 실행하지 못했거나 0이 아닌 값으로 끝나면 None이다."""
    try:
        done = subprocess.run([str(part) for part in command], cwd=cwd, capture_output=True, text=True, errors="replace", timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def digest(*parts: str | bytes) -> str:
    hashed = hashlib.sha256()
    for part in parts:
        hashed.update(part if isinstance(part, bytes) else part.encode())
        hashed.update(b"\0")
    return hashed.hexdigest()


def sha256(path: Path) -> str:
    hashed = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            hashed.update(block)
    return hashed.hexdigest()


def megabytes(path: Path) -> int:
    """폴더나 파일이 디스크에서 쓰는 크기(MB). 없으면 0이다."""
    told = read(["du", "-sk", path]) if path.exists() else None
    return int(told.split()[0]) // 1024 if told else 0


def version_of(text: str | None) -> tuple[int, ...] | None:
    found = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text or "")
    return tuple(int(part) for part in found.groups() if part is not None) if found else None


# 빌드 전 점검


@dataclass
class Check:
    """점검 한 줄. `detail`은 찾은 판과 경로나 통과하지 못한 까닭이고, `fix`는 통과하지 못했을 때 적는 설치·설정 방법이다."""

    name: str
    ok: bool
    detail: str
    fix: list[str] = field(default_factory=list)


def check_machine() -> Check:
    chip, macos = platform.machine(), platform.mac_ver()[0]
    ok = chip in PYTHON_BUILDS and (version_of(macos) or (0,)) >= MIN_MACOS
    fix = [] if ok else ["Apple Silicon이나 Intel Mac의 macOS {}.{} 이상에서 만든다".format(*MIN_MACOS)]
    return Check("칩과 macOS", ok, f"{chip}, macOS {macos or '아님'}", fix)


def check_xcode() -> Check:
    tools = read(["xcode-select", "-p"])
    missing = [name for name in ("codesign", "hdiutil") if shutil.which(name) is None]
    if tools is None or not Path(tools).is_dir() or read(["xcrun", "--find", "codesign"]) is None:
        return Check("Xcode Command Line Tools", False, "찾지 못했다", ["xcode-select --install"])
    if missing:
        return Check("Xcode Command Line Tools", False, f"{', '.join(missing)}를 찾지 못했다", ["xcode-select --install"])
    return Check("Xcode Command Line Tools", True, tools)


def check_rust() -> Check:
    install = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    found = {name: (shutil.which(name), read([name, "--version"])) for name in ("cargo", "rustc")}
    missing = [name for name, (path, told) in found.items() if path is None or told is None]
    if missing:
        fix = [install]
        if (Path.home() / ".cargo" / "bin" / missing[0]).exists():
            fix = ['이 터미널의 PATH에 없다. source "$HOME/.cargo/env"를 실행하거나 새 터미널을 연다']
        return Check("Rust", False, f"{', '.join(missing)}를 찾지 못했다", fix)
    detail = ", ".join(f"{told.split(' (')[0]} ({path})" for path, told in found.values())
    old = [name for name, (_, told) in found.items() if (version_of(told) or (0,)) < MIN_RUST]
    if old:
        return Check("Rust", False, "{}, {}.{} 이상이어야 한다".format(detail, *MIN_RUST), ["rustup update stable"])
    return Check("Rust", True, detail)


def check_node() -> Check:
    wanted = json.loads((FRONTEND / "package.json").read_text(encoding="utf-8"))["engines"]["node"]
    node, npm = read(["node", "--version"]), read(["npm", "--version"])
    fix = ["https://nodejs.org/ 에서 받거나 brew install node, 또는 nvm install --lts"]
    if node is None or npm is None:
        return Check("Node.js", False, f"{'node' if node is None else 'npm'}을 찾지 못했다", fix)
    detail = f"node {node} ({shutil.which('node')}), npm {npm}"
    if (version_of(node) or (0,)) < version_of(wanted):
        return Check("Node.js", False, f"{detail}, node {wanted}이어야 한다", fix)
    return Check("Node.js", True, detail)


def check_python() -> Check:
    detail = f"{platform.python_version()} ({sys.executable})"
    if sys.version_info >= MIN_PYTHON:
        return Check("Python", True, detail)
    fix = ["brew install python@3.13, pyenv install 3.13, uv python install 3.13 가운데 하나로 설치하고 그 Python으로 이 명령을 실행한다"]
    newer = [path for path in (shutil.which(f"python3.{minor}") for minor in range(MIN_PYTHON[1], 20)) if path]
    if newer:
        fix = [f"{newer[-1]} {' '.join(sys.argv)}"]
    return Check("Python", False, "{}, 이 명령은 {}.{} 이상에서 돈다".format(detail, *MIN_PYTHON), fix)


def check_disk() -> Check:
    needed = DISK_MARGIN + sum(max(0, size - megabytes(path)) for path, size in BUILD_SIZES.items())
    free = shutil.disk_usage(ROOT).free // (1 << 20)
    detail = f"{ROOT}의 볼륨에 {free:,}MB가 남아 있고 빌드에 {needed:,}MB가 필요하다"
    return Check("디스크 여유", free >= needed, detail, [] if free >= needed else [f"{needed - free:,}MB를 더 비운다"])


def python_source() -> str:
    """묶을 Python을 받는 주소나 받아 둔 파일의 경로."""
    chip = PYTHON_BUILDS[platform.machine()][0]
    return os.environ.get(PYTHON_URL_ENV) or PYTHON_URL.format(release=PYTHON_RELEASE, version=PYTHON_VERSION, chip=chip)


def kept_python() -> Path:
    """받은 묶을 Python을 두는 경로. 파일 이름이 체크섬이다."""
    return DOWNLOADS / f"{PYTHON_BUILDS[platform.machine()][1]}.tar.gz"


def cargo_index() -> str | None:
    """cargo가 크레이트 목록을 받는 주소. `~/.cargo/config.toml`이 주소가 아닌 것(폴더)으로 바꿔 두었으면 None이다."""
    import tomllib

    home = Path(os.environ.get("CARGO_HOME") or Path.home() / ".cargo")
    try:
        sources = tomllib.loads((home / "config.toml").read_text(encoding="utf-8")).get("source", {})
    except (OSError, ValueError):
        return CARGO_INDEX
    replaced = sources.get("crates-io", {}).get("replace-with")
    if replaced is None:
        return CARGO_INDEX
    registry = sources.get(replaced, {}).get("registry")
    if registry is None:
        return None
    return registry.removeprefix("sparse+").rstrip("/") + ("/config.json" if registry.startswith("sparse+") else "")


def reach(url: str) -> str | None:
    """`curl -I`가 응답을 받지 못한 까닭. 400 미만의 응답을 받으면 None이다."""
    command = ["curl", "--head", "--location", "--silent", "--show-error", "--max-time", str(REACH_TIMEOUT)]
    try:
        done = subprocess.run([*command, "--output", os.devnull, "--write-out", "%{http_code}", url], capture_output=True, text=True, errors="replace")
    except OSError as error:
        return str(error)
    if done.returncode:
        return (done.stderr.strip().splitlines() or [f"curl이 종료 코드 {done.returncode}로 끝났다"])[-1]
    return None if int(done.stdout) < 400 else f"HTTP {done.stdout.strip()}"


def check_sources() -> list[Check]:
    """내려받을 곳마다 한 줄. 주소는 이 Mac의 설정에서 읽고, 닿지 않으면 그 주소를 바꾸는 설정을 적는다."""
    checks = []
    source = python_source()
    if kept_python().is_file():
        checks.append(Check("묶을 Python", True, f"받아 둔 파일을 쓴다 ({kept_python()})"))
    elif "://" not in source:
        ok = Path(source).expanduser().is_file()
        checks.append(Check("묶을 Python", ok, source if ok else f"없는 파일이다: {source}", [] if ok else [f"{PYTHON_URL_ENV}에 받아 둔 파일의 경로나 주소를 준다"]))
    else:
        checks.append(reached("묶을 Python", source, "curl"))
    pip = os.environ.get("PIP_INDEX_URL") or read([sys.executable, "-m", "pip", "config", "get", "global.index-url"]) or PIP_INDEX
    checks.append(reached("pip의 index", pip, "pip"))
    npm = read(["npm", "config", "get", "registry"], cwd=FRONTEND)
    if npm is not None:
        checks.append(reached("npm의 registry", npm, "npm"))
    cargo = cargo_index() if sys.version_info >= MIN_PYTHON else CARGO_INDEX
    if cargo is None:
        checks.append(Check("cargo의 registry", True, "~/.cargo/config.toml이 폴더로 바꿔 두었다"))
    else:
        checks.append(reached("cargo의 registry", cargo, "cargo"))
    return checks


def reached(name: str, url: str, tool: str) -> Check:
    trouble = reach(url)
    if trouble is None:
        return Check(name, True, url)
    return Check(name, False, f"{url}에 닿지 못했다: {trouble}", [f"주소와 망 설정을 확인한다: {NETWORK_SETTINGS[tool]}"])


def doctor() -> None:
    """점검을 모두 돌고 한 줄씩 적는다. 통과하지 못한 것이 있으면 모아서 `Failed`를 낸다."""
    checks = [check_machine(), check_xcode(), check_rust(), check_node(), check_python(), check_disk(), *check_sources()]
    for check in checks:
        print(f"  {'통과' if check.ok else '실패'}  {check.name}: {check.detail}")
        for line in check.fix:
            print(f"        → {line}")
    failed = [check.name for check in checks if not check.ok]
    if failed:
        raise Failed(f"통과하지 못한 점검 {len(failed)}개를 위의 방법으로 고친 뒤 다시 실행한다: {', '.join(failed)}")


# 표식과 레포의 상태


@dataclass
class Revision:
    commit: str | None  # 레포의 커밋 해시. git 저장소가 아니면 None
    state: str | None  # 커밋과 커밋하지 않은 변경을 함께 해시한 값. 표식의 입력이다


def revision() -> Revision:
    commit = read(["git", "rev-parse", "HEAD"], cwd=ROOT)
    if commit is None:
        return Revision(None, None)
    changed = read(["git", "diff", "HEAD"], cwd=ROOT) or ""
    untracked = (read(["git", "ls-files", "--others", "--exclude-standard"], cwd=ROOT) or "").splitlines()
    added = [name + sha256(ROOT / name) for name in untracked if (ROOT / name).is_file()]
    return Revision(commit, digest(commit, changed, *added))


def done(name: str, key: str | None) -> bool:
    """`name` 단계를 같은 입력으로 끝낸 적이 있는지."""
    try:
        return key is not None and (STAMPS / name).read_text(encoding="utf-8") == key
    except OSError:
        return False


def begin(name: str) -> None:
    """`name`의 표식과 그 결과를 입력으로 쓰는 표식을 지운다."""
    for stale in (name, *STAMPED[name]):
        (STAMPS / stale).unlink(missing_ok=True)


def finish(name: str, key: str | None) -> None:
    if key is not None:
        STAMPS.mkdir(parents=True, exist_ok=True)
        (STAMPS / name).write_text(key, encoding="utf-8")


# 묶을 Python


def python_archive() -> Path:
    """묶을 Python 파일의 경로. 받아 둔 파일이 없으면 받고, 체크섬이 적어 둔 값과 다른 파일은 쓰지 않는다."""
    expected = PYTHON_BUILDS[platform.machine()][1]
    kept, source = kept_python(), python_source()
    if kept.is_file() and sha256(kept) == expected:
        print(f"  받아 둔 파일을 쓴다: {kept}")
        return kept
    if "://" not in source:
        given = Path(source).expanduser()
        if not given.is_file():
            raise Failed(f"{PYTHON_URL_ENV}에 준 파일이 없다: {given}")
        refuse_unless(given, expected)
        return given
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    part = kept.with_suffix(".part")
    run(["curl", "--fail", "--location", "--silent", "--show-error", "--output", part, source], net="curl")
    try:
        refuse_unless(part, expected)
    except Failed:
        part.unlink()
        raise
    part.replace(kept)
    return kept


def refuse_unless(path: Path, expected: str) -> None:
    actual = sha256(path)
    if actual != expected:
        raise Failed(f"묶을 Python의 체크섬이 다르다. 이 파일을 쓰지 않는다: {path}\n  적어 둔 값 {expected}\n  받은 파일 {actual}")


def unpack_python(archive: Path) -> None:
    """묶을 Python을 `pyembed/python/`에 새로 푼다."""
    shutil.rmtree(PYTHON, ignore_errors=True)
    PYEMBED.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar:
        tar.extractall(PYEMBED, filter="data")
    if not (PYTHON / "bin" / "python3").exists():
        raise Failed(f"푼 폴더에 bin/python3이 없다: {PYTHON}")


def prune() -> None:
    """앱이 쓰지 않는 것을 묶을 폴더에서 지운다.

    `bin/python3`과 표준 라이브러리 폴더만 남기고(C 헤더, Tcl/Tk, 다른 이름의 실행 파일 사본, 설치한 패키지의 실행 스크립트,
    `python3`이 쓰지 않는 `libpython`이 빠진다), 그 안에서 pip, IDLE, tkinter, npm과 node의 헤더, basedpyright의 소스맵을 지운다.
    """
    node = SITE / "nodejs_wheel"
    doomed = [
        *(path for path in PYTHON.iterdir() if path.name not in ("bin", "lib")),
        *(path for path in (PYTHON / "bin").iterdir() if path.name != "python3"),
        *(path for path in (PYTHON / "lib").iterdir() if path != LIB),
        *(LIB / name for name in ("ensurepip", "idlelib", "tkinter", "turtledemo")),
        *(LIB / "lib-dynload").glob("_tkinter.*"),
        SITE / "pip",
        *SITE.glob("pip-*.dist-info"),
        *(node / name for name in ("include", "share", "lib", "bin/npm", "bin/npx", "bin/corepack")),
        *(SITE / "basedpyright").rglob("*.js.map"),
    ]
    for path in doomed:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)


def materialize() -> None:
    """묶을 폴더의 심볼릭 링크를 가리키던 파일의 사본으로 바꾼다. 가리키는 것이 없는 링크는 지운다."""
    for folder, folders, files in os.walk(PYTHON):
        for name in [*folders, *files]:
            link = Path(folder) / name
            if not link.is_symlink():
                continue
            target = link.resolve()
            link.unlink()
            if target.is_dir():
                shutil.copytree(target, link, symlinks=True)
            elif target.is_file():
                shutil.copy2(target, link)


# 단계


def install_packages(at: Revision) -> None:
    key = digest(PYTHON_BUILDS[platform.machine()][1], REQUIREMENTS.read_bytes(), at.state) if at.state else None
    if done("packages", key) and (PYTHON / "bin" / "python3").is_file():
        print("  입력이 같아 건너뛴다")
        return
    begin("packages")
    unpack_python(python_archive())
    python = [PYTHON / "bin" / "python3", "-I"]
    pip = [*python, "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "--no-compile"]
    run([*pip, "--require-hashes", "--only-binary", ":all:", "-r", REQUIREMENTS], net="pip")
    shutil.copytree(ROOT / "code_atlas", SITE / "code_atlas", ignore=shutil.ignore_patterns("__pycache__", "_build.json"))
    build = {"commit": at.commit, "built": date.today().isoformat()}
    (SITE / "code_atlas" / "_build.json").write_text(json.dumps(build), encoding="utf-8")
    materialize()
    prune()
    run([*python, "-m", "compileall", "-q", "-j", "0", "--invalidation-mode", "unchecked-hash", PYTHON / "lib"])
    print(f"  묶을 Python {megabytes(PYTHON)}MB: {PYTHON}")
    finish("packages", key)


def build_frontend(at: Revision) -> None:
    lock = digest((FRONTEND / "package-lock.json").read_bytes())
    if done("npm", lock) and (FRONTEND / "node_modules").is_dir():
        print("  package-lock.json이 같아 npm ci를 건너뛴다")
    else:
        begin("npm")
        run(["npm", "ci"], cwd=FRONTEND, net="npm")
        finish("npm", lock)
    if done("dist", at.state) and (FRONTEND / "dist" / "index.html").is_file():
        print("  입력이 같아 화면 빌드를 건너뛴다")
        return
    begin("dist")
    run(["npm", "run", "build"], cwd=FRONTEND)
    finish("dist", at.state)


def build_shell(at: Revision) -> None:
    if done("shell", at.state) and (APP / "Contents" / "MacOS").is_dir():
        print("  입력이 같아 건너뛴다")
        return
    begin("shell")
    built = json.dumps({"build": {"beforeBuildCommand": None}})  # 화면은 앞 단계가 빌드했다
    tauri = ["npm", "run", "tauri", "build", "--", "--bundles", "app", "--no-sign", "--config", "src-tauri/tauri.bundle.json", "--config", built]
    run([*tauri, "--", "--locked"], cwd=FRONTEND, net="cargo")
    if not (APP / "Contents" / "MacOS").is_dir():
        raise Failed(f"빌드가 끝났는데 앱이 없다: {APP}")
    finish("shell", at.state)


def machos(root: Path) -> list[Path]:
    """`root` 아래의 Mach-O 파일. 앞 네 바이트가 Mach-O의 것인 파일만 `file`에 물어 판정한다."""
    maybe = []
    for folder, _, names in os.walk(root):
        for path in (Path(folder) / name for name in names):
            if not path.is_symlink():
                with path.open("rb") as file:
                    if file.read(4) in MACHO_MAGICS:
                        maybe.append(str(path))
    told = subprocess.run(["file", "-0", "-f", "-"], input="\n".join(maybe), capture_output=True, text=True, errors="replace").stdout
    found = {name for name, _, kind in (line.partition("\0") for line in told.splitlines()) if "Mach-O" in kind}
    return sorted(Path(name) for name in found.intersection(maybe))


def sign(path: Path, identity: str = "-", options: list[str] | tuple[str, ...] = ()) -> None:
    """`path`를 `identity`로 서명한다. `-`는 임시 서명이다."""
    run(["codesign", "--force", "--sign", identity, *options, path], show=False)


def sign_app(identity: str, dmg: bool) -> None:
    key = digest(identity)
    if done("sign", key):
        print("  입력이 같아 서명을 건너뛴다")
    else:
        begin("sign")
        inside = sorted(machos(APP), key=lambda path: len(path.parts), reverse=True)
        for path in inside:
            sign(path, identity)
        sign(APP, identity)
        print(f"  Mach-O 파일 {len(inside)}개와 {APP.name}을 서명했다")
        finish("sign", key)
    if dmg:
        stage = DMG.parent / "stage"
        shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir(parents=True)
        try:
            run(["ditto", APP, stage / APP.name])
            (stage / "Applications").symlink_to("/Applications")
            run(["hdiutil", "create", "-volname", "Atlas", "-format", "UDZO", "-srcfolder", stage, "-ov", DMG])
        finally:
            shutil.rmtree(stage, ignore_errors=True)


def quarantined(bundle: Path) -> list[Path]:
    """`bundle`과 그 아래에서 격리 속성(`com.apple.quarantine`)이 붙은 경로."""
    told = read(["xattr", "-r", "-l", bundle]) or ""
    return [Path(line.split(": com.apple.quarantine:", 1)[0]) for line in told.splitlines() if ": com.apple.quarantine:" in line]


def check_app(app: Path, dmg: Path | None = None) -> None:
    """`app`이 이 Mac에서 실행 차단 없이 열리고 묶은 Python과 node가 실행되는지 본다. 어긋난 것을 모아 `Failed`를 낸다.

    격리 속성은 묶음 자신과 실행되는 파일(Mach-O)에 붙었을 때 실행을 막는다. 그 밖의 파일에 붙은 것은 적기만 한다.
    """
    if not (app / "Contents" / "MacOS").is_dir():
        raise Failed(f"만들어 둔 앱이 없다: {app}")
    python = app / "Contents" / "Resources" / "python"
    node = python / SITE.relative_to(PYTHON) / "nodejs_wheel" / "bin" / "node"
    inside = machos(app)
    marked = quarantined(app) + (quarantined(dmg) if dmg is not None else [])
    blocking = [path for path in marked if path in (app, dmg, *inside)]
    wrong = [f"격리 속성(com.apple.quarantine)이 붙어 있다: {path}" for path in blocking]
    sealed = subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], capture_output=True, text=True, errors="replace")
    if sealed.returncode:
        wrong.append(f"묶음 서명이 맞지 않는다: {sealed.stderr.strip()}")
    unsigned = [path for path in inside if subprocess.run(["codesign", "--verify", "--strict", str(path)], capture_output=True).returncode]
    wrong.extend(f"서명되지 않은 Mach-O 파일: {path}" for path in unsigned)
    if read([python / "bin" / "python3", "-I", "-B", "-c", "import code_atlas.cli, basedpyright, nodejs_wheel"]) is None:
        wrong.append("묶은 Python이 code_atlas.cli, basedpyright, nodejs_wheel을 불러오지 못했다")
    told = read([node, "--version"])
    if told is None:
        wrong.append(f"묶은 node가 실행되지 않는다: {node}")
    if wrong:
        raise Failed("\n  ".join(["판정을 통과하지 못했다", *wrong]))
    print(f"  묶음과 Mach-O 파일 {len(inside)}개에 격리 속성 없음, 묶음 서명 맞음, Mach-O 파일 모두 서명됨, 묶은 Python과 node {told} 실행됨")
    for path in marked:
        print(f"  실행되지 않는 파일에 격리 속성이 붙어 있다: {path}")
    print(f"  {app} {megabytes(app)}MB (묶은 Python {megabytes(python)}MB, 그 안의 node {megabytes(node)}MB)")
    if dmg is not None:
        print(f"  {dmg} {megabytes(dmg)}MB")


def running(app: Path) -> bool:
    return read(["pgrep", "-f", f"^{re.escape(str(app))}/Contents/MacOS/"]) is not None


def install(app: Path, destination: Path) -> None:
    """`app`을 `destination`에 놓는다. 그곳의 앱이 떠 있으면 놓지 않는다."""
    if running(destination):
        raise Failed(f"{destination}이 떠 있다. 앱을 끝낸 뒤 같은 명령을 다시 실행한다")
    fresh, old = (destination.with_name(f".{destination.name}.{tag}") for tag in ("new", "old"))
    for leftover in (fresh, old):
        shutil.rmtree(leftover, ignore_errors=True)
    run(["ditto", app, fresh])
    if destination.exists():
        destination.rename(old)
    fresh.rename(destination)
    shutil.rmtree(old, ignore_errors=True)
    check_app(destination)
    print(f"  놓았다: {destination}\n  여는 방법: open -a {shlex.quote(destination.stem)}")


def place_app(install_it: bool, dmg: bool) -> None:
    if install_it:
        install(APP, INSTALLED)
        return
    print(f"  만든 앱: {APP}")
    if dmg:
        print(f"  만든 .dmg: {DMG}")
    print(f"  놓으려면 --install을 붙여 다시 실행하거나: rm -rf {INSTALLED} && ditto {shlex.quote(str(APP))} {INSTALLED}")


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="레포를 받은 Mac에서 Atlas 앱을 만든다")
    p.add_argument("--doctor", action="store_true", help="빌드 전 점검만 한다")
    p.add_argument("--install", action="store_true", help=f"만든 앱을 {INSTALLED}에 놓는다")
    p.add_argument("--dmg", action="store_true", help=".dmg도 만든다")
    p.add_argument("--check", action="store_true", help="만들어 둔 앱에 판정만 다시 돌린다")
    p.add_argument("--clean", action="store_true", help="표식과 묶을 Python 폴더를 지우고 처음부터 한다")
    p.add_argument("--sign", choices=["adhoc", "developer-id"], default="adhoc", help="서명 방식. 이번 판은 adhoc(임시 서명)만 만든다")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.sign != "adhoc":
        print("이번 판은 임시 서명만 만든다. --sign adhoc으로 실행한다", file=sys.stderr)
        return 2
    dmg = DMG if args.dmg else None
    at = revision()
    plan = {
        1: doctor,
        2: python_archive,
        3: lambda: install_packages(at),
        4: lambda: build_frontend(at),
        5: lambda: build_shell(at),
        6: lambda: sign_app("-", args.dmg),
        7: lambda: check_app(APP, dmg),
        8: lambda: place_app(args.install, args.dmg),
    }
    numbers = [7] if args.check else [1] if args.doctor else list(plan)
    if args.clean and not (args.check or args.doctor):
        shutil.rmtree(PYEMBED, ignore_errors=True)
    started = time.monotonic()
    for number in numbers:
        label = f"[{number}/{len(STEPS)}] {STEPS[number - 1]}"
        print(label, flush=True)
        began = time.monotonic()
        try:
            plan[number]()
        except Failed as failed:
            report(label, failed, resumes=number > 1 and not args.check)
            return 1
        except KeyboardInterrupt:
            sys.stdout.flush()
            print(f"\n{label}에서 끊었다. {RESUME}", file=sys.stderr)
            return 130
        print(f"  {time.monotonic() - began:.0f}초", flush=True)
    if len(numbers) > 1:
        print(f"끝났다. 모두 {time.monotonic() - started:.0f}초")
    return 0


def report(label: str, failed: Failed, resumes: bool) -> None:
    """실패한 단계, 까닭, 실패한 명령과 그 명령이 낸 마지막 줄들, 망 문제로 보이면 관련 설정의 이름을 표준 오류에 적는다."""
    lines = [f"{label}에서 실패했다: {failed.reason}"]
    if failed.command is not None:
        lines.append(f"  명령: {shlex.join(failed.command)}")
        lines.extend(["  마지막 출력:", *(f"    {line}" for line in failed.tail)])
    if failed.net is not None and NETWORK_TROUBLE.search("\n".join(failed.tail)):
        lines.append(f"  망 문제로 보인다. 이 Mac의 설정을 확인한다: {NETWORK_SETTINGS[failed.net]}")
    if resumes:
        lines.append(f"  {RESUME}")
    sys.stdout.flush()
    print("\n".join(lines), file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
