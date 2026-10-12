from shop.report import fmt

ENTRIES = []


def log(amount):
    ENTRIES.append(fmt(amount))
    return len(ENTRIES)
