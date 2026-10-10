import { describe, expect, it } from "vitest";
import type { Box, Layout } from "./layout";
import { settled, tween } from "./motion";

/** 최상위 노드만 있는 배치. 부모 기준 좌표와 절대 좌표가 같다. */
function flat(boxes: Record<string, Box>): Layout {
  const entries = Object.entries(boxes);
  return {
    positions: new Map(entries.map(([id, b]) => [id, { x: b.x, y: b.y }])),
    sizes: new Map(entries.map(([id, b]) => [id, { width: b.width, height: b.height }])),
    boxes: new Map(entries),
    routes: new Map(),
  };
}

const from = flat({ a: { x: 0, y: 0, width: 220, height: 40 }, gone: { x: 0, y: 100, width: 220, height: 40 } });
const to = flat({ a: { x: 100, y: 40, width: 420, height: 240 }, fresh: { x: 300, y: 0, width: 80, height: 18 } });

describe("tween", () => {
  it("t가 0이면 두 배치에 모두 있는 노드는 출발 위치와 크기다", () => {
    const start = tween(from, to, 0);
    expect(start.boxes.get("a")).toEqual({ x: 0, y: 0, width: 220, height: 40 });
    expect(start.positions.get("a")).toEqual({ x: 0, y: 0 });
    expect(start.sizes.get("a")).toEqual({ width: 220, height: 40 });
  });

  it("t가 0.5이면 위치와 크기가 가운데 값이다", () => {
    const mid = tween(from, to, 0.5);
    expect(mid.boxes.get("a")).toEqual({ x: 50, y: 20, width: 320, height: 140 });
    expect(mid.positions.get("a")).toEqual({ x: 50, y: 20 });
  });

  it("ease-in-out이므로 앞쪽 4분의 1 시점에는 8분의 1만 움직인다", () => {
    expect(tween(from, to, 0.25).boxes.get("a")!.x).toBeCloseTo(12.5);
    expect(tween(from, to, 0.75).boxes.get("a")!.x).toBeCloseTo(87.5);
  });

  it("t가 1이면 도착 배치를 그대로 돌려준다", () => {
    expect(tween(from, to, 1)).toBe(to);
  });

  it("새로 나타나는 노드는 도착 위치에 두고 사라지는 노드는 담지 않는다", () => {
    const start = tween(from, to, 0);
    expect(start.boxes.get("fresh")).toEqual({ x: 300, y: 0, width: 80, height: 18 });
    expect(start.boxes.has("gone")).toBe(false);
    expect(start.positions.has("gone")).toBe(false);
  });
});

describe("settled", () => {
  it("노드와 위치·크기가 모두 같을 때만 참이다", () => {
    expect(settled(from, flat({ ...Object.fromEntries(from.boxes) }))).toBe(true);
    expect(settled(from, to)).toBe(false);
    expect(settled(from, flat({ a: from.boxes.get("a")! }))).toBe(false);
  });
});
