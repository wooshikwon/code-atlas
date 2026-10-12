"""연 레포의 목록과 사용자가 직접 고른 도구의 경로를 JSON 파일 하나에 담는다.

파일은 `{"repos": [{"root", "python", "opened"}], "tools": {"claude", "git"}}` 모양이다. CLI와 앱이 같은 파일을 나눠
쓰므로 값을 메모리에 두지 않고 읽을 때마다 파일을 읽는다. 어느 폴더를 레포로 여는지와 도구를 찾는 순서는 이 모듈이 모른다.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

SETTINGS_PATH = Path.home() / ".config" / "code-atlas" / "settings.json"


@dataclass
class Repo:
    """연 레포 하나. `python`은 사용자가 직접 고른 인터프리터의 경로이고 고른 적이 없으면 None이다."""

    root: str
    python: str | None
    opened: float  # 마지막으로 연 시각(epoch 초)


class Settings:
    """설정 파일 하나.

    쓸 때는 임시 파일에 쓴 뒤 이름을 바꾼다. 읽지 못하는 파일은 `settings.json.broken`으로 옮기고 빈 설정으로 시작한다.
    쓰지 못한 저장은 경고만 남긴다.
    """

    def __init__(self, path: Path | None = None):
        self.path = Path(path or SETTINGS_PATH)
        self._lock = threading.Lock()

    def _read(self) -> dict:
        try:
            found = json.loads(self.path.read_text(encoding="utf-8"))
            repos = [asdict(Repo(r["root"], r.get("python"), float(r["opened"]))) for r in found.get("repos", [])]
            tools = {name: str(path) for name, path in found.get("tools", {}).items()}
        except (FileNotFoundError, NotADirectoryError):
            return {"repos": [], "tools": {}}
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            logger.warning("설정 파일을 읽지 못해 %s.broken으로 옮겼다", self.path)
            try:
                os.replace(self.path, f"{self.path}.broken")
            except OSError:
                pass
            return {"repos": [], "tools": {}}
        return {"repos": repos, "tools": tools}

    def _write(self, found: dict) -> None:
        temporary = self.path.with_name(f"{self.path.name}.{os.getpid()}.tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps(found, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temporary, self.path)
        except OSError as exc:
            logger.warning("설정 파일을 쓰지 못했다: %s", exc)
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def repos(self) -> list[Repo]:
        """연 레포의 목록. 마지막으로 연 레포가 앞이다."""
        with self._lock:
            found = [Repo(**r) for r in self._read()["repos"]]
        return sorted(found, key=lambda r: r.opened, reverse=True)

    def python(self, root: str | Path) -> str | None:
        """그 레포에 사용자가 직접 고른 인터프리터의 경로. 없으면 None이다."""
        return next((r.python for r in self.repos() if r.root == str(root)), None)

    def opened(self, root: str | Path, python: str | None = None) -> None:
        """레포를 지금 연 것으로 적는다. `python`을 주면 그 레포의 인터프리터로 저장하고, 주지 않으면 저장해 둔 값을 그대로 둔다."""
        with self._lock:
            found = self._read()
            kept = next((r["python"] for r in found["repos"] if r["root"] == str(root)), None)
            found["repos"] = [r for r in found["repos"] if r["root"] != str(root)]
            found["repos"].append(asdict(Repo(str(root), python or kept, time.time())))
            self._write(found)

    def forget(self, root: str | Path) -> None:
        """레포를 목록에서 지운다. 저장해 둔 인터프리터도 함께 지운다."""
        with self._lock:
            found = self._read()
            found["repos"] = [r for r in found["repos"] if r["root"] != str(root)]
            self._write(found)

    def tool(self, name: str) -> str | None:
        """사용자가 직접 고른 도구(`claude`·`git`)의 경로. 없으면 None이다."""
        with self._lock:
            return self._read()["tools"].get(name)

    def keep_tool(self, name: str, path: str | None) -> None:
        """도구의 경로를 저장한다. `path`가 None이면 저장해 둔 경로를 지운다."""
        with self._lock:
            found = self._read()
            if path is None:
                found["tools"].pop(name, None)
            else:
                found["tools"][name] = path
            self._write(found)
