import sys

import pytest

from code_atlas import unused
from code_atlas.analyze import analyze
from code_atlas.collect import config_texts
from code_atlas.extract import extract_repo
from code_atlas.unused import candidates

CORE = """\
import functools
import threading


def idle():
    return 0


def checked():
    return 1


@functools.cache
def cached():
    return 2


def __getattr__(name):
    raise AttributeError(name)


def test_probe():
    return 3


class Lonely:
    def clone(self):
        return Lonely()


class Shape:
    pass


class Square(Shape):
    pass


class Tools:
    def make(self):
        return Square()


class Base:
    def handle(self):
        return None


class Child(Base):
    def handle(self):
        return 1


class Worker(threading.Thread):
    def run(self):
        return None


class Raw:
    def handle_raw(self, raw):
        return raw


def on_done():
    return None


def strategy():
    return None
"""

MAIN = """\
from pkg import core
from pkg.core import Base, Child, Raw, Tools, Worker


def serve(base: Base, handler):
    base.handle()
    Tools.make(None)
    handler.handle_raw(1)
    getattr(core, "on_done")()
    return Child(), Raw(), Worker()


def cli():
    return serve(Child(), None)


if __name__ == "__main__":
    serve(Child(), None)
"""

TEST_CORE = """\
from pkg.core import checked


def test_checked():
    assert checked() == 1
"""

PYPROJECT = """\
[project]
name = "demo"
version = "0.0.1"

[project.scripts]
demo = "main:cli"
"""

# 규칙마다, 그 규칙을 빼면 후보가 되는 정의
EXCLUDED = {
    unused._declared: ["main:cli", "pkg.core:cached", "pkg.core:__getattr__", "pkg.core:test_probe"],
    unused._class_in_use: ["pkg.core:Shape", "pkg.core:Tools"],
    unused._override_in_use: ["pkg.core:Child.handle"],
    unused._externally_based: ["pkg.core:Worker.run"],
    unused._called_by_name: ["pkg.core:Raw.handle_raw"],
    unused._named_in_string: ["pkg.core:on_done"],
    unused._named_in_config: ["pkg.core:strategy"],
}
ALWAYS = ["pkg.core:idle", "pkg.core:Lonely", "pkg.core:Lonely.clone"]


@pytest.fixture(scope="module")
def judged(tmp_path_factory):
    """손으로 만든 레포를 분석해 `candidates`에 넘길 인자를 만든다."""
    repo = tmp_path_factory.mktemp("unused") / "demo"
    (repo / "pkg").mkdir(parents=True)
    (repo / "tests").mkdir()
    (repo / "conf").mkdir()
    (repo / "pkg" / "__init__.py").write_text("")
    (repo / "pkg" / "core.py").write_text(CORE)
    (repo / "main.py").write_text(MAIN)
    (repo / "tests" / "test_core.py").write_text(TEST_CORE)
    (repo / "pyproject.toml").write_text(PYPROJECT)
    (repo / "conf" / "run.yaml").write_text("trainer:\n  strategy: pkg.core.strategy\n")
    analyzed = analyze(repo, sys.executable)
    return analyzed.analysis, extract_repo(analyzed.files), analyzed.texts, config_texts(analyzed.files.root)


def test_candidates_have_no_use_from_outside_and_pass_every_rule(judged):
    found = candidates(*judged)
    assert found.candidates == ALWAYS
    assert found.definitions == 23


@pytest.mark.parametrize("rule", unused.RULES, ids=lambda rule: rule.__name__)
def test_each_rule_excludes_its_definitions(judged, monkeypatch, rule):
    monkeypatch.setattr(unused, "RULES", [r for r in unused.RULES if r is not rule])
    assert sorted(candidates(*judged).candidates) == sorted([*ALWAYS, *EXCLUDED[rule]])


def test_definition_called_only_by_test_code_is_used(judged):
    analysis = judged[0]
    nodes = {n.id: n for n in analysis.nodes}
    callers = {e.source for e in analysis.edges if e.target == "pkg.core:checked" and e.group in ("run", "use")}
    assert callers == {"tests.test_core:test_checked"} and nodes["tests.test_core:test_checked"].test
    found = candidates(*judged).candidates
    assert "pkg.core:checked" not in found
    assert not any(nodes[c].test for c in found)


def test_class_constructed_only_by_its_own_method_is_a_candidate(judged):
    analysis = judged[0]
    assert {(e.kind, e.source) for e in analysis.edges if e.target == "pkg.core:Lonely"} == {
        ("construct", "pkg.core:Lonely.clone")
    }
    assert "pkg.core:Lonely" in candidates(*judged).candidates


def test_config_path_must_match_the_whole_dotted_path(judged):
    analysis, facts, texts, _ = judged
    for text in ("pkg.core.strategy_v2", "other.pkg.core.strategy", "core.strategy"):
        assert "pkg.core:strategy" in candidates(analysis, facts, texts, [text]).candidates
    for text in ("pkg.core.strategy", "target: 'pkg.core.strategy'"):
        assert "pkg.core:strategy" not in candidates(analysis, facts, texts, [text]).candidates


def test_candidates_leave_the_analysis_unchanged(judged):
    analysis = judged[0]
    before = (list(analysis.nodes), list(analysis.edges), dict(analysis.stats))
    candidates(*judged)
    assert (analysis.nodes, analysis.edges, analysis.stats) == before
