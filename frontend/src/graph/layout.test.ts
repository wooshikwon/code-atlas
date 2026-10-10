import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { describe, expect, it } from "vitest";
import type { AtlasNode, Graph } from "../api/types";
import { columns } from "./columns";
import { repoFixture } from "./fixture";
import { flow } from "./flow";
import {
  arrange,
  belowRoute,
  crossRoute,
  elkGraphs,
  labelOf,
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

function shownFor(selection: string | null, collapsed: string[] = []): Shown {
  const picked = selection === null ? null : flow(repoFixture, selection, 2, hidden(repoFixture, toggles));
  return shown(repoFixture, { ...toggles, collapsed: new Set(collapsed), flow: picked });
}

function arranged(selection: string | null, collapsed: string[] = []): Promise<Layout> {
  return arrange(elkGraphs(repoFixture, shownFor(selection, collapsed), cols, measure), run);
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

/** 형제 묶음마다 열 순서(x가 같은 노드끼리 한 열)와 열 안 y 순서를 문자열로 만든다. */
function arrangement(result: Layout, ids: string[]): string {
  const groups = new Map<string | null, string[]>();
  for (const id of ids) {
    const parent = nodes.get(id)!.parent;
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

  it("24자를 넘는 경로는 앞쪽 폴더부터 …/로 줄이고 그 밖의 이름표는 24자에서 자른다", () => {
    expect(labelOf(node("billing.adapters.stripe_gateway", "module", "stripe_gateway"))).toBe("…/stripe_gateway.py");
    expect(labelOf(node("services.billing.adapters", "package", "adapters"))).toBe("…/billing/adapters/");
    expect(labelOf(node("a.test_arbiter_lifecycle_extra", "module", "x"))).toBe("…/test_arbiter_lifecycl…");
    expect(labelOf(node("m:f", "function", "_rebuild_note_sections_all"))).toBe("_rebuild_note_sections_…");
    expect(titleOf(node("m:f", "function", "_rebuild_note_sections_all"))).toBe("_rebuild_note_sections_all()");
  });
});

describe("elkGraphs", () => {
  const closed = elkGraphs(repoFixture, shownFor(null), cols, measure);
  const opened = elkGraphs(repoFixture, shownFor("pkg.mod"), cols, measure);

  it("연결 묶음마다 뿌리 하나를 만들고 단위를 열 안 순서로 넣어 열 번호를 partition으로 준다", () => {
    expect(closed.components).toHaveLength(1);
    const root = closed.components[0];
    expect(root.children?.map((c) => c.id)).toEqual(["app", "pkg", "cli", "common", "main"]);
    expect(root.children?.map((c) => c.layoutOptions?.["elk.partitioning.partition"])).toEqual(["0", "1", "0", "2", "0"]);
    expect(find(root, "app")?.children?.map((c) => c.id)).toEqual(["app.text", "app.web"]);
    expect(find(root, "app.text")?.layoutOptions?.["elk.partitioning.partition"]).toBe("1");
    expect(closed.shelf.map((n) => n.id)).toEqual(["scratch"]);
  });

  it("접힌 파일 상자는 220×40이고 함수 수 글자를 상자 아래 이름표로 넘긴다", () => {
    const main = find(closed.components[0], "main")!;
    expect(main).toMatchObject({ width: 220, height: 40, labels: [{ text: "함수 2개", height: 16 }] });
    expect(main.children).toBeUndefined();
  });

  it("펼친 폴더는 여백 없는 부모 노드이고 접은 폴더는 이름표 폭에 36을 더한 높이 40 상자다", () => {
    expect(find(closed.components[0], "pkg")?.layoutOptions?.["elk.padding"]).toBe("[top=0,left=0,bottom=0,right=0]");
    const folded = elkGraphs(repoFixture, shownFor(null, ["pkg"]), cols, measure);
    expect(find(folded.components[0], "pkg")).toMatchObject({ width: measure("pkg/") + 36, height: 40 });
  });

  it("펼친 파일 상자는 머리 줄 여백을 두고 안의 노드를 소스 정의 순서로 품는다", () => {
    const mod = find(opened.components[0], "pkg.mod")!;
    expect(mod.layoutOptions?.["elk.padding"]).toBe("[top=32,left=16,bottom=16,right=16]");
    expect(mod.children?.map((c) => c.id)).toEqual(["pkg.mod:Store", "pkg.mod:Row", "pkg.mod:parse"]);
    expect(mod.children?.map((c) => c.layoutOptions?.["elk.partitioning.partition"])).toEqual(["0", "1", "1"]);
    expect(find(mod, "pkg.mod:Store")?.children?.map((c) => c.id)).toEqual(["pkg.mod:Store.load", "pkg.mod:Store.save"]);
  });

  it("함수·메서드는 원, 이름표, 줄 수 숫자를 담는 폭에 높이 18이다", () => {
    const load = find(opened.components[0], "pkg.mod:Store.load")!;
    expect(load).toMatchObject({ width: 16 + 6 + measure("load()") + 5 + measure("9"), height: 18 });
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

  it("진입점 단위 사이 선을 side에 담는다", () => {
    expect(closed.side).toEqual([
      { key: "main|cli|import", source: "main", target: "cli" },
      { key: "agg|cli|main", source: "cli", target: "main" },
    ]);
  });

  it("파일 상자를 펼쳐도 최상위 선과 partition이 같다", () => {
    const strip = (root: ElkNode) => ({
      nodes: root.children?.map((c) => [c.id, c.layoutOptions?.["elk.partitioning.partition"]]),
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

  it("폴더를 접어도 다른 단위의 열 순서와 열 안 y 순서가 같다", () => {
    expect(arrangement(folded, units)).toBe(arrangement(closed, units));
    expect(folded.boxes.has("pkg.mod")).toBe(false);
  });

  it("선반 단위의 y가 모든 묶음보다 크다", () => {
    for (const result of [closed, file, node]) {
      const bottom = Math.max(...units.map((id) => result.boxes.get(id)!.y + result.boxes.get(id)!.height));
      expect(result.boxes.get("scratch")!.y).toBeGreaterThanOrEqual(bottom + 64);
    }
    expect(closed.sizes.get("scratch")).toEqual({ width: 220, height: 40 });
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

  it("진입점 단위 사이 선은 두 상자 왼쪽으로 나가는 경로를 받는다", () => {
    const route = closed.routes.get("agg|cli|main")!;
    const cli = closed.boxes.get("cli")!;
    const main = closed.boxes.get("main")!;
    expect(route).toEqual(sideRoute(cli, main));
    expect(route[1].x).toBe(cli.x - 12);
  });

  it("연결 묶음을 노드가 많은 묶음부터 48px 간격으로 쌓는다", async () => {
    const unit = (id: string): AtlasNode => ({ ...nodes.get("common")!, id, name: id });
    const edge = (source: string, target: string) => ({ ...repoFixture.edges[0], source, target });
    const graph: Graph = {
      nodes: ["a", "b", "c", "d", "e"].map(unit),
      edges: [edge("a", "b"), edge("c", "d"), edge("d", "e")],
    };
    const all = columns(graph, toggles);
    const visible = shown(graph, { ...toggles, collapsed: new Set(), flow: null });
    const result = await arrange(elkGraphs(graph, visible, all, measure), run);
    expect(all.components).toEqual([
      ["c", "d", "e"],
      ["a", "b"],
    ]);
    expect(result.boxes.get("a")!.y).toBeGreaterThanOrEqual(result.boxes.get("c")!.y + 40 + 48);
    expect(result.boxes.get("a")!.x).toBe(result.boxes.get("c")!.x);
  });
});

describe("crossRoute, belowRoute, sideRoute", () => {
  const a = { x: 0, y: 0, width: 40, height: 20 };
  const right = { x: 100, y: 50, width: 40, height: 20 };
  const under = { x: 10, y: 80, width: 40, height: 20 };

  it("가로로 떨어진 두 노드는 마주 보는 옆면을 잇는다", () => {
    for (const [s, t] of [
      [a, right],
      [right, a],
    ]) {
      const route = crossRoute(s, t);
      expect(onBorder(route[0], s) && onBorder(route.at(-1)!, t)).toBe(true);
      expect(route[0].y).toBe(s.y + s.height / 2);
    }
  });

  it("가로로 겹치는 두 노드는 윗면·아랫면을 잇는다", () => {
    const route = crossRoute(a, under);
    expect(route[0]).toEqual({ x: 20, y: 20 });
    expect(route.at(-1)).toEqual({ x: 30, y: 80 });
  });

  it("함수 안 import는 두 노드 아래로 돌아간다", () => {
    const route = belowRoute(a, right);
    expect(route[0]).toEqual({ x: 20, y: 20 });
    expect(route[1].y).toBeGreaterThan(70);
    expect(route.at(-1)).toEqual({ x: 120, y: 70 });
  });

  it("진입점 단위 사이 선은 두 노드 왼쪽 12px 밖으로 돌아간다", () => {
    expect(sideRoute(a, under)).toEqual([
      { x: 0, y: 10 },
      { x: -12, y: 10 },
      { x: -12, y: 90 },
      { x: 10, y: 90 },
    ]);
  });
});
