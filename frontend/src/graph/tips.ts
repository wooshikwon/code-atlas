// 노드에 단 배지와 표시 위에 마우스를 올렸을 때 말풍선에 적는 글. 배지 요소가 `data-tip`에 글을 담고,
// 그래프 뷰가 마우스 아래 요소에서 그 글을 찾아 노드의 말풍선 대신 띄운다. 줄은 `\n`으로 나눈다.
import type { AtlasNode, Change } from "../api/types";

export const ENTRY_TIP = "진입점: 실행을 시작하는 코드";

export const CHANGE_TIPS: Record<Change, string> = {
  modified: "수정: 마지막 커밋 뒤 바뀜",
  added: "추가: 마지막 커밋에 없음",
};

/** 접힌 파일 상자와 접힌 폴더 상자는 안에 든 노드의 수를 합쳐 적는다. */
function merged(node: AtlasNode, expanded: boolean): string {
  if (expanded || (node.kind !== "module" && node.kind !== "package")) {
    return "";
  }
  return node.kind === "module" ? " · 이 파일 안의 함수에서 합친 수" : " · 이 폴더 안의 함수에서 합친 수";
}

/** 미확인 호출 수 배지 `?N` */
export function unresolvedTip(node: AtlasNode, count: number, expanded: boolean): string {
  return [
    `대상을 확인하지 못한 호출 ${count}곳${merged(node, expanded)}`,
    "getattr로 부르는 동적 호출이나 타입 힌트 없는 인자의 메서드 호출처럼",
    "정적 분석으로 대상을 확인하지 못해 선으로 그리지 않은 호출이다",
  ].join("\n");
}

/** 모듈 변수 변경 배지 `g`. 바꾸는 모듈 변수 이름을 적는다. */
export function globalTip(node: AtlasNode): string {
  const names = node.writes.filter((name) => !name.includes("."));
  return names.length === 0 ? "모듈 변수 변경: global 문으로 모듈 변수를 바꾼다" : `모듈 변수 변경: global 문으로 ${names.join(", ")}을 바꾼다`;
}

/** LLM 요약을 만드는 중인 노드의 도는 원. 상자는 안에 든 노드의 요청까지 센다. */
export function busyTip(node: AtlasNode, count: number): string {
  const inside = node.kind === "module" || node.kind === "package" ? " · 이 상자와 안에 든 노드" : "";
  return `LLM 요약을 만드는 중 ${count}개${inside}`;
}

/** 편재 노드 배지 `←N` */
export function inflowTip(count: number): string {
  return [`편재 노드: 선을 숨긴 출발 노드 ${count}개`, "화면에 보이는 상자의 절반 이상이 이 노드를 써서 들어오는 선을 숨겼다", "이 노드를 고르면 숨긴 선을 다시 그린다"].join("\n");
}

/** 이름표 옆 줄 수 숫자 */
export function locTip(node: AtlasNode): string {
  return `줄 수 ${node.loc}줄 · 빈 줄을 뺀 수`;
}

/** 마우스 아래 요소나 그 조상이 담은 말풍선 글. 없으면 null이다. */
export function tipOf(target: EventTarget | null): string | null {
  return target instanceof Element ? (target.closest<HTMLElement>("[data-tip]")?.dataset.tip ?? null) : null;
}
