import { describe, expect, it } from "vitest";
import type { AtlasEdge, AtlasNode, Graph } from "../api/types";
import { columns, entryUnits, siblings } from "./columns";
import { compared } from "./compare";
import { compareFixture, repoFixture } from "./fixture";
import { nodeIndex } from "./visible";

const off = { showTests: false, showExternal: false };

function unit(id: string, extra: Partial<AtlasNode> = {}): AtlasNode {
  return {
    id,
    kind: "module",
    name: id,
    parent: null,
    path: `${id}.py`,
    range: null,
    loc: 1,
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

function link(source: string, target: string, extra: Partial<AtlasEdge> = {}): AtlasEdge {
  return { group: "use", kind: "import", source, target, sites: [{ path: "x.py", line: 1, col: 0 }], deferred: false, ...extra };
}

function small(nodes: AtlasNode[], edges: [string, string][]): Graph {
  return { nodes, edges: edges.map(([source, target]) => link(source, target)) };
}

function pick(map: Map<string, number>, ids: string[]): Record<string, number | undefined> {
  return Object.fromEntries(ids.map((id) => [id, map.get(id)]));
}

describe("siblings, entryUnits", () => {
  const nodes = nodeIndex(repoFixture);

  it("두 노드를 같은 부모 아래 형제가 될 때까지 올린다", () => {
    expect(siblings(nodes, "main:run", "pkg.mod:Store.load")).toEqual(["main", "pkg"]);
    expect(siblings(nodes, "pkg.mod:Store.load", "pkg.mod:Row")).toEqual(["pkg.mod:Store", "pkg.mod:Row"]);
    expect(siblings(nodes, "pkg.mod", "pkg.util")).toEqual(["pkg.mod", "pkg.util"]);
  });

  it("같은 노드와 조상·자손 사이는 null이다", () => {
    expect(siblings(nodes, "pkg.mod", "pkg.mod")).toBeNull();
    expect(siblings(nodes, "pkg.mod:Store.load", "pkg")).toBeNull();
  });

  it("진입점과 진입점을 품은 파일·폴더를 모은다", () => {
    expect([...entryUnits(repoFixture, new Set())].sort()).toEqual(["app", "app.web", "app.web:index", "cli", "main"]);
    expect(entryUnits(repoFixture, new Set(["app.web:index"])).has("app")).toBe(false);
  });
});

describe("columns", () => {
  const result = columns(repoFixture, off);

  it("진입점을 품은 최상위 단위는 열0이고 나머지는 앞 단위의 가장 큰 열에 1을 더한다", () => {
    expect(pick(result.column, ["main", "cli", "app", "pkg", "common"])).toEqual({ main: 0, cli: 0, app: 0, pkg: 1, common: 2 });
  });

  it("폴더 안 파일, 파일 안 노드, 클래스 안 메서드의 열을 부모마다 따로 정한다", () => {
    expect(pick(result.column, ["app.web", "app.text"])).toEqual({ "app.web": 0, "app.text": 1 });
    expect(pick(result.column, ["app.web:index", "app.web:render"])).toEqual({ "app.web:index": 0, "app.web:render": 1 });
    expect(pick(result.column, ["app.text:wrap", "app.text:pad"])).toEqual({ "app.text:wrap": 0, "app.text:pad": 1 });
    expect(pick(result.column, ["pkg.mod:Store", "pkg.mod:Row", "pkg.mod:parse"])).toEqual({
      "pkg.mod:Store": 0,
      "pkg.mod:Row": 1,
      "pkg.mod:parse": 1,
    });
    expect(pick(result.column, ["pkg.mod:Store.load", "pkg.mod:Store.save"])).toEqual({
      "pkg.mod:Store.load": 0,
      "pkg.mod:Store.save": 1,
    });
    expect(pick(result.column, ["main:run", "main:helper"])).toEqual({ "main:run": 0, "main:helper": 1 });
  });

  it("함수 안 import는 열 배정에 쓰지 않는다", () => {
    expect(pick(result.column, ["pkg.mod", "pkg.util"])).toEqual({ "pkg.mod": 0, "pkg.util": 0 });
  });

  it("형제를 폴더, 파일, 소스 정의 줄 순서로 센다", () => {
    const top = ["app", "pkg", "cli", "common", "main", "scratch"];
    expect(top.map((id) => result.order.get(id))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pick(result.order, ["main:run", "main:helper"])).toEqual({ "main:run": 0, "main:helper": 1 });
    expect(pick(result.order, ["pkg.mod:Store", "pkg.mod:Row", "pkg.mod:parse"])).toEqual({
      "pkg.mod:Store": 0,
      "pkg.mod:Row": 1,
      "pkg.mod:parse": 2,
    });
  });

  it("선으로 이어진 최상위 단위를 묶음 하나로, 선이 없는 단위를 선반으로 나눈다", () => {
    expect(result.components).toEqual([["app", "pkg", "cli", "common", "main"]]);
    expect(result.shelf).toEqual(["scratch"]);
  });

  it("안의 노드 사이에만 선이 있는 최상위 폴더는 단위 하나짜리 묶음이고, 선이 없는 폴더와 파일은 선반이다", () => {
    const graph: Graph = {
      nodes: [
        unit("app", { kind: "package" }),
        unit("app.cli", { parent: "app" }),
        unit("app.core", { parent: "app" }),
        unit("app.lone", { parent: "app" }),
        unit("docs", { kind: "package" }),
        unit("docs.conf", { parent: "docs" }),
        unit("setup"),
        unit("setup:main", { kind: "function", parent: "setup" }),
        unit("setup:helper", { kind: "function", parent: "setup" }),
      ],
      edges: [link("app.cli", "app.core"), link("setup:main", "setup:helper")],
    };
    const result = columns(graph, off);
    expect(result.components).toEqual([["app"]]);
    expect(result.shelf).toEqual(["docs", "setup"]);
    expect([result.column.get("app.cli"), result.column.get("app.core"), result.column.get("app.lone")]).toEqual([0, 1, 0]);
  });

  it("토글로 숨긴 노드는 열과 순서를 받지 않는다", () => {
    expect(result.column.has("tests.test_mod")).toBe(false);
    expect(result.column.has("pkg.conftest")).toBe(false);
    expect(result.order.has("ext:json")).toBe(false);
  });

  it("테스트 코드와 외부 노드를 켜면 그 노드와 선을 넣어 다시 계산한다", () => {
    const all = columns(repoFixture, { showTests: true, showExternal: true });
    expect(pick(all.column, ["main", "tests.test_mod", "pkg", "common", "ext:json"])).toEqual({
      main: 0,
      "tests.test_mod": 1,
      pkg: 2,
      common: 3,
      "ext:json": 3,
    });
    expect(all.components[0]).toContain("ext:json");
  });

  it("진입점이 없는 그래프는 앞 단위가 없는 단위가 열0이고, 순환은 되돌아가는 선을 빼서 끊는다", () => {
    const graph = small(
      [unit("a"), unit("b"), unit("c"), unit("d")],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
        ["c", "d"],
      ],
    );
    expect(pick(columns(graph, off).column, ["a", "b", "c", "d"])).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });

  it("진입점으로 들어가는 선은 쓰지 않고, 진입점이 있으면 앞 단위가 없는 단위는 열1이다", () => {
    const graph = small(
      [unit("a"), unit("b", { entry: true }), unit("c"), unit("d", { entry: true })],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
        ["b", "d"],
        ["d", "b"],
      ],
    );
    expect(pick(columns(graph, off).column, ["a", "b", "c", "d"])).toEqual({ a: 2, b: 0, c: 1, d: 0 });
    const loose = small([unit("a"), unit("b", { entry: true }), unit("c")], [["a", "b"], ["b", "c"]]);
    expect(pick(columns(loose, off).column, ["a", "b", "c"])).toEqual({ a: 1, b: 0, c: 1 });
  });

  it("연결 묶음을 노드 수 내림차순으로 담고 선반을 이름순으로 담는다", () => {
    const graph: Graph = {
      nodes: [
        unit("a"),
        unit("b"),
        unit("c"),
        unit("d"),
        unit("d:f", { kind: "function", parent: "d", name: "f", range: [1, 2] }),
        unit("d:g", { kind: "function", parent: "d", name: "g", range: [3, 4] }),
        unit("z"),
        unit("y"),
      ],
      edges: [link("a", "b"), link("c", "d:f"), link("d:f", "d:g")],
    };
    const result = columns(graph, off);
    expect(result.components).toEqual([
      ["c", "d"],
      ["a", "b"],
    ]);
    expect(result.shelf).toEqual(["y", "z"]);
    expect(pick(result.column, ["a", "b", "c", "d", "y", "z"])).toEqual({ a: 0, b: 1, c: 0, d: 1, y: 0, z: 0 });
  });

  it("함수 안 import만 있는 단위는 선반에 두지 않는다", () => {
    const graph: Graph = { nodes: [unit("a"), unit("b")], edges: [link("a", "b", { deferred: true })] };
    const result = columns(graph, off);
    expect(result.components).toEqual([["a", "b"]]);
    expect(result.shelf).toEqual([]);
    expect(pick(result.column, ["a", "b"])).toEqual({ a: 0, b: 0 });
  });
});

describe("columns: 시점 비교", () => {
  const { graph } = compareFixture;
  const compare = compared(graph, compareFixture);
  const both = { showTests: true, showExternal: true };
  /** 부모마다 자식을 순서 번호 순으로 늘어놓은 글. only에 든 노드만 적는다. */
  const sequence = (result: ReturnType<typeof columns>, only: Set<string>) => {
    const lists = new Map<string | null, string[]>();
    for (const node of graph.nodes.filter((n) => only.has(n.id) && result.order.has(n.id))) {
      lists.set(node.parent, [...(lists.get(node.parent) ?? []), node.id]);
    }
    return [...lists].map(([parent, ids]) => `${parent}: ${ids.sort((a, b) => result.order.get(a)! - result.order.get(b)!).join(",")}`).sort();
  };

  it("비교를 켜도 대상 시점 노드의 열 번호와 형제 사이의 상대 순서, 연결 묶음과 선반 안의 순서가 같다", () => {
    for (const opts of [off, both]) {
      const before = columns(repoFixture, opts);
      const after = columns(graph, opts, compare);
      const live = new Set(before.order.keys());
      expect(live.size).toBeGreaterThan(10);
      expect(pick(after.column, [...live])).toEqual(Object.fromEntries(before.column));
      expect(sequence(after, live)).toEqual(sequence(before, live));
      expect(after.components.map((ids) => ids.filter((id) => live.has(id)))).toEqual(before.components);
      expect(after.shelf.filter((id) => live.has(id))).toEqual(before.shelf);
    }
  });

  it("비교가 없거나 흐린 단계로 그리는 노드가 없으면 대상 시점의 열과 순서 그대로다", () => {
    expect(columns(repoFixture, off, null)).toEqual(columns(repoFixture, off));
    const none = compared(repoFixture, { ...compareFixture, graph: repoFixture, nodes: {}, edges: {} });
    expect(columns(repoFixture, off, none)).toEqual(columns(repoFixture, off));
  });

  it("삭제된 정의는 slot의 줄 번호로 소스 정의 순서에 끼우고, 그 노드로 선을 보내는 형제의 다음 열에 놓는다", () => {
    const result = columns(graph, off, compare);
    expect(sequence(result, new Set(result.order.keys()))).toContain("pkg.mod: pkg.mod:Store,pkg.mod:Row,pkg.mod:parse,pkg.mod:drop");
    expect(pick(result.column, ["pkg.mod:Store", "pkg.mod:drop"])).toEqual({ "pkg.mod:Store": 0, "pkg.mod:drop": 1 });
    const early = compared(graph, { ...compareFixture, nodes: { ...compareFixture.nodes, "pkg.mod:drop": { change: "deleted", added: 0, deleted: 7, slot: 31 } } });
    expect(sequence(columns(graph, off, early), new Set(result.order.keys()))).toContain("pkg.mod: pkg.mod:Store,pkg.mod:drop,pkg.mod:Row,pkg.mod:parse");
  });

  it("삭제된 파일은 형제 순서(폴더, 파일, 이름순)에 끼우고 들어오는 선이 없으면 형제의 첫 열에 놓는다", () => {
    const result = columns(graph, off, compare);
    expect(sequence(result, new Set(result.order.keys()))).toContain("pkg: pkg.mod,pkg.old,pkg.util");
    expect(pick(result.column, ["pkg.old", "pkg.old:legacy"])).toEqual({ "pkg.old": 0, "pkg.old:legacy": 0 });
  });

  it("기준 시점에만 있던 최상위 단위는 선으로 이어진 단위의 연결 묶음에 들고, 선이 없으면 선반에, 더한 단위끼리만 이어지면 새 묶음에 든다", () => {
    const linked = columns(graph, both, compare);
    expect(linked.components.find((ids) => ids.includes("ext:yaml"))).toContain("pkg");
    expect(linked.column.get("ext:yaml")).toBe(linked.column.get("pkg")! + 1);
    expect(columns(graph, off, compare).order.has("ext:yaml")).toBe(false);

    const base = small([unit("a"), unit("b"), unit("z")], [["a", "b"]]);
    const more: Graph = { nodes: [...base.nodes, unit("gone"), unit("lost"), unit("left")], edges: [...base.edges, link("lost", "left")] };
    const deleted = { change: "deleted" as const, added: 0, deleted: 1 };
    const result = columns(more, off, compared(more, { ...compareFixture, graph: more, files: [], nodes: { gone: deleted, lost: deleted, left: deleted }, edges: { "lost|left|import": { change: "deleted", before: 1 } } }));
    expect(result.components).toEqual([["a", "b"], ["left", "lost"]]);
    expect(result.shelf).toEqual(["gone", "z"]);
    expect(pick(result.column, ["gone", "lost", "left"])).toEqual({ gone: 0, lost: 0, left: 1 });
  });
});
