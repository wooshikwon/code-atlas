// 고른 노드와 강조하는 경로로 화면을 옮길 좌표, "화면 맞춤"의 여백을 정한다. 좌표는 관계 그래프 영역의 왼쪽 위를 원점으로 한다.
import type { Rect } from "../state/store";
import type { Box, Point } from "./layout";

/** 확대 비율의 범위 */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;
/** 함수 이름표가 모두 보이는 확대 비율 구간의 시작값. 노드를 고르면 확대 비율을 이 값까지 키운다. */
export const NAMED_ZOOM = 0.8;
/** 화면을 맞출 때 이름표가 본문 글자보다 커지지 않게 확대 비율을 100%에서 멈춘다. */
const FRAME_ZOOM = 1;

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
 * 관계 그래프 영역 area의 아래 끝에서 margin만큼 띄운 높이 height의 띠에서 가리는 칸 covers가 덮지 않는 가장 넓은 가로 구간.
 * 띠에 조금이라도 걸친 칸은 그 칸의 폭만큼 띠를 덮는다.
 */
export function bottomSpan(area: Rect, covers: Rect[], height: number, margin: number): { x: number; width: number } {
  const band = { x: area.x, y: area.y + area.height - margin - height, width: area.width, height };
  const across = covers.filter((c) => c.y < band.y + band.height && c.y + c.height > band.y).map((c) => ({ x: c.x, y: band.y, width: c.width, height }));
  const { x, width } = freeRect(band, across);
  return across.some((c) => c.x < x + width && c.x + c.width > x) ? { x, width: 0 } : { x, width };
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
 * 상자 boxes 가운데 점 point에 가장 가까운 상자의 id. 점을 품은 상자는 거리가 0이고, 거리가 같으면 넓이가 작은 상자를 고른다.
 * 상자가 없으면 null이다. 다시 분석한 그래프의 배치가 올 때 화면 가운데의 상자를 찾아 그 상자를 화면의 같은 좌표에 둔다(`anchorOn`).
 */
export function nearest(boxes: Iterable<[string, Box]>, point: Point): string | null {
  let best: { id: string; far: number; size: number } | null = null;
  for (const [id, box] of boxes) {
    const far = Math.hypot(Math.max(box.x - point.x, 0, point.x - box.x - box.width), Math.max(box.y - point.y, 0, point.y - box.y - box.height));
    const size = box.width * box.height;
    if (best === null || far < best.far || (far === best.far && size < best.size)) {
      best = { id, far, size };
    }
  }
  return best?.id ?? null;
}

/**
 * 코드가 스스로 맞추는 화면(레포를 연 처음 화면, 전체 맞춤 상태에서 배치가 바뀐 뒤). whole은 그래프 전체를 free에 맞춘 화면이다.
 * whole의 확대 비율이 `NAMED_ZOOM` 이상이면 whole을 쓴다. 그보다 작으면 이름표가 읽히도록 확대 비율을 `NAMED_ZOOM`에 두고
 * corner(선을 눌러 간 폴더의 왼쪽 위, 그런 폴더가 없으면 그래프의 왼쪽 위)를 free의 왼쪽 위에서 24px 안쪽에 놓는다.
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
 * clear는 정보 패널과 왼쪽 아래 칸(펼친 미니맵·범례·경로 탐색 창, 버튼 줄), 왼쪽 위의 비교 버튼이 모두 가리지 않는 사각형이고
 * 노드나 그래프의 한 점으로 화면을 옮길 때 쓴다. covers는 정보 패널과 왼쪽 아래 칸, 비교 버튼의 사각형이다.
 * 정보 패널은 관계 그래프 영역 위에 떠 있을 때만 센다. 세로창 모드의 정보 패널은 영역 밖의 칸에 있으므로 free가 영역 전체다.
 */
export interface Stage {
  area: Rect;
  free: Rect;
  clear: Rect;
  covers: Rect[];
}

/**
 * 상자 box를 사각형 room의 네 변에서 24px 안쪽에 맞춘 화면. box의 가운데가 room의 가운데에 오고,
 * 확대 비율은 `ZOOM_MIN`과 `FRAME_ZOOM` 사이다.
 */
export function fitIn(box: Box, room: Rect): View {
  const zoom = Math.max(ZOOM_MIN, Math.min((room.width - 2 * FIT_MARGIN) / box.width, (room.height - 2 * FIT_MARGIN) / box.height, FRAME_ZOOM));
  return { x: room.x + room.width / 2 - (box.x + box.width / 2) * zoom, y: room.y + room.height / 2 - (box.y + box.height / 2) * zoom, zoom };
}

/** 화면에서 관계 그래프 영역 root와 그 영역 위에 떠 있는 정보 패널, 왼쪽 아래 칸, 비교 버튼의 사각형을 읽는다. */
export function stageOf(root: Element): Stage {
  const outer = root.getBoundingClientRect();
  const within = (element: Element): Rect => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left - outer.left, y: rect.top - outer.top, width: rect.width, height: rect.height };
  };
  const area = { x: 0, y: 0, width: outer.width, height: outer.height };
  const panel = [...(root.closest(".stage")?.querySelectorAll(".info-panel") ?? [])].map(within);
  const dock = [...root.querySelectorAll(".dock-panels > *, .dock-buttons")].map(within);
  const button = [...document.querySelectorAll(".compare-button")].map(within);
  const covers = [...panel, ...dock, ...button];
  return { area, free: freeRect(area, panel), clear: freeRect(area, covers), covers };
}
