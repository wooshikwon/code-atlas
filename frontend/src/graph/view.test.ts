import { describe, expect, it } from "vitest";
import { repoFixture, routeFixture } from "./fixture";
import { DIM, flow } from "./flow";
import { lit, route } from "./route";
import { sideRoute, type Layout } from "./layout";
import { drawn } from "./scope";
import { edgeViews, emphasized, letteredBoxes, NO_TRUNKS, ownNumbers, parentFirst, roundedPath, trunkShade, trunkViews, type EdgeView } from "./view";
import { hidden, nodeIndex, shown, type Shown } from "./visible";

const toggles = { showTests: false, showExternal: false };
const off = hidden(repoFixture, toggles);
const nodes = nodeIndex(repoFixture);

function scene(selection: string | null) {
  const picked = selection === null ? null : flow(repoFixture, selection, 2, off);
  return { flow: picked, shown: shown(repoFixture, { ...toggles, collapsed: new Set(), flow: picked, lit: null }) };
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
  return { positions: new Map(), sizes: new Map(), boxes, routes, lane: 12 };
}

function views(selection: string | null): Map<string, EdgeView> {
  const { flow: picked, shown: visible } = scene(selection);
  return new Map(edgeViews(drawn(repoFixture, visible, picked, null, null), lineLayout(visible), nodes).views.map((v) => [v.key, v]));
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
    const view = edgeViews(drawn(repoFixture, visible, picked, null, null), layout, nodes).views.find(
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
    const straight = edgeViews(drawn(repoFixture, visible, picked, null, null), layout, nodes).views.find(
      (v) => v.key === "pkg.mod:Store.save|main:helper|call",
    )!;
    expect(straight.points).toEqual([
      { x: 50, y: 110 },
      { x: 188, y: 110 },
      { x: 188, y: 70 },
      { x: 220, y: 70 },
    ]);
  });

  it("진입점 단위 사이 선은 보이는 양 끝 상자의 위치로 정한 경로를 받는다", () => {
    const { shown: visible } = scene(null);
    const layout = lineLayout(visible);
    const view = edgeViews(drawn(repoFixture, visible, null, null, null), layout, nodes).views.find((v) => v.key === "agg|cli|main")!;
    expect(view.points).toEqual(sideRoute(layout.boxes.get("cli")!, layout.boxes.get("main")!, layout.lane));
  });

  it("함수 안 import만 합친 선은 두 상자 아래로 돌아가는 경로를 받는다", () => {
    const points = views(null).get("pkg.mod|pkg.util|import")!.points;
    expect(points[0].y).toBe(20);
    expect(points[1].y).toBeGreaterThan(20);
    expect(points.at(-1)!.y).toBe(20);
  });

  it("따로 들어가는 선은 sites 수가 2 이상일 때 도착 노드 앞에 그 수를 적고, sites 수는 늘 담는다", () => {
    const closed = views(null);
    expect(closed.get("agg|main|pkg.mod")).toMatchObject({ trunks: { in: null }, sites: 3 });
    expect(closed.get("agg|main|pkg.mod")!.into).not.toBeNull();
    expect(closed.get("agg|pkg.mod|main")).toMatchObject({ into: null, sites: 1 });
    expect(views("main:run").get("main:run|main:helper|call")).toMatchObject({ into: null, sites: 1 });
  });

  it("진하기와 불투명도는 그릴 선의 값을 그대로 쓴다", () => {
    const focused = views("pkg.mod:Store.save");
    expect(focused.get("pkg.mod:Store.save|main:helper|call")).toMatchObject({ tone: "strong", opacity: 1 });
    expect(focused.get("pkg.mod:Store.save|pkg.mod:parse|call")).toMatchObject({ tone: "strong", opacity: 1 });
    expect(focused.get("pkg.mod:Store.load|pkg.mod:Row|construct")).toMatchObject({ tone: "muted", opacity: DIM });
  });

  it("배치에 상자가 없는 노드에 닿는 선은 뺀다", () => {
    const { shown: visible } = scene(null);
    const layout = lineLayout(visible);
    layout.boxes.delete("main");
    const keys = edgeViews(drawn(repoFixture, visible, null, null, null), layout, nodes).views.map((v) => v.key);
    expect(keys).not.toContain("agg|main|pkg.mod");
    expect(keys).toContain("pkg.mod|pkg.util|import");
  });
});

describe("edgeViews: 올린 상자 안으로 들어가는 경로", () => {
  const box = (x: number, y: number, width = 100, height = 40) => ({ x, y, width, height });
  /** main에서 폴더 pkg 안의 pkg.util로 가는 선. 배치 경로는 main과 pkg 사이에만 있다. */
  const edge = {
    key: "agg|main|pkg.util",
    source: "main",
    target: "pkg.util",
    group: "run" as const,
    weight: 1,
    kinds: {},
    tone: "muted" as const,
    opacity: 0.5,
    deferred: false,
    edges: [repoFixture.edges[0]],
    route: null,
    via: false,
  };
  const laid = (boxes: [string, ReturnType<typeof box>][], trunk: [number, number][]): Layout => ({
    positions: new Map(),
    sizes: new Map(),
    boxes: new Map(boxes),
    routes: new Map([["agg|main|pkg", trunk.map(([x, y]) => ({ x, y }))]]),
    lane: 12,
  });
  const pointsOf = (layout: Layout) => edgeViews([edge], layout, nodes).views[0].points.map((p) => [p.x, p.y]);

  it("도착 노드의 가운데 높이로 곧게 들어갈 수 있으면 그렇게 잇는다", () => {
    const layout = laid([["main", box(0, 40)], ["pkg", box(200, 0, 500, 200)], ["pkg.util", box(216, 40)]], [[100, 60], [200, 60]]);
    expect(pointsOf(layout)).toEqual([[100, 60], [216, 60]]);
  });

  it("앞 열의 상자가 그 높이를 막으면 상자 사이의 빈 가로 줄로 돌아 도착 노드의 열 앞에서 꺾는다", () => {
    const layout = laid(
      [["main", box(0, 40)], ["pkg", box(200, 0, 500, 200)], ["pkg.mod", box(216, 40)], ["pkg.util", box(380, 40)]],
      [[100, 60], [200, 60]],
    );
    // pkg.mod는 접힌 파일 상자여서 상자 아래 글자 줄 16px까지 막는다. 그 아래 12px(노드 간격의 절반)가 빈 가로 줄이다.
    expect(pointsOf(layout)).toEqual([[100, 60], [188, 60], [188, 108], [368, 108], [368, 60], [380, 60]]);
  });

  it("배치 경로의 세로 줄을 늘인 가로 줄이 올린 상자의 형제 상자를 지나면 올린 상자 옆 통로에서 꺾는다", () => {
    const layout = laid(
      [["main", box(0, 40)], ["cli", box(160, 100)], ["pkg", box(400, 0, 300, 300)], ["pkg.util", box(416, 100)]],
      [[100, 60], [130, 60], [130, 20], [400, 20]],
    );
    expect(pointsOf(layout)).toEqual([[100, 60], [130, 60], [130, 20], [388, 20], [388, 120], [416, 120]]);
  });

  it("빈 가로 줄이 없으면 도착 노드의 가운데 높이로 곧게 잇는다", () => {
    const layout = laid(
      [["main", box(0, 40)], ["pkg", box(200, 40, 500, 40)], ["pkg.mod", box(216, 40)], ["pkg.util", box(380, 40)]],
      [[100, 60], [200, 60]],
    );
    expect(pointsOf(layout)).toEqual([[100, 60], [380, 60]]);
  });
});

describe("roundedPath", () => {
  it("꺾이는 점에 원호를 넣는다", () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toBe("M0,0 L6,0 Q10,0 10,4 L10,10");
  });
});

describe("letteredBoxes", () => {
  it("접힌 파일 상자는 배지가 나가는 폭과 상자 아래 함수 수 글자까지, 펼친 파일 상자와 펼친 폴더 영역은 머리 줄만 글자를 그리는 칸이다", () => {
    const { shown: visible } = scene("main:run");
    const layout = lineLayout(visible);
    const lettered = letteredBoxes(layout, nodes);
    const [common, run] = [layout.boxes.get("common")!, layout.boxes.get("main:run")!];
    expect(lettered).toContainEqual({ x: common.x, y: -7, width: 40 + 6, height: 7 + 20 + 16 });
    expect(lettered).toContainEqual({ ...layout.boxes.get("main")!, height: 32 });
    expect(lettered).toContainEqual({ x: run.x, y: -7, width: 40 + 6, height: 7 + 20 + 7 });
    expect(lettered).toContainEqual({ ...layout.boxes.get("pkg")!, height: 28 });
    expect(lettered).toHaveLength(visible.nodes.size);
  });
});

describe("edgeViews: 강조하는 경로", () => {
  const none = hidden(routeFixture, toggles);
  const routeNodes = nodeIndex(routeFixture);
  const scene = (from: string, to: string) => {
    const path = lit(route(routeFixture, from, to, none), 0)!;
    const visible = shown(routeFixture, { ...toggles, collapsed: new Set(), flow: null, lit: path });
    return { visible, edges: drawn(routeFixture, visible, null, null, path) };
  };
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it("걸음의 종류를 선에 그대로 담는다", () => {
    const { visible, edges } = scene("flow.build:make", "flow.sink:tune");
    const views = edgeViews(edges, { ...lineLayout(visible), routes: new Map() }, routeNodes).views;
    expect(views.filter((v) => v.route !== null).map((v) => v.route)).toEqual(["construct", "init", "call"]);
    expect(views.filter((v) => v.route === null).every((v) => v.opacity === DIM)).toBe(true);
  });

  it("클래스에서 그 생성자 메서드로 가는 걸음은 클래스의 왼쪽 변에서 메서드의 왼쪽 변으로 가로로 잇는다", () => {
    const { edges } = scene("flow.build:make", "flow.sink:tune");
    const boxes = new Map([
      ["flow.build:Engine", box(100, 50, 200, 66)],
      ["flow.build:Engine.__init__", box(116, 82, 90, 18)],
    ]);
    const [view] = edgeViews(edges, { positions: new Map(), sizes: new Map(), boxes, routes: new Map(), lane: 12 }, routeNodes).views;
    expect(view.key).toBe("step|flow.build:Engine|flow.build:Engine.__init__");
    expect(view.points).toEqual([
      { x: 100, y: 91 },
      { x: 116, y: 91 },
    ]);
  });

  it("오버라이드 이음은 두 클래스 사이에 반대 방향 배치 경로만 있으면 그 경로를 뒤집어 따라간다", () => {
    const { edges } = scene("flow.build:Base.run", "flow.sink:emit");
    const boxes = new Map([
      ["flow.build:Base.step", box(316, 40, 60, 18)],
      ["flow.build:Child.step", box(16, 140, 60, 18)],
    ]);
    const trunk = [
      { x: 100, y: 150 },
      { x: 200, y: 150 },
      { x: 200, y: 60 },
      { x: 300, y: 60 },
    ];
    const routes = new Map([["agg|flow.build:Child|flow.build:Base", trunk]]);
    const [view] = edgeViews(edges, { positions: new Map(), sizes: new Map(), boxes, routes, lane: 12 }, routeNodes).views;
    expect(view.route).toBe("overridden");
    expect(view.points).toEqual([
      { x: 316, y: 49 },
      { x: 200, y: 49 },
      { x: 200, y: 149 },
      { x: 76, y: 149 },
    ]);
    expect(trunk[0]).toEqual({ x: 100, y: 150 });
  });
});

describe("trunkViews", () => {
  const view = (key: string, target: string, points: [number, number][], more: Partial<EdgeView> = {}): EdgeView => {
    const path = points.map(([x, y]) => ({ x, y }));
    return { key, source: key, target, group: "run", points: path, tone: "muted", opacity: 0.5, sites: 1, kinds: { call: 1 }, route: null, via: false, joins: true, below: false, into: null, branch: path, trunks: NO_TRUNKS, ...more };
  };
  /** 세 선이 x=100의 세로선에 차례로 붙어 (120, 50)으로 들어간다. c는 아래에서 올라온다. */
  const a = view("a", "t", [[0, 0], [100, 0], [100, 50], [120, 50]]);
  const b = view("b", "t", [[0, 20], [100, 20], [100, 50], [120, 50]]);
  const c = view("c", "t", [[0, 90], [100, 90], [100, 50], [120, 50]], { sites: 3, group: "use" });

  it("도착이 같은 선이 끝에서부터 함께 지나는 구간을 줄기로 떼고 선마다 가지를 남긴다", () => {
    const { views, trunks } = trunkViews([a, b, c], []);
    expect(trunks).toHaveLength(1);
    const [trunk] = trunks;
    expect(trunk).toMatchObject({ key: "trunk|t|in|0", end: "in", node: "t", keys: ["a", "b", "c"], far: 3, sites: 5, group: "run", route: false });
    expect(trunk.pieces).toEqual([
      [{ x: 100, y: 20 }, { x: 100, y: 50 }, { x: 120, y: 50 }],
    ]);
    expect(trunk.joints).toEqual([{ x: 100, y: 20 }, { x: 100, y: 50 }]);
    const byKey = new Map(views.map((v) => [v.key, v]));
    expect(byKey.get("a")).toMatchObject({ trunks: { in: "trunk|t|in|0", out: null }, branch: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }] });
    expect(byKey.get("b")!.branch).toEqual([{ x: 0, y: 20 }, { x: 100, y: 20 }]);
    expect(byKey.get("c")!.branch).toEqual([{ x: 0, y: 90 }, { x: 100, y: 90 }, { x: 100, y: 50 }]);
    expect(byKey.get("a")!.points).toEqual(a.points);
  });

  it("도착 노드 앞에서 만나기 전에 먼저 모인 선은 줄기에 붙는 묶음 하나가 된다", () => {
    const d = view("d", "t", [[0, 80], [50, 80], [50, 90], [100, 90], [100, 50], [120, 50]]);
    const { trunks } = trunkViews([a, c, d], []);
    expect(trunks[0].pieces).toEqual([
      [{ x: 50, y: 90 }, { x: 100, y: 90 }, { x: 100, y: 50 }, { x: 120, y: 50 }],
    ]);
    const e = view("e", "t", [[0, 10], [100, 10], [100, 50], [120, 50]]);
    expect(trunkViews([a, c, d, e], []).trunks[0].pieces[1]).toEqual([{ x: 100, y: 10 }, { x: 100, y: 50 }]);
    expect(trunks[0].joints).toContainEqual({ x: 50, y: 90 });
    expect(trunks[0].joints).toContainEqual({ x: 100, y: 50 });
  });

  it("도착이 다른 선, 함께 지나는 구간이 없는 선, 합류하지 않는 선은 줄기에 들지 않는다", () => {
    const other = view("o", "u", [[0, 0], [100, 0], [100, 50], [120, 50]]);
    const apart = view("p", "t", [[300, 50], [200, 50]]);
    const below = view("q", "t", [[0, 20], [100, 20], [100, 50], [120, 50]], { joins: false });
    const { views, trunks } = trunkViews([a, other, apart, below], []);
    expect(trunks).toEqual([]);
    expect(views.every((v) => v.trunks.in === null && v.trunks.out === null && v.branch === v.points)).toBe(true);
  });

  /** s에서 나간 세 선이 y=50의 가로 줄을 함께 지나다 x=30, x=40에서 차례로 갈라진다. */
  const from = (key: string, target: string, points: [number, number][], more: Partial<EdgeView> = {}) => view(key, target, points, { source: "s", ...more });
  const up = from("u", "tu", [[0, 50], [30, 50], [30, 0], [120, 0]]);
  const down = from("d", "td", [[0, 50], [40, 50], [40, 90], [120, 90]], { sites: 3, group: "use" });
  const ahead = from("h", "th", [[0, 50], [120, 50]]);

  it("출발이 같은 선이 처음부터 함께 지나는 구간을 줄기로 떼고 선마다 가지를 남긴다. 나가는 줄기에는 합계를 적는 점이 없다", () => {
    const { views, trunks } = trunkViews([up, down, ahead], []);
    expect(trunks).toHaveLength(1);
    const [trunk] = trunks;
    expect(trunk).toMatchObject({ key: "trunk|s|out|0", end: "out", node: "s", keys: ["d", "h", "u"], far: 3, sites: 5, at: null, group: "run", route: false });
    expect(trunk.pieces).toEqual([[{ x: 0, y: 50 }, { x: 40, y: 50 }]]);
    expect(trunk.joints).toEqual([{ x: 40, y: 50 }, { x: 30, y: 50 }]);
    const byKey = new Map(views.map((v) => [v.key, v]));
    expect(byKey.get("u")).toMatchObject({ trunks: { in: null, out: "trunk|s|out|0" }, branch: [{ x: 30, y: 50 }, { x: 30, y: 0 }, { x: 120, y: 0 }] });
    expect(byKey.get("d")!.branch).toEqual([{ x: 40, y: 50 }, { x: 40, y: 90 }, { x: 120, y: 90 }]);
    expect(byKey.get("h")!.branch).toEqual([{ x: 40, y: 50 }, { x: 120, y: 50 }]);
    // 나가는 줄기에만 든 선은 따로 들어가므로 도착 노드 앞에 그 선의 수를 적는다.
    expect(byKey.get("d")!.into).toEqual({ x: 120 - 13 - 2 - 5.5, y: 90 });
  });

  it("나가는 줄기와 들어오는 줄기에 모두 든 선은 두 줄기 사이만 가지로 남기고, 갈림점이 합류점과 같은 점이면 합류점만 남긴다", () => {
    // o는 다른 노드에서 나와 x=40의 세로 줄에 위에서 붙어 d와 함께 td로 들어간다.
    const other = view("o", "td", [[0, 0], [40, 0], [40, 90], [120, 90]]);
    const { views, trunks } = trunkViews([down, ahead, other], []);
    expect(trunks.map((t) => t.key)).toEqual(["trunk|s|out|0", "trunk|td|in|0"]);
    const [out, into] = trunks;
    expect(into.pieces).toEqual([[{ x: 40, y: 50 }, { x: 40, y: 90 }, { x: 120, y: 90 }]]);
    expect(into.joints).toEqual([{ x: 40, y: 50 }]);
    expect(out.pieces).toEqual([[{ x: 0, y: 50 }, { x: 40, y: 50 }]]);
    expect(out.joints).toEqual([]);
    const d = views.find((v) => v.key === "d")!;
    expect(d.trunks).toEqual({ in: "trunk|td|in|0", out: "trunk|s|out|0" });
    expect(d.branch).toEqual([{ x: 40, y: 50 }, { x: 40, y: 50 }]);
    expect(d.into).toBeNull();
  });

  it("두 줄기가 모두 지나는 구간은 들어오는 줄기에 들고, 나가는 줄기는 남은 구간에서만 뗀다", () => {
    // 출발과 도착이 같은 두 선은 경로 전체를 함께 지나 들어오는 줄기에 든다. 셋째 선은 앞 30만 함께 지나다 갈라진다.
    const twin = from("w", "tu", [[0, 50], [30, 50], [30, 0], [120, 0]]);
    const { views, trunks } = trunkViews([up, twin, ahead], []);
    expect(trunks.map((t) => [t.key, t.keys])).toEqual([
      ["trunk|s|out|0", ["h"]],
      ["trunk|tu|in|0", ["u", "w"]],
    ]);
    expect(trunks[0].pieces).toEqual([[{ x: 0, y: 50 }, { x: 30, y: 50 }]]);
    expect(trunks[0].joints).toEqual([{ x: 30, y: 50 }]);
    expect(views.find((v) => v.key === "u")!.trunks.out).toBeNull();
  });

  it("배치 밖에서 정한 경로가 마지막 가로 구간만 겹쳐도 같은 줄기에 든다", () => {
    const side = view("s", "t", [[0, 200], [110, 200], [110, 50], [120, 50]]);
    const { views, trunks } = trunkViews([a, side], []);
    expect(trunks[0].pieces).toEqual([[{ x: 110, y: 50 }, { x: 120, y: 50 }]]);
    expect(views.find((v) => v.key === "a")!.branch.at(-1)).toEqual({ x: 110, y: 50 });
  });

  it("줄기는 도착 노드로 들어오는 합계를 화살촉 앞의 마지막 구간 위에 적는다", () => {
    // 끝점 (120, 50)에서 화살촉 13, 둘레 2, 한 자리 수의 폭 11의 절반을 띄운다.
    expect(trunkViews([a, c], []).trunks[0]).toMatchObject({ sites: 4, at: { x: 120 - 13 - 2 - 5.5, y: 50 } });
  });

  it("줄기에 들지 않은 선은 sites 수가 2 이상이면 그 선이 도착 노드 앞에 수를 적는다", () => {
    const { views } = trunkViews([c, view("o", "u", [[0, 0], [100, 0]])], []);
    expect(views.map((v) => v.into)).toEqual([{ x: 120 - 13 - 2 - 5.5, y: 50 }, null]);
  });

  it("활성화된 선의 수는 그 선만 지나는 가장 긴 구간의 가운데에 적고, 들어오는 줄기에 들지 않은 선과 sites 수가 1인 선은 적지 않는다", () => {
    const lines = trunkViews([a, c], []);
    const [first, third] = lines.views;
    expect([...ownNumbers(lines, lines.views)]).toEqual([["c", { x: 50, y: 90 }]]);
    expect(third.branch).toEqual([{ x: 0, y: 90 }, { x: 100, y: 90 }, { x: 100, y: 50 }]);
    expect(first.sites).toBe(1);
    expect(ownNumbers(trunkViews([c], []), [c]).size).toBe(0);
    const fanned = trunkViews([up, down, ahead], []);
    expect(ownNumbers(fanned, fanned.views).size).toBe(0);
  });

  it("나가는 줄기를 벗어난 점에서 바로 들어오는 줄기에 붙어 가지가 없는 선은 활성화돼도 수를 적지 않는다", () => {
    const other = view("o", "td", [[0, 0], [40, 0], [40, 90], [120, 90]]);
    const lines = trunkViews([down, ahead, other], []);
    expect(ownNumbers(lines, [lines.views[0]]).size).toBe(0);
  });

  it("활성화된 선의 수는 글자를 그리는 칸, 다른 선, 먼저 놓은 수와 겹치지 않는 가장 가까운 점으로 옮기고 없으면 다음으로 긴 구간에서 찾는다", () => {
    const wide = { ...c, sites: 3 };
    const crossing = view("x", "v", [[50, 0], [50, 200]]);
    const lines = trunkViews([a, wide, crossing], []);
    // 가운데 (50, 90)을 다른 선이 지나므로 구간을 따라 그 선에서 벗어난 첫 점으로 옮긴다.
    const at = ownNumbers(lines, [lines.views[1]]).get("c")!;
    expect(at.y).toBe(90);
    expect(Math.abs(at.x - 50)).toBeGreaterThanOrEqual(5.5 + 1);
    expect(Math.abs(at.x - 50)).toBeLessThanOrEqual(12);
    const boxed = trunkViews([a, wide], [{ x: -10, y: 80, width: 200, height: 20 }]);
    expect(ownNumbers(boxed, [boxed.views[1]]).get("c")).toEqual({ x: 100, y: 70 });
    const second = { ...view("d", "t", [[0, 60], [100, 60], [100, 50], [120, 50]]), sites: 5 };
    const both = trunkViews([wide, second], []);
    const spots = ownNumbers(both, both.views);
    expect(spots.size).toBe(2);
  });

  it("줄기의 진하기는 따로 그리는 선을 뺀 가지 가운데 가장 진한 값이다", () => {
    const strong = { ...a, tone: "strong" as const, opacity: 1 };
    const rest = { ...b, opacity: DIM };
    const flowed = { ...c, opacity: 1 };
    const apart = (v: EdgeView) => emphasized(v, { pointed: false, cycle: false });
    expect(trunkShade([strong, rest, flowed], apart)).toEqual({ tone: "muted", opacity: 1 });
    expect(trunkShade([strong, rest], apart)).toEqual({ tone: "muted", opacity: DIM });
    expect(trunkShade([strong], apart)).toEqual({ tone: "strong", opacity: 1 });
  });

  it("마우스를 올린 선, 순환 선, 경로의 걸음, 고른 노드에 닿는 선을 강조한다", () => {
    const none = { pointed: false, cycle: false };
    expect(emphasized(a, none)).toBe(false);
    expect(emphasized(a, { pointed: true, cycle: false })).toBe(true);
    expect(emphasized(a, { pointed: false, cycle: true })).toBe(true);
    expect(emphasized({ ...a, route: "call" }, none)).toBe(true);
    expect(emphasized({ ...a, tone: "strong" }, none)).toBe(true);
  });
});
