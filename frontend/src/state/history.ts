// 탐색 이력. 한 단계는 뷰 종류, 선택, 지나온 선, 접은 폴더 집합, 전부 펼친 상자 집합이다.
import type { EdgeKey } from "../graph/scope";

export type View = { kind: "structure" } | { kind: "function"; center: string; expanded: string[] };

/** 선을 고르면 직전에 초점을 둔 노드를 focus에 담아 그래프가 그 노드의 초점을 유지한다. */
export type Selection = { type: "node"; id: string } | { type: "edge"; key: EdgeKey; focus: string | null } | null;

/** 선택에서 그래프가 초점을 두는 노드 */
export function focusOf(selection: Selection): string | null {
  if (selection === null) {
    return null;
  }
  return selection.type === "node" ? selection.id : selection.focus;
}

export interface Place {
  view: View;
  selection: Selection;
  /** 그래프에서 선을 눌러 이 단계에 왔으면 누른 선의 키. 정렬해 둔다. 다른 방법으로 왔으면 null이다. */
  via: EdgeKey[] | null;
  /** 접은 폴더의 패키지 노드 id. 같은 집합이 같은 배열이 되도록 정렬해 둔다. */
  collapsed: string[];
  /** 전부 펼침 단계인 파일 상자의 노드 id. 정렬해 둔다. */
  unpacked: string[];
}

export interface History {
  entries: Place[];
  index: number;
}

const LIMIT = 100;

/** index 뒤의 단계를 버리고 place를 넣는다. 지금 단계와 같은 place는 넣지 않는다. */
export function push(history: History, place: Place): History {
  if (JSON.stringify(history.entries[history.index]) === JSON.stringify(place)) {
    return history;
  }
  const entries = [...history.entries.slice(0, history.index + 1), place].slice(-LIMIT);
  return { entries, index: entries.length - 1 };
}

export function back(history: History): History {
  return jump(history, history.index - 1);
}

export function forward(history: History): History {
  return jump(history, history.index + 1);
}

/** 이력에 없는 번호면 history를 그대로 돌려준다. */
export function jump(history: History, index: number): History {
  if (!Number.isInteger(index) || index < 0 || index >= history.entries.length || index === history.index) {
    return history;
  }
  return { entries: history.entries, index };
}

/**
 * 모든 단계를 change로 바꾼 이력. 바꾼 뒤에 바로 앞 단계와 같아진 단계는 빼고, 지금 단계의 번호는 빠진 단계만큼 줄인다.
 */
export function remap(history: History, change: (place: Place) => Place): History {
  const entries: Place[] = [];
  let index = 0;
  history.entries.forEach((place, at) => {
    const next = change(place);
    if (entries.length === 0 || JSON.stringify(entries[entries.length - 1]) !== JSON.stringify(next)) {
      entries.push(next);
    }
    if (at === history.index) {
      index = entries.length - 1;
    }
  });
  return { entries, index };
}
