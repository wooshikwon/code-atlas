// 탐색 이력. 한 단계는 뷰 종류, 선택, 접은 폴더 집합이다.
import type { EdgeKey } from "../graph/scope";

export type View = { kind: "structure" } | { kind: "function"; center: string; expanded: string[] };

export type Selection = { type: "node"; id: string } | { type: "edge"; key: EdgeKey } | null;

export interface Place {
  view: View;
  selection: Selection;
  /** 접은 폴더의 패키지 노드 id. 같은 집합이 같은 배열이 되도록 정렬해 둔다. */
  collapsed: string[];
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
