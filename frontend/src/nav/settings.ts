// 필터 창의 보기 설정 가운데 기본값과 다른 것. 상단 줄의 필터 버튼이 개수와 이름을 적는다.
import type { OverlayKind } from "../state/overlay";
import type { Depth } from "../state/store";

export const OVERLAY_NAMES: Record<OverlayKind, string> = { cycles: "순환 의존", unused: "미사용 후보" };

/** 흐름 단계의 기본값 */
export const DEPTH: Depth = 2;

export interface ViewSettings {
  depth: Depth;
  overlay: OverlayKind | null;
  showTests: boolean;
  showExternal: boolean;
  autoSummary: boolean;
}

/** 기본값(흐름 단계 2, 분석 표시 없음, 토글 세 개 꺼짐)과 다른 보기 설정의 이름. 필터 창에 그리는 순서다. */
export function changed(settings: ViewSettings): string[] {
  return [
    ...(settings.depth !== DEPTH ? [`흐름 단계 ${settings.depth}`] : []),
    ...(settings.overlay !== null ? [`${OVERLAY_NAMES[settings.overlay]} 표시`] : []),
    ...(settings.showTests ? ["테스트 코드"] : []),
    ...(settings.showExternal ? ["외부 노드"] : []),
    ...(settings.autoSummary ? ["자동 요약"] : []),
  ];
}

/** 필터 버튼의 말풍선 글 */
export function filterTip(names: string[]): string {
  return names.length === 0 ? "필터 · 보기 설정이 모두 기본값이다" : ["필터 · 기본값과 다른 보기 설정", ...names].join("\n");
}
