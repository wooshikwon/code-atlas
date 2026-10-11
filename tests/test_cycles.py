import shutil
import sys

import pytest

from code_atlas.analyze import analyze

from conftest import CYCLE_FIXTURE


@pytest.fixture(scope="module")
def cycle(tmp_path_factory):
    """순환이 있는 고정 레포에 실제 basedpyright를 띄워 한 번 분석한 결과."""
    repo = tmp_path_factory.mktemp("cycle") / "cycle_repo"
    shutil.copytree(CYCLE_FIXTURE, repo)
    return analyze(repo, sys.executable)


def components(edges: set[tuple[str, str]]) -> set[frozenset[str]]:
    """꼭짓점이 둘 이상인 강한 연결 요소. 서로 닿는 꼭짓점을 한 묶음으로 모은다."""
    reach: dict[str, set[str]] = {}
    for source, target in edges:
        reach.setdefault(source, set()).add(target)
        reach.setdefault(target, set())
    for middle in reach:
        for start in reach:
            if middle in reach[start]:
                reach[start] |= reach[middle]
    groups = {frozenset(b for b in reach if a in reach[b] and b in reach[a]) for a in reach}
    return {group for group in groups if len(group) > 1}


def test_cycle_repo_imports(cycle):
    imports = {(e.source, e.target): e.deferred for e in cycle.analysis.edges if e.kind == "import"}
    for pair in [("a.one", "a.two"), ("a.two", "a.three"), ("a.three", "a.one"), ("a.bridge", "b.gate"), ("b.gate", "a.bridge")]:
        assert imports[pair] is False
    assert imports[("b.lazy", "c.far")] is True
    assert imports[("c.far", "b.lazy")] is False


def test_cycle_repo_groups(cycle):
    kinds = {n.id: n.kind for n in cycle.analysis.nodes}
    imports = [e for e in cycle.analysis.edges if e.kind == "import" and kinds[e.source] == "module" and kinds[e.target] == "module"]
    top = {(e.source, e.target) for e in imports if not e.deferred}
    assert components(top) == {frozenset({"a.one", "a.two", "a.three"}), frozenset({"a.bridge", "b.gate"})}
    every = {(e.source, e.target) for e in imports}
    assert frozenset({"b.lazy", "c.far"}) in components(every)


def test_cycle_repo_path_and_unused(cycle):
    calls = {(e.source, e.target) for e in cycle.analysis.edges if e.kind == "call"}
    assert {("main:run", "a.one:first"), ("a.one:first", "a.two:second"), ("a.two:second", "a.three:third")} <= calls
    assert cycle.unused.candidates == ["a.two:spare"]
    assert cycle.analysis.errors == []
