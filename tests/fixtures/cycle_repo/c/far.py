from b.lazy import late


def far(n: int) -> int:
    return n if n < 1 else late(n - 1)
