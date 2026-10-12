import { describe, expect, it } from "vitest";
import { compared, gone, inSource, lineTotals, liveGraph, liveSites, rowChange } from "./compare";
import { compareFixture, edge, node, repoFixture } from "./fixture";
import { edgeKey } from "./scope";

const { graph } = compareFixture;
const lines = (source: string, target: string) => graph.edges.filter((e) => e.source === source && e.target === target);
const keys = (edges: { source: string; target: string; kind: string }[]) => edges.map((e) => `${e.source}|${e.target}|${e.kind}`);

describe("gone", () => {
  it("삭제된 노드와 기준 시점에만 있던 노드, 삭제된 선을 낸다", () => {
    const off = gone(compareFixture);
    expect([...off.nodes].sort()).toEqual(["ext:yaml", "pkg.mod:drop", "pkg.old", "pkg.old:legacy"]);
    expect([...off.edges].sort()).toEqual([
      "cli:main|main:helper|call",
      "pkg.mod:Store.save|pkg.mod:drop|call",
      "pkg.mod:drop|main:helper|call",
      "pkg.old:legacy|pkg.mod:parse|call",
      "pkg.old|ext:yaml|import",
    ]);
  });

  it("비교가 꺼져 있으면 비어 있다", () => {
    expect(gone(null)).toEqual({ nodes: new Set(), edges: new Set() });
  });
});

describe("liveGraph", () => {
  it("삭제된 노드와 선을 빼면 대상 시점의 그래프다", () => {
    const live = liveGraph(graph, compareFixture);
    expect(live.nodes).toEqual(repoFixture.nodes);
    expect(live.edges).toEqual(repoFixture.edges);
  });

  it("비교 결과에 적히지 않았어도 뺀 노드에 닿는 선은 뺀다", () => {
    const stray = edge("main:run", "pkg.mod:drop", "call");
    expect(liveGraph({ nodes: graph.nodes, edges: [...graph.edges, stray] }, compareFixture).edges).toEqual(repoFixture.edges);
  });

  it("비교가 꺼져 있거나 뺄 것이 없으면 받은 그래프 그대로다", () => {
    expect(liveGraph(repoFixture, null)).toBe(repoFixture);
    expect(liveGraph(repoFixture, { ...compareFixture, nodes: { "pkg.mod:parse": compareFixture.nodes["pkg.mod:parse"] }, edges: {} })).toBe(repoFixture);
  });
});

describe("liveSites", () => {
  const off = gone(compareFixture).edges;

  it("화면의 선이 합친 원래 선에서 삭제된 선을 뺀다", () => {
    const merged = [...lines("cli:main", "main:helper"), ...lines("cli:main", "main:run")];
    expect(keys(liveSites(merged, off))).toEqual(["cli:main|main:run|call"]);
  });

  it("삭제된 관계만 든 선은 비고, 추가된 관계와 수만 달라진 관계는 남는다", () => {
    expect(liveSites(lines("pkg.old:legacy", "pkg.mod:parse"), off)).toEqual([]);
    expect(liveSites(lines("cli:main", "common:log"), off)).toHaveLength(1);
    expect(liveSites(lines("main:run", "pkg.mod:Store.load"), off)).toHaveLength(1);
  });

  it("삭제된 선이 없으면 받은 목록 그대로다", () => {
    expect(liveSites(repoFixture.edges, new Set())).toBe(repoFixture.edges);
  });
});

describe("lineTotals", () => {
  const totals = lineTotals(graph, compareFixture.files);

  it("파일의 줄 수를 파일 노드에 적고 삭제된 파일도 적는다", () => {
    expect(totals.get("pkg.mod")).toEqual({ added: 3, deleted: 8 });
    expect(totals.get("pkg.old")).toEqual({ added: 0, deleted: 12 });
    expect(totals.get("app.text")).toEqual({ added: 7, deleted: 0 });
  });

  it("폴더의 수가 아래 파일의 합이고 파일 노드가 없는 파일의 줄 수가 든다", () => {
    expect(totals.get("pkg")).toEqual({ added: 5, deleted: 21 });
    expect(totals.get("app")).toEqual({ added: 7, deleted: 0 });
  });

  it("최상위 노드의 합이 바뀐 파일 전체의 합과 같다", () => {
    const top = graph.nodes.filter((n) => n.parent === null).map((n) => totals.get(n.id) ?? { added: 0, deleted: 0 });
    const sum = (side: "added" | "deleted") => compareFixture.files.reduce((n, file) => n + file[side], 0);
    expect([top.reduce((n, t) => n + t.added, 0), top.reduce((n, t) => n + t.deleted, 0)]).toEqual([sum("added"), sum("deleted")]);
  });

  it("패키지 노드의 path가 `__init__.py`여도 그 파일의 줄 수를 그 폴더부터 더한다", () => {
    const packaged = { nodes: [node("lib", "package", null, { path: "lib/__init__.py" }), node("lib.a", "module", "lib", { path: "lib/a.py" })], edges: [] };
    const files = [
      { path: "lib/__init__.py", old: null, status: "modified" as const, added: 2, deleted: 1, hunks: [], test: false },
      { path: "lib/a.py", old: null, status: "modified" as const, added: 4, deleted: 0, hunks: [], test: false },
    ];
    expect(lineTotals(packaged, files).get("lib")).toEqual({ added: 6, deleted: 1 });
  });

  it("줄 수가 0인 파일과 바뀌지 않은 파일은 담지 않는다", () => {
    expect(totals.has("cli")).toBe(false);
    expect(totals.has("common")).toBe(false);
    expect([...totals.keys()].sort()).toEqual(["app", "app.text", "main", "pkg", "pkg.mod", "pkg.old"]);
  });
});

describe("rowChange", () => {
  const changes = compareFixture.edges;

  it("바뀐 선이 없는 줄은 0과 null이다", () => {
    expect(rowChange(lines("main:run", "main:helper"), changes)).toEqual({ added: 0, deleted: 0, before: null });
  });

  it("추가된 선과 삭제된 선의 수를 센다", () => {
    expect(rowChange(lines("cli:main", "common:log"), changes)).toEqual({ added: 1, deleted: 0, before: null });
    expect(rowChange(lines("pkg.old:legacy", "pkg.mod:parse"), changes)).toEqual({ added: 0, deleted: 1, before: null });
    const file = graph.edges.filter((e) => e.source === "cli:main");
    expect(keys(file).sort()).toEqual(["cli:main|common:log|call", "cli:main|main:helper|call", "cli:main|main:run|call"]);
    expect(rowChange(file, changes)).toEqual({ added: 1, deleted: 1, before: null });
  });

  it("수만 달라진 선이 든 줄은 기준 시점의 수를 종류마다 낸다", () => {
    expect(rowChange(lines("main:run", "pkg.mod:Store.load"), changes)).toEqual({ added: 0, deleted: 0, before: { call: 2 } });
  });

  it("기준 시점의 수는 그 줄에 있던 세는 관계를 모두 더하고 추가된 선과 세지 않는 관계는 뺀다", () => {
    const row = [
      ...lines("main:run", "pkg.mod:Store.load"),
      ...lines("main:run", "main:helper"),
      ...lines("cli:main", "main:helper"),
      ...lines("cli:main", "common:log"),
      edge("main:run", "pkg.mod:Row", "construct"),
      edge("main:run", "pkg.mod:Row", "type"),
    ];
    expect(rowChange(row, changes)).toEqual({ added: 1, deleted: 1, before: { call: 4, construct: 1 } });
  });

  it("기준 시점의 수가 지금과 같은 선은 수만 달라진 선이 아니다", () => {
    const same = lines("main:run", "main:helper")[0];
    expect(rowChange([same], { [edgeKey(same)]: { change: null, before: 1 } }).before).toBeNull();
  });
});

describe("compared", () => {
  const drawn = compared(graph, compareFixture);

  it("대상 시점의 그래프, 흐린 단계로 그리는 노드와 선, 선마다의 변경 내용을 한 번에 낸다", () => {
    expect(drawn.live).toEqual(liveGraph(graph, compareFixture));
    expect(drawn.gone).toEqual(gone(compareFixture));
    expect(drawn.changes).toBe(compareFixture.edges);
  });

  it("이름 옆 줄 수는 정의면 비교 결과의 nodes에서, 파일과 폴더면 lineTotals에서 읽고 바뀐 줄이 없는 노드는 담지 않는다", () => {
    expect(drawn.lines.get("pkg.mod:parse")).toEqual({ added: 3, deleted: 1 });
    expect(drawn.lines.get("pkg.mod:drop")).toEqual({ added: 0, deleted: 7 });
    expect(drawn.lines.get("app.text:pad")).toEqual({ added: 7, deleted: 0 });
    expect(drawn.lines.get("pkg.old")).toEqual({ added: 0, deleted: 12 });
    expect(drawn.lines.get("pkg")).toEqual({ added: 5, deleted: 21 });
    expect(drawn.lines.has("ext:yaml")).toBe(false);
    expect(drawn.lines.has("main:run")).toBe(false);
  });

  it("삭제된 노드의 slot을 담는다", () => {
    expect([...drawn.slots]).toEqual([
      ["pkg.mod:drop", 51],
      ["pkg.old:legacy", 1],
    ]);
  });
});

describe("inSource", () => {
  const inFile = graph.nodes.filter((n) => n.path === "pkg/mod.py" && n.kind !== "module");

  it("삭제된 정의를 대상 시점의 본문에서 놓였을 줄 뒤에 끼운다", () => {
    expect(inSource(inFile, compareFixture.nodes).map((n) => n.id)).toEqual([
      "pkg.mod:Store",
      "pkg.mod:Store.load",
      "pkg.mod:Store.save",
      "pkg.mod:Row",
      "pkg.mod:parse",
      "pkg.mod:drop",
    ]);
    const early = { ...compareFixture.nodes, "pkg.mod:drop": { change: "deleted" as const, added: 0, deleted: 7, slot: 32 } };
    expect(inSource(inFile, early).map((n) => n.id.split(":")[1])).toEqual(["Store", "Store.load", "Store.save", "Row", "drop", "parse"]);
  });

  it("비교가 꺼져 있으면 시작 줄 순서다", () => {
    expect(inSource([...inFile].reverse(), null).map((n) => n.range?.[0])).toEqual([1, 3, 12, 32, 42, 52]);
  });
});
