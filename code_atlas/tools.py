"""`claude`, `git`, 대상 레포의 파이썬 인터프리터를 찾는다.

세 도구를 같은 규칙으로 찾는다. 후보를 저장한 경로, 환경, 알려진 위치 순서로 만들고, 후보마다 확인 명령을 실제로
실행해 처음 통과한 것을 쓰며, 시도한 후보를 모두 기록한다. 도구마다 다른 것은 후보를 내는 함수와 확인 함수뿐이다.
도구가 내는 결과의 뜻(요약, 커밋 목록)과 화면은 모른다.

설정 파일에서는 저장한 경로만 읽는다. `settings.tool("claude")`·`settings.tool("git")`이 사용자가 고른 실행 파일의
경로를, `settings.python(root)`가 그 레포 루트에 고른 인터프리터의 경로를 내고 없으면 None이다.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .settings import Settings

SAVED = "saved"
ENV = "env"
KNOWN = "known"


@dataclass
class Attempt:
    """후보 하나를 시도한 기록."""

    source: str  # saved·env·known
    path: str | None  # 후보의 경로. 경로를 내지 못한 시도(관리자 명령이 없음)는 None이다
    ok: bool
    detail: str  # 판 번호나 통과하지 못한 까닭


@dataclass
class Found:
    """도구 하나를 찾은 결과."""

    tool: str  # claude·git·python
    path: str | None  # 확인을 통과한 경로. 없으면 None
    version: str | None
    source: str | None  # 통과한 후보의 출처
    attempts: list[Attempt]
    note: str | None = None  # 경로는 통과했지만 쓰지 못하는 까닭(로그인돼 있지 않다)
    auth: str | None = None  # claude만: CLI가 알려 준 로그인 방법
    prefix: str | None = None  # python만: sys.prefix
    venv: bool | None = None  # python만: 가상환경인지


def claude(settings: Settings | None = None) -> Found:
    """Claude Code CLI. 찾은 뒤 로그인 여부를 확인해 `note`와 `auth`에 적는다."""
    raise NotImplementedError


def git(settings: Settings | None = None) -> Found:
    raise NotImplementedError


def python(repo: Path, given: str | None = None, settings: Settings | None = None) -> Found:
    """레포의 인터프리터. `given`은 `--python`에 준 값이고 그 실행에서만 저장한 경로로 쓴다."""
    raise NotImplementedError


def interpreters() -> list[Found]:
    """인터프리터를 고르는 화면의 후보. 확인을 통과한 것만 낸다."""
    raise NotImplementedError


def fresh(tool: str | None = None) -> None:
    """메모리의 값을 버린다. `tool`을 주지 않으면 모든 도구의 값을 버린다."""
    raise NotImplementedError
