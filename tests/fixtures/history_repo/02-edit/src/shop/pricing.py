# 금액 계산
RATE = 0.1


def tax(amount):
    return amount * RATE


def discount(amount, percent):
    return amount - amount * percent / 100


def rounded(amount):
    return round(amount, 2)


def total(amount, percent):
    reduced = discount(amount, percent)
    if reduced <= 0:
        return tax(0)
    return rounded(reduced + tax(reduced))
