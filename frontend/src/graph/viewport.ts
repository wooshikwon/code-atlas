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
 * 관계 그래프 영역 area 안에서 가리는 칸 covers와 겹치지 않는 사각형 가운데 가장 넓은 사각형.
 * 사각형의 변은 영역의 변이나 가리는 칸의 변에 맞춘다. 가리는 칸이 없거나 영역과 겹치지 않으면 영역 전체다.
 */
export function freeRect(area: Rect, covers: Rect[]): Rect {
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  const inside = covers
    .map((c) => ({
      left: Math.max(area.x, Math.min(c.x, right)),
      right: Math.max(area.x, Math.min(c.x + c.width, right)),
      top: Math.max(area.y, Math.min(c.y, bottom)),
      bottom: Math.max(area.y, Math.min(c.y + c.height, bottom)),
    }))
    .filter((c) => c.left < c.right && c.top < c.bottom);
  const cuts = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  const xs = cuts([area.x, right, ...inside.flatMap((c) => [c.left, c.right])]);
  const ys = cuts([area.y, bottom, ...inside.flatMap((c) => [c.top, c.bottom])]);
  let best = inside.length === 0 ? area : null;
  for (const [i, x] of xs.entries()) {
    for (const far of xs.slice(i + 1)) {
      for (const [j, y] of ys.entries()) {
        for (const low of ys.slice(j + 1)) {
          const size = (far - x) * (low - y);
          if (best !== null && size <= best.width * best.height) {
            continue;
          }
          if (inside.every((c) => c.right <= x || c.left >= far || c.bottom <= y || c.top >= low)) {
            best = { x, y, width: far - x, height: low - y };
          }
        }
      }
    }
  }
  return best ?? area;
}

/**
 * 상자의 중심이 빈 사각형 free의 중심에 오는 화면 이동 좌표. 확대한 상자가 free보다 긴 축은 상자의 시작 끝을
 * free의 시작 끝에서 20px 안쪽에 맞춘다.
 */
export function centerOn(box: Box, free: Rect, zoom: number): Point {
  const along = (start: number, length: number, from: number, room: number) =>
    length * zoom > room ? from + INSET - start * zoom : from + room / 2 - (start + length / 2) * zoom;
  return { x: along(box.x, box.width, free.x, free.width), y: along(box.y, box.height, free.y, free.height) };
}

/**
 * 강조하는 경로를 보이는 화면 위치와 확대 비율. path는 경로 위 노드의 상자이고 focus는 정보 패널이 보이는 경로 위 노드의 상자다.
 * 확대 비율은 zoom을 줄이지 않고 `NAMED_ZOOM`보다 작으면 그 값으로 키운다. 경로 위 노드를 모두 품는 사각형을 `centerOn`으로
 * clear에 맞춘 뒤, focus가 clear의 20px 안쪽을 벗어난 축은 focus가 그 안에 들어올 만큼만 옮긴다.
 */
export function frameOn(path: Box[], focus: Box, clear: Rect, zoom: number): Point & { zoom: number } {
  const scale = Math.max(zoom, NAMED_ZOOM);
  const at = centerOn(boundsOf(path), clear, scale);
  /** 화면 좌표 from에서 시작하는 길이 length의 구간이 room의 안쪽에 들어오도록 옮길 거리. 구간이 더 길면 시작 끝을 맞춘다. */
  const shift = (from: number, length: number, start: number, room: number) => {
    const low = start + INSET;
    const high = start + room - INSET - length;
    return from < low || high < low ? low - from : from > high ? high - from : 0;
  };
  return {
    x: at.x + shift(focus.x * scale + at.x, focus.width * scale, clear.x, clear.width),
    y: at.y + shift(focus.y * scale + at.y, focus.height * scale, clear.y, clear.height),
    zoom: scale,
  };
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
 * 관계 그래프 영역과 그 안의 빈 사각형 두 개. free는 정보 패널이 가리지 않는 사각형이고 그래프 전체를 맞출 때 쓴다.
 * clear는 정보 패널과 왼쪽 아래 칸(펼친 미니맵·범례·경로 탐색 창, 버튼 줄)이 모두 가리지 않는 사각형이고
 * 노드나 그래프의 한 점으로 화면을 옮길 때 쓴다.
 */
export interface Stage {
  area: Rect;
  free: Rect;
  clear: Rect;
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

/** 화면에서 관계 그래프 영역 root와 정보 패널, 왼쪽 아래 칸의 사각형을 읽는다. */
export function stageOf(root: Element): Stage {
  const outer = root.getBoundingClientRect();
  const within = (element: Element): Rect => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left - outer.left, y: rect.top - outer.top, width: rect.width, height: rect.height };
  };
  const area = { x: 0, y: 0, width: outer.width, height: outer.height };
  const panel = [...document.querySelectorAll(".info-panel")].map(within);
  const dock = [...root.querySelectorAll(".dock-panels > *, .dock-buttons")].map(within);
  return { area, free: freeRect(area, panel), clear: freeRect(area, [...panel, ...dock]) };
}
