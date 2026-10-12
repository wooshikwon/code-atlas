// 고른 노드와 강조하는 경로로 화면을 옮길 좌표, "화면 맞춤"의 여백을 정한다. 좌표는 관계 그래프 영역의 왼쪽 위를 원점으로 한다.
import type { Rect } from "../state/store";
import type { Box, Point } from "./layout";

/** 확대 비율의 범위 */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;
/** 함수 이름표가 모두 보이는 확대 비율 구간의 시작값. 노드를 고르면 확대 비율을 이 값까지 키운다. */
export const NAMED_ZOOM = 0.8;
/** 화면을 맞출 때 이름표가 본문 글자보다 커지지 않게 확대 비율을 100%에서 멈춘다. */
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

/** 화면 위치와 확대 비율 */
export type View = Point & { zoom: number };

/**
 * 경로 고정 중에 화면을 옮길 위치와 확대 비율. path는 강조하는 경로 위 노드의 상자, focus는 정보 패널이 보이는 경로 위 노드의 상자,
 * step은 focus의 노드와 경로에서 그 다음 노드를 품는 상자다. 확대 비율은 view의 값을 줄이지 않고 `NAMED_ZOOM`보다 작으면 그 값으로 키운다.
 * whole이 참이거나 확대 비율을 키웠으면 path를 모두 품는 사각형을 `centerOn`으로 clear에 맞춘 화면에서 시작하고, 그 밖에는 view에서 시작한다.
 * 시작한 화면에서 step이 clear의 20px 안쪽에 들어 있는 축은 그대로 두고, 벗어난 축은 step을 `centerOn`으로 clear에 맞춘다.
 * step이 clear의 20px 안쪽보다 크면 step 대신 focus로 판정한다.
 */
export function frameOn(path: Box[], step: Box, focus: Box, clear: Rect, view: View, whole: boolean): View {
  const zoom = Math.max(view.zoom, NAMED_ZOOM);
  const from = whole || zoom !== view.zoom ? centerOn(boundsOf(path), clear, zoom) : view;
  const fits = step.width * zoom <= clear.width - 2 * INSET && step.height * zoom <= clear.height - 2 * INSET;
  const target = fits ? step : focus;
  const to = centerOn(target, clear, zoom);
  /** 화면 좌표 start에서 시작하는 길이 length의 구간이 room의 20px 안쪽에 들어 있는지 */
  const inside = (start: number, length: number, low: number, room: number) =>
    start >= low + INSET && start + length <= low + room - INSET;
  return {
    x: inside(target.x * zoom + from.x, target.width * zoom, clear.x, clear.width) ? from.x : to.x,
    y: inside(target.y * zoom + from.y, target.height * zoom, clear.y, clear.height) ? from.y : to.y,
    zoom,
  };
}

/**
 * 배치가 바뀌어 상자가 before에서 after로 옮겨 갔을 때 그 상자의 왼쪽 위 모서리가 화면의 같은 좌표에 남는 화면 위치.
 * 확대 비율은 그대로다. 손잡이와 폴더를 눌러 상자를 펼치거나 접을 때 쓴다.
 */
export function anchorOn(before: Point, after: Point, view: View): View {
  return { x: view.x + (before.x - after.x) * view.zoom, y: view.y + (before.y - after.y) * view.zoom, zoom: view.zoom };
}

/**
 * 상자의 왼쪽 위 모서리가 clear의 20px 안쪽에 들어오도록 가장 적게 옮긴 화면 위치. 이미 들어 있는 축은 그대로 둔다.
 * 확대 비율은 그대로다.
 */
export function cornerInto(corner: Point, clear: Rect, view: View): View {
  const along = (start: number, low: number, room: number, at: number) => {
    const from = start * view.zoom + at;
    return at + Math.min(Math.max(from, low + INSET), low + room - INSET) - from;
  };
  return { x: along(corner.x, clear.x, clear.width, view.x), y: along(corner.y, clear.y, clear.height, view.y), zoom: view.zoom };
}

/**
 * 코드가 스스로 맞추는 화면(레포를 연 처음 화면, 전체 맞춤 상태에서 배치가 바뀐 뒤). whole은 그래프 전체를 free에 맞춘 화면이다.
 * whole의 확대 비율이 `NAMED_ZOOM` 이상이면 whole을 쓴다. 그보다 작으면 이름표가 읽히도록 확대 비율을 `NAMED_ZOOM`에 두고
 * corner(사용자가 방금 가리킨 상자의 왼쪽 위, 가리킨 것이 없으면 그래프의 왼쪽 위)를 free의 왼쪽 위에서 24px 안쪽에 놓는다.
 */
export function autoView(whole: View, corner: Point, free: Rect): View {
  if (whole.zoom >= NAMED_ZOOM) {
    return whole;
  }
  return { x: free.x + FIT_MARGIN - corner.x * NAMED_ZOOM, y: free.y + FIT_MARGIN - corner.y * NAMED_ZOOM, zoom: NAMED_ZOOM };
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

/** 그래프를 관계 그래프 영역 area 안의 사각형 room에 24px를 두고 맞추도록 area의 네 변에서 비울 폭 */
export function fitPadding(area: Rect, room: Rect) {
  const px = (n: number) => `${Math.round(n) + FIT_MARGIN}px` as const;
  return {
    top: px(room.y - area.y),
    right: px(area.x + area.width - room.x - room.width),
    bottom: px(area.y + area.height - room.y - room.height),
    left: px(room.x - area.x),
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
