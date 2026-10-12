// 시험용 고정 그래프. 폴더 pkg → 파일 pkg.mod → 클래스 Store → 메서드 두 개를 3단으로 중첩하고,
// 메서드가 클래스 밖 데이터 클래스·함수로 계층을 넘어 잇고, 파일 main의 진입점 run과 메서드가 파일 경계를 넘어 서로 부른다.
// 여기에 서로 import하는 진입점 파일 cli, 선이 없는 파일 scratch, 파일 다섯 개가 import하는 common,
// 함수 진입점 index에서 시작해 파일 경계를 넘는 세 단계 호출 사슬 index → render → wrap → pad,
// 폴더 pkg 안의 테스트 코드 pkg.conftest, 폴더 app의 `__init__.py` 파일 app.__init__과 거기에 정의한 함수 app:version을 더한다.
// routeFixture는 경로와 순환 묶음의 시험에 쓴다. 폴더 flow에 경로를, 폴더 ring·north·south·lazy에 import 순환을 담는다.
// variableFixture는 모듈 변수 노드와 읽음·바꿈 선의 시험에 쓴다.
// compareFixture는 시점 비교의 시험에 쓴다. repoFixture를 대상 시점으로 삼고 삭제된 정의·파일·관계를 더한다.
import type { AtlasEdge, AtlasNode, Comparison, Graph } from "../api/types";

export function node(id: string, kind: AtlasNode["kind"], parent: string | null, extra: Partial<AtlasNode> = {}): AtlasNode {
  const name = id.includes(":") ? id.split(":")[1].split(".").at(-1)! : id.split(".").at(-1)!;
  return {
    id,
    kind,
    name,
    parent,
    path: null,
    range: null,
    loc: 9,
    unresolved: 0,
    test: false,
    entry: false,
    reads: [],
    writes: [],
    global_write: false,
    fields: null,
    method_kind: null,
    origin: null,
    value: null,
    external_value: false,
    routes: [],
    ...extra,
  };
}

export function edge(source: string, target: string, kind: AtlasEdge["kind"], extra: Partial<AtlasEdge> = {}): AtlasEdge {
  const group = kind === "call" || kind === "construct" ? "run" : kind === "inherit" || kind === "override" ? "derive" : "use";
  return { group, kind, source, target, sites: [{ path: "x.py", line: 1, col: 0 }], deferred: false, ...extra };
}

export const repoFixture: Graph = {
  nodes: [
    node("main", "module", null, { path: "main.py", loc: 40, entry: true }),
    node("main:helper", "function", "main", { path: "main.py", range: [20, 30] }),
    node("main:run", "function", "main", { path: "main.py", range: [5, 15] }),
    node("pkg", "package", null, { path: "pkg" }),
    node("pkg.mod", "module", "pkg", { path: "pkg/mod.py", loc: 60 }),
    node("pkg.mod:Store", "class", "pkg.mod", { path: "pkg/mod.py", range: [1, 30] }),
    node("pkg.mod:Store.load", "method", "pkg.mod:Store", { path: "pkg/mod.py", range: [3, 10] }),
    node("pkg.mod:Store.save", "method", "pkg.mod:Store", { path: "pkg/mod.py", range: [12, 20] }),
    node("pkg.mod:Row", "dataclass", "pkg.mod", {
      path: "pkg/mod.py",
      range: [32, 40],
      fields: ["a", "b", "c", "d", "e", "f", "g"].map((name) => ({ name, type: "int" })),
    }),
    node("pkg.mod:parse", "function", "pkg.mod", { path: "pkg/mod.py", range: [42, 50] }),
    node("pkg.util", "module", "pkg", { path: "pkg/util.py", loc: 5 }),
    node("tests.test_mod", "module", null, { path: "tests/test_mod.py", test: true }),
    node("tests.test_mod:test_load", "function", "tests.test_mod", { test: true, range: [1, 3] }),
    node("ext:json", "external", null, { origin: "stdlib" }),
    node("pkg.conftest", "module", "pkg", { path: "pkg/conftest.py", test: true }),
    node("pkg.conftest:setup", "function", "pkg.conftest", { path: "pkg/conftest.py", test: true, range: [1, 3] }),
    node("cli", "module", null, { path: "cli.py", loc: 20, entry: true }),
    node("cli:main", "function", "cli", { path: "cli.py", range: [5, 15] }),
    node("common", "module", null, { path: "common.py", loc: 12 }),
    node("common:log", "function", "common", { path: "common.py", range: [1, 8] }),
    node("scratch", "module", null, { path: "scratch.py", loc: 4 }),
    node("scratch:todo", "function", "scratch", { path: "scratch.py", range: [1, 4] }),
    node("app", "package", null, { path: "app" }),
    node("app.__init__", "module", "app", { path: "app/__init__.py", loc: 3 }),
    node("app.web", "module", "app", { path: "app/web.py", loc: 30 }),
    node("app.web:index", "function", "app.web", { path: "app/web.py", range: [5, 12], entry: true }),
    node("app.web:render", "function", "app.web", { path: "app/web.py", range: [14, 25] }),
    node("app.text", "module", "app", { path: "app/text.py", loc: 20 }),
    node("app.text:wrap", "function", "app.text", { path: "app/text.py", range: [1, 8] }),
    node("app.text:pad", "function", "app.text", { path: "app/text.py", range: [10, 16] }),
    node("app:version", "function", "app.__init__", { path: "app/__init__.py", range: [1, 3] }),
  ],
  edges: [
    edge("main", "pkg.mod", "import"),
    edge("main:run", "pkg.mod:Store.load", "call", { sites: [1, 2, 3].map((line) => ({ path: "main.py", line, col: 0 })) }),
    edge("main:run", "main:helper", "call"),
    edge("pkg.mod:Store.save", "main:helper", "call"),
    edge("pkg.mod:Store.load", "pkg.mod:Store.save", "call"),
    edge("pkg.mod:Store.load", "pkg.mod:Row", "construct"),
    edge("pkg.mod:Store.save", "pkg.mod:parse", "call"),
    edge("pkg.mod", "pkg.util", "import", { deferred: true }),
    edge("pkg.mod", "ext:json", "import"),
    edge("tests.test_mod:test_load", "pkg.mod:Store.load", "call"),
    edge("main", "cli", "import"),
    edge("cli", "main", "import"),
    edge("cli:main", "main:run", "call"),
    edge("main", "common", "import"),
    edge("cli", "common", "import"),
    edge("pkg.mod", "common", "import"),
    edge("app.web", "common", "import"),
    edge("app.__init__", "common", "import"),
    edge("cli:main", "common:log", "call"),
    edge("app.web", "app.text", "import"),
    edge("app.web:index", "app.web:render", "call"),
    edge("app.web:render", "app.text:wrap", "call"),
    edge("app.text:wrap", "app.text:pad", "call"),
    edge("pkg.conftest:setup", "main:helper", "call"),
  ],
};

/**
 * 경로: begin에서 finish까지 세 개(left, right를 거치는 2단계 두 개와 mid → left를 거치는 3단계 하나)이고 반대 방향에는 없다.
 * make → Engine → Engine.__init__ → tune은 생성자 이음을, Base.run → Base.step → Child.step → emit은 오버라이드 이음을 지난다.
 * probe에서 lone까지는 테스트 코드 tests.fakes:relay를 거쳐야만 이어진다.
 * 순환: ring의 파일 세 개가 한 묶음, north.up과 south.down이 폴더 두 개에 걸친 한 묶음이다. lazy의 파일 두 개는
 * 함수 안 import로만 돌아오고, 폴더 ring과 lazy는 폴더 단위로만 서로 돌아온다. flow.walk와 tests.fakes는 테스트 코드를 켰을 때만 묶음이다.
 */
export const routeFixture: Graph = {
  nodes: [
    node("flow", "package", null, { path: "flow" }),
    node("flow.walk", "module", "flow", { path: "flow/walk.py", loc: 70 }),
    node("flow.walk:begin", "function", "flow.walk", { path: "flow/walk.py", range: [1, 8], entry: true }),
    node("flow.walk:left", "function", "flow.walk", { path: "flow/walk.py", range: [10, 18], unresolved: 1 }),
    node("flow.walk:mid", "function", "flow.walk", { path: "flow/walk.py", range: [20, 28] }),
    node("flow.walk:right", "function", "flow.walk", { path: "flow/walk.py", range: [30, 38] }),
    node("flow.walk:finish", "function", "flow.walk", { path: "flow/walk.py", range: [40, 48], unresolved: 3 }),
    node("flow.walk:probe", "function", "flow.walk", { path: "flow/walk.py", range: [50, 58] }),
    node("flow.walk:lone", "function", "flow.walk", { path: "flow/walk.py", range: [60, 68] }),
    node("flow.build", "module", "flow", { path: "flow/build.py", loc: 60 }),
    node("flow.build:make", "function", "flow.build", { path: "flow/build.py", range: [1, 8] }),
    node("flow.build:Engine", "class", "flow.build", { path: "flow/build.py", range: [10, 20] }),
    node("flow.build:Engine.__init__", "method", "flow.build:Engine", { path: "flow/build.py", range: [11, 20] }),
    node("flow.build:Base", "class", "flow.build", { path: "flow/build.py", range: [22, 40] }),
    node("flow.build:Base.run", "method", "flow.build:Base", { path: "flow/build.py", range: [23, 30] }),
    node("flow.build:Base.step", "method", "flow.build:Base", { path: "flow/build.py", range: [32, 40], unresolved: 1 }),
    node("flow.build:Child", "class", "flow.build", { path: "flow/build.py", range: [42, 55] }),
    node("flow.build:Child.step", "method", "flow.build:Child", { path: "flow/build.py", range: [43, 55] }),
    node("flow.sink", "module", "flow", { path: "flow/sink.py", loc: 20 }),
    node("flow.sink:tune", "function", "flow.sink", { path: "flow/sink.py", range: [1, 8], unresolved: 2 }),
    node("flow.sink:emit", "function", "flow.sink", { path: "flow/sink.py", range: [10, 18] }),
    node("tests.fakes", "module", null, { path: "tests/fakes.py", test: true }),
    node("tests.fakes:relay", "function", "tests.fakes", { path: "tests/fakes.py", test: true, range: [1, 5] }),
    node("ring", "package", null, { path: "ring" }),
    node("ring.a", "module", "ring", { path: "ring/a.py" }),
    node("ring.b", "module", "ring", { path: "ring/b.py" }),
    node("ring.c", "module", "ring", { path: "ring/c.py" }),
    node("north", "package", null, { path: "north" }),
    node("north.up", "module", "north", { path: "north/up.py" }),
    node("south", "package", null, { path: "south" }),
    node("south.down", "module", "south", { path: "south/down.py" }),
    node("lazy", "package", null, { path: "lazy" }),
    node("lazy.one", "module", "lazy", { path: "lazy/one.py" }),
    node("lazy.two", "module", "lazy", { path: "lazy/two.py" }),
  ],
  edges: [
    edge("flow.walk:begin", "flow.walk:left", "call"),
    edge("flow.walk:begin", "flow.walk:right", "call"),
    edge("flow.walk:begin", "flow.walk:mid", "call"),
    edge("flow.walk:mid", "flow.walk:left", "call"),
    edge("flow.walk:left", "flow.walk:finish", "call"),
    edge("flow.walk:right", "flow.walk:finish", "call"),
    edge("flow.walk:probe", "tests.fakes:relay", "call"),
    edge("tests.fakes:relay", "flow.walk:lone", "call"),
    edge("flow.build:make", "flow.build:Engine", "construct"),
    edge("flow.build:Engine.__init__", "flow.sink:tune", "call"),
    edge("flow.build:Child", "flow.build:Base", "inherit"),
    edge("flow.build:Child.step", "flow.build:Base.step", "override"),
    edge("flow.build:Base.run", "flow.build:Base.step", "call"),
    edge("flow.build:Child.step", "flow.sink:emit", "call"),
    edge("flow.build", "flow.sink", "import"),
    edge("flow.walk", "tests.fakes", "import"),
    edge("tests.fakes", "flow.walk", "import"),
    edge("ring.a", "ring.b", "import"),
    edge("ring.b", "ring.c", "import"),
    edge("ring.c", "ring.a", "import"),
    edge("north.up", "south.down", "import"),
    edge("south.down", "north.up", "import"),
    edge("lazy.one", "lazy.two", "import"),
    edge("lazy.two", "lazy.one", "import", { deferred: true }),
    edge("ring.a", "lazy.two", "import"),
    edge("lazy.one", "ring.b", "import"),
  ],
};

/**
 * 파일 conf의 변수 다섯 개와 그 변수를 읽고 바꾸는 함수, 파일 app, 테스트 코드 tests.test_conf를 담는다.
 * - PRESETS: 다른 파일의 함수 app:run이 두 곳에서 읽고, 값이 같은 파일의 데이터 클래스 Preset을 두 곳에서 생성한다.
 * - LIMIT, DEFAULT, _cache: 파일 안에서만 쓴다. DEFAULT의 값이 LIMIT을 읽고, remember가 _cache를 바꾼다.
 * - logger: 값을 만든 호출의 대상이 외부 노드인 변수다.
 * - app:STARTERS: 값이 다른 파일의 Preset을 생성한다.
 * - tests.test_conf:SAMPLE: 테스트 코드의 변수다.
 */
export const variableFixture: Graph = {
  nodes: [
    node("conf", "module", null, { path: "conf.py", loc: 30 }),
    node("conf:Preset", "dataclass", "conf", { path: "conf.py", range: [1, 5], fields: [{ name: "name", type: "str" }] }),
    node("conf:clamp", "function", "conf", { path: "conf.py", range: [19, 25] }),
    node("conf:remember", "function", "conf", { path: "conf.py", range: [27, 32] }),
    node("app", "module", null, { path: "app.py", loc: 12, entry: true }),
    node("app:run", "function", "app", { path: "app.py", range: [3, 9] }),
    node("tests.test_conf", "module", null, { path: "tests/test_conf.py", test: true }),
    node("tests.test_conf:test_clamp", "function", "tests.test_conf", { path: "tests/test_conf.py", test: true, range: [3, 6] }),
    node("conf:PRESETS", "variable", "conf", { path: "conf.py", range: [7, 12], loc: 6, value: { kind: "dict", size: 2, text: '{"fast": Preset("fast"), "slow": Preset("slow")}' } }),
    node("conf:LIMIT", "variable", "conf", { path: "conf.py", range: [14, 14], loc: 1, value: { kind: "int", size: null, text: "3" } }),
    node("conf:DEFAULT", "variable", "conf", { path: "conf.py", range: [15, 15], loc: 1, value: { kind: "expr", size: null, text: "LIMIT - 1" } }),
    node("conf:_cache", "variable", "conf", { path: "conf.py", range: [16, 16], loc: 1, value: { kind: "dict", size: 0, text: "{}" } }),
    node("conf:logger", "variable", "conf", {
      path: "conf.py",
      range: [17, 17],
      loc: 1,
      value: { kind: "logging.getLogger(…)", size: null, text: "logging.getLogger(__name__)" },
      external_value: true,
    }),
    node("app:STARTERS", "variable", "app", { path: "app.py", range: [1, 1], loc: 1, value: { kind: "list", size: 1, text: '[Preset("first")]' } }),
    node("tests.test_conf:SAMPLE", "variable", "tests.test_conf", { path: "tests/test_conf.py", test: true, range: [1, 1], loc: 1, value: { kind: "tuple", size: 0, text: "" } }),
  ],
  edges: [
    edge("app", "conf", "import"),
    edge("app:run", "conf:PRESETS", "read", { sites: [4, 6].map((line) => ({ path: "app.py", line, col: 4 })) }),
    edge("app:run", "conf:clamp", "call"),
    edge("app:run", "app:STARTERS", "read"),
    edge("app:STARTERS", "conf:Preset", "construct"),
    edge("conf:PRESETS", "conf:Preset", "construct", { sites: [8, 10].map((line) => ({ path: "conf.py", line, col: 12 })) }),
    edge("conf:clamp", "conf:LIMIT", "read"),
    edge("conf:clamp", "conf:DEFAULT", "read"),
    edge("conf:clamp", "conf:_cache", "read"),
    edge("conf:clamp", "conf:logger", "read"),
    edge("conf:clamp", "conf:remember", "call"),
    edge("conf:DEFAULT", "conf:LIMIT", "read"),
    edge("conf:remember", "conf:_cache", "write"),
    edge("tests.test_conf", "conf", "import"),
    edge("tests.test_conf:test_clamp", "tests.test_conf:SAMPLE", "read"),
    edge("tests.test_conf:test_clamp", "conf:clamp", "call"),
  ],
};

/**
 * 기준 시점 `a…`에서 대상 시점 `b…`(repoFixture)로 바뀐 내용.
 * - pkg/mod.py: 함수 drop이 삭제되고 parse가 수정됐다. Store.save → drop, drop → helper 호출이 함께 삭제됐다.
 * - pkg/old.py: 파일이 삭제됐다. 그 안의 legacy → parse 호출과, 외부 노드 yaml로 가던 import가 삭제됐고 yaml은 기준 시점에만 있다.
 * - app/text.py: 함수 pad와 wrap → pad 호출이 추가됐다.
 * - cli.py: 이름이 tool.py에서 바뀌었고 줄은 그대로다. main → helper 호출이 삭제되고 main → log 호출이 추가됐다.
 * - main.py: run → Store.load 호출이 2곳에서 3곳이 됐다.
 * - pkg/__init__.py: 정의가 없어 파일 노드가 없는 파일의 줄이 바뀌었다.
 */
export const compareFixture: Comparison = {
  base: "a".repeat(40),
  target: "b".repeat(40),
  revision: 0,
  graph: {
    nodes: [
      ...repoFixture.nodes,
      node("pkg.mod:drop", "function", "pkg.mod", { path: "pkg/mod.py", range: [52, 58] }),
      node("pkg.old", "module", "pkg", { path: "pkg/old.py", loc: 12 }),
      node("pkg.old:legacy", "function", "pkg.old", { path: "pkg/old.py", range: [3, 12] }),
      node("ext:yaml", "external", null, { origin: "thirdparty" }),
    ],
    edges: [
      ...repoFixture.edges,
      edge("pkg.mod:Store.save", "pkg.mod:drop", "call"),
      edge("pkg.mod:drop", "main:helper", "call"),
      edge("pkg.old:legacy", "pkg.mod:parse", "call", { sites: [4, 9].map((line) => ({ path: "pkg/old.py", line, col: 4 })) }),
      edge("pkg.old", "ext:yaml", "import"),
      edge("cli:main", "main:helper", "call"),
    ],
  },
  tree: { entries: [] },
  nodes: {
    "pkg.mod:drop": { change: "deleted", added: 0, deleted: 7, slot: 51 },
    "pkg.mod:parse": { change: "modified", added: 3, deleted: 1 },
    "pkg.old": { change: "deleted", added: 0, deleted: 12 },
    "pkg.old:legacy": { change: "deleted", added: 0, deleted: 10, slot: 1 },
    "ext:yaml": { change: null, added: 0, deleted: 0, only: "base" },
    "app.text:pad": { change: "added", added: 7, deleted: 0 },
  },
  edges: {
    "pkg.mod:Store.save|pkg.mod:drop|call": { change: "deleted", before: 1 },
    "pkg.mod:drop|main:helper|call": { change: "deleted", before: 1 },
    "pkg.old:legacy|pkg.mod:parse|call": { change: "deleted", before: 2 },
    "pkg.old|ext:yaml|import": { change: "deleted", before: 1 },
    "cli:main|main:helper|call": { change: "deleted", before: 1 },
    "cli:main|common:log|call": { change: "added", before: null },
    "app.text:wrap|app.text:pad|call": { change: "added", before: null },
    "main:run|pkg.mod:Store.load|call": { change: null, before: 2 },
  },
  files: [
    { path: "app/text.py", old: null, status: "modified", added: 7, deleted: 0, hunks: [], test: false },
    { path: "cli.py", old: "tool.py", status: "renamed", added: 0, deleted: 0, hunks: [], test: false },
    { path: "main.py", old: null, status: "modified", added: 1, deleted: 0, hunks: [], test: false },
    { path: "pkg/__init__.py", old: null, status: "modified", added: 2, deleted: 1, hunks: [], test: false },
    { path: "pkg/mod.py", old: null, status: "modified", added: 3, deleted: 8, hunks: [], test: false },
    { path: "pkg/old.py", old: null, status: "deleted", added: 0, deleted: 12, hunks: [], test: false },
  ],
  unused: { definitions: 12, candidates: ["scratch:todo"] },
};
