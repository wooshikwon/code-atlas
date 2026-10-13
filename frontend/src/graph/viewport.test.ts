import { describe, expect, it } from "vitest";
import { anchorOn, autoView, bottomSpan, boundsOf, centerOn, fitIn, frameOn, freeRect, nearest } from "./viewport";

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

describe("bottomSpan", () => {
  const buttons = { x: 12, y: 854, width: 118, height: 34 };

  it("버튼 줄과 패널 사이의 구간이다. 띠 위에 있는 미니맵은 덮지 않는다", () => {
    const panel = { x: 912, y: 8, width: 480, height: 884 };
    const minimap = { x: 12, y: 700, width: 220, height: 140 };
    expect(bottomSpan(area, [panel, minimap, buttons], 34, 12)).toEqual({ x: 130, width: 782 });
  });

  it("패널이 띠 위에서 끝나면 버튼 줄 오른쪽 전부다", () => {
    expect(bottomSpan(area, [{ x: 912, y: 8, width: 480, height: 420 }, buttons], 34, 12)).toEqual({ x: 130, width: 1270 });
  });

  it("패널이 띠의 가운데를 덮으면 양쪽 가운데 넓은 구간이다", () => {
    expect(bottomSpan(area, [{ x: 300, y: 500, width: 500, height: 392 }, buttons], 34, 12)).toEqual({ x: 800, width: 600 });
  });

  it("띠를 모두 덮으면 폭이 0이다", () => {
    expect(bottomSpan(area, [{ x: 0, y: 500, width: 1400, height: 400 }], 34, 12).width).toBe(0);
    expect(bottomSpan(area, [{ x: 0, y: 500, width: 700, height: 400 }, { x: 700, y: 800, width: 700, height: 100 }], 34, 12).width).toBe(0);
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

describe("anchorOn", () => {
  it("상자가 옮겨 간 만큼 화면을 옮겨 왼쪽 위 모서리를 화면의 같은 좌표에 두고 확대 비율은 그대로 둔다", () => {
    const view = { x: 100, y: 50, zoom: 0.5 };
    const next = anchorOn({ x: 200, y: 300 }, { x: 260, y: 280 }, view);
    expect(next).toEqual({ x: 70, y: 60, zoom: 0.5 });
    expect([260 * next.zoom + next.x, 280 * next.zoom + next.y]).toEqual([200 * view.zoom + view.x, 300 * view.zoom + view.y]);
  });
});

describe("autoView", () => {
  const free = { x: 10, y: 30, width: 900, height: 600 };

  it("전체를 맞춘 확대 비율이 이름표가 읽히는 값 이상이면 그 화면을 쓴다", () => {
    const whole = { x: 40, y: 50, zoom: 0.8 };
    expect(autoView(whole, { x: 100, y: 200 }, free)).toBe(whole);
  });

  it("그보다 작으면 확대 비율을 0.8에 두고 가리킨 모서리를 빈 사각형의 왼쪽 위에서 24px 안쪽에 놓는다", () => {
    const view = autoView({ x: 40, y: 50, zoom: 0.38 }, { x: 100, y: 200 }, free);
    expect(view.zoom).toBe(0.8);
    expect([100 * view.zoom + view.x, 200 * view.zoom + view.y]).toEqual([34, 54]);
  });
});

describe("fitIn", () => {
  const free = freeRect(area, [{ x: 912, y: 8, width: 480, height: 884 }]);

  it("확대 비율이 100%에서 멈추는 작은 상자도 가운데를 빈 사각형의 가운데에 놓는다", () => {
    const view = fitIn({ x: 40, y: 20, width: 100, height: 160 }, free);
    expect(view.zoom).toBe(1);
    expect([90 * view.zoom + view.x, 100 * view.zoom + view.y]).toEqual([456, 450]);
  });

  it("빈 사각형보다 큰 상자는 네 변에서 24px 안쪽에 들어오게 줄이고 가운데를 맞춘다", () => {
    const view = fitIn({ x: 0, y: 0, width: 1728, height: 600 }, free);
    expect(view.zoom).toBe(0.5);
    expect([view.x, 1728 * view.zoom + view.x]).toEqual([24, 888]);
    expect(300 * view.zoom + view.y).toBe(450);
  });

  it("패널이 없으면 영역 전체의 가운데에 놓는다", () => {
    const view = fitIn({ x: 0, y: 0, width: 200, height: 100 }, area);
    expect([100 * view.zoom + view.x, 50 * view.zoom + view.y]).toEqual([700, 450]);
  });

  it("확대 비율을 5% 아래로 줄이지 않는다", () => {
    expect(fitIn({ x: 0, y: 0, width: 100000, height: 100 }, free).zoom).toBe(0.05);
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
  const origin = { x: 0, y: 0, zoom: 1 };

  it("경로 위 상자가 모두 영역에 들어가면 그 상자를 품는 사각형을 영역의 가운데에 둔다", () => {
    const via = { x: 300, y: 150, width: 80, height: 18 };
    const to = { x: 500, y: 300, width: 100, height: 18 };
    expect(frameOn([from, via, to], boundsOf([from, via]), from, clear, origin, true)).toEqual({ x: 450 - 350, y: 300 - 209, zoom: 1 });
  });

  it("확대 비율이 0.8보다 작으면 0.8로 키우고 그보다 크면 그대로 둔다", () => {
    const to = { x: 300, y: 200, width: 100, height: 18 };
    const step = boundsOf([from, to]);
    expect(frameOn([from, to], step, from, clear, { ...origin, zoom: 0.3 }, true).zoom).toBe(0.8);
    expect(frameOn([from, to], step, from, clear, { ...origin, zoom: 1.5 }, true).zoom).toBe(1.5);
  });

  it("경로가 영역보다 길면 경로의 시작 끝을 맞추고, 그 화면에 출발 상자와 다음 상자가 들어 있으면 더 옮기지 않는다", () => {
    const via = { x: 400, y: 100, width: 80, height: 18 };
    const to = { x: 2000, y: 100, width: 100, height: 18 };
    expect(frameOn([from, via, to], boundsOf([from, via]), from, clear, origin, true)).toEqual({ x: 20 - 100, y: 300 - 109, zoom: 1 });
  });

  it("지금 화면에 초점 상자와 다음 상자가 들어 있으면 화면을 옮기지 않는다", () => {
    const via = { x: 400, y: 300, width: 80, height: 18 };
    const to = { x: 2000, y: 100, width: 100, height: 18 };
    const view = { x: 37, y: -11, zoom: 1.2 };
    expect(frameOn([from, via, to], boundsOf([from, via]), from, clear, view, false)).toEqual(view);
  });

  it("초점 상자와 다음 상자가 화면을 벗어난 축은 두 상자를 품는 사각형을 영역의 가운데에 둔다", () => {
    const via = { x: 400, y: 100, width: 80, height: 18 };
    const to = { x: 1000, y: 100, width: 100, height: 18 };
    const far = { x: 1400, y: 500, width: 100, height: 18 };
    // 가로는 벗어났으므로 두 상자의 가운데(750)를 영역의 가운데에 두고, 세로는 들어 있으므로 그대로 둔다.
    expect(frameOn([from, via, to], boundsOf([via, to]), via, clear, { x: -80, y: 191, zoom: 1 }, false)).toEqual({
      x: 450 - 750,
      y: 191,
      zoom: 1,
    });
    // 두 축을 모두 벗어나면 두 축 모두 가운데에 둔다.
    expect(frameOn([from, to, far], boundsOf([to, far]), to, clear, { x: 0, y: -300, zoom: 1 }, false)).toEqual({
      x: 450 - 1250,
      y: 300 - 309,
      zoom: 1,
    });
  });

  it("초점 상자와 다음 상자가 영역에 함께 들어가지 않으면 초점 상자만 영역의 가운데에 둔다", () => {
    const to = { x: 2000, y: 100, width: 100, height: 18 };
    expect(frameOn([from, to], boundsOf([from, to]), to, clear, origin, false)).toEqual({ x: 450 - 2050, y: 0, zoom: 1 });
  });

  it("확대 비율을 키웠으면 경로의 시작 끝을 맞춘 화면에서 판정한다", () => {
    const via = { x: 400, y: 100, width: 80, height: 18 };
    const to = { x: 2000, y: 100, width: 100, height: 18 };
    expect(frameOn([from, via, to], boundsOf([from, via]), from, clear, { x: -5000, y: -5000, zoom: 0.2 }, false)).toEqual({
      x: 20 - 80,
      y: 300 - 109 * 0.8,
      zoom: 0.8,
    });
  });
});

describe("nearest", () => {
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it("점을 품은 상자 가운데 가장 작은 상자를 고른다", () => {
    const boxes: [string, ReturnType<typeof box>][] = [["folder", box(0, 0, 400, 300)], ["file", box(40, 40, 200, 100)], ["far", box(600, 0, 50, 50)]];
    expect(nearest(boxes, { x: 100, y: 80 })).toBe("file");
    expect(nearest(boxes, { x: 300, y: 250 })).toBe("folder");
  });

  it("점을 품은 상자가 없으면 변까지의 거리가 가장 짧은 상자를 고르고, 상자가 없으면 null이다", () => {
    const boxes: [string, ReturnType<typeof box>][] = [["left", box(0, 0, 100, 100)], ["right", box(300, 0, 100, 100)]];
    expect(nearest(boxes, { x: 180, y: 50 })).toBe("left");
    expect(nearest(boxes, { x: 230, y: 400 })).toBe("right");
    expect(nearest([], { x: 0, y: 0 })).toBeNull();
  });

  it("reach를 주면 변까지의 거리가 그 값을 넘는 상자를 고르지 않는다", () => {
    const boxes: [string, ReturnType<typeof box>][] = [["left", box(0, 0, 100, 100)], ["right", box(300, 0, 100, 100)]];
    expect(nearest(boxes, { x: 120, y: 50 }, 20)).toBe("left");
    expect(nearest(boxes, { x: 121, y: 50 }, 20)).toBeNull();
    expect(nearest(boxes, { x: 350, y: 50 }, 0)).toBe("right");
  });
});
