import { describe, expect, it } from "vitest";
import { flight, pace, RAMP_MS, RHO, SPEED } from "./flight";
import { ZOOM_MIN, type View } from "./viewport";

const room = { x: 0, y: 0, width: 1000, height: 600 };
/** 확대 비율 zoom에서 room의 가운데가 그래프 좌표 (x, y)를 보는 화면 */
const looking = (x: number, y: number, zoom: number): View => ({ x: 500 - x * zoom, y: 300 - y * zoom, zoom });
/** 화면 이동을 steps 등분한 시각마다의 화면 */
const frames = (from: View, to: View, steps = 200, rolling = false) => {
  const path = flight(from, to, room, rolling);
  return Array.from({ length: steps + 1 }, (_, i) => path.at((path.ms * i) / steps));
};

describe("pace", () => {
  const cruise = 0.002;

  it("긴 경로는 순항 속도로 걷는 시간에 RAMP_MS를 더한 시간이 걸린다", () => {
    expect(pace(4, cruise, false).ms).toBeCloseTo(4 / cruise + RAMP_MS);
  });

  it("순항 속도에 이르지 못하는 짧은 경로는 길이의 제곱근에 비례하는 시간이 걸린다", () => {
    const short = pace(0.01, cruise, false).ms;
    expect(short).toBeLessThan(2 * RAMP_MS);
    expect(pace(0.04, cruise, false).ms).toBeCloseTo(2 * short);
  });

  it("걸은 비율이 0에서 1까지 줄지 않고 는다", () => {
    for (const length of [0.01, 0.3, 4]) {
      for (const rolling of [false, true]) {
        const walk = pace(length, cruise, rolling);
        const walked = Array.from({ length: 101 }, (_, i) => walk.at((walk.ms * i) / 100));
        expect(walked[0]).toBe(0);
        expect(walked[100]).toBe(1);
        expect(walked.every((value, i) => i === 0 || value >= walked[i - 1])).toBe(true);
      }
    }
  });

  it("멈춘 화면은 천천히 출발하고 천천히 멈춘다", () => {
    const walk = pace(4, cruise, false);
    const first = walk.at(10);
    const middle = walk.at(walk.ms / 2 + 10) - walk.at(walk.ms / 2);
    const last = 1 - walk.at(walk.ms - 10);
    expect(first).toBeLessThan(middle / 10);
    expect(last).toBeLessThan(middle / 10);
  });

  it("이미 움직이는 화면은 순항 속도로 시작하고 RAMP_MS의 절반만큼 일찍 끝난다", () => {
    const walk = pace(4, cruise, true);
    expect(walk.ms).toBeCloseTo(4 / cruise + RAMP_MS / 2);
    expect(walk.at(10) * 4).toBeCloseTo(cruise * 10);
  });

  it("길이가 0이면 시간이 걸리지 않는다", () => {
    expect(pace(0, cruise, false).ms).toBe(0);
  });
});

describe("flight", () => {
  const from = looking(0, 0, 0.8);

  it("시작 화면은 from이고 끝 화면은 to다", () => {
    for (const to of [looking(200, 100, 0.8), looking(9000, -4000, 0.8), looking(300, 0, 0.3), looking(-20000, 500, 1)]) {
      const path = flight(from, to, room, false);
      const start = path.at(0);
      expect(start.x).toBeCloseTo(from.x);
      expect(start.y).toBeCloseTo(from.y);
      expect(start.zoom).toBeCloseTo(from.zoom);
      expect(path.at(path.ms)).toBe(to);
      expect(path.at(path.ms + 100)).toBe(to);
    }
  });

  it("걸리는 시간이 거리에 따라 늘고, 먼 이동에서는 거리가 두 배가 될 때마다 같은 시간만큼만 는다", () => {
    const ms = [50, 200, 400, 800, 1600, 6400, 12800, 25600, 51200].map((x) => flight(from, looking(x, 0, 0.8), room, false).ms);
    expect(ms.every((value, i) => i === 0 || value > ms[i - 1])).toBe(true);
    const doubled = ((2 * Math.LN2) / (RHO * RHO * SPEED)) * 1000;
    expect(ms[8] - ms[7]).toBeCloseTo(doubled, 0);
    expect(ms[7] - ms[6]).toBeCloseTo(doubled, 0);
  });

  it("to의 가운데가 room 안에 보이는 이동은 확대 비율을 그대로 두고 곧게 옮긴다", () => {
    const to = looking(500, -300, 0.8);
    const seen = frames(from, to);
    expect(seen.every((view) => view.zoom === 0.8)).toBe(true);
    // 그래프 좌표 (500, -300)이 화면의 (900, 60)에서 room의 가운데 (500, 300)까지 직선 위를 간다.
    for (const view of seen) {
      const at = { x: 500 * view.zoom + view.x, y: -300 * view.zoom + view.y };
      expect((at.x - 500) * (60 - 300) - (at.y - 300) * (900 - 500)).toBeCloseTo(0);
    }
  });

  it("to의 가운데가 room 안에 보이고 확대 비율이 다르면 두 비율 사이에서 한 방향으로만 바뀐다", () => {
    const zooms = frames(looking(0, 0, 0.2), looking(1500, 800, 0.8)).map((view) => view.zoom);
    expect(zooms.every((zoom, i) => i === 0 || zoom >= zooms[i - 1])).toBe(true);
    expect(zooms[0]).toBeCloseTo(0.2);
    expect(zooms[zooms.length - 1]).toBe(0.8);
  });

  it("to의 가운데가 room 밖이면 가운데에서 출발·도착보다 축소하고, 멀수록 더 축소한다", () => {
    const lowest = (x: number) => Math.min(...frames(from, looking(x, 0, 0.8)).map((view) => view.zoom));
    expect(lowest(3000)).toBeLessThan(0.8 / 2);
    expect(lowest(9000)).toBeLessThan(lowest(3000) / 2);
  });

  it("가장 축소한 순간에 출발과 도착의 가운데가 room의 짧은 변 안에 함께 보인다", () => {
    const to = looking(0, 9000, 0.8);
    const widest = frames(from, to).reduce((a, b) => (b.zoom < a.zoom ? b : a));
    const start = 0 * widest.zoom + widest.y;
    const end = 9000 * widest.zoom + widest.y;
    expect(start).toBeGreaterThan(room.y);
    expect(end).toBeLessThan(room.y + room.height);
    expect((end - start) / room.height).toBeCloseTo(2 / (RHO * RHO), 1);
  });

  it("확대 비율이 한 번 줄었다가 한 번 늘고, 화면이 가는 방향이 뒤집히지 않는다", () => {
    const seen = frames(from, looking(9000, -4000, 0.8));
    const turn = seen.findIndex((view, i) => i > 0 && view.zoom > seen[i - 1].zoom);
    expect(seen.slice(1, turn).every((view, i) => view.zoom <= seen[i].zoom)).toBe(true);
    expect(seen.slice(turn).every((view, i) => view.zoom >= seen[turn - 1 + i].zoom)).toBe(true);
    const eyes = seen.map((view) => (500 - view.x) / view.zoom);
    expect(eyes.every((x, i) => i === 0 || x >= eyes[i - 1] - 1e-6)).toBe(true);
  });

  it("확대 비율을 ZOOM_MIN보다 줄이지 않는다", () => {
    const seen = frames(from, looking(400000, 0, 0.8));
    expect(Math.min(...seen.map((view) => view.zoom))).toBe(ZOOM_MIN);
    const eyes = seen.map((view) => (500 - view.x) / view.zoom);
    expect(eyes.every((x, i) => i === 0 || x >= eyes[i - 1] - 1e-6)).toBe(true);
  });

  it("같은 화면으로 가면 시간이 걸리지 않는다", () => {
    expect(flight(from, { ...from }, room, false).ms).toBe(0);
  });

  it("이미 움직이는 화면은 같은 거리를 더 짧은 시간에 가고 첫 프레임부터 순항 속도로 간다", () => {
    const to = looking(9000, 0, 0.8);
    const still = flight(from, to, room, false);
    const rolling = flight(from, to, room, true);
    expect(still.ms - rolling.ms).toBeCloseTo(RAMP_MS / 2);
    expect(from.x - rolling.at(16).x).toBeGreaterThan(10 * (from.x - still.at(16).x));
  });
});
