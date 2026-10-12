// 말풍선에 적는 글. 요소가 `data-tip`에 글을 담으면 마우스를 올리거나 키보드 초점을 받았을 때 말풍선(`Tooltip.tsx`)이 그 글을 띄운다.
// 그래프에서는 그래프 뷰가 마우스 아래 배지와 표시에서 그 글을 찾아 노드의 말풍선 대신 띄운다. 줄은 `\n`으로 나눈다.
// 선의 말풍선은 줄마다 세 칸으로 따로 그린다(`rows.ts`, `LineBubble.tsx`).
import type { AtlasNode, Change } from "../api/types";
import type { Lines } from "./compare";
import { valueAside } from "./names";
import type { Pack } from "./visible";

export const ENTRY_TIP = "진입점: 실행을 시작하는 코드";

export const CHANGE_TIPS: Record<Change, string> = {
  modified: "수정: 마지막 커밋 뒤 바뀜",
  added: "추가: 마지막 커밋에 없음",
};

/**
 * 상자의 오른쪽 위 배지. 줄이지 않은 줄 수 loc 뒤에 안에 든 것의 수 inside를 적는다. 파일 상자는 안에 든 함수·클래스·변수 수,
 * 폴더는 안에 든 파일 수이고, 안에 든 것이 없는 상자와 클래스는 줄 수만 적는다.
 */
export function sizeTip(node: AtlasNode, loc: number, inside: number): string {
  const lines = `줄 수 ${loc}줄 · 빈 줄을 뺀 수`;
  if (inside === 0) {
    return lines;
  }
  return node.kind === "package" ? `${lines} · 안에 든 파일 ${inside}개` : `${lines} · 안에 든 함수·클래스·변수 ${inside}개`;
}

/** 시점 비교에서 이름 옆에 적는 줄 수. 0인 쪽은 적지 않는다. */
export function diffTip(lines: Lines): string {
  const parts = [lines.added > 0 ? `추가된 줄 ${lines.added}줄` : null, lines.deleted > 0 ? `삭제된 줄 ${lines.deleted}줄` : null];
  return `기준 시점과 대상 시점 사이 · ${parts.filter((part) => part !== null).join(" · ")}`;
}

/** 모듈 변수 변경 배지 `g`. names는 그 함수에서 나가는 바꿈 선의 도착 변수 이름이다. */
export function globalTip(names: string[]): string {
  return names.length === 0 ? "모듈 변수 변경: 모듈 변수를 바꾼다" : `모듈 변수 변경: ${names.join(", ")}을 바꾼다`;
}

/** LLM 요약을 만드는 중인 노드의 도는 원. 파일 상자는 안에 든 노드의 요청까지 세고, 요약이 없는 폴더는 안에 든 노드의 요청만 센다. */
export function busyTip(node: AtlasNode, count: number): string {
  if (node.kind === "package") {
    return `LLM 요약을 만드는 중 · 안에 든 노드 남은 ${count}개`;
  }
  return `LLM 요약을 만드는 중 ${count}개${node.kind === "module" ? " · 이 상자와 안에 든 노드" : ""}`;
}

/** 변수 노드의 말풍선. 값의 종류와 원소 수 뒤에 값 식의 글을 적는다. 글이 없는 값은 종류와 원소 수만 적는다. */
export function valueTip(node: AtlasNode): string {
  const aside = valueAside(node);
  return node.value === null || node.value.text === "" ? aside : `${aside} · ${node.value.text}`;
}

const NAMES_MAX = 5;

/** 이름을 쉼표로 잇고 여섯 개부터는 "외 k개"로 줄인다. */
function listed(names: string[]): string {
  const rest = names.length - NAMES_MAX;
  return names.slice(0, NAMES_MAX).join(", ") + (rest > 0 ? ` 외 ${rest}개` : "");
}

/**
 * 손잡이에 든 안쪽 자식의 수. 변수가 없으면 `내부 함수 k개`, 변수가 있으면 함수·클래스와 변수를 나눠 `내부 함수 14개 · 변수 6개`,
 * 변수만 있으면 `내부 변수 k개`다. 손잡이의 글과 말풍선이 함께 쓴다.
 */
export function packCount(pack: Pick<Pack, "definitions" | "variables">): string {
  if (pack.variables === 0) {
    return `내부 함수 ${pack.definitions}개`;
  }
  return pack.definitions === 0 ? `내부 변수 ${pack.variables}개` : `내부 함수 ${pack.definitions}개 · 변수 ${pack.variables}개`;
}

/** 손잡이. 파일 밖과 선이 없는 정의의 수와 이름을 적는다. names는 그 정의의 이름표다. */
export function packTip(pack: Pick<Pack, "definitions" | "variables">, names: string[]): string {
  return `이 파일 안에서만 쓰이는 ${packCount(pack)} · ${listed(names)}`;
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

/**
 * 노드의 말풍선. 이름표가 말줄임으로 잘린 노드는 줄이지 않은 이름 full을, LLM 요약이 있는 노드는 그 요지 lead를,
 * 미사용 후보 표시가 표시한 후보는 그 뜻을 줄마다 적는다. 적을 줄이 없으면 null이다.
 */
export function nodeTip(full: string | null, lead: string | null, unused: boolean): string | null {
  const lines = [full, lead, unused ? UNUSED_TIP : null].filter((line) => line !== null);
  return lines.length === 0 ? null : lines.join("\n");
}

/** 요소나 그 자식의 글자가 말줄임으로 잘렸는지 */
export function clipped(element: Element | null): boolean {
  return element !== null && [element, ...element.children].some((each) => each.scrollWidth > each.clientWidth);
}

/**
 * 마우스 아래 요소나 그 조상이 담은 말풍선 글. `data-full`에 담은 줄이지 않은 이름은 그 요소의 글자가 말줄임으로 잘렸을 때만 첫 줄에 적고,
 * `data-tip`에 담은 글은 늘 적는다. 적을 글이 없으면 null이다.
 */
export function tipOf(target: EventTarget | null): string | null {
  const holder = target instanceof Element ? target.closest<HTMLElement>("[data-tip], [data-full]") : null;
  if (holder === null) {
    return null;
  }
  const { full, tip } = holder.dataset;
  const lines = [full !== undefined && clipped(holder) ? full : undefined, tip].filter((line) => line !== undefined && line !== "");
  return lines.length === 0 ? null : lines.join("\n");
}
