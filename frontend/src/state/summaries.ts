// 노드마다의 LLM 요약과 요약 요청. 요청은 정보 패널이 아니라 이 저장소가 보내므로 다른 노드를 고르거나 폴더를 접거나
// 뷰를 바꿔도 끝까지 가고, 그 노드를 다시 고르면 만드는 중인 상태나 끝난 결과가 보인다. 요청이 여럿이면 서버로 둘씩 보내고
// 나머지는 차례를 기다리며, 차례를 기다리는 요청은 취소한다.
import { create } from "zustand";
import { getSummaries, getSummary, makeSummary } from "../api/client";
import type { Usage } from "../api/types";
import { partsOf } from "../panel/parts";
import { added } from "./usage";

/**
 * 서버로 한꺼번에 보내는 요약 요청의 수. 서버가 요약을 둘씩 만들고(`summary.py`의 `MAX_PROCESSES`) 브라우저는 한 서버에 연결을
 * 여섯 개까지만 열므로, 더 보내면 기다리는 요청이 연결을 차지해 다른 API 호출이 늦어진다.
 */
export const MAX_REQUESTS = 2;

/**
 * stale은 요약을 만든 뒤 코드나 앞뒤 흐름이 바뀌었다는 뜻이고, refresh는 캐시에 있어도 다시 만든 요청이다. 차례를 기다리는 요청도 making이다.
 * usage는 이 화면의 요청으로 요약을 만든 호출의 사용량이고, 캐시에서 읽은 요약은 null이다.
 */
export type SummaryState =
  | { phase: "reading" }
  | { phase: "empty" }
  | { phase: "making" }
  | { phase: "done"; summary: string; available: boolean; stale: boolean; usage: Usage | null }
  | { phase: "failed"; error: string; refresh: boolean }
  | { phase: "unavailable"; reason: string; code: string | null };

/**
 * 요청 묶음의 진행. 묶음은 기다리는 요청도 보낸 요청도 없을 때 들어온 요청에서 시작하고, 둘이 다시 없어지면 끝난다.
 * 묶음이 없는 동안은 수가 모두 0이다.
 */
export interface Batch {
  /** 묶음이 시작된 뒤 요청한 수. 취소하면 그때 서버로 보낸 요청의 수에서 다시 센다. */
  total: number;
  /** 그 가운데 끝난 수. 만든 것과 만들지 못한 것을 함께 센다. */
  ended: number;
  /** 끝난 것 가운데 만들지 못한 수 */
  failed: number;
  /** 차례를 기다린 요청이 있었는지. 요청을 한꺼번에 `MAX_REQUESTS`개보다 많이 받은 묶음이다. */
  held: boolean;
  /** 차례를 기다리던 요청을 취소했는지 */
  cancelled: boolean;
  /** 묶음에서 끝난 요청의 사용량 합. 사용량을 담은 응답이 아직 없으면 null이다. 취소해도 그대로 둔다. */
  usage: Usage | null;
}

const IDLE: Batch = { total: 0, ended: 0, failed: 0, held: false, cancelled: false, usage: null };

export interface SummaryStore {
  /** 노드 id → 요약 상태. 한 번도 읽지 않은 노드는 없다. */
  states: Record<string, SummaryState>;
  /** 노드 id → 요약의 요지. 요약이 있는 노드만 담는다. 노드의 말풍선이 적는다. */
  leads: Record<string, string>;
  /** 서버로 보낼 차례를 기다리는 요청. 앞에서부터 보낸다. before는 요청하기 전의 요약 상태다. */
  waiting: { node: string; refresh: boolean; before: SummaryState | undefined }[];
  /** 서버로 보내고 응답을 기다리는 요청의 수 */
  sent: number;
  batch: Batch;
  /** 레포에 남겨 둔 요약의 요지를 한 번에 받아 `leads`를 바꾼다. 받는 동안 화면에서 만든 요약의 요지는 그대로 둔다. */
  list(): void;
  /** 캐시에 있는 요약을 읽는다. 읽는 중이거나 만드는 중이거나 이미 결과(요약, 실패)가 있는 노드는 다시 읽지 않는다. */
  read(node: string): void;
  /**
   * 캐시에 없으면 요약을 만든다. refresh면 캐시에 있어도 다시 만든다. 만드는 중인 노드에는 요청을 다시 보내지 않는다.
   * 서버로 보낸 요청이 `MAX_REQUESTS`개면 앞의 요청이 끝날 때까지 기다렸다가 보낸다.
   */
  make(node: string, refresh: boolean): void;
  /**
   * 차례를 기다리는 요청을 모두 뺀다. 뺀 노드의 요약 상태는 요청하기 전으로 돌아가고, 서버로 보낸 요청은 끝까지 간다.
   * 요청하기 전에 읽는 중이던 노드는 읽지 않은 노드로 돌아간다.
   */
  cancel(): void;
  /** 읽어 둔 요약을 버려 다음에 고를 때 다시 읽게 한다. 만드는 중인 노드는 그대로 두고, 차례를 기다리는 요청은 취소하면 읽지 않은 노드로 돌아간다. */
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
        const { sent, batch } = get();
        set({
          sent: sent - 1,
          batch: {
            ...batch,
            ended: batch.ended + 1,
            failed: batch.failed + (state.phase === "failed" ? 1 : 0),
            usage: added(batch.usage, state.phase === "done" ? state.usage : null),
          },
        });
        put(node, state);
        send();
        if (get().sent === 0) {
          set({ batch: IDLE });
        }
      };
      makeSummary(node, refresh).then(
        (made) => finish({ phase: "done", summary: made.summary, available: true, stale: false, usage: made.usage }),
        (error: unknown) => finish({ phase: "failed", error: message(error), refresh }),
      );
    }
  };

  return {
    states: {},
    leads: {},
    waiting: [],
    sent: 0,
    batch: IDLE,
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
            put(node, { phase: "done", summary: cached.summary, available: cached.available, stale: cached.stale, usage: null });
          } else if (!cached.available) {
            put(node, { phase: "unavailable", reason: cached.reason ?? "Claude Code CLI를 부르지 못합니다", code: cached.code });
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
      const before = get().states[node];
      put(node, { phase: "making" });
      set({ waiting: [...get().waiting, { node, refresh, before }], batch: { ...get().batch, total: get().batch.total + 1 } });
      send();
      if (get().waiting.length > 0) {
        set({ batch: { ...get().batch, held: true } });
      }
    },
    cancel: () =>
      set((store) => {
        const states = { ...store.states };
        for (const { node, before } of store.waiting) {
          if (before === undefined || before.phase === "reading") {
            delete states[node];
          } else {
            states[node] = before;
          }
        }
        return { states, waiting: [], batch: store.sent === 0 ? IDLE : { total: store.sent, ended: 0, failed: 0, held: true, cancelled: true, usage: store.batch.usage } };
      }),
    forget: () =>
      set((store) => ({
        states: Object.fromEntries(Object.entries(store.states).filter(([, state]) => state.phase === "making")),
        waiting: store.waiting.map((each) => ({ ...each, before: undefined })),
      })),
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
