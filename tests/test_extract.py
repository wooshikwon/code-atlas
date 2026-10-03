import pytest

from code_atlas.collect import collect
from code_atlas.extract import extract_repo


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
