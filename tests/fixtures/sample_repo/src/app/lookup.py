from app import tables
from app.tables import LIMITS


def lowest():
    return LIMITS["low"]


def highest():
    return tables.LIMITS["high"]


def reset():
    tables.total = 0


class Window:
    size = LIMITS["high"]
