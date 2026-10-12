// 정보 패널 사각형의 이동·크기 조절·자르기·비율 변환과 LLM 요약 칸의 높이 조절. 좌표는 관계 그래프 영역의 왼쪽 위에서 잰다.
import type { Rect } from "../state/store";

export type Dir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** 관계 그래프 영역의 크기 */
export interface Area {
  width: number;
  height: number;
}

export const MIN_WIDTH = 260;
/** 기본 사각형의 폭과, 기본 사각형이 영역의 위·오른쪽·아래 끝에서 띄우는 여백을 관계 그래프 영역의 폭으로 나눈 값 */
const DEFAULT_SHARE = 0.4;
const DEFAULT_GAP = 0.005;
export const MIN_HEIGHT = 58;
/** 경계선을 끌어 줄일 때 LLM 요약 칸과 코드 뷰어에 남기는 높이 */
export const MIN_SUMMARY = 56;
export const MIN_CODE = 96;
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

/**
 * 사용자가 옮기거나 크기를 바꾸기 전의 사각형. 영역 폭의 40%를 차지하고 영역의 위·오른쪽·아래 끝에서 영역 폭의 0.5%씩 띄운다.
 * 세 여백은 같은 값이다. 영역 폭의 40%가 최소 폭보다 좁으면 최소 폭으로 그린다.
 */
export function initial(area: Area): Rect {
  const gap = Math.round(area.width * DEFAULT_GAP);
  const height = area.height - 2 * gap;
  const { width } = clamp({ x: 0, y: 0, width: Math.round(area.width * DEFAULT_SHARE), height }, area);
  return clamp({ x: area.width - gap - width, y: gap, width, height }, area);
}

/** 사각형의 x·width를 영역의 폭으로, y·height를 영역의 높이로 나눈 비율 사각형. 저장소에는 이 값을 담는다. */
export function share(rect: Rect, area: Area): Rect {
  return { x: rect.x / area.width, y: rect.y / area.height, width: rect.width / area.width, height: rect.height / area.height };
}

/** 비율 사각형 shares를 영역 area의 픽셀 사각형으로 바꾸고 `clamp`로 자른다. */
export function scale(shares: Rect, area: Area): Rect {
  return clamp(
    {
      x: Math.round(shares.x * area.width),
      y: Math.round(shares.y * area.height),
      width: Math.round(shares.width * area.width),
      height: Math.round(shares.height * area.height),
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

/**
 * LLM 요약 칸의 높이 height를 dy만큼 바꾼다. room은 요약 칸과 코드 뷰어의 높이를 더한 값이다.
 * 요약 칸과 코드 뷰어에 최소 높이를 남기고, room이 두 최소 높이의 합보다 작으면 요약 칸의 최소 높이를 먼저 남긴다.
 */
export function divide(height: number, dy: number, room: number): number {
  return Math.max(MIN_SUMMARY, Math.min(height + dy, room - MIN_CODE));
}
