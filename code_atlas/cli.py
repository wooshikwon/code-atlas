"""code-atlas 명령. `code-atlas [레포]`는 화면 서버를 띄워 분석을 뒤에서 돌리고, `code-atlas analyze <레포>`는 결과만 출력한다.

레포를 주지 않으면 서버가 연 레포 없이 뜬다. `--hosted`는 앱 껍데기가 띄우는 실행이고, 주소를 표준 출력에 JSON 한 줄로
쓰며 표준 입력이 닫히면 끝난다.
"""

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
from .settings import Settings
from .summary import STYLE_GUIDE_ENV, find_style_guide


NO_CACHE_HELP = "저장해 둔 분석 결과를 읽지 않고 레포 전체를 다시 분석해 덮어쓴다"
# `--hosted` 실행이 끝날 때 응답하는 중인 요청을 기다리는 시간. 앱 껍데기는 표준 입력을 닫은 뒤 10초를 기다리고 그 시간의
# 대부분은 언어 서버를 닫는 데 쓴다.
HOSTED_GRACE = 1


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

    sock = _bind_or_exit(args.port)
    python = _python_or_exit(args.repo, args.python) if args.repo is not None else None
    url = f"http://{HOST}:{sock.getsockname()[1]}"

    app = create_app(
        args.repo,
        python,
        None if args.hosted else _print_summary,
        find_style_guide(args.style_guide),
        cache=not args.no_cache,
        settings=Settings(),
        origin=args.origin,
    )

    class Server(uvicorn.Server):
        async def startup(self, sockets=None) -> None:
            """서버가 요청을 받기 시작하면 분석을 기다리지 않고 브라우저를 연다. `--hosted`면 주소를 쓰고 표준 입력을 지켜본다."""
            await super().startup(sockets)
            if self.should_exit:
                return
            if args.hosted:
                print(json.dumps({"url": url}), flush=True)
                threading.Thread(target=self.exit_when_stdin_closes, daemon=True).start()
            elif args.no_open or (sys.platform.startswith("linux") and not os.environ.get("DISPLAY")):
                print(f"주소: {url}", flush=True)
            else:
                threading.Thread(target=webbrowser.open, args=[url], daemon=True).start()

        def exit_when_stdin_closes(self) -> None:
            """표준 입력이 닫힐 때까지 읽고 서버를 끝낸다. 앱 껍데기가 끝나거나 죽으면 운영체제가 파이프를 닫는다."""
            try:
                while os.read(0, 4096):
                    pass
            except OSError:
                pass
            self.should_exit = True

    grace = HOSTED_GRACE if args.hosted else None
    Server(uvicorn.Config(app, log_level="warning", timeout_graceful_shutdown=grace)).run(sockets=[sock])
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
    p.add_argument("repo", nargs="?", help="주지 않으면 연 레포 없이 뜨고 화면에서 폴더를 골라 연다")
    p.add_argument("--python", help="대상 레포의 파이썬 인터프리터 경로")
    p.add_argument("--port", type=int, default=PORT, help="0이면 비어 있는 포트를 잡는다")
    p.add_argument("--no-open", action="store_true", help="브라우저를 열지 않는다")
    p.add_argument("--no-cache", action="store_true", help=NO_CACHE_HELP)
    p.add_argument(
        "--style-guide",
        help=f"LLM 요약의 문체를 정하는 서술 규약 문서 경로. 주지 않으면 환경 변수 {STYLE_GUIDE_ENV}를 읽는다",
    )
    p.add_argument(
        "--hosted",
        action="store_true",
        help="앱 껍데기가 띄우는 실행. 브라우저를 열지 않고 주소를 JSON 한 줄로 쓰며 표준 입력이 닫히면 끝난다",
    )
    p.add_argument("--origin", help="이 출처의 화면이 보내는 요청을 받는다")
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
