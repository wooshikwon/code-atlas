// 시험용 고정 그래프. 폴더 pkg → 파일 pkg.mod → 클래스 Store → 메서드 두 개를 3단으로 중첩하고,
// 메서드가 클래스 밖 데이터 클래스·함수로 계층을 넘어 잇고, 파일 main의 진입점 run과 메서드가 파일 경계를 넘어 서로 부른다.
// 여기에 서로 import하는 진입점 파일 cli, 선이 없는 파일 scratch, 파일 네 개가 import하는 common,
// 함수 진입점 index에서 시작해 파일 경계를 넘는 세 단계 호출 사슬 index → render → wrap → pad,
// 폴더 pkg 안의 테스트 코드 pkg.conftest, 폴더 app의 `__init__.py`에 정의한 함수 app:version을 더한다.
import type { AtlasEdge, AtlasNode, Graph } from "../api/types";

function node(id: string, kind: AtlasNode["kind"], parent: string | null, extra: Partial<AtlasNode> = {}): AtlasNode {
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
    ...extra,
  };
}

function edge(source: string, target: string, kind: AtlasEdge["kind"], extra: Partial<AtlasEdge> = {}): AtlasEdge {
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
    node("app", "package", null, { path: "app/__init__.py" }),
    node("app.web", "module", "app", { path: "app/web.py", loc: 30 }),
    node("app.web:index", "function", "app.web", { path: "app/web.py", range: [5, 12], entry: true }),
    node("app.web:render", "function", "app.web", { path: "app/web.py", range: [14, 25] }),
    node("app.text", "module", "app", { path: "app/text.py", loc: 20 }),
    node("app.text:wrap", "function", "app.text", { path: "app/text.py", range: [1, 8] }),
    node("app.text:pad", "function", "app.text", { path: "app/text.py", range: [10, 16] }),
    node("app:version", "function", "app", { path: "app/__init__.py", range: [1, 3] }),
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
    edge("cli:main", "common:log", "call"),
    edge("app.web", "app.text", "import"),
    edge("app.web:index", "app.web:render", "call"),
    edge("app.web:render", "app.text:wrap", "call"),
    edge("app.text:wrap", "app.text:pad", "call"),
    edge("pkg.conftest:setup", "main:helper", "call"),
  ],
};
