"""대상 레포의 파이썬 인터프리터를 찾는다."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def find(repo: str | Path) -> str | None:
    """`.venv`, `venv`, poetry 환경 순서로 인터프리터를 찾는다. 없으면 None이다."""
    root = Path(repo).resolve()
    for name in (".venv", "venv"):
        python = root / name / "bin" / "python"
        if python.exists():
            return str(python)
    if (root / "poetry.lock").exists() and shutil.which("poetry"):
        try:
            out = subprocess.run(
                ["poetry", "env", "info", "-p"], cwd=root, capture_output=True, text=True, timeout=30
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        python = Path(out.stdout.strip()) / "bin" / "python"
        if out.returncode == 0 and python.exists():
            return str(python)
    return None
