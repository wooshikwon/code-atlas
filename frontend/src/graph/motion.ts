// 배치가 바뀔 때 노드를 옮기는 움직임. 두 배치 사이의 중간 배치를 순수 함수로 만들고 프레임마다 그리게 한다.
import type { Layout } from "./layout";

/** 펼치기·접기 움직임의 길이(ms) */
export const MOVE_MS = 300;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
}

/**
 * from에서 to로 가는 움직임의 t(0~1) 시점 배치. 두 배치에 모두 있는 노드는 위치와 크기를 ease-in-out으로 보간하고,
 * to에만 있는 노드는 도착 위치에 둔다. from에만 있는 노드는 담지 않는다. 선 경로는 to의 경로다.
 */
export function tween(from: Layout, to: Layout, t: number): Layout {
  if (t >= 1) {
    return to;
  }
  const k = easeInOut(Math.max(0, t));
  const mix = (a: number, b: number) => a + (b - a) * k;
  const result: Layout = { positions: new Map(), sizes: new Map(), boxes: new Map(), routes: to.routes, lane: to.lane };
  for (const [id, box] of to.boxes) {
    const position = to.positions.get(id)!;
    const before = from.boxes.get(id);
    const origin = from.positions.get(id);
    if (before === undefined || origin === undefined) {
      result.positions.set(id, position);
      result.sizes.set(id, to.sizes.get(id)!);
      result.boxes.set(id, box);
      continue;
    }
    const size = { width: mix(before.width, box.width), height: mix(before.height, box.height) };
    result.positions.set(id, { x: mix(origin.x, position.x), y: mix(origin.y, position.y) });
    result.sizes.set(id, size);
    result.boxes.set(id, { x: mix(before.x, box.x), y: mix(before.y, box.y), ...size });
  }
  return result;
}

/** 두 배치의 노드와 그 위치·크기가 모두 같은지 본다. 같으면 움직임 없이 바꾼다. */
export function settled(from: Layout, to: Layout): boolean {
  if (from.boxes.size !== to.boxes.size) {
    return false;
  }
  for (const [id, box] of to.boxes) {
    const before = from.boxes.get(id);
    if (
      before === undefined ||
      before.x !== box.x ||
      before.y !== box.y ||
      before.width !== box.width ||
      before.height !== box.height
    ) {
      return false;
    }
  }
  return true;
}

/** 움직임을 줄이는 시스템 설정이 켜져 있는지 본다. */
export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * from에서 to로 가는 움직임을 MOVE_MS 동안 돌린다. 프레임마다 그 시점의 배치로 draw를 부르고 마지막 프레임 뒤에 done을 부른다.
 * 돌려주는 함수는 남은 프레임을 취소한다.
 */
export function play(from: Layout, to: Layout, draw: (at: Layout) => void, done: () => void): () => void {
  const started = performance.now();
  let frame = requestAnimationFrame(function step(now: number) {
    const t = Math.min(1, (now - started) / MOVE_MS);
    draw(tween(from, to, t));
    if (t < 1) {
      frame = requestAnimationFrame(step);
    } else {
      done();
    }
  });
  return () => cancelAnimationFrame(frame);
}
