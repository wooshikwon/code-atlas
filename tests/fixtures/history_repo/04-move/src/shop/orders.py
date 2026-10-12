from shop.inventory import reserve
from shop.pricing import total
from shop.report import render


class Order:
    def __init__(self, item, amount):
        self.item = item
        self.amount = amount

    def price(self, percent):
        return total(self.amount, percent)


def checkout(order, percent):
    reserve(order.item, 1)
    price = order.price(percent)
    return render(price)


def refund(order):
    return total(order.amount, 0)
