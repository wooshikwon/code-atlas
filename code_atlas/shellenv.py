"""로그인 셸에서 환경 변수를 읽는다.

Finder에서 띄운 앱은 로그인 셸의 `PATH`를 받지 않으므로, 앱 껍데기가 띄운 실행은 서버를 띄우기 전에 사용자 계정의
셸을 한 번 띄워 그 셸이 가진 환경을 읽는다. 읽은 환경을 어디에 쓰는지와 도구를 찾는 순서는 모른다.
"""

from __future__ import annotations

from dataclasses import dataclass

# VS Code가 로그인 셸의 환경을 읽을 때 두는 기본 시간 제한과 같고, 개인 Mac에서 잰 `zsh -ilc`(2.62초)의 네 배다.
TIMEOUT = 10.0


@dataclass
class ShellEnv:
    shell: str  # 셸의 경로
    ok: bool
    detail: str  # 읽지 못한 까닭. 읽었으면 빈 문자열
    seconds: float
    env: dict[str, str] | None


def read(timeout: float = TIMEOUT) -> ShellEnv:
    raise NotImplementedError
