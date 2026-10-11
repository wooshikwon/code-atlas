import { describe, expect, it } from "vitest";
import { boundsOf, centerOn, fitPadding, frameOn, freeRect } from "./viewport";

const area = { x: 0, y: 0, width: 1400, height: 900 };

describe("freeRect", () => {
  it("패널이 오른쪽 위에 있으면 패널 왼쪽 사각형이다", () => {
    expect(freeRect(area, [{ x: 912, y: 8, width: 480, height: 420 }])).toEqual({ x: 0, y: 0, width: 912, height: 900 });
  });

  it("패널이 왼쪽에 있으면 패널 오른쪽 사각형이다", () => {
    expect(freeRect(area, [{ x: 8, y: 8, width: 400, height: 800 }])).toEqual({ x: 408, y: 0, width: 992, height: 900 });
  });

  it("패널이 위쪽을 가로로 덮으면 패널 아래 사각형이다", () => {
    expect(freeRect(area, [{ x: 100, y: 0, width: 1200, height: 300 }])).toEqual({ x: 0, y: 300, width: 1400, height: 600 });
  });

  it("패널이 없거나 영역 밖에 있으면 영역 전체다", () => {
    expect(freeRect(area, [])).toEqual(area);
    expect(freeRect(area, [{ x: 1500, y: 0, width: 300, height: 300 }])).toEqual(area);
  });

  it("패널이 오른쪽에, 왼쪽 아래 칸이 아래에 있으면 둘을 모두 피하는 가장 넓은 사각형이다", () => {
    const panel = { x: 912, y: 8, width: 480, height: 884 };
    const minimap = { x: 12, y: 700, width: 220, height: 140 };
    const buttons = { x: 12, y: 854, width: 118, height: 34 };
    expect(freeRect(area, [panel, minimap, buttons])).toEqual({ x: 0, y: 0, width: 912, height: 700 });
    const finder = { x: 240, y: 300, width: 330, height: 540 };
    expect(freeRect(area, [panel, minimap, buttons, finder])).toEqual({ x: 570, y: 0, width: 342, height: 900 });
  });

  it("가리는 칸이 영역을 모두 덮으면 영역 전체다", () => {
    expect(freeRect(area, [{ x: -10, y: -10, width: 2000, height: 2000 }])).toEqual(area);
  });

  it("영역 밖으로 나간 패널은 영역 안쪽 부분만 뺀다", () => {
    expect(freeRect(area, [{ x: 1000, y: -100, width: 600, height: 500 }])).toEqual({ x: 0, y: 0, width: 1000, height: 900 });
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
    const free = freeRect(area, [{ x: 912, y: 8, width: 480, height: 420 }]);
    expect(fitPadding({ area, free, clear: free })).toEqual({ top: "24px", right: "512px", bottom: "24px", left: "24px" });
  });

  it("패널이 왼쪽에 있으면 왼쪽을 패널 오른쪽 끝까지 비운다", () => {
    const free = freeRect(area, [{ x: 8, y: 8, width: 400, height: 800 }]);
    expect(fitPadding({ area, free, clear: free })).toEqual({ top: "24px", right: "24px", bottom: "24px", left: "432px" });
  });

  it("패널이 없으면 네 변을 24px씩 비운다", () => {
    expect(fitPadding({ area, free: area, clear: area })).toEqual({ top: "24px", right: "24px", bottom: "24px", left: "24px" });
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

describe("frameOn", () => {
  const clear = { x: 0, y: 0, width: 900, height: 600 };
  const from = { x: 100, y: 100, width: 120, height: 18 };

  it("경로 위 상자가 모두 영역에 들어가면 그 상자를 품는 사각형을 영역의 가운데에 둔다", () => {
    const via = { x: 300, y: 150, width: 80, height: 18 };
    const to = { x: 500, y: 300, width: 100, height: 18 };
    expect(frameOn([from, via, to], to, clear, 1)).toEqual({ x: 450 - 350, y: 300 - 209, zoom: 1 });
  });

  it("확대 비율이 0.8보다 작으면 0.8로 키우고 그보다 크면 그대로 둔다", () => {
    const to = { x: 300, y: 200, width: 100, height: 18 };
    expect(frameOn([from, to], to, clear, 0.3).zoom).toBe(0.8);
    expect(frameOn([from, to], to, clear, 1.5).zoom).toBe(1.5);
  });

  it("경로 위 상자가 영역에 들어가지 않으면 경로의 시작 끝을 맞춘 뒤 초점 상자가 20px 안쪽에 들어올 만큼만 옮긴다", () => {
    const to = { x: 2000, y: 100, width: 100, height: 18 };
    // 가로는 경로가 영역보다 길어 왼쪽 끝을 맞추고, 도착 상자의 오른쪽 끝이 영역의 오른쪽 20px 안쪽에 오게 옮긴다.
    expect(frameOn([from, to], to, clear, 1)).toEqual({ x: 900 - 20 - 2100, y: 300 - 109, zoom: 1 });
    // 출발 상자는 왼쪽 끝을 맞춘 화면에 이미 들어 있다.
    expect(frameOn([from, to], from, clear, 0.5)).toEqual({ x: 20 - 80, y: 300 - 109 * 0.8, zoom: 0.8 });
  });

  it("출발과 도착은 들어가도 그 사이의 상자가 영역 밖이면 초점 상자가 들어올 만큼만 옮긴다", () => {
    const via = { x: 300, y: 1500, width: 80, height: 18 };
    const to = { x: 500, y: 300, width: 100, height: 18 };
    // 세로는 경로가 영역보다 길어 위 끝을 맞추고, 그 화면에 도착 상자가 들어 있다.
    expect(frameOn([from, via, to], to, clear, 1)).toEqual({ x: 450 - 350, y: 20 - 100, zoom: 1 });
    expect(frameOn([from, via, to], via, clear, 1)).toEqual({ x: 450 - 350, y: 600 - 20 - 1518, zoom: 1 });
  });
});
