from shop.pricing import discount

CODES = {"WELCOME": 10}


def apply(amount, code):
    return discount(amount, CODES.get(code, 0))
