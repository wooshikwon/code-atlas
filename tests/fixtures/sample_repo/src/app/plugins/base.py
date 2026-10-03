PLUGINS = []


def register(cls):
    PLUGINS.append(cls)
    return cls


class Plugin:
    def run(self):
        def inner():
            return helper_inside()

        return [x for x in map(str, PLUGINS)]

    @property
    def label(self):
        return self.run()

    @staticmethod
    def make():
        return Plugin()


@register
class Loud(Plugin):
    def run(self):
        try:
            return super().run()
        except ValueError:
            return None
