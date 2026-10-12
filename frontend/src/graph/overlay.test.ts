import { describe, expect, it } from "vitest";
import { cycles } from "./cycles";
import { node, routeFixture } from "./fixture";
import { DIM, flow } from "./flow";
import { cycleLines, cycleMarks, unusedCounts } from "./overlay";
import { lit, route } from "./route";
import { drawn } from "./scope";
import { hidden, shown } from "./visible";

const toggles = { showTests: false, showExternal: false };
const off = hidden(routeFixture, toggles);
const found = cycles(routeFixture, off);

function scene(collapsed: string[], focus: string | null = null) {
  const picked = focus === null ? null : flow(routeFixture, focus, 2, off);
  return { flow: picked, shown: shown(routeFixture, { ...toggles, collapsed: new Set(collapsed), flow: picked, lit: null }) };
}

describe("cycleMarks", () => {
  it("묶음에 든 파일 상자에만 아이콘을 달고 묶음의 파일을 함께 낸다", () => {
    const marks = cycleMarks(routeFixture, found, scene([]).shown);
    expect([...marks.keys()].sort()).toEqual(["north.up", "ring.a", "ring.b", "ring.c", "south.down"]);
    expect(marks.get("ring.b")).toEqual([["ring.a", "ring.b", "ring.c"]]);
    expect(marks.get("north.up")).toEqual([["north.up", "south.down"]]);
  });

  it("묶음에 든 파일을 품은 접힌 폴더 상자에 아이콘을 달고 펼친 폴더 영역에는 달지 않는다", () => {
    const marks = cycleMarks(routeFixture, found, scene(["ring", "north"]).shown);
    expect([...marks.keys()].sort()).toEqual(["north", "ring", "south.down"]);
    expect(marks.get("ring")).toEqual([["ring.a", "ring.b", "ring.c"]]);
    expect(marks.get("north")).toEqual([["north.up", "south.down"]]);
    expect(marks.has("lazy")).toBe(false);
  });

  it("접힌 폴더가 여러 묶음의 파일을 품으면 묶음을 번호순으로 모두 낸다", () => {
    const graph = { ...routeFixture, nodes: routeFixture.nodes.map((n) => (n.parent === null && n.kind === "package" ? { ...n, parent: "top" } : n)) };
    const all = { ...graph, nodes: [node("top", "package", null), ...graph.nodes] };
    const visible = shown(all, { ...toggles, collapsed: new Set(["top"]), flow: null, lit: null });
    expect(cycleMarks(all, cycles(all, off), visible).get("top")).toEqual([
      ["north.up", "south.down"],
      ["ring.a", "ring.b", "ring.c"],
    ]);
  });

  it("파일 상자를 펼쳐도 아이콘을 다는 상자가 같다", () => {
    const closed = cycleMarks(routeFixture, found, scene([]).shown);
    const opened = cycleMarks(routeFixture, found, scene([], "flow.walk:begin").shown);
    expect([...opened.keys()].sort()).toEqual([...closed.keys()].sort());
  });
});

describe("cycleLines", () => {
  it("양 끝이 보이는 파일 상자인 묶음 안 import 선이 순환 선이다", () => {
    const { shown: visible } = scene([]);
    const edges = drawn(routeFixture, visible, null, null, null);
    const lines = cycleLines(routeFixture, visible, null, null, edges, found);
    expect([...lines.keys].sort()).toEqual([
      "north.up|south.down|import",
      "ring.a|ring.b|import",
      "ring.b|ring.c|import",
      "ring.c|ring.a|import",
      "south.down|north.up|import",
    ]);
    expect(lines.keys.has("lazy.one|lazy.two|import")).toBe(false);
    expect(lines.keys.has("ring.a|lazy.two|import")).toBe(false);
    expect(lines.edges.filter((e) => lines.keys.has(e.key)).every((e) => e.opacity === 1)).toBe(true);
    expect(lines.edges.find((e) => e.key === "ring.a|lazy.two|import")?.opacity).toBe(0.5);
  });

  it("접힌 폴더로 올라간 집계 선은 순환 선이 아니다", () => {
    const { shown: visible } = scene(["ring", "north"]);
    const edges = drawn(routeFixture, visible, null, null, null);
    const lines = cycleLines(routeFixture, visible, null, null, edges, found);
    expect(lines.keys.size).toBe(0);
    expect(lines.edges).toEqual(edges);
  });

  it("그리는 범위 규칙으로 빠진 순환 선을 다시 넣는다", () => {
    const { shown: visible, flow: picked } = scene([], "flow.walk:begin");
    const edges = drawn(routeFixture, visible, picked, null, null).filter((e) => e.key !== "ring.a|ring.b|import");
    const lines = cycleLines(routeFixture, visible, picked, null, edges, found);
    const added = lines.edges.find((e) => e.key === "ring.a|ring.b|import");
    expect(added).toMatchObject({ source: "ring.a", target: "ring.b", group: "use", tone: "muted", opacity: 1 });
    expect(lines.edges).toHaveLength(edges.length + 1);
    expect(lines.keys.size).toBe(5);
  });
});

describe("경로 고정 중의 순환 선", () => {
  it("순환 선도 경로 밖 선의 불투명도로 그리고 경로의 걸음은 그대로 둔다", () => {
    const found2 = route(routeFixture, "flow.walk:begin", "flow.walk:finish", off);
    const path = lit(found2, 0)!;
    const visible = shown(routeFixture, { ...toggles, collapsed: new Set(), flow: null, lit: path });
    const edges = drawn(routeFixture, visible, null, null, path);
    const lines = cycleLines(routeFixture, visible, null, path, edges, found);
    expect(lines.keys.size).toBe(5);
    expect(lines.edges.filter((e) => lines.keys.has(e.key)).every((e) => e.opacity === DIM && e.route === null)).toBe(true);
    const steps = lines.edges.filter((e) => e.route !== null);
    expect(steps).toHaveLength(path.path.length - 1);
    expect(steps.every((e) => e.opacity === 1 && !lines.keys.has(e.key))).toBe(true);
  });
});

describe("unusedCounts", () => {
  it("파일과 그 파일을 품은 폴더마다 안의 후보를 세고 그래프에 없는 id는 세지 않는다", () => {
    const counts = unusedCounts(routeFixture, new Set(["flow.walk:lone", "flow.walk:probe", "flow.build:Child.step", "flow.gone:f"]));
    expect(Object.fromEntries(counts)).toEqual({ "flow.walk": 2, "flow.build": 1, flow: 3 });
  });
});
