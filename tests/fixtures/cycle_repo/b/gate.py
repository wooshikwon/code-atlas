from a.bridge import cross


def enter(n: int) -> int:
    return cross(n) if n > 5 else n
