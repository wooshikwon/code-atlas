"""함수 안 import로만 돌아오는 두 파일: b/lazy.py → c/far.py는 함수 안 import다."""


def late(n: int) -> int:
    from c.far import far

    return far(n)
