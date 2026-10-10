"""code-atlas 명령. `code-atlas <레포>`는 분석 뒤 화면 서버를 띄우고, `code-atlas analyze <레포>`는 결과만 출력한다."""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
import webbrowser

from .analyze import PythonNotFound, analyze, require_python
from .api import HOST, PORT, create_app
from .model import to_dict


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
        f"호출 해석률 {rate:.1f}% ({s['resolved']}/{s['call_sites']}) · {s['elapsed_ms']}ms"
    )
    if s["timed_out"]:
        print(f"정의 요청 {s['timed_out']}개가 시간 안에 응답받지 못했다", file=sys.stderr)
    for error in analysis.errors:
        print(f"파싱 실패 {error['path']}: {error['message']}", file=sys.stderr)


def _analyze_command(args: argparse.Namespace) -> int:
    analysis, _ = analyze(args.repo, _python_or_exit(args.repo, args.python))
    if args.json:
        json.dump(to_dict(analysis), sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        _print_summary(analysis)
    return 0


def _bind_or_exit(port: int) -> socket.socket:
    """분석에 수십 초가 걸리므로 포트를 먼저 잡아 둔다."""
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

    sock = _bind_or_exit(args.port)
    python = _python_or_exit(args.repo, args.python)
    url = f"http://{HOST}:{args.port}"

    def on_ready(analysis) -> None:
        _print_summary(analysis)
        if args.no_open or (sys.platform.startswith("linux") and not os.environ.get("DISPLAY")):
            print(f"주소: {url}", flush=True)
        else:
            threading.Timer(1.0, webbrowser.open, [url]).start()

    app = create_app(args.repo, python, on_ready)

    class Server(uvicorn.Server):
        def handle_exit(self, sig, frame) -> None:
            """분석이 끝나기 전에 받은 첫 종료 신호에 분석을 끊는다."""
            starting = app.state.starting
            if starting is not None and not self.should_exit and not self.started:
                starting.get_loop().call_soon_threadsafe(starting.cancel)
            super().handle_exit(sig, frame)

    Server(uvicorn.Config(app, log_level="warning")).run(sockets=[sock])
    return 0


def _analyze_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="code-atlas analyze", description="레포를 분석해 결과를 출력한다")
    p.add_argument("repo")
    p.add_argument("--python", help="대상 레포의 파이썬 인터프리터 경로")
    p.add_argument("--json", action="store_true", help="분석 결과 전체를 JSON으로 출력한다")
    return p


def _serve_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="code-atlas", description="레포를 분석하고 탐색 화면 서버를 띄운다")
    p.add_argument("repo")
    p.add_argument("--python", help="대상 레포의 파이썬 인터프리터 경로")
    p.add_argument("--port", type=int, default=PORT)
    p.add_argument("--no-open", action="store_true", help="브라우저를 열지 않는다")
    return p


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["analyze"]:
        return _analyze_command(_analyze_parser().parse_args(argv[1:]))
    return _serve_command(_serve_parser().parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
