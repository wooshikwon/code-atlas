"""순환 의존을 담은 고정 레포의 진입점."""

from a.one import first
from b.gate import enter
from b.lazy import late


def run() -> int:
    return first(3) + enter(8) + late(2)


if __name__ == "__main__":
    run()
