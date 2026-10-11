import { describe, expect, it } from "vitest";
import { repoFixture } from "../fixture";
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
});
