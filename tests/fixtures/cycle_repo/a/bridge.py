"""폴더 두 개에 걸친 묶음: a/bridge.py ↔ b/gate.py."""

import b.gate


def cross(n: int) -> int:
    return b.gate.enter(n - 5)
