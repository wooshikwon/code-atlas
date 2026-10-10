// 고른 노드로 화면을 옮길 좌표·확대 비율과 "화면 맞춤"의 여백을 정한다. 좌표는 관계 그래프 영역의 왼쪽 위를 원점으로 한다.
import type { Rect } from "../state/store";
import type { Box, Point } from "./layout";

/** 화면 이동의 길이(ms) */
export const PAN_MS = 400;

/** 확대 비율의 범위 */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;
/** 고른 노드로 화면을 옮길 때 확대 비율을 이 값 아래로 줄이지 않는다. */
export const FOCUS_ZOOM_MIN = 0.4;

const INSET = 20;
const FIT_MARGIN = 24;

const areaOf = (rect: Rect) => rect.width * rect.height;

function widest(rects: Rect[]): Rect {
  return rects.reduce((best, rect) => (areaOf(rect) > areaOf(best) ? rect : best));
}

/**
 * 관계 그래프 영역에서 정보 패널을 뺀 왼쪽·오른쪽·위·아래 네 사각형.
 * 패널이 없거나 영역과 겹치지 않으면 영역 전체 하나다.
 */
export function freeRects(area: Rect, panel: Rect | null): Rect[] {
  if (panel === null) {
    return [area];
  }
  const left = Math.max(area.x, Math.min(panel.x, area.x + area.width));
  const right = Math.max(area.x, Math.min(panel.x + panel.width, area.x + area.width));
  const top = Math.max(area.y, Math.min(panel.y, area.y + area.height));
  const bottom = Math.max(area.y, Math.min(panel.y + panel.height, area.y + area.height));
  if (left >= right || top >= bottom) {
    return [area];
  }
  return [
    { ...area, width: left - area.x },
    { ...area, x: right, width: area.x + area.width - right },
    { ...area, height: top - area.y },
    { ...area, y: bottom, height: area.y + area.height - bottom },
  ];
}

/** freeRects 가운데 가장 넓은 사각형 */
export function freeRect(area: Rect, panel: Rect | null): Rect {
  return widest(freeRects(area, panel));
}

/**
 * 상자의 중심이 free의 중심에 오는 화면 이동 좌표. 확대한 상자가 free보다 긴 축은 상자의 시작 끝을
 * free의 시작 끝에서 20px 안쪽에 맞춘다.
 */
export function centerOn(box: Box, free: Rect, zoom: number): Point {
  const along = (start: number, length: number, from: number, room: number) =>
    length * zoom > room ? from + INSET - start * zoom : from + room / 2 - (start + length / 2) * zoom;
  return { x: along(box.x, box.width, free.x, free.width), y: along(box.y, box.height, free.y, free.height) };
}

/** 상자를 모두 품는 가장 작은 사각형 */
export function boundsOf(boxes: Iterable<Box>): Box {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  return left > right ? { x: 0, y: 0, width: 0, height: 0 } : { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * boxes가 sides 가운데 한 사각형 안에 24px를 두고 모두 들어오는 화면 이동 좌표와 확대 비율.
 * 사각형마다 boxes가 들어오는 확대 비율을 사용자 확대 비율 zoom을 넘지 않게 구하고, 그 값이 가장 큰 사각형(같으면 넓은 쪽)
 * 가운데로 boxes를 옮긴다. FOCUS_ZOOM_MIN 아래로는 줄이지 않으며, 어느 사각형에도 들어오지 않으면
 * 가장 넓은 사각형 가운데에 anchor를 둔다. zoom이 FOCUS_ZOOM_MIN보다 작으면 확대 비율을 zoom으로 둔다.
 */
export function fitOn(boxes: Iterable<Box>, anchor: Box, sides: Rect[], zoom: number): Point & { zoom: number } {
  const bounds = boundsOf(boxes);
  const scale = (side: Rect) =>
    Math.min(zoom, (side.width - 2 * FIT_MARGIN) / bounds.width, (side.height - 2 * FIT_MARGIN) / bounds.height);
  const best = sides.reduce((a, b) =>
    scale(b) > scale(a) || (scale(b) === scale(a) && areaOf(b) > areaOf(a)) ? b : a,
  );
  const floor = Math.min(zoom, FOCUS_ZOOM_MIN);
  return scale(best) >= floor
    ? { ...centerOn(bounds, best, scale(best)), zoom: scale(best) }
    : { ...centerOn(anchor, widest(sides), floor), zoom: floor };
}

/** 관계 그래프 영역, 정보 패널이 가리지 않는 사각형 sides, 그 가운데 가장 넓은 사각형 free */
export interface Stage {
  area: Rect;
  sides: Rect[];
  free: Rect;
}

/** "화면 맞춤"의 여백. 그래프를 free 안에 24px를 두고 맞추도록 area의 네 변에서 비울 폭을 낸다. */
export function fitPadding({ area, free }: Pick<Stage, "area" | "free">) {
  const px = (n: number) => `${Math.round(n) + FIT_MARGIN}px` as const;
  return {
    top: px(free.y - area.y),
    right: px(area.x + area.width - free.x - free.width),
    bottom: px(area.y + area.height - free.y - free.height),
    left: px(free.x - area.x),
  };
}

/** 화면에서 관계 그래프 영역 root와 정보 패널의 사각형을 읽는다. */
export function stageOf(root: Element): Stage {
  const outer = root.getBoundingClientRect();
  const panel = document.querySelector(".info-panel")?.getBoundingClientRect();
  const area = { x: 0, y: 0, width: outer.width, height: outer.height };
  const sides = freeRects(
    area,
    panel === undefined
      ? null
      : { x: panel.left - outer.left, y: panel.top - outer.top, width: panel.width, height: panel.height },
  );
  return { area, sides, free: widest(sides) };
}
