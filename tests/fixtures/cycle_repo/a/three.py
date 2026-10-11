import a.one


def third(n: int) -> int:
    return n if n < 1 else a.one.first(n - 1)
