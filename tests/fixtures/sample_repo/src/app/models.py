from dataclasses import dataclass
from enum import Enum
from typing import NamedTuple


@dataclass
class Config:
    name: str
    retries: int = 3


class Point(NamedTuple):
    x: int
    y: int


class Color(Enum):
    RED = 1
    BLUE = 2
