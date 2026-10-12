"""code-atlas 명령. `code-atlas <레포>`는 화면 서버를 띄워 분석을 뒤에서 돌리고, `code-atlas analyze <레포>`는 결과만 출력한다."""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
import webbrowser

from . import shellenv

# 앱 껍데기가 띄운 실행은 아래의 무거운 import와 함께 로그인 셸의 환경을 읽는다.
if "--hosted" in sys.argv[1:]:
    shellenv.start()

from .analyze import PythonNotFound, analyze, require_python
from .api import HOST, PORT, create_app
from .model import to_dict
from .summary import STYLE_GUIDE_ENV, find_style_guide


NO_CACHE_HELP = "저장해 둔 분석 결과를 읽지 않고 레포 전체를 다시 분석해 덮어쓴다"


def _python_or_exit(repo: str, python: str | None) -> str:
    try:
        return require_python(repo, python)
    except PythonNotFound as exc:
        print(exc, file=sys.stderr)
        sys.exit(2)


def _print_summary(analysis) -> None:
    s = analysis.stats
    rate = s["resolved"] / s["call_sites"] * 100 if s["call_sites"] else 0.0
    print(
        f"노드 {s['nodes']} · 선 {s['edges']} · 지점 {len(analysis.sites)} · "
        f"호출 해석률 {rate:.1f}% ({s['resolved']}/{s['call_sites']}) · {s['elapsed_ms']}ms",
        flush=True,
    )
    if s["timed_out"]:
        print(f"정의 요청 {s['timed_out']}개가 시간 안에 응답받지 못했다", file=sys.stderr)
    for error in analysis.errors:
        print(f"파싱 실패 {error['path']}: {error['message']}", file=sys.stderr)


def _analyze_command(args: argparse.Namespace) -> int:
    analyzed = analyze(args.repo, _python_or_exit(args.repo, args.python), cache=not args.no_cache)
    if args.json:
        json.dump(to_dict(analyzed.analysis), sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        _print_summary(analyzed.analysis)
        print(f"미사용 후보 {len(analyzed.unused.candidates)}개")
    return 0


def _bind_or_exit(port: int) -> socket.socket:
    """포트를 잡는다. 잡지 못하면 서버를 만들기 전에 끝낸다."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((HOST, port))
    except OSError as exc:
        print(f"{HOST}:{port}에 서버를 띄울 수 없다: {exc.strerror}. --port로 다른 포트를 고른다", file=sys.stderr)
        sys.exit(2)
    return sock


def _serve_command(args: argparse.Namespace) -> int:
    import uvicorn

    shellenv.adopt()
    sock = _bind_or_exit(args.port)
    python = _python_or_exit(args.repo, args.python)
    url = f"http://{HOST}:{args.port}"

    app = create_app(args.repo, python, _print_summary, find_style_guide(args.style_guide), cache=not args.no_cache)

    class Server(uvicorn.Server):
        async def startup(self, sockets=None) -> None:
            """서버가 요청을 받기 시작하면 분석을 기다리지 않고 브라우저를 연다."""
            await super().startup(sockets)
            if self.should_exit:
                return
            if args.no_open or (sys.platform.startswith("linux") and not os.environ.get("DISPLAY")):
                print(f"주소: {url}", flush=True)
            else:
                threading.Thread(target=webbrowser.open, args=[url], daemon=True).start()

    Server(uvicorn.Config(app, log_level="warning")).run(sockets=[sock])
    return 0


def _analyze_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="code-atlas analyze", description="레포를 분석해 결과를 출력한다")
    p.add_argument("repo")
    p.add_argument("--python", help="대상 레포의 파이썬 인터프리터 경로")
    p.add_argument("--json", action="store_true", help="분석 결과 전체를 JSON으로 출력한다")
    p.add_argument("--no-cache", action="store_true", help=NO_CACHE_HELP)
    return p


def _serve_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="code-atlas", description="레포를 분석하고 탐색 화면 서버를 띄운다")
    p.add_argument("repo")
    p.add_argument("--python", help="대상 레포의 파이썬 인터프리터 경로")
    p.add_argument("--port", type=int, default=PORT)
    p.add_argument("--no-open", action="store_true", help="브라우저를 열지 않는다")
    p.add_argument("--no-cache", action="store_true", help=NO_CACHE_HELP)
    p.add_argument(
        "--style-guide",
        help=f"LLM 요약의 문체를 정하는 서술 규약 문서 경로. 주지 않으면 환경 변수 {STYLE_GUIDE_ENV}를 읽는다",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    try:
        if argv[:1] == ["analyze"]:
            return _analyze_command(_analyze_parser().parse_args(argv[1:]))
        return _serve_command(_serve_parser().parse_args(argv))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
