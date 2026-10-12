import { describe, expect, it } from "vitest";
import { node, repoFixture, variableFixture } from "./fixture";
import { flow } from "./flow";
import { baseOf, definedName, rowsOf, stageOf, type RowLine } from "./rows";
import { drawn } from "./scope";
import { hidden, nodeIndex, shown } from "./visible";

const toggles = { showTests: false, showExternal: false };
const off = hidden(repoFixture, toggles);
const nodes = nodeIndex(repoFixture);

/** 고른 노드 selection과 접은 폴더 collapsed에서 그린 선을 키로 찾는 표 */
function lines(selection: string | null, collapsed: string[] = []): Map<string, RowLine> {
  const focus = selection === null ? null : flow(repoFixture, selection, 2, off);
  const visible = shown(repoFixture, { ...toggles, collapsed: new Set(collapsed), flow: focus, lit: null });
  return new Map(drawn(repoFixture, visible, focus, null, null).map((edge) => [edge.key, edge]));
}

describe("stageOf", () => {
  it("고른 노드가 없거나 고른 노드에 닿지 않는 선은 화면에 그린 양 끝을 적는다", () => {
    expect(stageOf(nodes, null, lines(null, ["pkg"]).get("agg|main|pkg")!)).toBe("drawn");
    const apart = [...lines("main:run", ["pkg"]).values()].filter((line) => line.source !== "main:run" && line.target !== "main:run");
    expect(apart.length).toBeGreaterThan(0);
    expect(apart.map((line) => stageOf(nodes, "main:run", line))).toEqual(apart.map(() => "drawn"));
  });

  it("고른 노드에 닿는 선은 함수(클래스, 메서드)면 함수 단계, 파일이면 파일 단계다", () => {
    expect(stageOf(nodes, "main:run", lines("main:run", ["pkg"]).get("agg|main:run|pkg")!)).toBe("function");
    expect(stageOf(nodes, "main", lines("main", ["pkg"]).get("agg|main|pkg")!)).toBe("file");
  });

  it("폴더는 단계가 아니다", () => {
    expect(stageOf(nodes, "pkg", lines("pkg", ["pkg"]).get("agg|main|pkg")!)).toBe("drawn");
  });
});

describe("rowsOf", () => {
  it("고른 노드가 없으면 그린 양 끝 한 줄이고 이름을 누르면 그 선의 키를 지나온 선으로 담는다", () => {
    expect(rowsOf(nodes, null, lines(null, ["pkg"]).get("agg|main|pkg")!)).toEqual([
      { line: "agg|main|pkg", source: "main", target: "pkg", relation: "호출 3곳", keys: ["agg|main|pkg"], list: "agg|main|pkg" },
    ]);
  });

  it("함수를 고르면 접힌 폴더로 뭉친 선을 실제 상대 함수로 풀어 줄마다 그 관계의 원래 선 키를 담는다", () => {
    expect(rowsOf(nodes, "main:run", lines("main:run", ["pkg"]).get("agg|main:run|pkg")!)).toEqual([
      {
        line: "agg|main:run|pkg",
        source: "main:run",
        target: "pkg.mod:Store.load",
        relation: "호출 3곳",
        keys: ["main:run|pkg.mod:Store.load|call"],
        list: "main:run|pkg.mod:Store.load|call",
      },
    ]);
  });

  it("함수 단계에서 타입에만 쓰이는 관계도 누를 수 있는 줄이고 관계 칸은 수 없이 적는다", () => {
    const uses = [
      { ...repoFixture.edges[0], source: "main:run", target: "pkg.mod:Row", kind: "type" as const },
      { ...repoFixture.edges[0], source: "main:helper", target: "pkg.mod:Row", kind: "type" as const },
    ];
    const line: RowLine = { key: "agg|main|pkg.mod:Row", source: "main", target: "pkg.mod:Row", kinds: { type: 2 }, route: null, edges: uses };
    expect(rowsOf(nodes, "pkg.mod:Row", line)).toEqual([
      { line: line.key, source: "main:run", target: "pkg.mod:Row", relation: "타입에만 쓰임", keys: ["main:run|pkg.mod:Row|type"], list: "main:run|pkg.mod:Row|type" },
      { line: line.key, source: "main:helper", target: "pkg.mod:Row", relation: "타입에만 쓰임", keys: ["main:helper|pkg.mod:Row|type"], list: "main:helper|pkg.mod:Row|type" },
    ]);
  });

  it("함수 단계에서 import는 줄이 되지 않고, import뿐인 선은 그린 양 끝과 관계 글을 누를 수 없는 안내 줄 하나로 낸다", () => {
    const imported = { ...repoFixture.edges[0], source: "main:run", target: "common" };
    const called = { ...repoFixture.edges[0], source: "main:run", target: "common:log", kind: "call" as const };
    const alone: RowLine = { key: "f|m|import", source: "main:run", target: "common", kinds: { import: 1 }, route: null, edges: [imported] };
    expect(rowsOf(nodes, "main:run", alone)).toEqual([{ line: "f|m|import", source: "main:run", target: "common", relation: "import 관계만 있음", keys: null, list: "f|m|import" }]);
    const mixed: RowLine = { key: "agg|main:run|common", source: "main:run", target: "common", kinds: { import: 1, call: 1 }, route: null, edges: [imported, called] };
    expect(rowsOf(nodes, "main:run", mixed).map((row) => [row.source, row.target, row.relation])).toEqual([["main:run", "common:log", "호출 1곳"]]);
  });

  it("파일을 고르면 접힌 폴더로 뭉친 선의 상대 끝을 그 안의 파일로 풀고 고른 파일 쪽은 그린 노드를 적는다", () => {
    expect(rowsOf(nodes, "main", lines("main", ["pkg"]).get("agg|main|pkg")!)).toEqual([
      { line: "agg|main|pkg", source: "main", target: "pkg.mod", relation: "호출 3곳", keys: ["agg|main|pkg.mod"], list: "agg|main|pkg" },
    ]);
    expect(rowsOf(nodes, "main", lines("main", ["pkg"]).get("agg|pkg|main")!)).toEqual([
      { line: "agg|pkg|main", source: "pkg.mod", target: "main", relation: "호출 1곳", keys: ["agg|pkg.mod|main"], list: "pkg.mod:Store.save|main:helper|call" },
    ]);
  });

  it("파일 단계의 줄은 import만 있는 선도 누를 수 있다", () => {
    const [row] = rowsOf(nodes, "main", lines("main").get("main|common|import")!);
    expect(row).toMatchObject({ source: "main", target: "common", relation: "import 관계만 있음", keys: ["main|common|import"] });
  });

  it("실행 선이 없는 경로의 이음은 걸음의 이름을 적고 코드 줄 목록이 없다", () => {
    const step: RowLine = { key: "step|a|b", source: "a", target: "b", kinds: {}, route: "init", edges: [] };
    expect(rowsOf(nodes, null, step)).toEqual([{ line: "step|a|b", source: "a", target: "b", relation: "생성자 이음", keys: ["step|a|b"], list: null }]);
  });

  it("원래 선 없이 넘긴 함수 시점 뷰의 선은 그린 양 끝 한 줄이고 코드 줄 목록을 연다", () => {
    const call: RowLine = { key: "a|b|call", source: "a", target: "b", kinds: { call: 2 }, route: null, edges: [] };
    expect(rowsOf(nodes, null, call)).toEqual([{ line: "a|b|call", source: "a", target: "b", relation: "호출 2곳", keys: ["a|b|call"], list: "a|b|call" }]);
  });
});

describe("baseOf", () => {
  it("줄의 한 끝이 고른 노드이거나 그 안의 노드이면 고른 노드가 든 파일이 기준이다", () => {
    const row = { source: "main:run", target: "pkg.mod:Store.load" };
    expect([baseOf(nodes, "main:run", row, row.source), baseOf(nodes, "main:run", row, row.target)]).toEqual(["main", "main"]);
    expect(baseOf(nodes, "main", row, row.target)).toBe("main");
    const inner = { source: "pkg.mod:Store.save", target: "main:helper" };
    expect(baseOf(nodes, "pkg.mod:Store", inner, inner.target)).toBe("pkg.mod");
  });

  it("고른 노드가 없거나 폴더이거나 줄이 고른 노드에 닿지 않으면 줄의 다른 쪽 끝이 든 파일이 기준이다", () => {
    const row = { source: "cli:main", target: "common:log" };
    for (const focus of [null, "pkg", "main:run"]) {
      expect([baseOf(nodes, focus, row, row.source), baseOf(nodes, focus, row, row.target)]).toEqual(["common", "cli"]);
    }
    const within = { source: "main:run", target: "main:helper" };
    expect(baseOf(nodes, "main", within, within.target)).toBe("main");
  });

  it("다른 쪽 끝이 폴더면 그 폴더가 기준이다", () => {
    const row = { source: "main:run", target: "pkg" };
    expect(baseOf(nodes, null, row, row.source)).toBe("pkg");
  });
});

describe("definedName", () => {
  const named = (base: string, id: string) => definedName(nodes, base, nodes.get(id)!);

  it("기준 파일 안의 정의는 이름만 적는다", () => {
    expect(named("main", "main:helper")).toEqual({ path: "", name: "helper()", full: "main.py::helper()" });
    expect(named("pkg.mod", "pkg.mod:Store.load")).toEqual({ path: "", name: "Store.load()", full: "pkg/mod.py::Store.load()" });
  });

  it("같은 폴더의 다른 파일에 든 정의는 파일 이름부터 적는다", () => {
    expect(named("app.web", "app.text:wrap")).toEqual({ path: "text.py::", name: "wrap()", full: "app/text.py::wrap()" });
    expect(named("cli", "common:log")).toMatchObject({ path: "common.py::", name: "log()" });
  });

  it("다른 폴더의 정의는 두 경로가 갈라지는 첫 폴더부터 적고 메서드는 클래스 이름을 함께 적는다", () => {
    expect(named("main", "pkg.mod:Store.load")).toEqual({ path: "pkg/mod.py::", name: "Store.load()", full: "pkg/mod.py::Store.load()" });
    expect(named("app.web", "pkg.mod:parse")).toMatchObject({ path: "pkg/mod.py::", name: "parse()" });
    const deep = new Map(
      [
        node("a", "package", null),
        node("a.b", "package", "a"),
        node("a.b.x", "module", "a.b"),
        node("a.b.x:f", "function", "a.b.x"),
        node("a.c", "package", "a"),
        node("a.c.y", "module", "a.c"),
        node("a.c.y:g", "function", "a.c.y"),
        node("a.b.b", "package", "a.b"),
        node("a.b.b.z", "module", "a.b.b"),
        node("a.b.b.z:h", "function", "a.b.b.z"),
      ].map((each) => [each.id, each]),
    );
    expect(definedName(deep, "a.c.y", deep.get("a.b.x:f")!).path).toBe("b/x.py::");
    expect(definedName(deep, "a.b.x", deep.get("a.b.b.z:h")!).path).toBe("b/z.py::");
    expect(definedName(deep, "a.b.b.z", deep.get("a.b.x:f")!).path).toBe("x.py::");
  });

  it("기준이 폴더면 그 폴더와 갈라지는 곳부터 적는다", () => {
    expect(named("pkg", "main:run")).toMatchObject({ path: "main.py::", name: "run()" });
    expect(named("pkg", "pkg.mod:parse")).toMatchObject({ path: "pkg/mod.py::", name: "parse()" });
    expect(named("app", "pkg.mod:parse")).toMatchObject({ path: "pkg/mod.py::", name: "parse()" });
  });
});

describe("변수 노드의 줄", () => {
  const none = hidden(variableFixture, toggles);
  const variables = nodeIndex(variableFixture);
  /** 고른 노드 selection에서 그린 선 가운데 양 끝이 source와 target인 선 */
  const line = (selection: string, source: string, target: string): RowLine => {
    const focus = flow(variableFixture, selection, 2, none);
    const visible = shown(variableFixture, { ...toggles, collapsed: new Set(), flow: focus, lit: null });
    return drawn(variableFixture, visible, focus, null, null).find((edge) => edge.source === source && edge.target === target)!;
  };

  it("함수를 고르면 그 함수가 변수를 읽는 선은 함수 단계의 줄이고 관계 칸에 읽은 곳의 수를 적는다", () => {
    const read = line("app:run", "app:run", "conf:PRESETS");
    expect(stageOf(variables, "app:run", read)).toBe("function");
    expect(rowsOf(variables, "app:run", read)).toMatchObject([{ source: "app:run", target: "conf:PRESETS", relation: "읽음 2곳", keys: ["app:run|conf:PRESETS|read"] }]);
  });

  it("변수를 고르면 들어오는 선과 값에서 나가는 선이 함수 단계의 줄이다", () => {
    const read = line("conf:PRESETS", "app:run", "conf:PRESETS");
    expect(stageOf(variables, "conf:PRESETS", read)).toBe("function");
    expect(rowsOf(variables, "conf:PRESETS", read)).toMatchObject([{ source: "app:run", target: "conf:PRESETS", relation: "읽음 2곳" }]);
    const made = line("conf:PRESETS", "conf:PRESETS", "conf:Preset");
    expect(rowsOf(variables, "conf:PRESETS", made)).toMatchObject([{ source: "conf:PRESETS", target: "conf:Preset", relation: "생성 2곳" }]);
  });

  it("바꾸는 선의 관계 칸은 바꿈을 적는다", () => {
    const full = shown(variableFixture, { ...toggles, collapsed: new Set(), flow: flow(variableFixture, "conf:remember", 2, none), lit: null, unpacked: new Set(["conf"]) });
    const write = drawn(variableFixture, full, flow(variableFixture, "conf:remember", 2, none), null, null).find((edge) => edge.target === "conf:_cache" && edge.source === "conf:remember")!;
    expect(rowsOf(variables, "conf:remember", write)).toMatchObject([{ source: "conf:remember", target: "conf:_cache", relation: "바꿈 1곳" }]);
  });

  it("파일을 고르면 변수에 닿는 선도 파일 단계의 줄에 들고 관계 칸이 읽은 곳을 함께 적는다", () => {
    const into = line("conf", "app", "conf");
    expect(stageOf(variables, "conf", into)).toBe("file");
    expect(rowsOf(variables, "conf", into)).toMatchObject([{ source: "app", target: "conf", relation: "호출 1곳 · 생성 1곳 · 읽음 2곳" }]);
  });

  it("변수는 기준 파일에서 갈라지는 곳부터의 경로와 괄호 없는 이름으로 적는다", () => {
    expect(definedName(variables, "app", variables.get("conf:PRESETS")!)).toEqual({ path: "conf.py::", name: "PRESETS", full: "conf.py::PRESETS" });
    expect(definedName(variables, "conf", variables.get("conf:PRESETS")!)).toEqual({ path: "", name: "PRESETS", full: "conf.py::PRESETS" });
    expect(baseOf(variables, "conf:PRESETS", { source: "app:run", target: "conf:PRESETS" }, "app:run")).toBe("conf");
  });
});
