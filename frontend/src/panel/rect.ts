// 정보 패널 사각형의 이동·크기 조절·자르기. 좌표는 관계 그래프 영역의 왼쪽 위에서 잰다.
import type { Rect } from "../state/store";

export type Dir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** 관계 그래프 영역의 크기 */
export interface Area {
  width: number;
  height: number;
}

export const MIN_WIDTH = 260;
const DEFAULT_WIDTH = 480;
/** 기본 사각형이 영역의 위·오른쪽·아래 가장자리에서 떨어지는 길이 */
const DEFAULT_GAP = 8;
export const MIN_HEIGHT = 58;
/** 머리 줄이 관계 그래프 영역 안에 남아야 하는 가로·세로 길이 */
const KEEP_X = 60;
const KEEP_Y = 40;

/** 크기를 최소 크기와 영역 크기 사이로, 위치를 머리 줄이 영역 안에 남는 범위로 자른다. */
export function clamp(rect: Rect, area: Area): Rect {
  const width = Math.max(MIN_WIDTH, Math.min(rect.width, area.width));
  const height = Math.max(MIN_HEIGHT, Math.min(rect.height, area.height));
  return {
    x: Math.max(KEEP_X - width, Math.min(rect.x, area.width - KEEP_X)),
    y: Math.max(0, Math.min(rect.y, area.height - KEEP_Y)),
    width,
    height,
  };
}

/** 사용자가 옮기거나 크기를 바꾸기 전의 사각형. 영역의 오른쪽 가장자리에 붙어 위에서 아래까지 찬다. */
export function initial(area: Area): Rect {
  return clamp(
    {
      x: area.width - DEFAULT_WIDTH - DEFAULT_GAP,
      y: DEFAULT_GAP,
      width: DEFAULT_WIDTH,
      height: area.height - 2 * DEFAULT_GAP,
    },
    area,
  );
}

export function move(rect: Rect, dx: number, dy: number, area: Area): Rect {
  return clamp({ ...rect, x: rect.x + dx, y: rect.y + dy }, area);
}

/**
 * dir 쪽 가장자리를 (dx, dy)만큼 옮긴다. 반대쪽 가장자리는 그대로 둔다.
 * 왼쪽·위쪽 가장자리는 최소 크기에 닿으면 멈추고, 끄는 가장자리는 영역 밖으로 나가지 않는다.
 */
export function resize(rect: Rect, dir: Dir, dx: number, dy: number, area: Area): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (dir.includes("w")) {
    left = Math.max(0, Math.min(left + dx, right - MIN_WIDTH, area.width - KEEP_X));
  }
  if (dir.includes("e")) {
    right = Math.max(Math.min(right + dx, area.width), left + MIN_WIDTH, KEEP_X);
  }
  if (dir.includes("n")) {
    top = Math.max(0, Math.min(top + dy, bottom - MIN_HEIGHT, area.height - KEEP_Y));
  }
  if (dir.includes("s")) {
    bottom = Math.max(Math.min(bottom + dy, area.height), top + MIN_HEIGHT);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
