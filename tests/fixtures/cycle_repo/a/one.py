"""같은 폴더의 파일 세 개가 도는 묶음: one → two → three → one."""

from a.two import second


def first(n: int) -> int:
    return second(n) + 1
