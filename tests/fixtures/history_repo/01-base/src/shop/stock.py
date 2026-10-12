LEVELS = {}


def reserve(item, count):
    left = LEVELS.get(item, 0) - count
    LEVELS[item] = left
    return left


def release(item, count):
    LEVELS[item] = LEVELS.get(item, 0) + count
    return LEVELS[item]


def available(item):
    return LEVELS.get(item, 0) > 0
