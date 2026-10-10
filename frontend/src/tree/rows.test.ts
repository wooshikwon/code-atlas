import { describe, expect, it } from "vitest";
import type { AtlasNode, Graph, Tree } from "../api/types";
import { build, find } from "../search/index";
import { parentOf, results, rows, type TreeState } from "./rows";

function node(id: string, kind: AtlasNode["kind"], parent: string | null, path: string, start = 1, test = false): AtlasNode {
  const name = id.includes(":") ? id.split(":")[1].split(".").at(-1)! : id.split(".").at(-1)!;
  return { id, kind, name, parent, path, range: [start, start + 5], test } as AtlasNode;
}

// 소스 루트 src에는 패키지 노드가 없고, 폴더 parser와 그 안의 __init__.py는 같은 패키지 노드를 가리킨다.
const graph: Graph = {
  nodes: [
    node("arbiter", "module", null, "src/arbiter.py"),
    node("arbiter:run", "function", "arbiter", "src/arbiter.py", 60),
    node("arbiter:Arbiter", "class", "arbiter", "src/arbiter.py", 10),
    node("arbiter:Arbiter.sync", "method", "arbiter:Arbiter", "src/arbiter.py", 30),
    node("arbiter:Arbiter.load", "method", "arbiter:Arbiter", "src/arbiter.py", 12),
    node("arbiter:State", "dataclass", "arbiter", "src/arbiter.py", 2),
    node("empty", "module", null, "src/empty.py"),
    node("parser", "package", null, "src/parser/__init__.py"),
    node("parser:version", "function", "parser", "src/parser/__init__.py", 3),
    node("parser.plan", "module", "parser", "src/parser/plan.py"),
    node("parser.plan:parse_plan", "function", "parser.plan", "src/parser/plan.py", 8),
    node("tests", "package", null, "tests", 1, true),
    node("tests.test_plan", "module", "tests", "tests/test_plan.py", 1, true),
  ],
  edges: [],
};

const file = (path: string, nodeId: string, test = false) => ({
  path,
  name: path.split("/").at(-1)!,
  kind: "file" as const,
  test,
  node: nodeId,
});

const tree: Tree = {
  entries: [
    {
      path: "src",
      name: "src",
      kind: "dir",
      test: false,
      node: null,
      children: [
        {
          path: "src/parser",
          name: "parser",
          kind: "dir",
          test: false,
          node: "parser",
          children: [file("src/parser/__init__.py", "parser"), file("src/parser/plan.py", "parser.plan")],
        },
        file("src/arbiter.py", "arbiter"),
        file("src/empty.py", "empty"),
      ],
    },
    { path: "tests", name: "tests", kind: "dir", test: true, node: "tests", children: [file("tests/test_plan.py", "tests.test_plan", true)] },
  ],
};

const state = (change: Partial<TreeState> = {}): TreeState => ({
  collapsed: new Set(),
  selected: null,
  showTests: false,
  ...change,
});
const keys = (change?: Partial<TreeState>) => rows(tree, graph, state(change)).map((row) => row.key);

describe("rows", () => {
  it("폴더와 파일을 깊이와 함께 위에서 아래로 편다", () => {
    expect(rows(tree, graph, state()).map((row) => [row.label, row.kind, row.level, row.expanded])).toEqual([
      ["src/", "dir", 1, true],
      ["parser/", "dir", 2, true],
      ["__init__.py", "file", 3, false],
      ["plan.py", "file", 3, false],
      ["arbiter.py", "file", 2, false],
      ["empty.py", "file", 2, null],
    ]);
  });

  it("접은 폴더의 자식은 빠지고 폴더 행은 남는다", () => {
    const list = rows(tree, graph, state({ collapsed: new Set(["parser"]) }));
    expect(list.map((row) => row.key)).toEqual(["src", "src/parser", "src/arbiter.py", "src/empty.py"]);
    expect(list[1].expanded).toBe(false);
  });

  it("패키지 노드가 없는 폴더는 늘 펼친다", () => {
    const list = rows(tree, graph, state({ collapsed: new Set(["src"]) }));
    expect(list[0]).toMatchObject({ key: "src", node: null, expanded: true });
    expect(list).toHaveLength(6);
  });

  it("고른 파일 아래에 클래스·함수 목록을 소스 정의 순서로 잇는다", () => {
    const list = rows(tree, graph, state({ selected: "arbiter" }));
    const at = list.findIndex((row) => row.key === "src/arbiter.py");
    expect(list[at]).toMatchObject({ expanded: true, selected: true });
    expect(list.slice(at + 1, at + 6).map((row) => [row.label, row.kind, row.level])).toEqual([
      ["State", "symbol", 3],
      ["Arbiter", "symbol", 3],
      ["Arbiter.load()", "symbol", 3],
      ["Arbiter.sync()", "symbol", 3],
      ["run()", "symbol", 3],
    ]);
    expect(list[at + 6].key).toBe("src/empty.py");
  });

  it("행마다 폴더의 열림과 노드 종류에 맞는 기호를 정한다", () => {
    const list = rows(tree, graph, state({ collapsed: new Set(["parser"]), selected: "arbiter" }));
    expect(list.slice(0, 7).map((row) => [row.label, row.icon])).toEqual([
      ["src/", "folder-open"],
      ["parser/", "folder"],
      ["arbiter.py", "file"],
      ["State", "dataclass"],
      ["Arbiter", "class"],
      ["Arbiter.load()", "method"],
      ["Arbiter.sync()", "method"],
    ]);
    expect(list[7]).toMatchObject({ label: "run()", icon: "function" });
  });

  it("함수를 고르면 그 함수가 든 파일의 목록을 펴고 함수 행만 고른 행으로 표시한다", () => {
    const list = rows(tree, graph, state({ selected: "arbiter:Arbiter.sync" }));
    expect(list.filter((row) => row.selected).map((row) => row.key)).toEqual(["arbiter:Arbiter.sync"]);
    expect(list.find((row) => row.key === "src/arbiter.py")?.expanded).toBe(true);
    expect(list.some((row) => row.key === "parser.plan:parse_plan")).toBe(false);
  });

  it("폴더와 __init__.py가 같은 패키지 노드를 가리키면 두 행을 고른 행으로 표시하고 목록은 파일 아래에 잇는다", () => {
    const list = rows(tree, graph, state({ selected: "parser" }));
    expect(list.filter((row) => row.selected).map((row) => row.key)).toEqual(["src/parser", "src/parser/__init__.py"]);
    expect(list.map((row) => row.key).slice(1, 5)).toEqual([
      "src/parser",
      "src/parser/__init__.py",
      "parser:version",
      "src/parser/plan.py",
    ]);
  });

  it("테스트 코드는 토글이 켜졌을 때만 넣는다", () => {
    expect(keys()).not.toContain("tests");
    expect(keys({ showTests: true }).slice(-2)).toEqual(["tests", "tests/test_plan.py"]);
  });
});

describe("parentOf", () => {
  it("깊이가 하나 얕은 가장 가까운 윗행을 찾는다", () => {
    const list = rows(tree, graph, state({ selected: "arbiter:run" }));
    const at = (key: string) => list.findIndex((row) => row.key === key);
    expect(parentOf(list, at("arbiter:run"))).toBe(at("src/arbiter.py"));
    expect(parentOf(list, at("src/arbiter.py"))).toBe(at("src"));
    expect(parentOf(list, at("src"))).toBe(-1);
  });
});

describe("results", () => {
  const entries = build(graph, false);

  it("질의가 있으면 결과 행이 find의 순서를 따른다", () => {
    const list = results(entries, "pl", null);
    expect(list.length).toBeGreaterThan(1);
    expect(list.map((result) => result.hit)).toEqual(find(entries, "pl", 200));
    expect(list[0].hit.entry.id).toBe("parser.plan");
  });

  it("고른 노드의 결과 행만 고른 행으로 표시한다", () => {
    const list = results(entries, "plan", "parser.plan:parse_plan");
    expect(list.filter((result) => result.selected).map((result) => result.hit.entry.id)).toEqual(["parser.plan:parse_plan"]);
  });

  it("질의가 비면 결과 행이 없다", () => {
    expect(results(entries, " ", "arbiter")).toEqual([]);
  });
});
