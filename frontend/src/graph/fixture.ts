// 시험용 고정 그래프. 폴더 pkg → 파일 pkg.mod → 클래스 Store → 메서드 두 개를 3단으로 중첩하고,
// 메서드가 클래스 밖 데이터 클래스·함수로 계층을 넘어 잇고, 파일 main의 진입점 run과 메서드가 파일 경계를 넘어 서로 부른다.
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

export const fixture: Graph = {
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
  ],
};
