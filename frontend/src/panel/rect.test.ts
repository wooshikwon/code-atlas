import { describe, expect, it } from "vitest";
import { clamp, initial, MIN_HEIGHT, MIN_WIDTH, move, resize, type Dir } from "./rect";

const area = { width: 1000, height: 800 };
const rect = { x: 400, y: 100, width: 480, height: 420 };

describe("initial", () => {
  it("영역의 오른쪽 가장자리에 붙어 위·오른쪽·아래에 8px를 두고 위에서 아래까지 찬다", () => {
    expect(initial(area)).toEqual({ x: 1000 - 480 - 8, y: 8, width: 480, height: 800 - 16 });
    expect(initial({ width: 1000, height: 600 })).toMatchObject({ y: 8, height: 600 - 16 });
  });

  it("영역이 기본 폭보다 좁거나 최소 높이보다 낮으면 clamp가 맞춘다", () => {
    expect(initial({ width: 400, height: 800 })).toMatchObject({ width: 400, height: 784 });
    expect(initial({ width: 1000, height: 40 })).toMatchObject({ y: 0, height: MIN_HEIGHT });
  });
});

describe("move", () => {
  it("옮긴 만큼 위치가 바뀌고 크기는 그대로다", () => {
    expect(move(rect, -30, 50, area)).toEqual({ x: 370, y: 150, width: 480, height: 420 });
  });

  it("머리 줄이 가로 60px, 세로 40px 이상 영역 안에 남는다", () => {
    expect(move(rect, -5000, -5000, area)).toMatchObject({ x: 60 - 480, y: 0 });
    expect(move(rect, 5000, 5000, area)).toMatchObject({ x: 1000 - 60, y: 800 - 40 });
  });
});

describe("resize", () => {
  const cases: [Dir, { x: number; y: number; width: number; height: number }][] = [
    ["n", { x: 400, y: 80, width: 480, height: 440 }],
    ["s", { x: 400, y: 100, width: 480, height: 400 }],
    ["e", { x: 400, y: 100, width: 490, height: 420 }],
    ["w", { x: 410, y: 100, width: 470, height: 420 }],
    ["ne", { x: 400, y: 80, width: 490, height: 440 }],
    ["nw", { x: 410, y: 80, width: 470, height: 440 }],
    ["se", { x: 400, y: 100, width: 490, height: 400 }],
    ["sw", { x: 410, y: 100, width: 470, height: 400 }],
  ];

  it.each(cases)("%s 손잡이는 그 쪽 가장자리만 옮긴다", (dir, expected) => {
    expect(resize(rect, dir, 10, -20, area)).toEqual(expected);
  });

  it("왼쪽 손잡이는 최소 폭에 닿으면 위치도 멈춘다", () => {
    expect(resize(rect, "w", 5000, 0, area)).toEqual({ ...rect, x: 400 + 480 - MIN_WIDTH, width: MIN_WIDTH });
  });

  it("위쪽 손잡이는 최소 높이에 닿으면 위치도 멈춘다", () => {
    expect(resize(rect, "n", 0, 5000, area)).toEqual({ ...rect, y: 100 + 420 - MIN_HEIGHT, height: MIN_HEIGHT });
  });

  it("왼쪽 위 모서리는 두 방향 모두 최소 크기에서 멈춘다", () => {
    expect(resize(rect, "nw", 5000, 5000, area)).toEqual({
      x: 400 + 480 - MIN_WIDTH,
      y: 100 + 420 - MIN_HEIGHT,
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
    });
  });

  it("오른쪽·아래쪽 손잡이는 최소 크기보다 줄지 않고 위치는 그대로다", () => {
    expect(resize(rect, "se", -5000, -5000, area)).toEqual({ ...rect, width: MIN_WIDTH, height: MIN_HEIGHT });
  });

  it("끄는 가장자리는 영역 밖으로 나가지 않는다", () => {
    expect(resize(rect, "se", 5000, 5000, area)).toEqual({ ...rect, width: 600, height: 700 });
    expect(resize(rect, "nw", -5000, -5000, area)).toEqual({ x: 0, y: 0, width: 880, height: 520 });
  });
});

describe("clamp", () => {
  it("영역 안에 든 사각형은 그대로 둔다", () => {
    expect(clamp(rect, area)).toEqual(rect);
  });

  it("영역이 줄면 머리 줄이 남는 위치로 옮긴다", () => {
    expect(clamp(rect, { width: 300, height: 120 })).toMatchObject({ x: 300 - 60, y: 120 - 40 });
  });

  it("영역보다 큰 크기는 영역 크기로, 최소 크기보다 작은 크기는 최소 크기로 바꾼다", () => {
    expect(clamp({ x: 0, y: 0, width: 2000, height: 2000 }, area)).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    expect(clamp({ x: 0, y: 0, width: 10, height: 10 }, { width: 100, height: 30 })).toMatchObject({
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
    });
  });
});
