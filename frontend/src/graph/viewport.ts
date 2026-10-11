// 고른 노드와 강조하는 경로로 화면을 옮길 좌표, "화면 맞춤"의 여백을 정한다. 좌표는 관계 그래프 영역의 왼쪽 위를 원점으로 한다.
import type { Rect } from "../state/store";
import type { Box, Point } from "./layout";

/** 화면 이동의 길이(ms) */
export const PAN_MS = 400;

/** 확대 비율의 범위 */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;
/** 함수 이름표가 모두 보이는 확대 비율 구간의 시작값. 노드를 고르면 확대 비율을 이 값까지 키운다. */
export const NAMED_ZOOM = 0.8;
/** 함수 시점 뷰에서 화면을 맞출 때 이름표가 본문 글자보다 커지지 않게 확대 비율을 100%에서 멈춘다. */
export const FRAME_ZOOM = 1;

const INSET = 20;
const FIT_MARGIN = 24;

/**
 * 관계 그래프 영역에서 정보 패널을 뺀 왼쪽·오른쪽·위·아래 네 사각형 가운데 가장 넓은 사각형.
 * 패널이 없거나 영역과 겹치지 않으면 영역 전체다.
 */
export function freeRect(area: Rect, panel: Rect | null): Rect {
  if (panel === null) {
    return area;
  }
  const left = Math.max(area.x, Math.min(panel.x, area.x + area.width));
  const right = Math.max(area.x, Math.min(panel.x + panel.width, area.x + area.width));
  const top = Math.max(area.y, Math.min(panel.y, area.y + area.height));
  const bottom = Math.max(area.y, Math.min(panel.y + panel.height, area.y + area.height));
  if (left >= right || top >= bottom) {
    return area;
  }
  const sides: Rect[] = [
    { ...area, width: left - area.x },
    { ...area, x: right, width: area.x + area.width - right },
    { ...area, height: top - area.y },
    { ...area, y: bottom, height: area.y + area.height - bottom },
  ];
  return sides.reduce((best, side) => (side.width * side.height > best.width * best.height ? side : best));
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

/**
 * 강조하는 경로의 출발 노드 from과 도착 노드 to가 함께 보이는 화면 위치와 확대 비율. 확대 비율은 zoom을 줄이지 않고
 * `NAMED_ZOOM`보다 작으면 그 값으로 키운다. 두 상자를 품는 사각형이 정보 패널이 가리지 않는 영역에 20px씩 남기고
 * 들어가면 그 사각형을 영역의 가운데에 두고, 들어가지 않으면 출발 노드를 영역의 왼쪽 끝에서 20px 안쪽, 세로 가운데에 둔다.
 */
export function frameOn([from, to]: [Box, Box], { free }: Stage, zoom: number): Point & { zoom: number } {
  const scale = Math.max(zoom, NAMED_ZOOM);
  const both = boundsOf([from, to]);
  const fits = both.width * scale + 2 * INSET <= free.width && both.height * scale + 2 * INSET <= free.height;
  const at = fits
    ? centerOn(both, free, scale)
    : { x: free.x + INSET - from.x * scale, y: free.y + free.height / 2 - (from.y + from.height / 2) * scale };
  return { ...at, zoom: scale };
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

/** 관계 그래프 영역과 그 안에서 정보 패널이 가리지 않는 사각형 */
export interface Stage {
  area: Rect;
  free: Rect;
}

/** "화면 맞춤"의 여백. 그래프를 free 안에 24px를 두고 맞추도록 area의 네 변에서 비울 폭을 낸다. */
export function fitPadding({ area, free }: Stage) {
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
  return {
    area,
    free: freeRect(
      area,
      panel === undefined
        ? null
        : { x: panel.left - outer.left, y: panel.top - outer.top, width: panel.width, height: panel.height },
    ),
  };
}
