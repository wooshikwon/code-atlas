import os
from typing import Optional

from app.models import Config

REGISTRY = {}
counter = 0


def helper(value):
    return value


class Engine:
    def __init__(self, config: Config):
        self.config = config
        self.calls = 0

    def start(self, label: "Config") -> Optional[Config]:
        self.calls += 1
        name = os.path.basename(label)
        callback = helper
        return self.config if name else None

    def stop(self):
        global counter
        counter += 1
        REGISTRY[self.config] = self.calls


def run_engine(config: Config) -> Engine:
    engine = Engine(config)
    engine.start(config)
    handlers = [helper, engine.stop]
    return engine
