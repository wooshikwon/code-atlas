import logging
import re

from app.core import helper
from app.models import Config

logger = logging.getLogger(__name__)
PATTERN = re.compile(r"\d+")
LIMITS = {"low": 1, "high": 9}
DEFAULTS = [Config("a"), Config("b")]
HANDLERS = {"say": helper}
SEEN = []
total = 0
BASE = 10
DOUBLE = BASE * 2
BANNER = "limits"
UNREAD = 3
name = "tables"
__all__ = ["dispatch", "LIMITS"]

if BANNER:
    SEEN.clear()


def dispatch(key, name=None):
    logger.info(key)
    handler = HANDLERS[key]
    return handler(name), DEFAULTS


def remember(value):
    global total
    total += 1
    SEEN.append(value)
    return PATTERN.match(value), DOUBLE


def label(name):
    return name
