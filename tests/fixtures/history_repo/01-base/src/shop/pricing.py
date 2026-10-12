RATE = 0.1


def tax(amount):
    return amount * RATE


def discount(amount, percent):
    return amount - amount * percent / 100


def total(amount, percent):
    reduced = discount(amount, percent)
    return reduced + tax(reduced)


def legacy_total(amount):
    return amount + tax(amount)
