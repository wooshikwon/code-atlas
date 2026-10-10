import { describe, expect, it } from "vitest";
import { repoFixture } from "./fixture";
import { flow } from "./flow";
import type { Layout } from "./layout";
import { drawn } from "./scope";
import { badges, edgeViews, midpoint, parentFirst, roundedPath, type EdgeView } from "./view";
import { hidden, nodeIndex, shown, type Shown } from "./visible";

const toggles = { showTests: false, showExternal: false };
const off = hidden(repoFixture, toggles);
const nodes = nodeIndex(repoFixture);

function scene(selection: string | null) {
  const picked = selection === null ? null : flow(repoFixture, selection, 2, off);
  return { flow: picked, shown: shown(repoFixture, { ...toggles, collapsed: new Set(), flow: picked }) };
}

/** 보이는 노드를 가로 한 줄로 늘어놓은 배치. 경로는 집계 선 하나만 배치 결과로 준다. */
function lineLayout(visible: Shown): Layout {
  const boxes = new Map([...visible.nodes].map((id, i) => [id, { x: i * 100, y: 0, width: 40, height: 20 }] as const));
  const routes = new Map([
    [
      "agg|main|pkg.mod",
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    ],
  ]);
  return { positions: new Map(), sizes: new Map(), boxes, routes };
}

function views(selection: string | null): Map<string, EdgeView> {
  const { flow: picked, shown: visible } = scene(selection);
  return new Map(edgeViews(drawn(repoFixture, visible, picked, null), lineLayout(visible), nodes).map((v) => [v.key, v]));
}

describe("parentFirst", () => {
  it("부모를 자식보다 앞에 둔다", () => {
    const visible = scene("pkg.mod:Store.save").shown.nodes;
    const order = parentFirst(repoFixture, visible).map((n) => n.id);
    expect(order).toHaveLength(visible.size);
    for (const node of repoFixture.nodes.filter((n) => visible.has(n.id) && n.parent !== null)) {
      expect(order.indexOf(node.parent!)).toBeLessThan(order.indexOf(node.id));
    }
  });
});

describe("edgeViews", () => {
  it("배치가 낸 경로가 있으면 쓰고, 없으면 두 상자를 잇는 경로를 만든다", () => {
    const closed = views(null);
    expect(closed.get("agg|main|pkg.mod")?.points).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect(closed.get("agg|pkg.mod|main")?.points).toHaveLength(4);
  });

  it("형제가 아닌 두 노드를 잇는 선은 형제로 올린 상자 사이의 배치 경로를 따라가고 올린 쪽 끝만 옮긴다", () => {
    const { flow: picked, shown: visible } = scene("pkg.mod:Store.save");
    const layout = lineLayout(visible);
    const box = (id: string, x: number, y: number) => layout.boxes.set(id, { x, y, width: 40, height: 20 });
    box("pkg", 0, 0);
    box("pkg.mod:Store.save", 10, 100);
    box("main", 200, 0);
    box("main:helper", 220, 60);
    layout.routes.set("agg|pkg|main", [
      { x: 40, y: 10 },
      { x: 120, y: 10 },
      { x: 120, y: 30 },
      { x: 200, y: 30 },
    ]);
    const view = edgeViews(drawn(repoFixture, visible, picked, null), layout, nodes).find(
      (v) => v.key === "pkg.mod:Store.save|main:helper|call",
    )!;
    expect(view.points).toEqual([
      { x: 50, y: 110 },
      { x: 120, y: 110 },
      { x: 120, y: 70 },
      { x: 220, y: 70 },
    ]);

    layout.routes.set("agg|pkg|main", [
      { x: 40, y: 10 },
      { x: 200, y: 10 },
    ]);
    const straight = edgeViews(drawn(repoFixture, visible, picked, null), layout, nodes).find(
      (v) => v.key === "pkg.mod:Store.save|main:helper|call",
    )!;
    expect(straight.points).toEqual([
      { x: 50, y: 110 },
      { x: 188, y: 110 },
      { x: 188, y: 70 },
      { x: 220, y: 70 },
    ]);
  });

  it("함수 안 import만 합친 선은 두 상자 아래로 돌아가는 경로를 받는다", () => {
    const points = views(null).get("pkg.mod|pkg.util|import")!.points;
    expect(points[0].y).toBe(20);
    expect(points[1].y).toBeGreaterThan(20);
    expect(points.at(-1)!.y).toBe(20);
  });

  it("집계 선은 무게가 2 이상일 때만 숫자를 달고, sites 수는 늘 담는다", () => {
    const closed = views(null);
    expect(closed.get("agg|main|pkg.mod")).toMatchObject({ weight: 4, sites: 4 });
    expect(closed.get("agg|pkg.mod|main")).toMatchObject({ weight: null, sites: 1 });
    expect(views("main:run").get("main:run|main:helper|call")).toMatchObject({ weight: null, sites: 1 });
  });

  it("진하기와 불투명도는 그릴 선의 값을 그대로 쓴다", () => {
    const focused = views("pkg.mod:Store.save");
    expect(focused.get("pkg.mod:Store.save|main:helper|call")).toMatchObject({ tone: "strong", opacity: 1 });
    expect(focused.get("pkg.mod:Store.load|pkg.mod:Store.save|call")).toMatchObject({ tone: "strong", opacity: 1 });
  });

  it("배치에 상자가 없는 노드에 닿는 선은 뺀다", () => {
    const { shown: visible } = scene(null);
    const layout = lineLayout(visible);
    layout.boxes.delete("main");
    const keys = edgeViews(drawn(repoFixture, visible, null, null), layout, nodes).map((v) => v.key);
    expect(keys).not.toContain("agg|main|pkg.mod");
    expect(keys).toContain("pkg.mod|pkg.util|import");
  });
});

describe("badges", () => {
  it("초점이 없으면 편재 노드마다 숨긴 선의 출발 노드 수를 낸다", () => {
    expect([...badges(repoFixture, scene(null).shown, null)]).toEqual([["common", 4]]);
  });

  it("편재 노드를 쓰는 노드나 편재 노드 안의 노드를 고르면 배지를 뺀다", () => {
    for (const selection of ["cli:main", "common:log", "common"]) {
      const { flow: picked, shown: visible } = scene(selection);
      expect(badges(repoFixture, visible, picked).size).toBe(0);
    }
  });

  it("편재 노드와 관계없는 노드를 고르면 배지를 남긴다", () => {
    const { flow: picked, shown: visible } = scene("app.text:pad");
    expect([...badges(repoFixture, visible, picked)]).toEqual([["common", 4]]);
  });
});

describe("roundedPath, midpoint", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];

  it("꺾이는 점에 원호를 넣는다", () => {
    expect(roundedPath(points)).toBe("M0,0 L6,0 Q10,0 10,4 L10,10");
  });

  it("경로 길이의 절반이 되는 점을 찾는다", () => {
    expect(midpoint(points)).toEqual({ x: 10, y: 0 });
  });
});
