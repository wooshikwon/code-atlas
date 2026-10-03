from app import Engine
from app.core import run_engine
from app.models import Config


def main():
    from app.plugins.base import Loud

    config = Config("x")
    label = "엔진 시작"; run_engine(config)
    getattr(config, "name")()
    Loud().run()
    if isinstance(config, Config):
        return Engine(config)


if __name__ == "__main__":
    main()
