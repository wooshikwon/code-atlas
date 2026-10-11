// 그래프 화면 요소의 겹침 순서. 구조 뷰와 함수 시점 뷰가 함께 쓴다.
// 요소의 층은 종류로만 정하고 선택·펼침·초점·움직임에 따라 바꾸지 않는다. 마우스를 올린 선 하나만 다른 선 위의 층으로 올린다.
// 노드 하나는 React Flow 노드 두 개로 그린다. 바탕 요소(body)는 테두리와 채움을 종류의 층에 그리고,
// 글자 요소(face)는 이름표·줄 수 숫자·배지·변경 표시 글자·선택 고리를 맨 위 층에 그린다.
import type { NodeKind } from "../api/types";

/** 아래층부터 그리는 순서. 값이 React Flow 노드와 선의 zIndex다. */
export const LAYER = {
  /** 파일 상자와 접힌 폴더 상자의 바탕과 테두리 */
  box: 1,
  /** 클래스 노드와 데이터 클래스 노드의 바탕과 테두리 */
  frame: 2,
  /** 선, 화살촉, 선의 누름 영역, 집계 숫자 */
  edge: 3,
  /** 마우스를 올린 선 */
  pointed: 4,
  /** 함수·메서드 노드의 원, 외부 노드 */
  mark: 5,
  /** 모든 노드의 이름표, 줄 수 숫자, 배지, 변경 표시 글자, 선택 고리 */
  text: 6,
} as const;

export type Part = "body" | "face";

const BODY_LAYER: Record<NodeKind, number> = {
  package: LAYER.box,
  module: LAYER.box,
  class: LAYER.frame,
  dataclass: LAYER.frame,
  function: LAYER.mark,
  method: LAYER.mark,
  external: LAYER.mark,
};

/** 노드 종류와 요소가 놓이는 층 */
export function layerOf(kind: NodeKind, part: Part): number {
  return part === "face" ? LAYER.text : BODY_LAYER[kind];
}

const FACE_SUFFIX = "#face";

/** 글자 요소의 React Flow 노드 id. 바탕 요소는 그래프 노드 id를 그대로 쓴다. */
export function faceId(id: string): string {
  return `${id}${FACE_SUFFIX}`;
}
