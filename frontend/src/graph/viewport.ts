// 고른 노드로 화면을 옮길 좌표를 정한다. 좌표는 관계 그래프 영역의 왼쪽 위를 원점으로 한다.
import type { Rect } from "../state/store";
import type { Box, Point } from "./layout";

/** 화면 이동의 길이(ms) */
export const PAN_MS = 400;

const INSET = 20;

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
