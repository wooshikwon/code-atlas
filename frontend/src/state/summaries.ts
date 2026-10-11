// 노드마다의 LLM 요약과 요약 요청. 요청은 정보 패널이 아니라 이 저장소가 보내므로 다른 노드를 고르거나 폴더를 접거나
// 뷰를 바꿔도 끝까지 가고, 그 노드를 다시 고르면 만드는 중인 상태나 끝난 결과가 보인다.
import { create } from "zustand";
import { getSummary, makeSummary } from "../api/client";

/** stale은 요약을 만든 뒤 코드나 앞뒤 흐름이 바뀌었다는 뜻이고, refresh는 캐시에 있어도 다시 만든 요청이다. */
export type SummaryState =
  | { phase: "reading" }
  | { phase: "empty" }
  | { phase: "making" }
  | { phase: "done"; summary: string; available: boolean; stale: boolean }
  | { phase: "failed"; error: string; refresh: boolean }
  | { phase: "unavailable"; reason: string };

export interface SummaryStore {
  /** 노드 id → 요약 상태. 한 번도 읽지 않은 노드는 없다. */
  states: Record<string, SummaryState>;
  /** 캐시에 있는 요약을 읽는다. 읽는 중이거나 만드는 중이거나 이미 결과(요약, 실패)가 있는 노드는 다시 읽지 않는다. */
  read(node: string): void;
  /** 캐시에 없으면 요약을 만든다. refresh면 캐시에 있어도 다시 만든다. 만드는 중인 노드에는 요청을 다시 보내지 않는다. */
  make(node: string, refresh: boolean): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const useSummaries = create<SummaryStore>()((set, get) => {
  const put = (node: string, state: SummaryState) => set((store) => ({ states: { ...store.states, [node]: state } }));

  return {
    states: {},
    read: (node) => {
      const phase = get().states[node]?.phase;
      if (phase !== undefined && phase !== "empty" && phase !== "unavailable") {
        return;
      }
      if (phase === undefined) {
        put(node, { phase: "reading" });
      }
      getSummary(node).then(
        (cached) => {
          if (get().states[node]?.phase === "making") {
            return;
          }
          if (cached.summary !== null) {
            put(node, { phase: "done", summary: cached.summary, available: cached.available, stale: cached.stale });
          } else if (!cached.available) {
            put(node, { phase: "unavailable", reason: cached.reason ?? "Claude Code CLI를 부르지 못한다" });
          } else {
            put(node, { phase: "empty" });
          }
        },
        (error: unknown) => get().states[node]?.phase !== "making" && put(node, { phase: "failed", error: message(error), refresh: false }),
      );
    },
    make: (node, refresh) => {
      if (get().states[node]?.phase === "making") {
        return;
      }
      put(node, { phase: "making" });
      makeSummary(node, refresh).then(
        (made) => put(node, { phase: "done", summary: made.summary, available: true, stale: false }),
        (error: unknown) => put(node, { phase: "failed", error: message(error), refresh }),
      );
    },
  };
});

/** 요약을 만드는 중인 노드 id를 줄마다 하나씩 적은 문자열. 집합이 같으면 같은 문자열이라 선택자로 쓴다. */
export function makingKey(store: SummaryStore): string {
  return Object.keys(store.states)
    .filter((node) => store.states[node].phase === "making")
    .sort()
    .join("\n");
}

export function makingOf(key: string): string[] {
  return key === "" ? [] : key.split("\n");
}
