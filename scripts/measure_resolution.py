"""호출 지점의 basedpyright 해석 결과를 표본으로 뽑아 직접 확인한 대상과 대조한다.

    measure_resolution.py <레포> [--seed 0] [--n 100] [--out PATH] [--force]
    measure_resolution.py --report [--out PATH]

첫 형식은 분석을 돌려 `status: builtin`을 뺀 호출 지점의 상태별 비율을 출력하고, 고정 시드로 뽑은 표본을
한 줄에 지점 하나씩 JSONL로 쓴다. 표본 줄의 `manual_target`·`verdict`·`manual_note`·`reason`은 비워 두고
코드를 읽어 직접 채운다. `--report`는 채운 JSONL을 읽어 일치율, 불일치 목록, 미확인 사유별 수를 마크다운 표로 출력한다.

verdict 값은 세 가지다. `match`는 basedpyright 대상과 직접 확인한 대상이 같고, `mismatch`는 둘이 다르다.
`unresolved`는 basedpyright가 대상을 내지 못한 지점이고, 그 이유를 `reason`에 적는다.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

from code_atlas.analyze import analyze
from code_atlas.resolve import STATUSES

DEFAULT_OUT = Path.home() / "data" / "code-atlas" / "resolution-sample.jsonl"
VERDICTS = ("match", "mismatch", "unresolved")


def _sample(repo: str, seed: int, n: int, out: Path, force: bool) -> int:
    if out.exists() and not force:
        print(f"{out}가 이미 있다. 직접 채운 판정을 덮어쓰려면 --force를 준다.", file=sys.stderr)
        return 2
    analysis, files = analyze(repo)
    calls = [s for s in analysis.sites if s.kind == "call" and s.status != "builtin"]
    counts = Counter(s.status for s in calls)
    print(f"호출 지점 {len(calls)}개 (builtin 제외)")
    for status in STATUSES:
        if status != "builtin" and counts[status]:
            print(f"  {status:<10} {counts[status]:>5}  {counts[status] / len(calls) * 100:5.1f}%")

    lines: dict[str, list[str]] = {}
    chosen = sorted(random.Random(seed).sample(calls, min(n, len(calls))), key=lambda s: (s.path, s.line, s.col))
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as fh:
        for i, site in enumerate(chosen, 1):
            if site.path not in lines:
                lines[site.path] = (files.root / site.path).read_text(encoding="utf-8").splitlines()
            row = {
                "id": i,
                "path": site.path,
                "line": site.line,
                "code": lines[site.path][site.line - 1].strip(),
                "callee": site.text,
                "enclosing": site.enclosing,
                "status": site.status,
                "pyright_target": site.target,
                "manual_target": None,
                "verdict": None,
                "manual_note": None,
                "reason": None,
            }
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"표본 {len(chosen)}개 (시드 {seed}): {out}")
    return 0


def _cell(value: object) -> str:
    return "" if value is None else str(value).replace("|", "\\|")


def _report(out: Path) -> int:
    rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines() if line.strip()]
    blank = [r["id"] for r in rows if r["verdict"] not in VERDICTS]
    if blank:
        print(f"판정이 비었거나 잘못된 표본: {blank}", file=sys.stderr)
        return 1
    verdicts = Counter(r["verdict"] for r in rows)
    judged = verdicts["match"] + verdicts["mismatch"]
    print("| 판정 | 수 | 비율 |\n|---|---|---|")
    for verdict in VERDICTS:
        print(f"| {verdict} | {verdicts[verdict]} | {verdicts[verdict] / len(rows) * 100:.1f}% |")
    if judged:
        print(f"\nbasedpyright가 대상을 낸 지점 {judged}개 가운데 {verdicts['match']}개가 직접 확인한 대상과 같다"
              f" ({verdicts['match'] / judged * 100:.1f}%).")

    mismatches = [r for r in rows if r["verdict"] == "mismatch"]
    if mismatches:
        print("\n| id | 위치 | 호출 | basedpyright 대상 | 직접 확인한 대상 | 근거 |\n|---|---|---|---|---|---|")
        for r in mismatches:
            print(f"| {r['id']} | {r['path']}:{r['line']} | `{_cell(r['callee'])}` | {_cell(r['pyright_target'])}"
                  f" | {_cell(r['manual_target'])} | {_cell(r['manual_note'])} |")

    reasons = Counter(r["reason"] or "(사유 없음)" for r in rows if r["verdict"] == "unresolved")
    if reasons:
        print("\n| 미확인 사유 | 수 |\n|---|---|")
        for reason, count in reasons.most_common():
            print(f"| {_cell(reason)} | {count} |")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="호출 해석률 표본 측정")
    parser.add_argument("repo", nargs="?")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--n", type=int, default=100)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()
    if args.report:
        return _report(args.out)
    if args.repo is None:
        parser.error("레포 경로가 필요하다")
    return _sample(args.repo, args.seed, args.n, args.out, args.force)


if __name__ == "__main__":
    sys.exit(main())
