import { describe, expect, it } from "vitest";
import { boundsOf, centerOn, fitOn, fitPadding, freeRect, freeRects } from "./viewport";

const area = { x: 0, y: 0, width: 1400, height: 900 };

describe("freeRect", () => {
  it("패널이 오른쪽 위에 있으면 패널 왼쪽 사각형이다", () => {
    expect(freeRect(area, { x: 912, y: 8, width: 480, height: 420 })).toEqual({ x: 0, y: 0, width: 912, height: 900 });
  });

  it("패널이 왼쪽에 있으면 패널 오른쪽 사각형이다", () => {
    expect(freeRect(area, { x: 8, y: 8, width: 400, height: 800 })).toEqual({ x: 408, y: 0, width: 992, height: 900 });
  });

  it("패널이 위쪽을 가로로 덮으면 패널 아래 사각형이다", () => {
    expect(freeRect(area, { x: 100, y: 0, width: 1200, height: 300 })).toEqual({ x: 0, y: 300, width: 1400, height: 600 });
  });

  it("패널이 없거나 영역 밖에 있으면 영역 전체다", () => {
    expect(freeRect(area, null)).toEqual(area);
    expect(freeRect(area, { x: 1500, y: 0, width: 300, height: 300 })).toEqual(area);
  });

  it("영역 밖으로 나간 패널은 영역 안쪽 부분만 뺀다", () => {
    expect(freeRect(area, { x: 1000, y: -100, width: 600, height: 500 })).toEqual({ x: 0, y: 0, width: 1000, height: 900 });
  });
});

describe("centerOn", () => {
  const free = { x: 0, y: 0, width: 900, height: 900 };

  it("상자의 중심을 free의 중심에 맞춘다", () => {
    const { x, y } = centerOn({ x: 400, y: 200, width: 220, height: 40 }, free, 0.5);
    expect((400 + 110) * 0.5 + x).toBe(450);
    expect((200 + 20) * 0.5 + y).toBe(450);
  });

  it("free가 원점에서 떨어져 있으면 그만큼 옮긴다", () => {
    const { x, y } = centerOn({ x: 0, y: 0, width: 100, height: 100 }, { x: 408, y: 300, width: 992, height: 600 }, 1);
    expect(50 + x).toBe(408 + 496);
    expect(50 + y).toBe(300 + 300);
  });

  it("free보다 큰 상자는 왼쪽 위를 free의 왼쪽 위에서 20px 안쪽에 맞춘다", () => {
    const { x, y } = centerOn({ x: 300, y: 100, width: 1000, height: 1200 }, free, 1);
    expect(300 + x).toBe(20);
    expect(100 + y).toBe(20);
  });

  it("한 축만 넘치면 그 축만 끝을 맞추고 다른 축은 가운데에 둔다", () => {
    const { x, y } = centerOn({ x: 300, y: 100, width: 1000, height: 200 }, free, 1);
    expect(300 + x).toBe(20);
    expect(100 + 100 + y).toBe(450);
  });
});

describe("fitPadding", () => {
  it("패널이 오른쪽 위에 있으면 오른쪽을 패널 왼쪽 끝까지 비운다", () => {
    const free = freeRect(area, { x: 912, y: 8, width: 480, height: 420 });
    expect(fitPadding({ area, free })).toEqual({ top: "24px", right: "512px", bottom: "24px", left: "24px" });
  });

  it("패널이 왼쪽에 있으면 왼쪽을 패널 오른쪽 끝까지 비운다", () => {
    const free = freeRect(area, { x: 8, y: 8, width: 400, height: 800 });
    expect(fitPadding({ area, free })).toEqual({ top: "24px", right: "24px", bottom: "24px", left: "432px" });
  });

  it("패널이 없으면 네 변을 24px씩 비운다", () => {
    expect(fitPadding({ area, free: area })).toEqual({ top: "24px", right: "24px", bottom: "24px", left: "24px" });
  });
});

describe("boundsOf", () => {
  it("상자를 모두 품는 사각형을 낸다", () => {
    const boxes = [
      { x: 10, y: 40, width: 100, height: 20 },
      { x: -30, y: 50, width: 20, height: 90 },
    ];
    expect(boundsOf(boxes)).toEqual({ x: -30, y: 40, width: 140, height: 100 });
  });

  it("상자가 없으면 크기가 0이다", () => {
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("freeRects", () => {
  it("패널의 왼쪽·오른쪽·위·아래 사각형을 낸다", () => {
    expect(freeRects(area, { x: 912, y: 8, width: 480, height: 420 })).toEqual([
      { x: 0, y: 0, width: 912, height: 900 },
      { x: 1392, y: 0, width: 8, height: 900 },
      { x: 0, y: 0, width: 1400, height: 8 },
      { x: 0, y: 428, width: 1400, height: 472 },
    ]);
  });

  it("패널이 없거나 영역 밖에 있으면 영역 전체 하나다", () => {
    expect(freeRects(area, null)).toEqual([area]);
    expect(freeRects(area, { x: 1500, y: 0, width: 300, height: 300 })).toEqual([area]);
  });
});

describe("fitOn", () => {
  const sides = freeRects(area, { x: 912, y: 8, width: 480, height: 420 });
  const anchor = { x: 100, y: 100, width: 200, height: 20 };
  /** (100, 100)에서 2600×300인 묶음. 왼쪽 사각형에는 864/2600, 아래 사각형에는 1352/2600 = 0.52에서 들어온다. */
  const wide = [anchor, { x: 2600, y: 300, width: 100, height: 100 }];

  it("사용자 확대 비율에서 여러 사각형에 들어오면 넓은 사각형 가운데로 옮긴다", () => {
    const boxes = [anchor, { x: 500, y: 300, width: 100, height: 100 }];
    // 묶음은 (100, 100)에서 500×300이고 중심은 (350, 250)이다. 왼쪽 사각형의 중심은 (456, 450)이다.
    expect(fitOn(boxes, anchor, sides, 1)).toEqual({ x: 456 - 350, y: 450 - 250, zoom: 1 });
  });

  it("묶음이 가장 크게 들어오는 사각형을 고르고 24px를 두고 들어올 때까지 줄인다", () => {
    const view = fitOn(wide, anchor, sides, 1);
    expect(view.zoom).toBeCloseTo(0.52);
    expect(view.x).toBeCloseTo(700 - 1400 * 0.52);
    expect(view.y).toBeCloseTo(428 + 236 - 250 * 0.52);
  });

  it("사용자 확대 비율을 넘지 않는다", () => {
    const view = fitOn(wide, anchor, sides, 0.45);
    expect(view.zoom).toBe(0.45);
    expect(view.x).toBeCloseTo(700 - 1400 * 0.45);
  });

  it("어느 사각형에도 0.4에서 들어오지 않으면 가장 넓은 사각형 가운데에 anchor를 0.4로 둔다", () => {
    const boxes = [anchor, { x: 9000, y: 9000, width: 100, height: 100 }];
    expect(fitOn(boxes, anchor, sides, 1)).toEqual({ x: 456 - 200 * 0.4, y: 450 - 110 * 0.4, zoom: 0.4 });
  });

  it("사용자 확대 비율이 0.4보다 작으면 확대 비율을 바꾸지 않는다", () => {
    const far = [anchor, { x: 9000, y: 9000, width: 100, height: 100 }];
    expect(fitOn(far, anchor, sides, 0.2)).toEqual({ x: 456 - 200 * 0.2, y: 450 - 110 * 0.2, zoom: 0.2 });
    const view = fitOn(wide, anchor, sides, 0.2);
    expect(view.zoom).toBe(0.2);
    expect(view.x).toBeCloseTo(456 - 1400 * 0.2);
  });
});
