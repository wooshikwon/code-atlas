import pytest

from code_atlas.collect import SourceFile, collect
from code_atlas.extract import extract, extract_repo


@pytest.fixture
def facts(sample_repo):
    return {f.file.path: f for f in extract_repo(collect(sample_repo))}


def nodes(facts, path):
    return {n.id: n for n in facts[path].nodes}


def sites(facts, path, kind=None):
    return [s for s in facts[path].sites if kind is None or s.kind == kind]


def test_node_kinds_and_parents(facts):
    core = nodes(facts, "src/app/core.py")
    assert core["app.core"].kind == "module"
    assert core["app.core:Engine"].kind == "class"
    assert core["app.core:Engine.start"].kind == "method"
    assert core["app.core:Engine.start"].parent == "app.core:Engine"
    assert core["app.core:run_engine"].kind == "function"
    assert nodes(facts, "src/app/__init__.py")["app"].kind == "package"


INIT_WITH_DEFINITIONS = """\
from pkg.models import Config


def version():
    return Config("x")


class Settings:
    def load(self):
        return version()
"""


def test_init_with_definitions_is_a_module_under_the_package():
    file = SourceFile(path="src/pkg/__init__.py", module_id="pkg", test=False, is_init=True)
    found = extract(file, INIT_WITH_DEFINITIONS, frozenset())
    module = found.nodes[0]
    assert (module.id, module.kind, module.name, module.parent) == ("pkg.__init__", "module", "__init__", "pkg")
    parents = {n.id: n.parent for n in found.nodes[1:]}
    assert parents == {"pkg:version": "pkg.__init__", "pkg:Settings": "pkg.__init__", "pkg:Settings.load": "pkg:Settings"}
    assert {s.enclosing for s in found.sites if s.kind == "import"} == {"pkg.__init__"}


@pytest.mark.parametrize(
    ("path", "module_id", "text", "expected"),
    [
        ("src/pkg/__init__.py", "pkg", "from pkg.core import run\n\nrun()\n", ("pkg", "package", None)),
        ("src/pkg/sub/__init__.py", "pkg.sub", "", ("pkg.sub", "package", "pkg")),
        ("src/__init__.py", "__init__", "def main():\n    pass\n", ("__init__", "module", None)),
        ("src/__init__.py", "__init__", "", ("__init__", "module", None)),
    ],
    ids=["정의 없는 패키지", "빈 하위 패키지", "소스 루트의 정의", "빈 소스 루트"],
)
def test_init_without_definitions_keeps_its_node(path, module_id, text, expected):
    found = extract(SourceFile(path=path, module_id=module_id, test=False, is_init=True), text, frozenset())
    module = found.nodes[0]
    assert (module.id, module.kind, module.parent) == expected
    assert {s.enclosing for s in found.sites} <= {module.id}


def test_nested_function_merges_into_enclosing(facts):
    base = nodes(facts, "src/app/plugins/base.py")
    assert not any("inner" in node_id for node_id in base)
    inner_call = next(s for s in sites(facts, "src/app/plugins/base.py", "call") if s.text == "helper_inside()")
    assert inner_call.enclosing == "app.plugins.base:Plugin.run"


def test_dataclass_detection_and_fields(facts):
    models = nodes(facts, "src/app/models.py")
    assert models["app.models:Config"].kind == "dataclass"
    assert models["app.models:Config"].fields == [
        {"name": "name", "type": "str"},
        {"name": "retries", "type": "int"},
    ]
    assert models["app.models:Point"].kind == "dataclass"
    assert models["app.models:Point"].fields == [{"name": "x", "type": "int"}, {"name": "y", "type": "int"}]
    assert models["app.models:Color"].kind == "dataclass"


def test_method_kind(facts):
    base = nodes(facts, "src/app/plugins/base.py")
    assert base["app.plugins.base:Plugin.label"].method_kind == "property"
    assert base["app.plugins.base:Plugin.make"].method_kind == "static"
    assert base["app.plugins.base:Plugin.run"].method_kind is None


def test_main_block_marks_module_entry(facts):
    cli = nodes(facts, "src/app/cli.py")
    assert cli["app.cli"].entry
    main_call = next(s for s in sites(facts, "src/app/cli.py", "call") if s.text == "main()")
    assert main_call.enclosing == "app.cli"


def test_deferred_import(facts):
    imports = sites(facts, "src/app/cli.py", "import")
    deferred = [s for s in imports if s.deferred]
    assert [s.text for s in deferred] == ["from app.plugins.base import Loud"]
    assert deferred[0].enclosing == "app.cli:main"


def test_request_position_after_korean_string(facts):
    call = next(s for s in sites(facts, "src/app/cli.py", "call") if s.text == "run_engine(config)")
    prefix = '    label = "엔진 시작"; '
    assert call.request_col == len(prefix.encode())
    assert call.request_col != len(prefix)


def test_attribute_request_points_at_attribute_name(facts):
    call = next(s for s in sites(facts, "src/app/core.py", "call") if s.text == "engine.start(config)")
    assert (call.col, call.request_col) == (4, 11)


def test_dynamic_call(facts):
    dynamic = [s for s in sites(facts, "src/app/cli.py", "call") if s.dynamic]
    assert [s.text for s in dynamic] == ["getattr(config, 'name')()"]


def test_use_sites(facts):
    core = sites(facts, "src/app/core.py")
    passed = {s.text for s in core if s.kind == "pass"}
    assert {"helper", "engine.stop"} <= passed
    types = [(s.line, s.text) for s in core if s.kind == "type"]
    assert (19, "Config") in types  # 문자열 주석 "Config"
    assert (31, "Engine") in types
    cli_types = {s.text for s in sites(facts, "src/app/cli.py", "type")}
    assert "Config" in cli_types  # isinstance 두 번째 인자


def test_string_annotation_column(facts):
    start = next(s for s in sites(facts, "src/app/core.py", "type") if s.line == 19 and s.col < 35)
    line = '    def start(self, label: "Config") -> Optional[Config]:'
    assert start.request_col == line.index("Config")


def test_decorate_and_inherit(facts):
    base = sites(facts, "src/app/plugins/base.py")
    decorate = {(s.text, s.enclosing) for s in base if s.kind == "decorate"}
    assert ("register", "app.plugins.base:Loud") in decorate
    inherit = [s for s in base if s.kind == "inherit"]
    assert [(s.text, s.enclosing) for s in inherit] == [("Plugin", "app.plugins.base:Loud")]


def test_reads_and_writes(facts):
    core = nodes(facts, "src/app/core.py")
    stop = core["app.core:Engine.stop"]
    assert stop.global_write
    assert set(stop.writes) == {"counter", "REGISTRY"}
    assert set(stop.reads) == {"self.calls", "self.config"}
    start = core["app.core:Engine.start"]
    assert start.writes == ["self.calls"]
    assert not start.global_write
    label = nodes(facts, "src/app/plugins/base.py")["app.plugins.base:Plugin.label"]
    assert label.reads == []


def test_def_name_position(facts):
    info = facts["src/app/plugins/base.py"].defs["app.plugins.base:Loud"]
    assert (info.name_line, info.name_col) == (26, 6)
    assert info.decorators == ["register"]
    assert info.bases == ["Plugin"]


def test_syntax_error_yields_module_only(facts):
    broken = facts["src/app/broken.py"]
    assert [n.id for n in broken.nodes] == ["app.broken"]
    assert broken.error and broken.sites == []


def test_expression_too_deep_yields_module_only_with_an_error():
    file = SourceFile(path="src/pkg/table.py", module_id="pkg.table", test=False, is_init=False)
    text = "def lookup():\n    return " + " + ".join(["f()"] * 5000) + "\n"
    found = extract(file, text, frozenset())
    assert [n.id for n in found.nodes] == ["pkg.table"]
    assert found.error == "식이 너무 깊습니다" and found.sites == []


def test_builtin_name_bound_in_the_file_is_not_prejudged(facts):
    calls = {s.text: s for s in sites(facts, "src/app/shadow.py", "call")}
    assert not calls["print(message)"].builtin
    assert calls["len(message)"].builtin
    assert not calls["message.upper()"].builtin
    getattr_call = next(s for s in sites(facts, "src/app/cli.py", "call") if s.text == "getattr(config, 'name')()")
    assert getattr_call.dynamic and not getattr_call.builtin


BINDINGS = {
    "대입": "len = 3\n",
    "함수 정의": "def len(x):\n    return 0\n",
    "클래스 정의": "class len:\n    pass\n",
    "import": "from pkg.core import len\n",
    "별칭 import": "import pkg.core as len\n",
    "모든 이름 import": "from pkg.core import *\n",
    "매개변수": "def g(len):\n    return len\n",
    "for의 대상": "for len in ():\n    pass\n",
    "with의 대상": "with open('a') as len:\n    pass\n",
    "except의 대상": "try:\n    pass\nexcept ValueError as len:\n    pass\n",
    "컴프리헨션의 대상": "sizes = [len for len in ()]\n",
    "match의 캡처": "match sizes:\n    case [len, *_]:\n        pass\n",
    "global": "def g():\n    global len\n",
    "nonlocal": "def g():\n    def h():\n        nonlocal len\n",
}


@pytest.mark.parametrize("binding", BINDINGS.values(), ids=BINDINGS.keys())
def test_builtin_prejudging_stops_wherever_the_file_binds_the_name(binding):
    file = SourceFile(path="src/pkg/m.py", module_id="pkg.m", test=False, is_init=False)
    text = "sizes = []\n" + binding + "def f(x):\n    return len(x), sorted(x)\n"
    calls = {s.text: s for s in extract(file, text, frozenset()).sites if s.kind == "call"}
    assert not calls["len(x)"].builtin
    assert calls["sorted(x)"].builtin != ("import *" in binding)


def test_builtin_prejudging_covers_decorators_bases_and_passed_names():
    file = SourceFile(path="src/pkg/m.py", module_id="pkg.m", test=False, is_init=False)
    text = "class Bad(ValueError):\n    @staticmethod\n    def f(x):\n        return map(str, x)\n"
    found = {(s.kind, s.text): s.builtin for s in extract(file, text, frozenset({"str"})).sites}
    assert found == {
        ("inherit", "ValueError"): True,
        ("decorate", "staticmethod"): True,
        ("call", "map(str, x)"): True,
        ("pass", "str"): True,
    }


def variables(facts, path):
    return {v.name: v for v in facts[path].variables}


def accesses(facts, path):
    return [(s.kind, s.line, s.text, s.enclosing) for s in facts[path].sites if s.kind in ("read", "write")]


def test_module_variables_and_their_values(facts):
    found = variables(facts, "src/app/tables.py")
    assert list(found) == [
        "logger", "PATTERN", "LIMITS", "DEFAULTS", "HANDLERS", "SEEN", "total",
        "BASE", "DOUBLE", "BANNER", "UNREAD", "name", "__all__",
    ]  # fmt: skip
    limits = found["LIMITS"]
    assert (limits.node_id, limits.range, limits.targets) == ("app.tables:LIMITS", (9, 9), [(9, 0)])
    assert (limits.value, limits.value_kind, limits.size, limits.text) == ((9, 9, 9, 30), "dict", 2, "{'low': 1, 'high': 9}")
    kinds = {name: (v.value_kind, v.size) for name, v in found.items()}
    assert kinds["logger"] == ("logging.getLogger(…)", None)
    assert kinds["DEFAULTS"] == ("list", 2)
    assert kinds["total"] == ("int", None)
    assert kinds["DOUBLE"] == ("expr", None)
    assert kinds["BANNER"] == ("str", None)


def test_maker_is_the_request_position_of_the_innermost_call(facts):
    found = variables(facts, "src/app/tables.py")
    calls = {(s.request_line, s.request_col): s.text for s in sites(facts, "src/app/tables.py", "call")}
    assert calls[found["logger"].maker] == "logging.getLogger(__name__)"
    assert calls[found["PATTERN"].maker] == "re.compile('\\\\d+')"
    assert found["LIMITS"].maker is None and found["DEFAULTS"].maker is None


VARIABLE_FORMS = """\
from pathlib import Path

HOME = Path.home().parent / "x"
FROZEN = frozenset({"a", "b", "c"})
first, second = 1, 2
ratio: float
ratio = 0.5
for step in range(3):
    pass
if HOME:
    late = None
try:
    import fast
except ImportError:
    fast = None
with open("f") as handle:
    pass


def late():
    return ratio


class Box:
    inside = 1
"""


def test_variable_forms():
    file = SourceFile(path="src/pkg/m.py", module_id="pkg.m", test=False, is_init=False)
    found = {v.name: v for v in extract(file, VARIABLE_FORMS, frozenset()).variables}
    assert list(found) == ["HOME", "FROZEN", "first", "second", "ratio", "step", "fast"]  # `late`는 함수 이름과 같다
    assert found["HOME"].maker == (3, 12) and found["HOME"].value_kind == "expr"
    assert (found["FROZEN"].value_kind, found["FROZEN"].size) == ("frozenset(…)", 3)
    assert (found["first"].value, found["first"].value_kind, found["first"].text) == (None, "expr", "")
    assert (found["ratio"].range, found["ratio"].targets, found["ratio"].value) == ((6, 6), [(6, 0), (7, 0)], None)
    assert found["step"].range == (8, 9) and found["fast"].value_kind == "None"


VALUE_KINDS = {
    "alias": ["make_forward_fn", "OutputFormat.text", "str", "typing.Any"],
    "type": [
        "Literal['a', 'b']",
        "typing.Optional[int]",
        "Callable[[list[Base], Any], None]",
        "list[str]",
        "str | Spec",
        "Spec | None",
        "Spec | 'Later' | dict[str, int]",
        "pkg.Spec | Other[int] | None",
    ],
    "expr": [
        "A | B",
        "re.I | re.M",
        "Spec | 3",
        "make() | None",
        "TABLE['a']",
        "Path(__file__).resolve().parents[2]",
        "platform.system() == 'Darwin'",
        "FIXTURES / 'recipes'",
        "['models'] + list(TABLE.keys())",
        "a if b else c",
        "lambda x: x",
        "-LIMIT",
    ],
    "str": ["f'{BASE}/x'"],
    "Path(__file__).resolve(…)": ["Path(__file__).resolve()"],
}


def test_value_kinds_are_told_apart_by_syntax_alone():
    file = SourceFile(path="src/pkg/m.py", module_id="pkg.m", test=False, is_init=False)
    cases = [(kind, text) for kind, texts in VALUE_KINDS.items() for text in texts]
    source = "".join(f"V{i} = {text}\n" for i, (_, text) in enumerate(cases))
    found = [v.value_kind for v in extract(file, source, frozenset()).variables]
    assert list(zip(found, (text for _, text in cases))) == cases


def test_assigned_names_pair_with_the_variables():
    from code_atlas.extract import assigned_names

    assert assigned_names(VARIABLE_FORMS) == sorted(["HOME", "FROZEN", "first", "second", "ratio", "step", "fast"])
    assert assigned_names("def broken(:\n") == []


def test_read_and_write_sites(facts):
    assert accesses(facts, "src/app/tables.py") == [
        ("read", 15, "BASE", "app.tables"),
        ("read", 21, "BANNER", "app.tables"),
        ("write", 22, "SEEN", "app.tables"),
        ("read", 26, "logger", "app.tables:dispatch"),
        ("read", 27, "HANDLERS", "app.tables:dispatch"),
        ("read", 28, "DEFAULTS", "app.tables:dispatch"),
        ("write", 33, "total", "app.tables:remember"),
        ("write", 34, "SEEN", "app.tables:remember"),
        ("read", 35, "PATTERN", "app.tables:remember"),
        ("read", 35, "DOUBLE", "app.tables:remember"),
    ]
    assert accesses(facts, "src/app/lookup.py") == [
        ("read", 6, "LIMITS", "app.lookup:lowest"),
        ("read", 10, "tables.LIMITS", "app.lookup:highest"),
        ("write", 14, "tables.total", "app.lookup:reset"),
        ("read", 18, "LIMITS", "app.lookup:Window"),
    ]
    highest = next(s for s in sites(facts, "src/app/lookup.py", "read") if s.text == "tables.LIMITS")
    assert (highest.col, highest.request_col) == (11, 18)


def test_local_names_make_no_access_sites(facts):
    # `name`은 app.tables의 모듈 변수이고 dispatch와 label의 매개변수다.
    assert not [s for s in sites(facts, "src/app/tables.py") if s.kind in ("read", "write") and s.text == "name"]


ACCESS_FORMS = """\
import other
from other import TABLE, HOOK, Alias

def f(x: Alias, TABLE=None):
    return TABLE

def g(self):
    HOOK()
    use(TABLE)
    other.TABLE[x] = 1
    del TABLE["k"]
    TABLE.update(a=1)
    other.TABLE.setdefault("k", [])
    self.TABLE = 2
    return other.HOOK

@HOOK
class K(Alias):
    kept = TABLE
    def m(self):
        global COUNT
        COUNT = TABLE.get(1)
"""


def test_access_sites_skip_positions_another_site_already_asks():
    file = SourceFile(path="src/pkg/m.py", module_id="pkg.m", test=False, is_init=False)
    names = frozenset({"TABLE", "HOOK", "Alias", "COUNT"})
    found = extract(file, ACCESS_FORMS, frozenset({"use"}), names).sites
    asked = [(s.request_line, s.request_col) for s in found if not s.dynamic]
    assert len(asked) == len(set(asked))
    assert [(s.kind, s.line, s.text, s.enclosing) for s in found if s.kind in ("read", "write")] == [
        ("write", 10, "other.TABLE", "pkg.m:g"),
        ("write", 11, "TABLE", "pkg.m:g"),
        ("write", 12, "TABLE", "pkg.m:g"),
        ("write", 13, "other.TABLE", "pkg.m:g"),
        ("read", 15, "other.HOOK", "pkg.m:g"),
        ("write", 22, "COUNT", "pkg.m:K.m"),
        ("read", 22, "TABLE", "pkg.m:K.m"),
    ]
    # import로 묶인 이름의 호출·전달·타입·데코레이터·상속 지점이 같은 위치를 이미 묻는다.
    kept = {(s.kind, s.line, s.text) for s in found if s.kind not in ("read", "write", "import")}
    assert {
        ("type", 4, "Alias"),
        ("call", 8, "HOOK()"),
        ("pass", 9, "TABLE"),
        ("decorate", 17, "HOOK"),
        ("inherit", 18, "Alias"),
        ("pass", 19, "TABLE"),
    } <= kept


def test_no_access_sites_without_repo_variables():
    file = SourceFile(path="src/pkg/m.py", module_id="pkg.m", test=False, is_init=False)
    assert not [s for s in extract(file, ACCESS_FORMS, frozenset()).sites if s.kind in ("read", "write")]
