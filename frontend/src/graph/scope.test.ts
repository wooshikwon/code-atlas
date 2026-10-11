import { describe, expect, it } from "vitest";
import type { AtlasEdge, AtlasNode, Graph } from "../api/types";
import { repoFixture, routeFixture } from "./fixture";
import { flow } from "./flow";
import { lit, route } from "./route";
import { arriving, degrees, drawn, neighbors, picked, trunkTarget, type DrawnEdge } from "./scope";
import { hidden, nodeIndex, shown, unitOf } from "./visible";

const toggles = { showTests: false, showExternal: false };
const off = hidden(repoFixture, toggles);

/** 고른 노드와 접은 폴더에서 그릴 선을 키로 찾는 표를 만든다. */
function draw(selection: string | null, collapsed: string[] = [], hover: string | null = null): Map<string, DrawnEdge> {
  const focus = selection === null ? null : flow(repoFixture, selection, 2, off);
  const visible = shown(repoFixture, { ...toggles, collapsed: new Set(collapsed), flow: focus, lit: null });
  return new Map(drawn(repoFixture, visible, focus, hover, null).map((e) => [e.key, e]));
}

describe("degrees", () => {
  it("노드마다 들어오는 선과 나가는 선을 센다", () => {
    const result = degrees(repoFixture);
    expect(result.get("main:helper")).toEqual({ incoming: 3, outgoing: 0 });
    expect(result.get("pkg.mod:Store.load")).toEqual({ incoming: 2, outgoing: 2 });
    expect(result.has("scratch:todo")).toBe(false);
  });
});

describe("neighbors", () => {
  const nodes = nodeIndex(repoFixture);
  const count = (selection: string, collapsed: string[] = []) => neighbors([...draw(selection, collapsed).values()], nodes, selection);

  it("파일 상자는 경계를 넘는 선을 올린 집계 선으로 이어진 상자를 센다", () => {
    // main은 pkg.mod, cli, common을 쓰고 pkg.mod와 cli가 main을 쓴다. degrees는 import 선 세 개만 센다.
    expect(count("main")).toEqual({ incoming: 2, outgoing: 3, external: 0 });
    expect(degrees(repoFixture).get("main")).toEqual({ incoming: 1, outgoing: 3 });
  });

  it("접힌 폴더 상자는 안에 든 노드의 선을 올려 세고, 상대 상자가 접힌 폴더면 그 폴더를 하나로 센다", () => {
    expect(count("pkg", ["pkg"])).toEqual({ incoming: 1, outgoing: 2, external: 0 });
    expect(degrees(repoFixture).has("pkg")).toBe(false);
    expect(count("main", ["pkg"])).toEqual({ incoming: 2, outgoing: 3, external: 0 });
    expect(count("common", ["app"])).toEqual({ incoming: 4, outgoing: 0, external: 0 });
  });

  it("외부 모듈은 쓰는 상자 수에 넣지 않고 따로 센다", () => {
    const on = { showTests: false, showExternal: true };
    const hiddenOn = hidden(repoFixture, on);
    const user = repoFixture.edges.find((e) => e.target === "ext:json")!.source;
    const box = unitOf(nodes, user);
    const focus = flow(repoFixture, box, 2, hiddenOn);
    const visible = shown(repoFixture, { ...on, collapsed: new Set(), flow: focus, lit: null });
    const withExternal = neighbors(drawn(repoFixture, visible, focus, null, null), nodes, box);
    expect(withExternal.external).toBe(1);
    expect(withExternal.outgoing).toBe(count(box).outgoing);
  });
});

describe("drawn", () => {
  it("규칙 1: 고른 노드가 없으면 상자 사이의 선을 그리고, 올린 선은 집계 선 하나로 합친다", () => {
    const edges = draw(null);
    expect([...edges.keys()].sort()).toEqual(
      [
        "agg|app.web|app.text",
        "agg|cli|common",
        "agg|cli|main",
        "agg|main|pkg.mod",
        "agg|pkg.mod|main",
        "app.__init__|common|import",
        "app.web|common|import",
        "main|cli|import",
        "main|common|import",
        "pkg.mod|common|import",
        "pkg.mod|pkg.util|import",
      ].sort(),
    );
    expect(edges.get("agg|main|pkg.mod")).toMatchObject({
      weight: 4,
      group: "run",
      kinds: { import: 1, call: 3 },
      tone: "muted",
      opacity: 0.5,
      deferred: false,
    });
    expect(edges.get("pkg.mod|pkg.util|import")?.deferred).toBe(true);
  });

  it("접은 폴더로 올린 선은 폴더에서 잇고 무게를 합친다. 폴더 안의 선과 숨긴 테스트 코드의 선은 넣지 않는다", () => {
    const edges = draw(null, ["pkg"]);
    expect(edges.get("agg|main|pkg")).toMatchObject({ weight: 4, kinds: { import: 1, call: 3 } });
    expect(edges.get("agg|pkg|main")?.weight).toBe(1);
    expect([...edges.keys()].some((key) => key.includes("pkg.mod"))).toBe(false);
  });

  it("테스트 코드를 켜면 접은 폴더 안 테스트 파일의 선을 폴더의 집계 선에 넣는다", () => {
    const visible = shown(repoFixture, { showTests: true, showExternal: false, collapsed: new Set(["pkg"]), flow: null, lit: null });
    const edges = new Map(drawn(repoFixture, visible, null, null, null).map((e) => [e.key, e]));
    expect(edges.get("agg|pkg|main")).toMatchObject({ weight: 2, kinds: { call: 2 } });
    expect(edges.get("agg|tests.test_mod|pkg")?.weight).toBe(1);
  });

  it("흐름이 depth보다 앞 단계에서 끝나면 끝 단계로 가는 선을 흐리지 않는다", () => {
    const focus = flow(repoFixture, "app.web:render", 3, off);
    const visible = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: focus, lit: null });
    const pad = drawn(repoFixture, visible, focus, null, null).find((e) => e.key === "app.text:wrap|app.text:pad|call");
    expect(pad?.opacity).toBe(1);
  });

  it("규칙 2: 함수를 고르면 흐름에 든 노드 사이의 선과 들어오는 선을 원래 선으로 그린다", () => {
    const edges = draw("app.web:render");
    expect(edges.get("app.web:render|app.text:wrap|call")).toMatchObject({ tone: "strong", opacity: 1 });
    expect(edges.get("app.web:index|app.web:render|call")).toMatchObject({ tone: "strong", opacity: 1 });
    expect(edges.get("app.text:wrap|app.text:pad|call")).toMatchObject({ tone: "muted", opacity: 1 });
  });

  it("진하기는 세 단계다. 고른 노드에 닿는 선은 strong, 흐름에 든 노드 사이의 선은 muted 1, 그 밖은 muted 0.2다", () => {
    const levels = new Set([...draw("main:run").values()].map((e) => `${e.tone} ${e.opacity}`));
    expect([...levels].sort()).toEqual(["muted 0.2", "muted 1", "strong 1"]);
    const edges = draw("main:run");
    expect(edges.get("cli:main|main:run|call")).toMatchObject({ tone: "strong", opacity: 1 });
    expect(edges.get("main:run|main:helper|call")).toMatchObject({ tone: "strong", opacity: 1 });
    expect(edges.get("pkg.mod:Store.load|pkg.mod:Store.save|call")).toMatchObject({ tone: "muted", opacity: 1 });
    expect(edges.get("agg|app.web|app.text")).toMatchObject({ tone: "muted", opacity: 0.2 });
  });

  it("규칙 2: 접힌 상자 사이의 선은 흐리게 그대로 그리고, 펼친 파일 상자에 닿는 흐름 밖 선은 그리지 않는다", () => {
    const edges = draw("app.web:render");
    expect(edges.get("agg|main|pkg.mod")).toMatchObject({ tone: "muted", opacity: 0.2 });
    expect(edges.has("app.web|app.text|import")).toBe(false);
    expect(edges.has("agg|app.web|app.text")).toBe(false);
  });

  it("규칙 2: 고른 노드가 든 파일 상자 안의 선을 그린다", () => {
    const edges = draw("pkg.mod:parse");
    expect(edges.get("pkg.mod:Store.load|pkg.mod:Row|construct")).toMatchObject({ tone: "muted", opacity: 0.2 });
    expect(edges.get("pkg.mod:Store.save|pkg.mod:parse|call")?.tone).toBe("strong");
  });

  it("규칙 2: 흐름이 접은 폴더로 들어가면 폴더에서 잇는다", () => {
    const edges = draw("main:run", ["pkg"]);
    expect(edges.get("agg|main:run|pkg")).toMatchObject({ weight: 3, tone: "strong", opacity: 1 });
  });

  it("규칙 2: 파일 상자를 고르면 안의 선은 원래 선으로, 경계를 넘는 선은 파일 상자 사이 집계 선으로 그린다", () => {
    const edges = draw("pkg.mod");
    expect(edges.get("pkg.mod:Store.load|pkg.mod:Store.save|call")).toMatchObject({ tone: "muted", opacity: 1 });
    expect(edges.get("agg|main|pkg.mod")).toMatchObject({ weight: 4, tone: "strong", opacity: 1 });
    expect(edges.get("agg|pkg.mod|main")).toMatchObject({ weight: 1, tone: "strong", opacity: 1 });
    expect(edges.get("pkg.mod|pkg.util|import")).toMatchObject({ tone: "strong", deferred: true });
    expect(edges.get("agg|cli|main")).toMatchObject({ tone: "muted", opacity: 1 });
    expect(edges.get("agg|app.web|app.text")).toMatchObject({ tone: "muted", opacity: 0.2 });
  });

  it("규칙 2: 접힌 폴더 상자를 고르면 그 상자에서 나가고 들어오는 집계 선만 strong이다", () => {
    const edges = draw("pkg", ["pkg"]);
    expect(edges.get("agg|main|pkg")).toMatchObject({ weight: 4, tone: "strong", opacity: 1 });
    expect(edges.get("agg|pkg|main")).toMatchObject({ weight: 1, tone: "strong", opacity: 1 });
    expect(edges.get("agg|pkg|common")).toMatchObject({ weight: 1, tone: "strong", opacity: 1 });
    expect(edges.get("agg|cli|main")).toMatchObject({ tone: "muted", opacity: 1 });
    expect(edges.get("agg|app.web|app.text")).toMatchObject({ tone: "muted", opacity: 0.2 });
    expect([...edges.values()].filter((e) => e.tone === "strong").every((e) => e.source === "pkg" || e.target === "pkg")).toBe(true);
  });

  it("규칙 2: 마우스를 올린 노드에 닿는 선은 모두 그린다", () => {
    const edges = draw(null, [], "common");
    expect([...edges.keys()].filter((key) => key.includes("common")).sort()).toEqual([
      "agg|cli|common",
      "app.__init__|common|import",
      "app.web|common|import",
      "main|common|import",
      "pkg.mod|common|import",
    ]);
  });

  it("숨기는 선이 없다: 여러 상자가 쓰는 상자로 들어오는 선도 모두 그리고, 무관한 노드를 골라도 접힌 상자 사이의 선은 남는다", () => {
    const into = (selection: string | null) => [...draw(selection).values()].filter((e) => e.target === "common").map((e) => e.key).sort();
    const all = ["agg|cli|common", "app.__init__|common|import", "app.web|common|import", "main|common|import", "pkg.mod|common|import"];
    expect(into(null)).toEqual(all);
    expect(into("scratch")).toEqual(all);
    expect([...draw("scratch").values()].filter((e) => e.target === "common").every((e) => e.opacity === 0.2)).toBe(true);
  });

  it("여러 상자가 쓰는 상자를 고르면 들어오는 선이 고른 노드에 닿는 선이다", () => {
    const edges = draw("common");
    expect(edges.get("main|common|import")?.tone).toBe("strong");
    expect(edges.get("agg|cli|common")).toMatchObject({ weight: 2, tone: "strong" });
    expect(edges.has("app.web|common|import")).toBe(true);
  });

  it("여러 상자가 쓰는 상자를 쓰는 노드를 고르면 그 선만 고른 노드에 닿는 선이다", () => {
    const edges = draw("cli");
    expect(edges.get("agg|cli|common")).toMatchObject({ weight: 2, tone: "strong", opacity: 1 });
    expect(edges.get("pkg.mod|common|import")).toMatchObject({ tone: "muted", opacity: 1 });
    expect(edges.get("app.web|common|import")?.opacity).toBe(0.2);
  });

  it("그린 선의 양 끝은 늘 보이는 노드다", () => {
    const selections = [
      [null, []],
      ["main:run", ["app"]],
      ["pkg.mod", []],
      ["pkg", ["pkg"]],
      ["app", ["app"]],
      ["app:version", []],
      ["app.web:render", ["pkg"]],
    ] as const;
    for (const showTests of [false, true]) {
      for (const showExternal of [false, true]) {
        const opts = { showTests, showExternal };
        const skipped = hidden(repoFixture, opts);
        for (const [selection, collapsed] of selections) {
          const focus = selection === null ? null : flow(repoFixture, selection, 3, skipped);
          const visible = shown(repoFixture, { ...opts, collapsed: new Set(collapsed), flow: focus, lit: null });
          for (const e of drawn(repoFixture, visible, focus, null, null)) {
            expect(visible.nodes.has(e.source) && visible.nodes.has(e.target), `${selection} ${e.key}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("picked", () => {
  // 접은 폴더 pkg의 함수 f가 다른 파일의 클래스 K를 생성하고 K의 메서드 go도 호출한다.
  const node = (id: string, kind: AtlasNode["kind"], parent: string | null) => ({ id, kind, parent, test: false }) as AtlasNode;
  const edge = (source: string, target: string, kind: AtlasEdge["kind"], lines: number[]): AtlasEdge => ({
    group: "run",
    kind,
    source,
    target,
    sites: lines.map((line) => ({ path: "pkg/a.py", line, col: 0 })),
    deferred: false,
  });
  const graph: Graph = {
    nodes: [
      node("pkg", "package", null),
      node("pkg.a", "module", "pkg"),
      node("pkg.a:f", "function", "pkg.a"),
      node("m", "module", null),
      node("m:K", "class", "m"),
      node("m:K.go", "method", "m:K"),
    ],
    edges: [edge("pkg.a:f", "m:K", "construct", [3]), edge("pkg.a:f", "m:K.go", "call", [4, 5])],
  };
  const focus = flow(graph, "m:K", 2, new Set());
  const visible = shown(graph, { ...toggles, collapsed: new Set(["pkg"]), flow: focus, lit: null });

  it("집계 선은 그래프가 그 키로 합친 선만 담는다", () => {
    const edges = new Map(drawn(graph, visible, focus, null, null).map((e) => [e.key, e]));
    expect(edges.get("agg|pkg|m:K")?.weight).toBe(1);
    expect(edges.get("agg|pkg|m:K.go")?.weight).toBe(2);
    const found = picked(graph, visible, focus, "agg|pkg|m:K");
    expect(found?.edges.map((e) => e.kind)).toEqual(["construct"]);
    expect(found?.edges.flatMap((e) => e.sites)).toHaveLength(found!.weight);
    expect(picked(graph, visible, focus, "agg|pkg|m:K.go")?.edges.flatMap((e) => e.sites.map((s) => s.line))).toEqual([4, 5]);
  });

  it("집계 선이 아닌 키는 보이는 노드와 관계없이 원래 선 하나다", () => {
    const closed = shown(graph, { ...toggles, collapsed: new Set(), flow: null, lit: null });
    expect(picked(graph, closed, null, "pkg.a:f|m:K.go|call")).toMatchObject({ source: "pkg.a:f", target: "m:K.go", weight: 2 });
  });

  it("집계 선의 키와 없는 키", () => {
    const off = hidden(repoFixture, toggles);
    const closed = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: null, lit: null });
    expect(off.size).toBeGreaterThan(0);
    expect(picked(repoFixture, closed, null, "agg|cli|common")?.weight).toBe(2);
    expect(picked(repoFixture, closed, null, "agg|scratch|common")).toBeNull();
    expect(picked(repoFixture, closed, null, "x|y|call")).toBeNull();
  });
});

describe("drawn: 강조하는 경로", () => {
  const none = hidden(routeFixture, toggles);
  const scene = (from: string, to: string, collapsed: string[] = []) => {
    const path = lit(route(routeFixture, from, to, none), 0)!;
    return { path, visible: shown(routeFixture, { ...toggles, collapsed: new Set(collapsed), flow: null, lit: path }) };
  };
  const steps = (edges: DrawnEdge[]) => edges.filter((e) => e.route !== null);

  it("걸음마다 선 하나를 strong에 불투명도 1로 내고 실행 선이 있는 걸음은 그 선의 키와 원래 선을 담는다", () => {
    const { path, visible } = scene("flow.walk:begin", "flow.walk:finish");
    const edges = steps(drawn(routeFixture, visible, null, null, path));
    expect(edges.map((e) => [e.key, e.route, e.tone, e.opacity, e.edges.length])).toEqual([
      ["flow.walk:begin|flow.walk:left|call", "call", "strong", 1, 1],
      ["flow.walk:left|flow.walk:finish|call", "call", "strong", 1, 1],
    ]);
  });

  it("생성자 이음과 오버라이드 이음은 `step|…` 키에 원래 선 없이 낸다", () => {
    const built = scene("flow.build:make", "flow.sink:tune");
    expect(steps(drawn(routeFixture, built.visible, null, null, built.path)).map((e) => [e.key, e.route, e.group, e.weight, e.edges.length])).toEqual([
      ["flow.build:make|flow.build:Engine|construct", "construct", "run", 1, 1],
      ["step|flow.build:Engine|flow.build:Engine.__init__", "init", "run", 0, 0],
      ["flow.build:Engine.__init__|flow.sink:tune|call", "call", "run", 1, 1],
    ]);
    const stepped = scene("flow.build:Base.run", "flow.sink:emit");
    expect(steps(drawn(routeFixture, stepped.visible, null, null, stepped.path)).map((e) => [e.key, e.route])).toEqual([
      ["flow.build:Base.run|flow.build:Base.step|call", "call"],
      ["step|flow.build:Base.step|flow.build:Child.step", "overridden"],
      ["flow.build:Child.step|flow.sink:emit|call", "call"],
    ]);
  });

  it("걸음이 아닌 선은 접힌 상자 사이의 선만 muted에 불투명도 0.2로 낸다", () => {
    const { path, visible } = scene("flow.build:make", "flow.sink:tune");
    const rest = drawn(routeFixture, visible, null, null, path).filter((e) => e.route === null);
    expect(rest.length).toBeGreaterThan(0);
    for (const e of rest) {
      expect([e.tone, e.opacity]).toEqual(["muted", 0.2]);
      expect(visible.open.has(e.source) || visible.open.has(e.target)).toBe(false);
      expect(e.source.includes(":") || e.target.includes(":")).toBe(false);
    }
    expect(rest.map((e) => e.key)).toContain("ring.a|ring.b|import");
    expect(rest.map((e) => e.key)).not.toContain("flow.build|flow.sink|import");
  });

  it("접은 폴더 안의 경로도 걸음마다 선을 내고 다른 접은 폴더로 가는 선은 집계 선으로 남긴다", () => {
    const { path, visible } = scene("flow.walk:begin", "flow.walk:finish", ["flow", "ring", "lazy"]);
    const edges = drawn(routeFixture, visible, null, null, path);
    expect(steps(edges)).toHaveLength(2);
    expect(edges.find((e) => e.key === "agg|ring|lazy")).toMatchObject({ tone: "muted", opacity: 0.2, route: null });
  });

  it("흐름과 마우스를 올린 노드를 보지 않는다", () => {
    const { path, visible } = scene("flow.walk:begin", "flow.walk:finish");
    const focus = flow(routeFixture, "flow.build:Base.run", 2, none);
    expect(drawn(routeFixture, visible, focus, "flow.build", path)).toEqual(drawn(routeFixture, visible, null, null, path));
  });

  it("경로가 없으면 모든 선의 route가 null이다", () => {
    const visible = shown(routeFixture, { ...toggles, collapsed: new Set(), flow: null, lit: null });
    expect(drawn(routeFixture, visible, null, null, null).every((e) => e.route === null)).toBe(true);
  });
});

describe("trunkTarget, arriving", () => {
  const closed = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: null, lit: null });

  it("줄기 키에서 도착 노드를 읽고 다른 키는 null이다", () => {
    expect(trunkTarget("trunk|common|0")).toBe("common");
    expect(trunkTarget("agg|cli|common")).toBeNull();
    expect(trunkTarget("main|common|import")).toBeNull();
  });

  it("노드로 들어오는 그린 선을 모으고 함수 안 import만 합친 선은 뺀다", () => {
    expect(arriving(repoFixture, closed, null, "common").map((e) => e.source).sort()).toEqual(["app.__init__", "app.web", "cli", "main", "pkg.mod"]);
    expect(drawn(repoFixture, closed, null, null, null).some((e) => e.target === "pkg.util" && e.deferred)).toBe(true);
    expect(arriving(repoFixture, closed, null, "pkg.util").some((e) => e.deferred)).toBe(false);
  });
});
