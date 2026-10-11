// 노드에 단 배지와 표시 위에 마우스를 올렸을 때 말풍선에 적는 글. 배지 요소가 `data-tip`에 글을 담고,
// 그래프 뷰가 마우스 아래 요소에서 그 글을 찾아 노드의 말풍선 대신 띄운다. 줄은 `\n`으로 나눈다.
import type { AtlasNode, Change } from "../api/types";

export const ENTRY_TIP = "진입점: 실행을 시작하는 코드";

export const CHANGE_TIPS: Record<Change, string> = {
  modified: "수정: 마지막 커밋 뒤 바뀜",
  added: "추가: 마지막 커밋에 없음",
};

/** 접힌 상자의 오른쪽 위 배지. 파일 상자는 안에 든 함수·클래스 수, 폴더 상자는 안에 든 파일 수다. */
export function insideTip(node: AtlasNode, count: number): string {
  return node.kind === "package" ? `안에 든 파일 ${count}개 · 펼치면 보인다` : `안에 든 함수·클래스 ${count}개 · 고르면 보인다`;
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

/** 이름표 옆 줄 수 숫자 */
export function locTip(node: AtlasNode): string {
  return `줄 수 ${node.loc}줄 · 빈 줄을 뺀 수`;
}

const NAMES_MAX = 5;

/** 이름을 쉼표로 잇고 여섯 개부터는 "외 k개"로 줄인다. */
function listed(names: string[]): string {
  const rest = names.length - NAMES_MAX;
  return names.slice(0, NAMES_MAX).join(", ") + (rest > 0 ? ` 외 ${rest}개` : "");
}

/** 손잡이. 상자 밖과 선이 없는 자식의 수와 이름을 적는다. box는 손잡이를 단 상자이고 names는 그 자식의 이름표다. */
export function packTip(box: AtlasNode, names: string[]): string {
  const what = box.kind === "package" ? "이 폴더 안에서만 쓰이는 파일" : "이 파일 안에서만 쓰이는 정의";
  return `${what} ${names.length}개 · ${listed(names)}`;
}

/**
 * 순환 아이콘. groups는 묶음마다 든 파일의 이름표다. 묶음마다 파일 이름을 한 줄에 적고 여섯 개부터는 "외 k개"로 줄인다.
 * 접힌 폴더 상자는 안에 든 파일의 묶음임을 밝히고, 묶음이 여럿이면 묶음 수를 적는다.
 */
export function cycleTip(node: AtlasNode, groups: string[][]): string {
  const inside = node.kind === "package" ? " · 이 폴더 안의 파일이 든 묶음" : "";
  if (groups.length === 1) {
    return `순환 묶음: 파일 ${groups[0].length}개가 서로를 import해 돌아온다${inside}\n${listed(groups[0])}`;
  }
  return [`순환 묶음 ${groups.length}개${inside}`, ...groups.map((files) => `파일 ${files.length}개: ${listed(files)}`)].join("\n");
}

export const UNUSED_TIP = "미사용 후보 · 들어오는 실행·사용 선이 없다 · 동적 호출이면 실제로는 쓰일 수 있다";

/** 접힌 상자 아래 글자의 미사용 후보 수. 상자 안의 후보를 합친 수다. */
export function candidatesTip(node: AtlasNode, count: number): string {
  const inside = node.kind === "package" ? "이 폴더 안의 정의에서 합친 수" : "이 파일 안의 정의에서 합친 수";
  return `미사용 후보 ${count}개 · ${inside}\n들어오는 실행·사용 선이 없다 · 동적 호출이면 실제로는 쓰일 수 있다`;
}

/** 노드의 말풍선. 이름과 종류를 적고, 미사용 덮개가 표시한 후보면 둘째 줄에 그 뜻을 적는다. */
export function nodeTip(title: string, kind: string, unused: boolean): string {
  return unused ? `${title} · ${kind}\n${UNUSED_TIP}` : `${title} · ${kind}`;
}

/** 줄기의 말풍선. 줄기에 든 선을 내보내는 노드 수, 도착 노드의 이름, 줄기에 든 선의 sites 수 합을 적는다. */
export function trunkTip(sources: number, target: string, sites: number): string {
  return `노드 ${sources}개 → ${target} · ${sites}곳`;
}

/** 마우스 아래 요소나 그 조상이 담은 말풍선 글. 없으면 null이다. */
export function tipOf(target: EventTarget | null): string | null {
  return target instanceof Element ? (target.closest<HTMLElement>("[data-tip]")?.dataset.tip ?? null) : null;
}
