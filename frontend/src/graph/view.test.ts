import { describe, expect, it } from "vitest";
import { fixture } from "./fixture";
import { focus, seedsOf } from "./focus";
import type { Layout } from "./layout";
import { scope, visibleNodes } from "./scope";
import { edgeIndex, edgeViews, midpoint, parentFirst, roundedPath } from "./view";

const visible = visibleNodes(fixture, false);
const index = edgeIndex(fixture, visible);

/** 노드를 가로 한 줄로 늘어놓은 배치. 경로는 집계 선 하나만 ELK 결과로 준다. */
function lineLayout(): Layout {
  const boxes = new Map(
    [...visible].map((id, i) => [id, { x: i * 100, y: 0, width: 40, height: 20 }] as const),
  );
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

describe("parentFirst", () => {
  it("부모를 자식보다 앞에 둔다", () => {
    const order = parentFirst(fixture, visible).map((n) => n.id);
    for (const node of fixture.nodes.filter((n) => visible.has(n.id) && n.parent !== null)) {
      expect(order.indexOf(node.parent!)).toBeLessThan(order.indexOf(node.id));
    }
  });
});

describe("edgeViews", () => {
  it("ELK 경로가 있으면 쓰고, 없으면 파일 경계를 넘는 경로를 만든다", () => {
    const keys = scope(fixture, visible, "pkg.mod:Store.save", null);
    const views = new Map(edgeViews(index, lineLayout(), keys, null, null).map((v) => [v.key, v]));
    expect(views.get("agg|main|pkg.mod")?.points).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect(views.get("pkg.mod:Store.save|main:helper|call")?.points.length).toBe(4);
  });

  it("집계 선은 무게가 2 이상일 때만 숫자를 단다", () => {
    const views = edgeViews(index, lineLayout(), scope(fixture, visible, null, null), null, null);
    const weights = new Map(views.map((v) => [v.key, v.weight]));
    expect(weights.get("agg|main|pkg.mod")).toBe(4);
    expect(weights.get("agg|pkg.mod|main")).toBeNull();
    expect(weights.get("main:run|main:helper|call")).toBeNull();
  });

  it("선택한 노드에서 나가는 선과 들어오는 선을 가르고, 나머지는 더 흐린 끝을 따른다", () => {
    const selection = "pkg.mod:Store.save";
    const keys = scope(fixture, visible, selection, null);
    const views = new Map(
      edgeViews(index, lineLayout(), keys, seedsOf(fixture, selection), focus(fixture, visible, selection, 1)).map(
        (v) => [v.key, v],
      ),
    );
    expect(views.get("pkg.mod:Store.save|main:helper|call")?.tone).toBe("outgoing");
    expect(views.get("pkg.mod:Store.load|pkg.mod:Store.save|call")?.tone).toBe("incoming");
    const row = views.get("pkg.mod:Store.load|pkg.mod:Row|construct");
    expect(row?.tone).toBe("muted");
    expect(row?.opacity).toBe(0.5);
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
