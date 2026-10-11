import { describe, expect, it } from "vitest";
import type { AtlasNode, Changes, Graph, Tree } from "../api/types";
import { build, find } from "../search/index";
import { parentOf, results, rows, type TreeState } from "./rows";

function node(id: string, kind: AtlasNode["kind"], parent: string | null, path: string, start = 1, test = false): AtlasNode {
  const name = id.includes(":") ? id.split(":")[1].split(".").at(-1)! : id.split(".").at(-1)!;
  return { id, kind, name, parent, path, range: [start, start + 5], test } as AtlasNode;
}

// 소스 루트 src에는 패키지 노드가 없고, 폴더 parser 안의 __init__.py는 모듈 노드가 없다.
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
    node("parser.plan", "module", "parser", "src/parser/plan.py"),
    node("parser.plan:parse_plan", "function", "parser.plan", "src/parser/plan.py", 8),
    node("tests", "package", null, "tests", 1, true),
    node("tests.test_plan", "module", "tests", "tests/test_plan.py", 1, true),
  ],
  edges: [],
};

const file = (path: string, nodeId: string | null, test = false) => ({
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
          children: [file("src/parser/__init__.py", null), file("src/parser/plan.py", "parser.plan")],
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
  opened: null,
  showTests: false,
  changes: null,
  ...change,
});

// arbiter.py의 메서드 하나를 고쳤고, plan.py는 분석한 뒤 고쳤고, 새 파일 두 개와 지워진 파일 하나가 있다.
const changes: Changes = {
  git: true,
  branch: "main",
  files: [
    { path: "src/arbiter.py", status: "modified", stale: false, test: false },
    { path: "src/gone.py", status: "deleted", stale: false, test: false },
    { path: "src/parser/plan.py", status: "modified", stale: true, test: false },
    { path: "src/parser/note.py", status: "added", stale: false, test: false },
    { path: "src/tools/new/late.py", status: "added", stale: false, test: false },
  ],
  nodes: { arbiter: "modified", "arbiter:Arbiter.sync": "modified", "parser.plan": "modified" },
};
const keys = (change?: Partial<TreeState>) => rows(tree, graph, state(change)).map((row) => row.key);

describe("rows", () => {
  it("폴더와 파일을 깊이와 함께 위에서 아래로 편다", () => {
    expect(rows(tree, graph, state()).map((row) => [row.label, row.kind, row.level, row.expanded])).toEqual([
      ["src/", "dir", 1, true],
      ["parser/", "dir", 2, true],
      ["__init__.py", "file", 3, null],
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

  it("고른 노드를 품은 폴더는 접은 폴더여도 펼치고, 고른 폴더는 접은 채로 둔다", () => {
    const list = rows(tree, graph, state({ collapsed: new Set(["parser"]), selected: "parser.plan:parse_plan" }));
    expect(list.find((row) => row.key === "src/parser")).toMatchObject({ expanded: true });
    expect(list.find((row) => row.key === "parser.plan:parse_plan")).toMatchObject({ selected: true });
    const folded = rows(tree, graph, state({ collapsed: new Set(["parser"]), selected: "parser" }));
    expect(folded.find((row) => row.key === "src/parser")).toMatchObject({ expanded: false, selected: true });
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

  it("__init__.py 행은 노드 없이 파일 경로를 담고, 폴더를 골라도 고른 행이 되지 않으며 아래에 목록을 잇지 않는다", () => {
    const list = rows(tree, graph, state({ selected: "parser" }));
    expect(list.filter((row) => row.selected).map((row) => row.key)).toEqual(["src/parser"]);
    expect(list.find((row) => row.key === "src/parser/__init__.py")).toMatchObject({ node: null, file: "src/parser/__init__.py", expanded: null });
    expect(list.filter((row) => row.file !== null)).toHaveLength(1);
  });

  it("모듈 노드가 있는 __init__.py 행은 그 노드를 가리키고 정의를 고르면 아래에 목록을 잇는다", () => {
    const defined: Graph = {
      nodes: [
        ...graph.nodes.map((n) => (n.id === "parser" ? { ...n, path: "src/parser" } : n)),
        node("parser.__init__", "module", "parser", "src/parser/__init__.py"),
        node("parser:version", "function", "parser.__init__", "src/parser/__init__.py", 3),
      ],
      edges: [],
    };
    const linked = structuredClone(tree);
    linked.entries[0].children![0].children![0].node = "parser.__init__";
    const init = (selected: string | null) => rows(linked, defined, state({ selected })).find((row) => row.key === "src/parser/__init__.py");
    expect(init(null)).toMatchObject({ node: "parser.__init__", file: null, expanded: false, selected: false });
    expect(init("parser.__init__")).toMatchObject({ expanded: true, selected: true });
    const list = rows(linked, defined, state({ selected: "parser:version" }));
    expect(list.filter((row) => row.selected).map((row) => row.key)).toEqual(["parser:version"]);
    expect(list[list.findIndex((row) => row.key === "parser:version") - 1].key).toBe("src/parser/__init__.py");
  });

  it("__init__.py 행이 패키지 노드 id를 담은 파일트리에서도 그 행은 노드 없이 파일 경로를 담는다", () => {
    const old = structuredClone(tree);
    old.entries[0].children![0].children![0].node = "parser";
    const list = rows(old, graph, state({ selected: "parser" }));
    expect(list.filter((row) => row.selected).map((row) => row.key)).toEqual(["src/parser"]);
    expect(list.find((row) => row.key === "src/parser/__init__.py")).toMatchObject({ node: null, file: "src/parser/__init__.py" });
  });

  it("정보 패널에 연 파일의 행을 고른 행으로 표시한다", () => {
    const list = rows(tree, graph, state({ selected: "arbiter", opened: "src/parser/__init__.py" }));
    expect(list.filter((row) => row.selected).map((row) => row.key)).toEqual(["src/parser/__init__.py", "src/arbiter.py"]);
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

describe("변경 표시", () => {
  const marks = (change?: Partial<TreeState>) =>
    rows(tree, graph, state({ changes, ...change })).map((row) => [row.label, row.change] as const);

  it("바뀐 파일과 바뀐 정의의 행에만 변경 상태를 붙인다", () => {
    const list = marks({ selected: "arbiter" });
    expect(list.filter(([, change]) => change !== null)).toEqual([
      ["note.py", "added"],
      ["plan.py", "modified"],
      ["late.py", "added"],
      ["arbiter.py", "modified"],
      ["Arbiter.sync()", "modified"],
    ]);
  });

  it("분석한 뒤 생긴 파일을 제 폴더에 이름 순서로 넣고 없는 폴더는 만든다", () => {
    const list = rows(tree, graph, state({ changes }));
    expect(list.map((row) => [row.key, row.level, row.node])).toEqual([
      ["src", 1, null],
      ["src/parser", 2, "parser"],
      ["src/parser/__init__.py", 3, null],
      ["src/parser/note.py", 3, null],
      ["src/parser/plan.py", 3, "parser.plan"],
      ["src/tools", 2, null],
      ["src/tools/new", 3, null],
      ["src/tools/new/late.py", 4, null],
      ["src/arbiter.py", 2, "arbiter"],
      ["src/empty.py", 2, "empty"],
    ]);
    expect(list.find((row) => row.key === "src/parser/note.py")).toMatchObject({ expanded: null, file: null });
    expect(tree.entries[0].children).toHaveLength(3);
  });

  it("접은 폴더는 안에 바뀐 파일이 있으면 수정으로 표시하고 펼친 폴더는 표시하지 않는다", () => {
    expect(marks().find(([label]) => label === "parser/")).toEqual(["parser/", null]);
    expect(marks({ collapsed: new Set(["parser"]) }).find(([label]) => label === "parser/")).toEqual(["parser/", "modified"]);
  });

  it("마지막 커밋과 같고 분석한 뒤에만 바뀐 파일은 변경 상태를 붙이지 않는다", () => {
    const stale: Changes = { git: true, branch: "main", files: [{ path: "src/empty.py", status: "unchanged", stale: true, test: false }], nodes: {} };
    expect(rows(tree, graph, state({ changes: stale })).every((row) => row.change === null)).toBe(true);
  });

  it("분석한 뒤 생긴 파일은 서버가 테스트 코드로 판정했으면 토글이 켜졌을 때만 넣고, 새 폴더는 안의 파일이 모두 테스트 코드일 때 테스트 코드다", () => {
    const added = (path: string, test: boolean) => ({ path, status: "added" as const, stale: false, test });
    const fresh: Changes = {
      git: true,
      branch: "main",
      files: [
        added("src/test_new.py", true),
        added("src/tools/tests/case.py", true),
        added("src/tools/tests/deep/case.py", true),
        added("src/mixed/test_one.py", true),
        added("src/mixed/two.py", false),
        added("src/latest.py", false),
      ],
      nodes: {},
    };
    const made = (showTests: boolean) => rows(tree, graph, state({ changes: fresh, showTests })).map((row) => row.key);
    expect(made(false).filter((key) => !keys().includes(key))).toEqual(["src/mixed", "src/mixed/two.py", "src/latest.py"]);
    expect(made(true).filter((key) => !keys({ showTests: true }).includes(key))).toEqual([
      "src/mixed",
      "src/mixed/test_one.py",
      "src/mixed/two.py",
      "src/tools",
      "src/tools/tests",
      "src/tools/tests/deep",
      "src/tools/tests/deep/case.py",
      "src/tools/tests/case.py",
      "src/latest.py",
      "src/test_new.py",
    ]);
  });

  it("지워진 파일과 변경 내용이 없을 때는 행을 더하지 않는다", () => {
    expect(rows(tree, graph, state({ changes })).some((row) => row.key === "src/gone.py")).toBe(false);
    expect(rows(tree, graph, state()).every((row) => row.change === null)).toBe(true);
  });
});

describe("results", () => {
  const entries = build(graph, false);

  it("질의가 있으면 결과 행이 find의 순서를 따른다", () => {
    const list = results(entries, "pl", null, null);
    expect(list.length).toBeGreaterThan(1);
    expect(list.map((result) => result.hit)).toEqual(find(entries, "pl", 200));
    expect(list[0].hit.entry.id).toBe("parser.plan");
  });

  it("고른 노드의 결과 행만 고른 행으로 표시한다", () => {
    const list = results(entries, "plan", "parser.plan:parse_plan", null);
    expect(list.filter((result) => result.selected).map((result) => result.hit.entry.id)).toEqual(["parser.plan:parse_plan"]);
  });

  it("질의가 비면 결과 행이 없다", () => {
    expect(results(entries, " ", "arbiter", null)).toEqual([]);
  });

  it("바뀐 노드의 결과 행에 변경 상태를 붙인다", () => {
    const list = results(entries, "sync", null, changes);
    expect(list.map((result) => [result.hit.entry.id, result.change])).toEqual([["arbiter:Arbiter.sync", "modified"]]);
    expect(results(entries, "parse_plan", null, changes)[0].change).toBeNull();
  });
});
