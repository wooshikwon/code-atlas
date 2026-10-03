"""code-atlas 명령."""

from __future__ import annotations

import argparse
import json
import sys

from .analyze import PythonNotFound, analyze
from .model import to_dict


def _analyze_command(args: argparse.Namespace) -> int:
    try:
        analysis, _ = analyze(args.repo, args.python)
    except PythonNotFound as exc:
        print(exc, file=sys.stderr)
        return 2
    if args.json:
        json.dump(to_dict(analysis), sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    s = analysis.stats
    rate = s["resolved"] / s["call_sites"] * 100 if s["call_sites"] else 0.0
    print(
        f"노드 {s['nodes']} · 선 {s['edges']} · 지점 {len(analysis.sites)} · "
        f"호출 해석률 {rate:.1f}% ({s['resolved']}/{s['call_sites']}) · {s['elapsed_ms']}ms"
    )
    for error in analysis.errors:
        print(f"파싱 실패 {error['path']}: {error['message']}", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="code-atlas")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("analyze", help="레포를 분석해 결과를 출력한다")
    p.add_argument("repo")
    p.add_argument("--python", help="대상 레포의 파이썬 인터프리터 경로")
    p.add_argument("--json", action="store_true", help="분석 결과 전체를 JSON으로 출력한다")
    p.set_defaults(func=_analyze_command)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
