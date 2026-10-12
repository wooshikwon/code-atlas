"""두 시점의 비교가 응답하기까지의 시간, 정의 요청 수, 응답 없음 수, 바뀐 노드와 선의 수를 잰다.

    measure_compare.py <레포> <기준> [대상] [--python P] [--runs 3] [--cold] [--cache-dir 폴더]

`<기준>`과 `[대상]`은 커밋(해시, 브랜치, `HEAD~1` 같은 이름)이고 대상을 주지 않으면 작업 중인 상태다. 실행마다 앱을 새로
만들어 첫 분석이 끝나기를 기다린 뒤 `/api/history`, `/api/compare/stat`, `POST /api/compare`를 부르고 한 줄에 실행
하나씩 JSONL로 표준 출력에 쓴다. 포트를 여는 서버는 띄우지 않는다.

분석 캐시는 `--cache-dir`(주지 않으면 `~/.cache/code-atlas`)에 있는 그 레포의 캐시 파일을 임시 폴더로 복사해 쓰고,
요약 캐시도 임시 폴더에 둔다. `--cold`는 실행마다 복사본에서 두 시점의 판정을 지운 뒤 재서 캐시에 없는 시점의 처음 비교를
잰다. `--cold`가 없으면 재기 전에 비교를 한 번 돌려 복사본에 두 시점을 저장해 두고, 실행마다 새로 만든 앱이 캐시에 있는
시점을 조립하는 시간을 잰다. `sessions`는 과거 시점의 분석이 띄운 언어 서버의 수이고 캐시에 있는 시점에서는 0이다.
`again_s`는 같은 앱에 같은 비교를 다시 요청한 시간이다. 대상 레포에는 읽는 git 명령만 쓰고 파일을 쓰지 않는다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

from fastapi.testclient import TestClient

from code_atlas import cache, snapshot, summary
from code_atlas.api import create_app
from code_atlas.collect import disk_path
from code_atlas.git import WORKTREE

READY_TIMEOUT = 600


class Counted(snapshot.Session):
    """과거 시점의 분석이 띄운 언어 서버와 준비 확인 뒤에 보낸 정의 요청을 센다."""

    sessions = 0
    requests = 0

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        Counted.sessions += 1

    async def wait_ready(self, probe):
        await super().wait_ready(probe)
        self._counting = True

    async def definition(self, *args, **kwargs):
        if getattr(self, "_counting", False):
            Counted.requests += 1
        return await super().definition(*args, **kwargs)


def resolved(repo: Path, name: str) -> str:
    """커밋의 이름을 40자 해시로 바꾼다. 작업 중인 상태는 그대로 둔다."""
    if name == WORKTREE:
        return name
    found = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--verify", f"{name}^{{commit}}"],
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
        capture_output=True,
        text=True,
        check=True,
    )
    return found.stdout.strip()


def forget(directory: Path, commits: list[str]) -> None:
    """`directory`의 캐시 파일에서 그 시점의 판정을 지운다."""
    for path in directory.glob("analysis-*.db"):
        with closing(sqlite3.connect(path)) as db, db:
            for commit in commits:
                db.execute("DELETE FROM answers WHERE snapshot = ?", (commit,))
                db.execute("DELETE FROM snapshots WHERE name = ?", (commit,))


def timed(call) -> tuple[float, object]:
    started = time.monotonic()
    result = call()
    return round(time.monotonic() - started, 3), result


def measure(repo: Path, python: str | None, base: str, target: str) -> dict:
    """앱을 새로 만들어 비교를 한 번 잰다."""
    Counted.sessions = Counted.requests = 0
    with TestClient(create_app(repo, python)) as client:
        deadline = time.monotonic() + READY_TIMEOUT
        while True:
            status = client.get("/api/status").json()
            if status["error"] is not None:
                raise RuntimeError(status["error"])
            if status["revision"] > 0 and not status["draft"] and status["phase"] == "ready":
                break
            if time.monotonic() > deadline:
                raise TimeoutError("첫 분석이 끝나지 않았다")
            time.sleep(0.2)
        history_s, _ = timed(lambda: client.get("/api/history").json())
        stat_s, stat = timed(lambda: client.get("/api/compare/stat", params={"a": base, "b": target}).json())
        ends = {"base": stat["base"], "target": stat["target"]}
        compare_s, response = timed(lambda: client.post("/api/compare", json=ends))
        response.raise_for_status()
        body = response.json()
        again_s, _ = timed(lambda: client.post("/api/compare", json=ends))
        held = [client.app.state.snapshots.held(name) for name in ends.values() if name != WORKTREE]
        timed_out = sum(analyzed.analysis.stats["timed_out"] for analyzed in held if analyzed is not None)
    nodes = [change["change"] for change in body["nodes"].values()]
    edges = [change["change"] for change in body["edges"].values()]
    return {
        "base": stat["base"],
        "target": stat["target"],
        "fork": stat["fork"],
        "history_s": history_s,
        "stat_s": stat_s,
        "compare_s": compare_s,
        "again_s": again_s,
        "sessions": Counted.sessions,
        "requests": Counted.requests,
        "timed_out": timed_out,
        "files": len(body["files"]),
        "added_lines": sum(f["added"] for f in body["files"]),
        "deleted_lines": sum(f["deleted"] for f in body["files"]),
        "nodes": {kind: nodes.count(kind) for kind in ("added", "deleted", "modified")},
        "edges": {"added": edges.count("added"), "deleted": edges.count("deleted"), "recounted": edges.count(None)},
        "bytes": len(response.content),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="시점 비교의 시간 측정")
    parser.add_argument("repo")
    parser.add_argument("base", help="기준 커밋")
    parser.add_argument("target", nargs="?", default=WORKTREE, help="대상 커밋. 주지 않으면 작업 중인 상태")
    parser.add_argument("--python", help="대상 레포의 파이썬 인터프리터 경로")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--cold", action="store_true", help="실행마다 캐시의 복사본에서 두 시점을 지운 뒤 잰다")
    parser.add_argument("--cache-dir", type=Path, help="복사할 분석 캐시 파일이 있는 폴더")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    commits = [resolved(repo, name) for name in (args.base, args.target)]
    source = args.cache_dir or cache.CACHE_DIR
    name = f"analysis-{hashlib.sha256(str(disk_path(repo)).encode()).hexdigest()[:16]}.db"
    snapshot.Session = Counted
    with tempfile.TemporaryDirectory(prefix="code-atlas-measure-") as scratch:
        directory = Path(scratch)
        for suffix in ("", "-wal", "-shm"):
            if (source / f"{name}{suffix}").exists():
                shutil.copy2(source / f"{name}{suffix}", directory / f"{name}{suffix}")
        cache.CACHE_DIR = directory
        summary.CACHE_PATH = directory / "summaries.db"
        if not args.cold:
            measure(repo, args.python, *commits)
        for _ in range(args.runs):
            if args.cold:
                forget(directory, [commit for commit in commits if commit != WORKTREE])
            print(json.dumps(measure(repo, args.python, *commits), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
