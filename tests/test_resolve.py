import pytest

from code_atlas import resolve
from code_atlas.collect import collect, disk_path
from code_atlas.extract import extract_repo
from code_atlas.lsp import Location
from code_atlas.model import Site
from code_atlas.resolve import Index, external_of, resolve_site

TYPESHED = "/x/.venv/lib/python3.12/site-packages/basedpyright/dist/typeshed-fallback"


@pytest.mark.parametrize(
    "path, expected",
    [
        (f"{TYPESHED}/stdlib/builtins.pyi", ("builtins", "builtin")),
        (f"{TYPESHED}/stdlib/os/__init__.pyi", ("os", "stdlib")),
        (f"{TYPESHED}/stdlib/typing.pyi", ("typing", "stdlib")),
        (f"{TYPESHED}/stubs/requests/requests/api.pyi", ("requests", "thirdparty")),
        ("/r/.venv/lib/python3.12/site-packages/yaml/__init__.py", ("yaml", "thirdparty")),
        ("/r/.venv/lib/python3.12/site-packages/numpy-stubs/__init__.pyi", ("numpy", "thirdparty")),
        ("/usr/lib/python3.12/json/decoder.py", ("json", "stdlib")),
        ("/somewhere/else.py", None),
    ],
)
def test_external_of(path, expected):
    assert external_of(path) == expected


@pytest.fixture
def index(sample_repo):
    return Index(sample_repo, extract_repo(collect(sample_repo))), sample_repo


def site(kind, path="src/app/cli.py", dynamic=False, builtin=False):
    return Site(kind, path, 1, 0, 1, 0, "app.cli:main", "x", dynamic=dynamic, builtin=builtin)


def run(index, kind, *locations, dynamic=False, builtin=False):
    idx, _ = index
    externals = {}
    return resolve_site(site(kind, dynamic=dynamic, builtin=builtin), list(locations), idx, externals), externals


def test_call_to_function_and_class(index):
    idx, root = index
    r, _ = run(index, "call", Location(str(root / "src/app/core.py"), *_name_pos(idx, "app.core:run_engine")))
    assert (r.status, r.target, r.edge) == ("resolved", "app.core:run_engine", "call")
    r, _ = run(index, "call", Location(str(root / "src/app/core.py"), *_name_pos(idx, "app.core:Engine")))
    assert (r.status, r.target, r.edge) == ("resolved", "app.core:Engine", "construct")


def test_import_targets_containing_module(index):
    idx, root = index
    r, _ = run(index, "import", Location(str(root / "src/app/core.py"), *_name_pos(idx, "app.core:Engine")))
    assert (r.target, r.edge) == ("app.core", "import")
    r, _ = run(index, "import", Location(str(root / "src/app/plugins/__init__.py"), 1, 0))
    assert (r.target, r.edge) == ("app.plugins", "import")


def test_first_location_that_maps_to_definition(index):
    idx, root = index
    variable = Location(str(root / "src/app/core.py"), 6, 0)
    r, _ = run(index, "call", variable, Location(str(root / "src/app/core.py"), *_name_pos(idx, "app.core:helper")))
    assert r.target == "app.core:helper"


def test_unresolved_builtin_dynamic_external(index):
    _, root = index
    r, _ = run(index, "call")
    assert r.status == "unresolved"
    r, _ = run(index, "call", Location(str(root / "src/app/core.py"), 6, 0))
    assert r.status == "unresolved"
    r, _ = run(index, "call", Location(f"{TYPESHED}/stdlib/builtins.pyi", 10, 4))
    assert (r.status, r.edge) == ("builtin", None)
    r, _ = run(index, "call", dynamic=True)
    assert r.status == "dynamic"
    r, _ = run(index, "call", builtin=True)
    assert (r.status, r.target, r.edge) == ("builtin", None, None)
    r, externals = run(index, "call", Location(f"{TYPESHED}/stdlib/os/__init__.pyi", 10, 4))
    assert (r.status, r.target, r.edge) == ("external", "ext:os", None)
    assert externals["ext:os"].origin == "stdlib"
    r, _ = run(index, "inherit", Location(f"{TYPESHED}/stdlib/enum.pyi", 10, 6))
    assert (r.target, r.edge) == ("ext:enum", "inherit")


def test_locations_under_a_symlinked_root_resolve(sample_repo, tmp_path):
    link = tmp_path / "link"
    link.symlink_to(sample_repo)
    idx = Index(link, extract_repo(collect(link)))
    pos = _name_pos(idx, "app.core:run_engine")
    for root in (link, sample_repo):
        r = resolve_site(site("call"), [Location(str(root / "src/app/core.py"), *pos)], idx, {})
        assert (r.status, r.target) == ("resolved", "app.core:run_engine")
    assert idx.relative(str(tmp_path / "elsewhere.py")) is None


def test_relative_converts_each_path_once(index, monkeypatch):
    idx, root = index
    converted = []
    monkeypatch.setattr(resolve, "disk_path", lambda path: converted.append(path) or disk_path(path))
    inside, outside = str(root / "src/app/core.py"), f"{TYPESHED}/stdlib/builtins.pyi"
    assert [idx.relative(p) for p in (inside, outside, inside, outside)] == ["src/app/core.py", None] * 2
    assert converted == [inside, outside]


def test_locations_spelled_in_another_case_resolve_only_where_they_name_the_same_file(sample_repo, tmp_path):
    shouted = tmp_path / "SAMPLE_REPO"
    same_file = shouted.exists()
    idx = Index(shouted if same_file else sample_repo, extract_repo(collect(sample_repo)))
    pos = _name_pos(idx, "app.core:run_engine")
    exact = resolve_site(site("call"), [Location(str(sample_repo / "src/app/core.py"), *pos)], idx, {})
    assert (exact.status, exact.target) == ("resolved", "app.core:run_engine")
    other = resolve_site(site("call"), [Location(str(shouted / "SRC/APP/CORE.py"), *pos)], idx, {})
    assert other.status == ("resolved" if same_file else "unresolved")


def _name_pos(idx, node_id):
    return next((line, col) for (path, line, col), nid in idx.names.items() if nid == node_id)
