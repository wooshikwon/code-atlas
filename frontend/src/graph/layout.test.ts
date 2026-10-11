import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { describe, expect, it } from "vitest";
import type { AtlasNode, Graph } from "../api/types";
import { columns } from "./columns";
import { repoFixture, routeFixture } from "./fixture";
import { flow } from "./flow";
import {
  arrange,
  BADGE_GAP,
  BADGE_OVERHANG,
  belowRoute,
  CIRCLE_GAP,
  elkGraphs,
  labelOf,
  boxCaption,
  sideRoute,
  titleOf,
  type Box,
  type Layout,
  type Point,
  type RunElk,
} from "./layout";
import { hidden, nodeIndex, shown, type Shown } from "./visible";

const toggles = { showTests: false, showExternal: false };
const measure = (text: string) => text.length * 7;
const elk = new ELK();
const run: RunElk = (graph) => elk.layout(graph);
const nodes = nodeIndex(repoFixture);
const cols = columns(repoFixture, toggles);

/** 모든 상자를 전부 펼침 단계로 둔 화면. 고른 노드가 든 파일 상자가 안의 노드를 모두 그린다. unpacked를 주면 그 상자만 전부 펼침이다. */
function shownFor(selection: string | null, collapsed: string[] = [], unpacked: string[] = repoFixture.nodes.map((n) => n.id)): Shown {
  const picked = selection === null ? null : flow(repoFixture, selection, 2, hidden(repoFixture, toggles));
  return shown(repoFixture, { ...toggles, collapsed: new Set(collapsed), unpacked: new Set(unpacked), flow: picked, lit: null });
}

/** 손잡이를 뺀 자식 */
function kidsOf(node: ElkNode | undefined): ElkNode[] | undefined {
  return node?.children?.filter((child) => !child.id.endsWith("#pack"));
}

function arranged(selection: string | null, collapsed: string[] = []): Promise<Layout> {
  return arrange(elkGraphs(repoFixture, shownFor(selection, collapsed), cols, measure, new Map()), run);
}

function find(node: ElkNode, id: string): ElkNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children ?? []) {
    const hit = find(child, id);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

function onBorder(p: Point, box: Box): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  const insideX = p.x >= box.x - 0.5 && p.x <= box.x + box.width + 0.5;
  const insideY = p.y >= box.y - 0.5 && p.y <= box.y + box.height + 0.5;
  return (
    (insideY && (near(p.x, box.x) || near(p.x, box.x + box.width))) ||
    (insideX && (near(p.y, box.y) || near(p.y, box.y + box.height)))
  );
}

/** 형제 묶음마다 열 순서(x가 같은 노드끼리 한 열)와 열 안 y 순서를 문자열로 만든다. 열 없이 격자에 놓는 선반 단위 scratch와 손잡이는 뺀다. */
function arrangement(result: Layout, ids: string[], index = nodes): string {
  const groups = new Map<string | null, string[]>();
  for (const id of ids.filter((id) => id !== "scratch" && !id.endsWith("#pack"))) {
    const parent = index.get(id)!.parent;
    groups.set(parent, [...(groups.get(parent) ?? []), id]);
  }
  return [...groups]
    .map(([parent, members]) => {
      const xs = [...new Set(members.map((id) => result.boxes.get(id)!.x))].sort((a, b) => a - b);
      const lanes = xs.map((x) =>
        members
          .filter((id) => result.boxes.get(id)!.x === x)
          .sort((a, b) => result.boxes.get(a)!.y - result.boxes.get(b)!.y)
          .join(","),
      );
      return `${parent}: ${lanes.join(" | ")}`;
    })
    .join("\n");
}

describe("labelOf", () => {
  const node = (id: string, kind: AtlasNode["kind"], name: string): AtlasNode => ({ ...nodes.get("main")!, id, kind, name });

  it("파일은 소스 루트 기준 경로, 폴더는 경로 뒤에 /, 함수·메서드는 이름()이다", () => {
    expect(labelOf(nodes.get("pkg.mod")!)).toBe("pkg/mod.py");
    expect(labelOf(nodes.get("pkg")!)).toBe("pkg/");
    expect(labelOf(nodes.get("pkg.mod:Store.load")!)).toBe("load()");
    expect(labelOf(nodes.get("main:run")!)).toBe("run()");
    expect(labelOf(nodes.get("pkg.mod:Store")!)).toBe("Store");
  });

  it("36자를 넘는 경로는 앞쪽 폴더부터 …/로 줄이고, 줄인 폴더가 없는 경로와 그 밖의 이름표는 36자에서 자른다", () => {
    expect(labelOf(node("services.billing.adapters.stripe_gateway", "module", "stripe_gateway"))).toBe("…/billing/adapters/stripe_gateway.py");
    expect(labelOf(node("services.billing.adapters.gateways.stripe", "package", "stripe"))).toBe("…/billing/adapters/gateways/stripe/");
    expect(labelOf(node("mdp.cli._logging_bootstrap", "module", "_logging_bootstrap"))).toBe("mdp/cli/_logging_bootstrap.py");
    expect(labelOf(node("a.test_arbiter_lifecycle_extra_long_cases", "module", "x"))).toBe("…/test_arbiter_lifecycle_extra_long…");
    expect(labelOf(node("test_arbiter_lifecycle_extra_long_cases", "module", "x"))).toBe("test_arbiter_lifecycle_extra_long_c…");
    expect(labelOf(node("m:f", "function", "_rebuild_note_sections_for_every_week"))).toBe("_rebuild_note_sections_for_every_we…");
    expect(titleOf(node("m:f", "function", "_rebuild_note_sections_for_every_week"))).toBe("_rebuild_note_sections_for_every_week()");
  });
});

describe("elkGraphs", () => {
  const closed = elkGraphs(repoFixture, shownFor(null), cols, measure, new Map());
  const opened = elkGraphs(repoFixture, shownFor("pkg.mod"), cols, measure, new Map());

  it("연결 묶음마다 뿌리 하나를 만들고 단위를 열 안 순서로 넣어 열 번호를 partition으로 준다", () => {
    expect(closed.components).toHaveLength(1);
    const root = closed.components[0];
    expect(kidsOf(root)?.map((c) => c.id)).toEqual(["app", "pkg", "cli", "common", "main"]);
    expect(kidsOf(root)?.map((c) => c.layoutOptions?.["elk.partitioning.partition"])).toEqual(["0", "1", "0", "2", "0"]);
    expect(kidsOf(find(root, "app"))?.map((c) => c.id)).toEqual(["app.__init__", "app.text", "app.web"]);
    expect(find(root, "app.text")?.layoutOptions?.["elk.partitioning.partition"]).toBe("1");
    expect(closed.shelf.map((n) => n.id)).toEqual(["scratch"]);
  });

  it("자식을 그리지 않는 노드는 왼쪽 변에 들어오는 포트 하나를 두고 그 노드로 가는 선은 포트에 닿는다. 자식을 그리는 노드에는 포트가 없다", () => {
    const root = opened.components[0];
    for (const id of ["main", "common", "pkg.util", "pkg.mod:parse", "pkg.mod:Store.load"]) {
      const node = find(root, id)!;
      expect(node.ports).toEqual([{ id: `${id}#in`, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST" } }]);
      expect(node.layoutOptions?.["elk.portConstraints"]).toBe("FIXED_SIDE");
    }
    for (const id of ["pkg", "pkg.mod", "pkg.mod:Store", "app"]) {
      expect(find(root, id)!.ports).toBeUndefined();
    }
    const targets = new Map(root.edges!.map((e) => [e.id, e.targets[0]]));
    expect(targets.get("main|common|import")).toBe("common#in");
    expect(targets.get("agg|main|pkg")).toBe("pkg");
    expect(root.edges!.every((e) => !e.sources[0].endsWith("#in"))).toBe(true);
  });

  it("손잡이를 다는 상자는 자식 목록 끝에 손잡이 노드를 열0으로 넣고, 이미 그리던 자식의 순서와 열은 그대로다", () => {
    const part = find(elkGraphs(repoFixture, shownFor("pkg.mod", [], []), cols, measure, new Map()).components[0], "pkg.mod")!;
    expect(part.children?.map((c) => c.id)).toEqual(["pkg.mod:Store", "pkg.mod#pack"]);
    const handle = part.children!.at(-1)!;
    expect(handle).toMatchObject({ width: measure("안쪽 2개") + 12, height: 18 });
    expect(handle.layoutOptions?.["elk.partitioning.partition"]).toBe("0");
    const full = find(opened.components[0], "pkg.mod")!;
    expect(full.children?.map((c) => c.id)).toEqual(["pkg.mod:Store", "pkg.mod:Row", "pkg.mod:parse", "pkg.mod#pack"]);
    expect(full.children!.at(-1)!.width).toBe(measure("안쪽 2개 접기") + 12);
    const partition = (node: ElkNode, id: string) => find(node, id)!.layoutOptions?.["elk.partitioning.partition"];
    expect(partition(part, "pkg.mod:Store")).toBe(partition(full, "pkg.mod:Store"));
  });

  it("강조하는 경로의 출발 노드와 도착 노드는 표지의 폭만큼 넓고 그 밖의 노드는 크기가 같다", () => {
    const ends = new Map([["pkg.mod:Store.load", "from"], ["pkg.mod:parse", "to"]] as const);
    const tagged = elkGraphs(repoFixture, shownFor("pkg.mod"), cols, measure, ends);
    const tag = 6 + measure("출발") + 12;
    for (const id of ["pkg.mod:Store.load", "pkg.mod:parse"]) {
      expect(find(tagged.components[0], id)!.width).toBe(find(opened.components[0], id)!.width! + tag);
    }
    expect(find(tagged.components[0], "pkg.mod:Store.save")).toEqual(find(opened.components[0], "pkg.mod:Store.save"));
  });

  it("접힌 파일 상자는 320×40이고 미사용 후보 수를 적는 줄을 상자 아래 이름표로 잡아 둔다", () => {
    const main = find(closed.components[0], "main")!;
    expect(main).toMatchObject({ width: 320, height: 40, labels: [{ text: "미사용 후보 999", height: 16 }] });
    expect(main.children).toBeUndefined();
  });

  it("펼친 폴더는 머리 줄 28px와 여백 16px를 둔 부모 노드이고 접은 폴더는 이름표 폭에 36을 더한 높이 40 상자다", () => {
    const region = find(closed.components[0], "pkg")!;
    expect(region.layoutOptions?.["elk.padding"]).toBe("[top=28,left=16,bottom=16,right=16]");
    expect(region.layoutOptions?.["elk.nodeSize.minimum"]).toBe(`(${measure("pkg/") + 32}, 44)`);
    const folded = elkGraphs(repoFixture, shownFor(null, ["pkg"]), cols, measure, new Map());
    expect(find(folded.components[0], "pkg")).toMatchObject({ width: measure("pkg/") + 36, height: 40 });
  });

  it("순환 아이콘을 다는 접힌 폴더 상자는 아이콘의 폭을 더하고, 파일 상자와 펼친 폴더 영역의 크기는 그대로다", () => {
    const routeCols = columns(routeFixture, toggles);
    const input = (collapsed: string[]) => {
      const visible = shown(routeFixture, { ...toggles, collapsed: new Set(collapsed), flow: null, lit: null });
      const built = elkGraphs(routeFixture, visible, routeCols, measure, new Map());
      return { id: "all", children: [...built.components, ...built.shelf] };
    };
    const folded = input(["ring", "lazy"]);
    expect(find(folded, "ring")).toMatchObject({ width: measure("ring/") + 16 + 36, height: 40 });
    expect(find(folded, "lazy")).toMatchObject({ width: measure("lazy/") + 36, height: 40 });
    const open = input([]);
    expect(find(open, "ring.a")).toMatchObject({ width: 320, height: 40 });
    expect(find(open, "ring")!.layoutOptions?.["elk.nodeSize.minimum"]).toBe(`(${measure("ring/") + 32}, 44)`);
  });

  it("접힌 폴더 상자는 접힌 파일 상자처럼 아래 글자의 줄을 상자 아래에 잡아 둔다", () => {
    const folded = elkGraphs(repoFixture, shownFor(null, ["pkg"]), cols, measure, new Map());
    const pkg = find(folded.components[0], "pkg")!;
    expect(pkg.labels).toEqual([{ text: "미사용 후보 999", width: measure("미사용 후보 999"), height: 16 }]);
    expect(pkg.layoutOptions?.["elk.nodeLabels.placement"]).toBe("OUTSIDE V_BOTTOM H_LEFT");
  });

  it("접힌 상자 아래 글자는 미사용 후보가 있을 때만 그 수를 적는다", () => {
    expect(boxCaption(0)).toBe("");
    expect(boxCaption(2)).toBe("미사용 후보 2");
  });

  it("펼친 파일 상자는 머리 줄 여백을 두고 안의 노드를 소스 정의 순서로 품는다", () => {
    const mod = find(opened.components[0], "pkg.mod")!;
    expect(mod.layoutOptions?.["elk.padding"]).toBe("[top=32,left=16,bottom=16,right=16]");
    expect(kidsOf(mod)?.map((c) => c.id)).toEqual(["pkg.mod:Store", "pkg.mod:Row", "pkg.mod:parse"]);
    expect(kidsOf(mod)?.map((c) => c.layoutOptions?.["elk.partitioning.partition"])).toEqual(["0", "1", "1"]);
    expect(kidsOf(find(mod, "pkg.mod:Store"))?.map((c) => c.id)).toEqual(["pkg.mod:Store.load", "pkg.mod:Store.save"]);
  });

  it("함수·메서드는 원, 배지가 나오는 폭과 그 뒤에 남기는 폭, 이름표, 줄 수 숫자를 담는 폭에 높이 18이다", () => {
    const load = find(opened.components[0], "pkg.mod:Store.load")!;
    expect(CIRCLE_GAP).toBe(BADGE_OVERHANG + BADGE_GAP);
    expect(load).toMatchObject({ width: 16 + BADGE_OVERHANG + BADGE_GAP + measure("load()") + 5 + measure("9"), height: 18 });
  });

  it("데이터 클래스는 머리 칸에 줄 수 숫자 폭을 더한 표 크기다", () => {
    const row = find(opened.components[0], "pkg.mod:Row")!;
    const head = measure("Row") + 5 + measure("9");
    expect(row).toMatchObject({ width: Math.max(head, measure("a: int")) + 16, height: 24 + 6 * 18 + 4 });
  });

  it("선은 형제 사이로 올려 그 부모에 선언하고 함수 안 import와 진입점 단위 사이 선을 뺀다", () => {
    const top = closed.components[0].edges?.map((e) => e.id) ?? [];
    expect(top).toEqual(expect.arrayContaining(["agg|main|pkg", "agg|pkg|main", "main|common|import", "agg|app|common"]));
    expect(top.some((id) => id.includes("cli") && id.includes("main"))).toBe(false);
    expect(find(closed.components[0], "pkg")?.edges).toEqual([]);
    expect(find(closed.components[0], "app")?.edges?.map((e) => e.id)).toEqual(["agg|app.web|app.text"]);
    const mod = find(opened.components[0], "pkg.mod")!;
    expect(mod.edges?.map((e) => e.id).sort()).toEqual(["agg|pkg.mod:Store|pkg.mod:Row", "agg|pkg.mod:Store|pkg.mod:parse"]);
    expect(find(mod, "pkg.mod:Store")?.edges?.map((e) => e.id)).toEqual(["pkg.mod:Store.load|pkg.mod:Store.save|call"]);
  });

  it("자식마다 children 배열의 순서를 elk.position으로 적고, 그 순서대로 놓는 옵션을 준다", () => {
    const walk = (parent: ElkNode) => {
      for (const [i, child] of (parent.children ?? []).entries()) {
        expect(child.layoutOptions?.["elk.position"], child.id).toBe(`(0,${i})`);
        walk(child);
      }
    };
    for (const root of [...closed.components, ...opened.components]) {
      walk(root);
      expect(root.layoutOptions).toMatchObject({
        "elk.layered.crossingMinimization.semiInteractive": "true",
        "elk.layered.crossingMinimization.greedySwitch.type": "OFF",
        "elk.layered.thoroughness": "1",
      });
      expect(Object.keys(root.layoutOptions ?? {}).filter((key) => key.includes("ModelOrder"))).toEqual([]);
    }
    expect(find(opened.components[0], "pkg.mod")?.layoutOptions?.["elk.layered.crossingMinimization.semiInteractive"]).toBe("true");
  });

  it("파일 상자를 펼쳐도 최상위 선과 partition이 같다", () => {
    const strip = (root: ElkNode) => ({
      nodes: kidsOf(root)?.map((c) => [c.id, c.layoutOptions?.["elk.partitioning.partition"]]),
      edges: root.edges?.map((e) => e.id),
    });
    expect(strip(opened.components[0])).toEqual(strip(closed.components[0]));
  });
});

describe("arrange", async () => {
  const closed = await arranged(null);
  const file = await arranged("main");
  const node = await arranged("app.web:index");
  const folded = await arranged(null, ["pkg"]);
  const units = ["app", "pkg", "cli", "common", "main"];

  it("같은 열 번호의 형제는 x가 같고 열 번호가 크면 x가 크다", () => {
    for (const result of [closed, file, node]) {
      const x = (id: string) => result.boxes.get(id)!.x;
      expect(x("app")).toBe(x("cli"));
      expect(x("cli")).toBe(x("main"));
      expect(x("pkg")).toBeGreaterThan(x("main"));
      expect(x("common")).toBeGreaterThan(x("pkg"));
      expect(x("pkg.mod")).toBe(x("pkg.util"));
      expect(x("app.text")).toBeGreaterThan(x("app.web"));
    }
    expect(node.boxes.get("app.web:render")!.x).toBeGreaterThan(node.boxes.get("app.web:index")!.x);
  });

  it("같은 노드로 들어가는 선은 그 노드의 왼쪽 변 가운데 한 점에 닿는다", () => {
    const box = closed.boxes.get("common")!;
    const into = [...closed.routes].filter(([key]) => key.split("|")[key.startsWith("agg|") ? 2 : 1] === "common");
    expect(into.length).toBeGreaterThan(2);
    for (const [, points] of into) {
      expect(points.at(-1)).toEqual({ x: box.x, y: box.y + box.height / 2 });
    }
  });

  it("손잡이는 상자 안 열0의 맨 아래에 놓이고, 단계를 바꿔도 상자 사이의 열과 순서는 그대로다", async () => {
    const part = await arrange(elkGraphs(repoFixture, shownFor("pkg.mod", [], []), cols, measure, new Map()), run);
    const full = await arranged("pkg.mod");
    for (const result of [part, full]) {
      const handle = result.boxes.get("pkg.mod#pack")!;
      const store = result.boxes.get("pkg.mod:Store")!;
      expect(handle.x).toBe(store.x);
      expect(handle.y).toBeGreaterThan(store.y + store.height);
    }
    const boxes = [...shownFor(null).nodes];
    expect(arrangement(part, boxes)).toBe(arrangement(full, boxes));
    expect(arrangement(part, boxes)).toBe(arrangement(closed, boxes));
  });

  it("진입점 두 개가 서로 import해도 둘 다 가장 작은 x에 놓인다", () => {
    const least = Math.min(...units.map((id) => closed.boxes.get(id)!.x));
    expect(closed.boxes.get("main")!.x).toBe(least);
    expect(closed.boxes.get("cli")!.x).toBe(least);
  });

  it("열 안에서는 열 안 순서대로 위에서 아래로 놓는다", () => {
    const y = (id: string) => closed.boxes.get(id)!.y;
    expect(y("app")).toBeLessThan(y("cli"));
    expect(y("cli")).toBeLessThan(y("main"));
    expect(y("pkg.mod")).toBeLessThan(y("pkg.util"));
  });

  it("파일 상자를 펼치기 전과 후에 모든 단위의 열 순서와 열 안 y 순서가 같다", () => {
    const boxes = [...shownFor(null).nodes];
    const before = arrangement(closed, boxes);
    expect(arrangement(file, boxes)).toBe(before);
    expect(arrangement(node, boxes)).toBe(before);
    expect(file.sizes.get("main")!.height).toBeGreaterThan(40);
    expect(node.boxes.has("app.text:wrap")).toBe(true);
  });

  it("형제마다 열과 열 안 순서가 고정한 값과 같다", async () => {
    const lanes = (result: Layout, index = nodes) => arrangement(result, [...result.boxes.keys()], index).split("\n").sort();
    const top = "null: app,cli,main | pkg | common";
    const folders = ["app: app.web | app.__init__,app.text", "pkg: pkg.mod,pkg.util"];
    expect(lanes(closed)).toEqual([...folders, top].sort());
    expect(lanes(await arranged("pkg.mod"))).toEqual(
      [...folders, top, "pkg.mod: pkg.mod:Store | pkg.mod:Row,pkg.mod:parse", "pkg.mod:Store: pkg.mod:Store.load | pkg.mod:Store.save"].sort(),
    );
    expect(lanes(node)).toEqual([...folders, top, "app.text: app.text:wrap", "app.web: app.web:index | app.web:render"].sort());
    expect(lanes(await arranged("main:run"))).toEqual(
      [
        ...folders,
        top,
        "cli: cli:main",
        "main: main:run | main:helper",
        "pkg.mod: pkg.mod:Store | pkg.mod:Row",
        "pkg.mod:Store: pkg.mod:Store.load | pkg.mod:Store.save",
      ].sort(),
    );

    const routeNodes = nodeIndex(routeFixture);
    const routeCols = columns(routeFixture, toggles);
    const route = async (selection: string | null) => {
      const picked = selection === null ? null : flow(routeFixture, selection, 2, hidden(routeFixture, toggles));
      const visible = shown(routeFixture, { ...toggles, collapsed: new Set(), unpacked: new Set(routeFixture.nodes.map((n) => n.id)), flow: picked, lit: null });
      return lanes(await arrange(elkGraphs(routeFixture, visible, routeCols, measure, new Map()), run), routeNodes);
    };
    const regions = [
      "flow: flow.walk | flow.build | flow.sink",
      "lazy: lazy.one | lazy.two",
      "north: north.up",
      "null: flow,lazy,north | south | ring",
      "ring: ring.a | ring.b | ring.c",
      "south: south.down",
    ];
    expect(await route(null)).toEqual(regions);
    expect(await route("flow.walk:begin")).toEqual(
      [...regions, "flow.walk: flow.walk:begin | flow.walk:mid,flow.walk:right,flow.walk:probe,flow.walk:lone | flow.walk:left | flow.walk:finish"].sort(),
    );
    expect(await route("flow.build:Child.step")).toEqual(
      [
        ...regions,
        "flow.build: flow.build:make,flow.build:Child | flow.build:Engine,flow.build:Base",
        "flow.build:Base: flow.build:Base.run | flow.build:Base.step",
        "flow.build:Child: flow.build:Child.step",
        "flow.build:Engine: flow.build:Engine.__init__",
        "flow.sink: flow.sink:emit",
      ].sort(),
    );
  });

  it("폴더를 접어도 다른 단위의 열 순서와 열 안 y 순서가 같다", () => {
    expect(arrangement(folded, units)).toBe(arrangement(closed, units));
    expect(folded.boxes.has("pkg.mod")).toBe(false);
  });

  it("선반 단위의 y가 모든 묶음보다 크다", () => {
    for (const result of [closed, file, node]) {
      const bottom = Math.max(...units.map((id) => result.boxes.get(id)!.y + result.boxes.get(id)!.height));
      expect(result.boxes.get("scratch")!.y).toBeGreaterThanOrEqual(bottom + 64);
    }
    expect(closed.sizes.get("scratch")).toEqual({ width: 320, height: 40 });
  });

  it("선반 단위를 펼치면 그 안의 노드를 배치한다", async () => {
    const result = await arranged("scratch");
    const box = result.boxes.get("scratch")!;
    const todo = result.boxes.get("scratch:todo")!;
    expect(todo.x).toBe(box.x + 16);
    expect(todo.y).toBe(box.y + 32);
    expect(result.positions.get("scratch:todo")).toEqual({ x: 16, y: 32 });
  });

  it("부모 기준 좌표를 더해 절대 좌표를 만든다", () => {
    const pkg = file.boxes.get("pkg")!;
    const mod = file.positions.get("pkg.mod")!;
    expect(file.boxes.get("pkg.mod")).toMatchObject({ x: pkg.x + mod.x, y: pkg.y + mod.y });
    const main = file.boxes.get("main")!;
    const helper = file.positions.get("main:helper")!;
    expect(file.boxes.get("main:helper")).toMatchObject({ x: main.x + helper.x, y: main.y + helper.y });
  });

  it("선 경로가 출발·도착 노드 테두리에 닿는다", () => {
    for (const [result, key, source, target] of [
      [closed, "agg|main|pkg", "main", "pkg"],
      [closed, "agg|pkg|main", "pkg", "main"],
      [closed, "agg|app.web|app.text", "app.web", "app.text"],
      [file, "main:run|main:helper|call", "main:run", "main:helper"],
      [node, "app.web:index|app.web:render|call", "app.web:index", "app.web:render"],
    ] as const) {
      const route = result.routes.get(key)!;
      expect(onBorder(route[0], result.boxes.get(source)!), `${key} start`).toBe(true);
      expect(onBorder(route.at(-1)!, result.boxes.get(target)!), `${key} end`).toBe(true);
    }
  });

  it("직각 경로의 이웃한 점은 가로 또는 세로로 잇는다", () => {
    for (const result of [closed, file, node]) {
      for (const route of result.routes.values()) {
        for (let i = 1; i < route.length; i++) {
          const [a, b] = [route[i - 1], route[i]];
          expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5).toBe(true);
        }
      }
    }
  });

  it("진입점 단위 사이 선에는 경로를 내지 않는다", () => {
    expect(closed.routes.has("agg|cli|main")).toBe(false);
    expect(closed.routes.has("main|cli|import")).toBe(false);
  });

  it("연결 묶음을 노드가 많은 묶음부터 48px 간격으로 쌓는다", async () => {
    const unit = (id: string): AtlasNode => ({ ...nodes.get("common")!, id, name: id });
    const edge = (source: string, target: string) => ({ ...repoFixture.edges[0], source, target });
    const graph: Graph = {
      nodes: ["a", "b", "c", "d", "e"].map(unit),
      edges: [edge("a", "b"), edge("c", "d"), edge("d", "e")],
    };
    const all = columns(graph, toggles);
    const visible = shown(graph, { ...toggles, collapsed: new Set(), flow: null, lit: null });
    const result = await arrange(elkGraphs(graph, visible, all, measure, new Map()), run);
    expect(all.components).toEqual([
      ["c", "d", "e"],
      ["a", "b"],
    ]);
    expect(result.boxes.get("a")!.y).toBeGreaterThanOrEqual(result.boxes.get("c")!.y + 40 + 48);
    expect(result.boxes.get("a")!.x).toBe(result.boxes.get("c")!.x);
  });
});

describe("belowRoute, sideRoute", () => {
  const a = { x: 0, y: 0, width: 40, height: 20 };
  const right = { x: 100, y: 50, width: 40, height: 20 };
  const under = { x: 10, y: 80, width: 40, height: 20 };

  it("함수 안 import는 두 노드 아래로 돌아간다", () => {
    const route = belowRoute(a, right);
    expect(route[0]).toEqual({ x: 20, y: 20 });
    expect(route[1].y).toBeGreaterThan(70);
    expect(route.at(-1)).toEqual({ x: 120, y: 70 });
  });

  it("도착 상자가 오른쪽에 있으면 출발 상자의 오른쪽 변에서 나와 도착 상자 10px 앞에서 꺾어 왼쪽 변으로 들어간다", () => {
    expect(sideRoute(a, right)).toEqual([
      { x: 40, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 60 },
      { x: 100, y: 60 },
    ]);
  });

  it("도착 상자가 왼쪽에 있으면 출발 상자의 왼쪽 변에서 나와 도착 상자의 오른쪽 변으로 들어간다", () => {
    expect(sideRoute(right, a)).toEqual([
      { x: 100, y: 60 },
      { x: 50, y: 60 },
      { x: 50, y: 10 },
      { x: 40, y: 10 },
    ]);
  });

  it("가로로 겹치는 두 상자는 오른쪽 10px 밖으로 돌고, 마주 보는 쪽 모서리에서 6px 안쪽 높이로 드나든다", () => {
    expect(sideRoute(a, under)).toEqual([
      { x: 40, y: 14 },
      { x: 60, y: 14 },
      { x: 60, y: 86 },
      { x: 50, y: 86 },
    ]);
    expect(sideRoute(under, a).map((p) => p.y)).toEqual([86, 86, 14, 14]);
  });
});
