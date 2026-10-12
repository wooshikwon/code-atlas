import { describe, expect, it } from "vitest";
import { compared } from "../compare";
import { compareFixture, repoFixture } from "../fixture";
import { DIM, HALF } from "../flow";
import type { Layout } from "../layout";
import { drawn } from "../scope";
import { edgeViews } from "../view";
import { nodeIndex, shown } from "../visible";
import { flowEdges } from "./OrthogonalEdge";

const toggles = { showTests: false, showExternal: false };
const visible = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: null, lit: null });
const boxes = new Map([...visible.nodes].map((id, i) => [id, { x: i * 100, y: 0, width: 40, height: 20 }] as const));
const layout: Layout = { positions: new Map(), sizes: new Map(), boxes, routes: new Map(), lane: 12 };
const lines = edgeViews(drawn(repoFixture, visible, null, null, null), layout, nodeIndex(repoFixture));

describe("flowEdges", () => {
  it("앞에 만든 선을 넘기면 강조가 바뀐 선만 새 객체로 만든다", () => {
    const none = new Set<string>();
    const first = flowEdges(lines, none, none);
    expect(first.length).toBeGreaterThan(1);
    const key = lines.views[0].key;
    const pointed = flowEdges(lines, new Set([key]), none, first);
    const changed = pointed.filter((edge) => !first.includes(edge));
    expect(changed.map((edge) => edge.id)).toContain(key);
    expect(changed.length).toBeLessThan(first.length);
    const back = flowEdges(lines, none, none, pointed);
    expect(back.filter((edge) => !pointed.includes(edge)).map((edge) => edge.id)).toEqual(changed.map((edge) => edge.id));
    expect(flowEdges(lines, none, none, back).every((edge, i) => edge === back[i])).toBe(true);
  });

  it("마우스를 올린 선은 그 선의 진하기에서 한 단계만 올려 그린다", () => {
    const view = lines.views[0];
    const drawnLine = flowEdges(lines, new Set([view.key]), new Set()).find((edge) => edge.id === view.key)!;
    expect(view).toMatchObject({ tone: "muted", opacity: HALF });
    expect(drawnLine.data).toMatchObject({ pointed: true, tone: "muted", opacity: 1 });
  });
});

describe("flowEdges: 시점 비교", () => {
  const { graph } = compareFixture;
  const compare = compared(graph, compareFixture);
  const seen = shown(graph, { ...toggles, collapsed: new Set(), flow: null, lit: null, compare });
  const places = new Map([...seen.nodes].map((id, i) => [id, { x: i * 100, y: 0, width: 40, height: 20 }] as const));
  const all = edgeViews(drawn(graph, seen, null, null, null, compare.gone.edges), { positions: new Map(), sizes: new Map(), boxes: places, routes: new Map(), lane: 12 }, nodeIndex(graph));
  const key = "agg|pkg.old|pkg.mod";

  it("삭제된 관계만 든 선은 마우스를 올려도 진하기를 올리지 않고 점을 그릴 곳을 받는다", () => {
    const view = all.views.find((v) => v.key === key)!;
    expect(view).toMatchObject({ gone: true, tone: "muted", opacity: DIM });
    const line = flowEdges(all, new Set([key]), new Set()).find((edge) => edge.id === key)!;
    expect(line.data).toMatchObject({ pointed: true, tone: "muted", opacity: DIM });
    const stem = all.trunks.find((trunk) => trunk.keys.includes(key) && trunk.end === "in");
    expect((line.data as { dot: unknown }).dot).toEqual(view.mark ?? stem?.mark ?? null);
    expect((line.data as { dot: unknown }).dot).not.toBeNull();
  });

  it("삭제된 관계가 없는 선은 점을 받지 않는다", () => {
    const lines = flowEdges(all, new Set(), new Set()).filter((edge) => edge.type === "orthogonal" && edge.id !== key);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every((edge) => (edge.data as { dot: unknown }).dot === null)).toBe(true);
  });
});
