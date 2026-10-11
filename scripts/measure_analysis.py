"""레포를 분석하며 단계별 시간, 정의 요청 수, 응답 없음 수를 잰다.

    measure_analysis.py <레포> [--python P] [--runs 3] [--dump 결과.json] [--compare 결과.json]

실행마다 새 언어 서버 세션으로 분석하고 한 줄에 실행 하나씩 JSONL로 표준 출력에 쓴다. `stages_s`는 단계별 초다:
`collect`(파일 수집), `extract`(구조 추출), `start`(언어 서버 기동), `ready`(준비 확인), `requests`(정의 요청),
`resolve`(응답 위치를 노드 id로 바꾸기), `build`(그래프 조립), `unused`(미사용 판정).

`--dump`는 마지막 실행의 분석 결과를 `code-atlas analyze --json`과 같은 JSON으로 쓴다. `--compare`는 그 JSON과
실행마다의 노드, 선, 지점별 판정을 견줘 `compare`에 다른 수를 적고 다른 지점을 표준 오류에 한 줄씩 쓴다.
대상 레포에는 파일을 쓰지 않는다.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from collections import Counter
from pathlib import Path

from code_atlas import analyze as pipeline
from code_atlas.collect import collect
from code_atlas.lsp import Session
from code_atlas.model import to_dict

STAGES = ("extract_repo", "_request_all", "resolve", "build", "candidates")
STAGE_NAMES = {"extract_repo": "extract", "_request_all": "requests", "candidates": "unused"}
JUDGED = ("kind", "path", "line", "col", "enclosing", "text", "status", "target", "edge")


class Clock:
    """`code_atlas.analyze`가 부르는 단계 함수와 세션의 요청을 감싸 걸린 시간과 요청 수를 모은다."""

    def __init__(self) -> None:
        self.stages: dict[str, float] = {}
        self.requests = 0

    def add(self, name: str, started: float) -> None:
        self.stages[name] = round(self.stages.get(name, 0.0) + time.monotonic() - started, 3)

    def timed(self, name: str, fn):
        if asyncio.iscoroutinefunction(fn):

            async def wrapper(*args, **kwargs):
                started = time.monotonic()
                try:
                    return await fn(*args, **kwargs)
                finally:
                    self.add(name, started)

        else:

            def wrapper(*args, **kwargs):
                started = time.monotonic()
                try:
                    return fn(*args, **kwargs)
                finally:
                    self.add(name, started)

        return wrapper

    def watch(self, session: Session) -> None:
        """준비 확인의 시간을 재고, 준비 확인 뒤에 보낸 정의 요청을 센다."""
        definition, wait_ready = session.definition, session.wait_ready

        async def counted(*args, **kwargs):
            self.requests += 1
            return await definition(*args, **kwargs)

        async def ready(probe):
            started = time.monotonic()
            try:
                await wait_ready(probe)
            finally:
                self.add("ready", started)
                self.requests = 0

        session.definition = counted
        session.wait_ready = ready


def _judged(sites: list[dict]) -> list[tuple]:
    return [tuple(s[k] for k in JUDGED) for s in sites]


def _compare(result: dict, expected: dict) -> dict:
    """노드와 선은 다른 개수를, 지점은 판정이 다른 지점 수를 낸다. 다른 지점은 표준 오류에 쓴다."""
    ours, theirs = _judged(result["sites"]), _judged(expected["sites"])
    differ = 0
    for i in range(max(len(ours), len(theirs))):
        a = ours[i] if i < len(ours) else None
        b = theirs[i] if i < len(theirs) else None
        if a != b:
            differ += 1
            print(json.dumps({"site": i, "now": a, "expected": b}, ensure_ascii=False), file=sys.stderr)

    def unequal(key: str) -> int:
        now = Counter(json.dumps(x, sort_keys=True, ensure_ascii=False) for x in result[key])
        then = Counter(json.dumps(x, sort_keys=True, ensure_ascii=False) for x in expected[key])
        return sum(((now - then) + (then - now)).values())

    return {"nodes": unequal("nodes"), "edges": unequal("edges"), "sites": differ}


async def _run(repo: str, python: str, clock: Clock) -> tuple[int, dict]:
    started = time.monotonic()
    files = collect(repo)
    clock.add("collect", started)
    started = time.monotonic()
    session = Session(files.root, python, files.extra_paths)
    async with session:
        clock.add("start", started)
        clock.watch(session)
        analyzed = await pipeline.analyze_async(files, session)
    return len(files.files), to_dict(analyzed.analysis)


def measure(repo: str, python: str) -> tuple[dict, dict]:
    """한 번 분석해 (잰 값, 분석 결과)를 돌려준다."""
    clock = Clock()
    originals = {name: getattr(pipeline, name) for name in STAGES}
    for name, fn in originals.items():
        setattr(pipeline, name, clock.timed(STAGE_NAMES.get(name, name), fn))
    started = time.monotonic()
    try:
        files, result = asyncio.run(_run(repo, python, clock))
    finally:
        for name, fn in originals.items():
            setattr(pipeline, name, fn)
    row = {
        "total_s": round(time.monotonic() - started, 2),
        "stages_s": clock.stages,
        "files": files,
        "nodes": len(result["nodes"]),
        "edges": len(result["edges"]),
        "sites": len(result["sites"]),
        "requests": clock.requests,
        "timed_out": result["stats"]["timed_out"],
        "errors": len(result["errors"]),
        "statuses": dict(sorted(Counter(s["status"] for s in result["sites"]).items())),
    }
    return row, result


def main() -> int:
    parser = argparse.ArgumentParser(description="분석 단계별 시간 측정")
    parser.add_argument("repo")
    parser.add_argument("--python", help="대상 레포의 파이썬 인터프리터 경로")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--dump", type=Path, help="마지막 실행의 분석 결과를 쓸 JSON 경로")
    parser.add_argument("--compare", type=Path, help="견줄 분석 결과 JSON 경로")
    args = parser.parse_args()
    try:
        python = pipeline.require_python(args.repo, args.python)
    except pipeline.PythonNotFound as exc:
        print(exc, file=sys.stderr)
        return 2
    expected = json.loads(args.compare.read_text(encoding="utf-8")) if args.compare else None
    result: dict = {}
    for run in range(1, args.runs + 1):
        row, result = measure(args.repo, python)
        if expected is not None:
            row["compare"] = _compare(result, expected)
        print(json.dumps({"repo": str(Path(args.repo).resolve()), "run": run, **row}, ensure_ascii=False), flush=True)
    if args.dump:
        args.dump.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
