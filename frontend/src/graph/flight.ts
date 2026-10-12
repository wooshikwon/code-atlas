// 화면 이동. 지금 화면에서 도착 화면까지 가는 경로와 걸리는 시간을 두 화면 사이의 거리에서 정하고, 그 경로를 프레임마다 그린다.
// 코드가 화면을 옮기는 호출은 모두 `useFlight`가 돌려주는 함수를 지난다. 사용자가 끄는 이동과 휠 확대는 React Flow가 맡는다.
import { useReactFlow } from "@xyflow/react";
import { useMemo } from "react";
import { create } from "zustand";
import type { Rect } from "../state/store";
import { reducedMotion } from "./motion";
import { fitIn, stageOf, ZOOM_MIN, type View } from "./viewport";

/**
 * 화면이 옆으로 움직이는 순항 속도. 1초에 기준 사각형의 짧은 변 몇 개만큼 가는지다. 화면 이동이 빠르거나 느리면 이 값을 바꾼다.
 * 먼 이동은 축소한 채로 가므로 거리가 두 배가 될 때마다 시간이 2·ln2 ÷ (ρ² × SPEED)초(0.37초)씩만 는다.
 */
export const SPEED = 1.5;
/**
 * 먼 이동이 가운데에서 얼마나 축소하는지를 정하는 값 ρ(van Wijk·Nuij, "Smooth and efficient zooming and panning").
 * 출발과 도착의 확대 비율이 같고 두 화면의 가운데가 짧은 변 d개만큼 떨어져 있으면 가장 축소한 순간에 보이는 폭이 √(1 + (ρ²d/2)²)배가 된다.
 * 먼 이동에서 이 폭은 ρ²d/2이고 출발과 도착의 가운데는 화면 가운데에서 d/2만큼 떨어져 있으므로, ρ² = 2.5이면 두 가운데가
 * 화면 가운데에서 변까지의 80%(2 ÷ ρ²)에 놓여 함께 보인다.
 */
export const RHO = Math.sqrt(2.5);
/** 멈춘 화면이 순항 속도에 이르는 시간(ms). 같은 시간에 걸쳐 느려져 멈춘다. */
export const RAMP_MS = 250;

/**
 * 길이 length인 경로를 걷는 빠르기. 멈춘 상태에서 고르게 빨라져 `RAMP_MS` 뒤에 순항 속도 cruise(길이/ms)에 이르고, 같은 가속도로 느려져
 * 끝에서 멈춘다. 순항 속도에 이르기 전에 경로의 절반을 지나면 그때부터 느려진다. rolling이면 이미 움직이는 화면이므로 빨라지는 구간 없이
 * 느려지는 구간의 속도로 시작한다. ms는 걸리는 시간, at은 시작한 뒤 ms가 지났을 때 걸은 길이의 비율(0~1)이다.
 */
export function pace(length: number, cruise: number, rolling: boolean): { ms: number; at: (ms: number) => number } {
  if (length <= 0) {
    return { ms: 0, at: () => 1 };
  }
  const push = cruise / RAMP_MS;
  const slow = Math.min(RAMP_MS, Math.sqrt(((rolling ? 2 : 1) * length) / push));
  const lead = rolling ? 0 : slow;
  const top = push * slow;
  const ms = length / top + (lead + slow) / 2;
  return {
    ms,
    at: (t) => {
      if (t >= ms) {
        return 1;
      }
      const now = Math.max(0, t);
      const walked = now < lead ? (push * now * now) / 2 : now <= ms - slow ? top * (now - lead / 2) : length - (push * (ms - now) ** 2) / 2;
      return walked / length;
    },
  };
}

/** 화면이 보는 곳. 가운데의 그래프 좌표 x·y와 보이는 폭이다. */
type Eye = [number, number, number];

/**
 * 두 화면 사이의 최단 경로(van Wijk·Nuij). 옆으로 가는 거리에 ρ를 곱하고 폭의 비율에 로그를 씌워 ρ로 나눈 값을 보이는 폭에 견줘 잰 길이가
 * 가장 짧은 경로이고, 그 길이를 고르게 걸으면 화면에 보이는 빠르기가 일정하다. 옆으로만 가는 짧은 이동의 길이는 ρ × 거리 ÷ 보이는 폭이다.
 * at은 길이의 비율 t(0~1)까지 걸었을 때 보는 곳이다.
 */
function shortest([x0, y0, w0]: Eye, [x1, y1, w1]: Eye): { length: number; at: (t: number) => Eye } {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) {
    const length = Math.log(w1 / w0) / RHO;
    return { length: Math.abs(length), at: (t) => [x0 + t * dx, y0 + t * dy, w0 * Math.exp(RHO * t * length)] };
  }
  const end = (w: number, sign: number) => {
    const b = (w1 * w1 - w0 * w0 + sign * RHO ** 4 * d * d) / (2 * w * RHO * RHO * d);
    return Math.log(Math.sqrt(b * b + 1) - b);
  };
  const r0 = end(w0, 1);
  const length = (end(w1, -1) - r0) / RHO;
  return {
    length,
    at: (t) => {
      const r = RHO * t * length + r0;
      const u = (w0 / (RHO * RHO * d)) * (Math.cosh(r0) * Math.tanh(r) - Math.sinh(r0));
      return [x0 + u * dx, y0 + u * dy, (w0 * Math.cosh(r0)) / Math.cosh(r)];
    },
  };
}

/** 화면 이동 하나. ms는 걸리는 시간, at은 시작한 뒤 ms가 지났을 때의 화면이다. */
export interface Flight {
  ms: number;
  at: (ms: number) => View;
}

/**
 * from에서 to로 가는 화면 이동. room은 화면을 맞추는 기준 사각형(떠 있는 칸이 가리지 않는 영역)이고, 보이는 폭은 room의 짧은 변으로 잰다.
 * 걸리는 시간은 두 화면 사이의 최단 경로(`shortest`)의 길이를 `pace`로 걸은 시간이다. 경로는 두 가지다.
 * to의 가운데가 from에서 room 안에 보이면 그 점을 room의 가운데로 곧게 옮기며 확대 비율을 등비로 바꾼다. 두 확대 비율 사이를 벗어나지 않는다.
 * 보이지 않으면 최단 경로를 따라 축소했다가 확대한다. 확대 비율은 `ZOOM_MIN`보다 줄이지 않는다.
 */
export function flight(from: View, to: View, room: Rect, rolling: boolean): Flight {
  const side = Math.min(room.width, room.height);
  const mid = { x: room.x + room.width / 2, y: room.y + room.height / 2 };
  const eye = (view: View): Eye => [(mid.x - view.x) / view.zoom, (mid.y - view.y) / view.zoom, side / view.zoom];
  const [x, y] = eye(to);
  const path = shortest(eye(from), eye(to));
  const walk = pace(path.length, (SPEED * RHO) / 1000, rolling);
  const seen = { x: x * from.zoom + from.x, y: y * from.zoom + from.y };
  const near = seen.x >= room.x && seen.x <= room.x + room.width && seen.y >= room.y && seen.y <= room.y + room.height;
  return {
    ms: walk.ms,
    at: (ms) => {
      if (ms >= walk.ms) {
        return to;
      }
      const t = walk.at(ms);
      if (near) {
        const zoom = from.zoom * (to.zoom / from.zoom) ** t;
        return { x: seen.x + (mid.x - seen.x) * t - x * zoom, y: seen.y + (mid.y - seen.y) * t - y * zoom, zoom };
      }
      const [cx, cy, width] = path.at(t);
      const zoom = Math.max(side / width, ZOOM_MIN);
      return { x: mid.x - cx * zoom, y: mid.y - cy * zoom, zoom };
    },
  };
}

/** 화면 이동을 그리는 중인지. 이동이 시작할 때와 끝날 때만 바뀐다. */
export const useFlying = create<{ on: boolean }>(() => ({ on: false }));

/** 그리는 중인 화면 이동의 도착 화면과 남은 프레임을 취소하는 함수. React Flow가 하나이므로 화면 이동도 한 번에 하나다. */
let going: { to: View; cancel: () => void } | null = null;

/**
 * 화면을 옮기는 함수 네 개와 화면이 향하는 곳.
 * fly는 지금 화면에서 to까지 `flight`의 경로를 프레임마다 그린다. 그리는 중인 화면 이동이 있으면 그 순간의 화면에서 이어 간다.
 * 움직임을 줄이는 설정에서는 바로 옮긴다. fit은 "화면 맞춤"이다. 강조하는 경로 path가 없으면 그래프 전체를 정보 패널이 가리지 않는 영역에,
 * 있으면 경로 위 노드를 정보 패널과 왼쪽 아래 칸이 가리지 않는 영역에 24px를 두고 맞추고 확대 비율을 100%보다 키우지 않는다.
 * jump는 to로 바로 옮기고, halt는 그리는 중인 화면 이동을 그 순간의 화면에서 멈춘다.
 * heading은 그리는 중인 화면 이동의 도착 화면이고, 화면 이동이 없으면 지금 화면이다. 도착 화면을 지금 화면의 확대 비율이나 위치에서 정할 때
 * 축소한 채 지나가는 화면 대신 이 화면을 쓴다.
 */
export function useFlight() {
  const { getViewport, setViewport, getNodes, getNodesBounds } = useReactFlow();
  return useMemo(() => {
    const heading = (): View => going?.to ?? getViewport();
    const halt = () => {
      going?.cancel();
      going = null;
      if (useFlying.getState().on) {
        useFlying.setState({ on: false });
      }
    };
    const jump = (to: View) => {
      halt();
      void setViewport(to);
    };
    const fly = (to: View, room: Rect) => {
      const rolling = going !== null;
      const path = reducedMotion() ? null : flight(getViewport(), to, room, rolling);
      if (path === null || path.ms === 0) {
        jump(to);
        return;
      }
      going?.cancel();
      const started = performance.now();
      let frame = requestAnimationFrame(function step(now: number) {
        const passed = now - started;
        if (passed >= path.ms) {
          jump(to);
          return;
        }
        void setViewport(path.at(passed));
        frame = requestAnimationFrame(step);
      });
      going = { to, cancel: () => cancelAnimationFrame(frame) };
      useFlying.setState({ on: true });
    };
    const fit = (root: Element, path: string[] | null) => {
      const { free, clear } = stageOf(root);
      const room = path === null ? free : clear;
      fly(fitIn(getNodesBounds(path ?? getNodes().map((node) => node.id)), room), room);
    };
    return { fly, fit, jump, halt, heading };
  }, [getViewport, setViewport, getNodes, getNodesBounds]);
}
