"""이력이 있는 고정 레포를 만든다.

`fixtures/history_repo/steps.json`이 적은 단계마다 그 단계의 폴더를 덮어쓰고 커밋한다. 이력은 함수 본문 수정, 줄만
밀린 함수, 함수의 추가와 삭제, 호출 관계의 추가와 삭제, 호출 수만 달라진 관계, 파일의 삭제와 이름 변경, 갈라졌다가
합쳐진 브랜치(`feature`)와 합쳐지지 않은 브랜치(`topic`), 태그 하나를 담고, 마지막에 커밋하지 않은 수정과 추적하지
않는 새 파일을 남긴다. 작성자와 날짜를 고정하고 사용자의 git 설정을 읽지 않으므로 커밋 해시가 실행마다 같다.

`python -m tests.history {dest}`로도 부른다.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HISTORY_FIXTURE = Path(__file__).parent / "fixtures" / "history_repo"
STARTED = 1_750_000_000  # 첫 커밋의 유닉스 시각. 단계마다 한 시간씩 뒤다


def run(repo: Path, *args: str, time: int = STARTED) -> str:
    """사용자와 시스템의 git 설정, 훅, 서명 없이 git 명령을 부르고 출력을 돌려준다."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_NOSYSTEM="1",
        GIT_AUTHOR_NAME="history",
        GIT_AUTHOR_EMAIL="history@example.com",
        GIT_COMMITTER_NAME="history",
        GIT_COMMITTER_EMAIL="history@example.com",
        GIT_AUTHOR_DATE=f"{time} +0000",
        GIT_COMMITTER_DATE=f"{time} +0000",
    )
    command = ["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, "-c", "commit.gpgsign=false", *args]
    return subprocess.run(command, check=True, capture_output=True, text=True, env=env).stdout.strip()


def build(dest: Path) -> dict[str, str]:
    """`dest`에 고정 레포를 만들고 단계 이름표별 커밋 해시를 돌려준다. `dest`는 없거나 빈 폴더여야 한다."""
    plan = json.loads((HISTORY_FIXTURE / "steps.json").read_text(encoding="utf-8"))
    dest.mkdir(parents=True, exist_ok=True)
    run(dest, "init", "-q", "--template=", "-b", plan["steps"][0]["branch"])
    hashes: dict[str, str] = {}
    branches: set[str] = set()
    for i, step in enumerate(plan["steps"]):
        time = STARTED + 3600 * i
        if step["branch"] in branches:
            run(dest, "checkout", "-q", step["branch"])
        elif branches:
            run(dest, "checkout", "-q", "-b", step["branch"], hashes[step["from"]])
        branches.add(step["branch"])
        if "merge" in step:
            run(dest, "merge", "-q", "--no-ff", "-m", step["message"], step["merge"], time=time)
        else:
            for old, new in step.get("rename", []):
                run(dest, "mv", old, new)
            for path in step.get("delete", []):
                run(dest, "rm", "-q", path)
            shutil.copytree(HISTORY_FIXTURE / step["folder"], dest, dirs_exist_ok=True)
            run(dest, "add", "-A")
            run(dest, "commit", "-q", "-m", step["message"], time=time)
        hashes[step["label"]] = run(dest, "rev-parse", "HEAD")
    for name, label in plan["tags"].items():
        run(dest, "tag", name, hashes[label])
    run(dest, "checkout", "-q", plan["head"])
    shutil.copytree(HISTORY_FIXTURE / plan["worktree"], dest, dirs_exist_ok=True)
    return hashes


if __name__ == "__main__":
    print(json.dumps(build(Path(sys.argv[1])), ensure_ascii=False, indent=2))
