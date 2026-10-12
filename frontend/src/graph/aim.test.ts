import { describe, expect, it } from "vitest";
import { linesAt, sameTarget } from "./aim";
import { NO_TRUNKS, type EdgeView } from "./view";

const view = (key: string, target: string, points: [number, number][]): EdgeView => {
  const path = points.map(([x, y]) => ({ x, y }));
  return { key, source: key, target, group: "run", points: path, tone: "muted", opacity: 0.5, into: null, sites: 1, kinds: { call: 1 }, route: null, via: false, joins: true, below: false, branch: path, trunks: NO_TRUNKS };
};
/** a, b, c는 t로 들어가며 x=100의 세로 줄에 차례로 붙는다. d는 a와 출발 직후의 구간만 함께 지나 u로 간다. */
const a = view("a", "t", [[0, 0], [100, 0], [100, 50], [120, 50]]);
const b = view("b", "t", [[0, 20], [100, 20], [100, 50], [120, 50]]);
const c = view("c", "t", [[0, 90], [100, 90], [100, 50], [120, 50]]);
const d = view("d", "u", [[0, 0], [40, 0], [40, 200], [120, 200]]);
const all = [a, b, c, d];
const keys = (at: [number, number]) => linesAt(all, { x: at[0], y: at[1] }).map((v) => v.key);

describe("linesAt", () => {
  it("한 선만 지나는 구간에서는 그 선 하나다", () => {
    expect(keys([60, 20])).toEqual(["b"]);
    expect(keys([40, 120])).toEqual(["d"]);
  });

  it("도착 노드 앞의 줄기에서는 그 구간을 지나는 선 전부다", () => {
    expect(keys([110, 50])).toEqual(["a", "b", "c"]);
  });

  it("줄기 가운데 일부 선만 지나는 구간에서는 그 선만이다", () => {
    expect(keys([100, 10])).toEqual(["a"]);
    expect(keys([100, 35])).toEqual(["a", "b"]);
    expect(keys([100, 70])).toEqual(["c"]);
  });

  it("도착이 다른 선이 함께 지나는 구간에서는 그 선들이다", () => {
    expect(keys([20, 0])).toEqual(["a", "d"]);
  });

  it("누름 영역의 절반 폭 6px 안을 지나는 선만 센다", () => {
    expect(keys([60, 26])).toEqual(["b"]);
    expect(keys([60, 27])).toEqual([]);
    expect(linesAt(all, { x: 60, y: 10 }, 10).map((v) => v.key)).toEqual(["a", "b"]);
  });
});

describe("sameTarget", () => {
  it("도착 노드가 모두 같으면 그 노드이고, 둘 이상이거나 선이 없으면 null이다", () => {
    expect(sameTarget([a, b, c])).toBe("t");
    expect(sameTarget([a])).toBe("t");
    expect(sameTarget([a, d])).toBeNull();
    expect(sameTarget([])).toBeNull();
  });
});
