// 노드마다의 LLM 요약과 요약 요청. 요청은 정보 패널이 아니라 이 저장소가 보내므로 다른 노드를 고르거나 폴더를 접거나
// 뷰를 바꿔도 끝까지 가고, 그 노드를 다시 고르면 만드는 중인 상태나 끝난 결과가 보인다. 요청이 여럿이면 서버로 둘씩 보내고
// 나머지는 차례를 기다린다.
import { create } from "zustand";
import { getSummaries, getSummary, makeSummary } from "../api/client";
import { partsOf } from "../panel/parts";

/**
 * 서버로 한꺼번에 보내는 요약 요청의 수. 서버가 요약을 둘씩 만들고(`summary.py`의 `MAX_PROCESSES`) 브라우저는 한 서버에 연결을
 * 여섯 개까지만 열므로, 더 보내면 기다리는 요청이 연결을 차지해 다른 API 호출이 늦어진다.
 */
export const MAX_REQUESTS = 2;

/** stale은 요약을 만든 뒤 코드나 앞뒤 흐름이 바뀌었다는 뜻이고, refresh는 캐시에 있어도 다시 만든 요청이다. 차례를 기다리는 요청도 making이다. */
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
  /** 노드 id → 요약의 요지. 요약이 있는 노드만 담는다. 노드의 말풍선이 적는다. */
  leads: Record<string, string>;
  /** 서버로 보낼 차례를 기다리는 요청. 앞에서부터 보낸다. */
  waiting: { node: string; refresh: boolean }[];
  /** 서버로 보내고 응답을 기다리는 요청의 수 */
  sent: number;
  /** 레포에 남겨 둔 요약의 요지를 한 번에 받아 `leads`를 바꾼다. 받는 동안 화면에서 만든 요약의 요지는 그대로 둔다. */
  list(): void;
  /** 캐시에 있는 요약을 읽는다. 읽는 중이거나 만드는 중이거나 이미 결과(요약, 실패)가 있는 노드는 다시 읽지 않는다. */
  read(node: string): void;
  /**
   * 캐시에 없으면 요약을 만든다. refresh면 캐시에 있어도 다시 만든다. 만드는 중인 노드에는 요청을 다시 보내지 않는다.
   * 서버로 보낸 요청이 `MAX_REQUESTS`개면 앞의 요청이 끝날 때까지 기다렸다가 보낸다.
   */
  make(node: string, refresh: boolean): void;
  /** 읽어 둔 요약을 버려 다음에 고를 때 다시 읽게 한다. 만드는 중인 노드는 그대로 둔다. */
  forget(): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const useSummaries = create<SummaryStore>()((set, get) => {
  const put = (node: string, state: SummaryState) =>
    set((store) => ({
      states: { ...store.states, [node]: state },
      leads: state.phase === "done" ? { ...store.leads, [node]: partsOf(state.summary).lead } : store.leads,
    }));

  /** 기다리는 요청을 앞에서부터 `MAX_REQUESTS`개까지 서버로 보낸다. 요청 하나가 끝나면 다음 요청을 보낸다. */
  const send = () => {
    while (get().sent < MAX_REQUESTS && get().waiting.length > 0) {
      const [{ node, refresh }, ...waiting] = get().waiting;
      set({ waiting, sent: get().sent + 1 });
      const finish = (state: SummaryState) => {
        set({ sent: get().sent - 1 });
        put(node, state);
        send();
      };
      makeSummary(node, refresh).then(
        (made) => finish({ phase: "done", summary: made.summary, available: true, stale: false }),
        (error: unknown) => finish({ phase: "failed", error: message(error), refresh }),
      );
    }
  };

  return {
    states: {},
    leads: {},
    waiting: [],
    sent: 0,
    list: () => {
      const before = get().leads;
      getSummaries().then(
        ({ summaries }) =>
          set((store) => ({
            leads: {
              ...Object.fromEntries(summaries.map(({ node, lead }) => [node, lead])),
              ...Object.fromEntries(Object.entries(store.leads).filter(([node, lead]) => before[node] !== lead)),
            },
          })),
        () => undefined,
      );
    },
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
      set({ waiting: [...get().waiting, { node, refresh }] });
      send();
    },
    forget: () => set((store) => ({ states: Object.fromEntries(Object.entries(store.states).filter(([, state]) => state.phase === "making")) })),
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
