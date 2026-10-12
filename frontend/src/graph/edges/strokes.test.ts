import { describe, expect, it } from "vitest";
import { cornerRadii, pathOf, split } from "./strokes";

const line = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
];
const whole = pathOf(line, cornerRadii(line, 4));

/** 경로 d의 M 뒤 좌표 */
const starts = (d: string) => [...d.matchAll(/M([-\d.]+),([-\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));

describe("split", () => {
  it("덮는 장식이 없으면 경로를 그대로 둔다", () => {
    expect(split([line], [], 0, 4)).toEqual({ d: whole, parts: [] });
  });

  it("화살촉은 끝에서 그 길이만큼을 장식 묶음으로 옮기고 긴 선과 토막을 이으면 처음 경로다", () => {
    const cut = split([line], [{ piece: 0, tail: 15 }], 0, 4);
    expect(cut.parts).toEqual([{ covers: [0], d: "M100,45 L100,60", tip: true }]);
    expect(cut.d).toBe("M0,0 L96,0 Q100,0 100,4 L100,45");
  });

  it("모서리의 곡선 안에서는 가르지 않는다", () => {
    const cut = split([line], [{ box: { x: 97, y: -2, width: 6, height: 4 } }], 0, 4);
    expect(cut.d).toBe("M0,0 L96,0 M100,4 L100,60");
    expect(cut.parts[0].d).toBe("M96,0 L96,0 Q100,0 100,4 L100,4");
  });

  it("점선은 둥글린 경로의 길이가 주기의 배수인 곳에서 가른다", () => {
    const cut = split([line], [{ box: { x: 40, y: -2, width: 10, height: 4 } }], 8, 4);
    expect(starts(cut.parts[0].d)).toEqual([{ x: 40, y: 0 }]);
    expect(cut.d.startsWith("M0,0 L40,0 M56,0")).toBe(true);
  });

  it("겹치는 장식과 여러 묶음에 걸친 장식을 한 묶음으로 모은다", () => {
    const branch = [
      { x: 50, y: 30 },
      { x: 50, y: 0 },
    ];
    const joint = { box: { x: 47, y: -3, width: 6, height: 6 } };
    const number = { box: { x: 52, y: -7, width: 18, height: 14 } };
    const cut = split([line, branch], [joint, number, { piece: 0, tail: 15 }], 0, 4);
    expect(cut.parts.map((part) => part.covers)).toEqual([[0, 1], [2]]);
    expect(starts(cut.parts[0].d)).toEqual([
      { x: 47, y: 0 },
      { x: 50, y: 3 },
    ]);
    expect(cut.parts[1].tip).toBe(true);
  });

  it("짧은 묶음이 통째로 덮이면 긴 선에 남기지 않는다", () => {
    const short = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const cut = split([short], [{ piece: 0, tail: 15 }], 0, 4);
    expect(cut.d).toBe("");
    expect(cut.parts[0].d).toBe("M0,0 L10,0");
  });
});
