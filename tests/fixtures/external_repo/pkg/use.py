from pkg import Thing
from pkg.base import make, plain


def run():
    t = Thing()
    t.encode({})
    make().get("a")
    plain(1)
    return t.name()
