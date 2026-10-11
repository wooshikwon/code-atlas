from pkg.mid import build


def go():
    m = build()
    m.encode({})
    return m.name()
