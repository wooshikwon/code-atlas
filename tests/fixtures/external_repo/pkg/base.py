import json


class Thing(json.JSONEncoder):
    def name(self):
        return "x"


def make():
    return {}


def plain(value):
    return value
