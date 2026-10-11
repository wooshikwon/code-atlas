from app import lookup, tables
from app.tables import LIMITS, dispatch, label, remember


def test_tables():
    assert dispatch("say", label("x"))
    assert remember("1")
    assert lookup.lowest() < lookup.highest() == LIMITS["high"]
    assert lookup.Window().size
    lookup.reset()
    tables.total = 1
