from shop.audit import log
from shop.pricing import legacy_total, total
from shop.report import render
from shop.stock import reserve


class Order:
    def __init__(self, item, amount):
        self.item = item
        self.amount = amount

    def price(self, percent):
        return total(self.amount, percent)


def checkout(order, percent):
    reserve(order.item, 1)
    price = order.price(percent)
    log(price)
    return render(price)


def refund(order):
    return legacy_total(order.amount)
