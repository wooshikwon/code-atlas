// 노드의 우클릭 메뉴. 그래프의 노드와 파일트리의 행이 `useNodeMenu`의 show로 열고 App이 한 번 그린다. 항목은 그 노드의 LLM 요약
// 요청이다(`ask.ts`). 메뉴를 열거나 항목을 골라도 선택과 화면, 탐색 이력은 바뀌지 않고, 경로 고정 중에도 열린다.
// 메뉴에서 요청한 요약을 만들지 못하면 관계 그래프 영역 위쪽에 까닭을 적는다.
import { useMemo } from "react";
import { create } from "zustand";
import { titleOf } from "../graph/layout";
import { nodeIndex } from "../graph/visible";
import { useAtlas } from "../state/store";
import { useSummaries } from "../state/summaries";
import { asksOf } from "./ask";
import { MenuList, type MenuItem } from "./MenuList";

interface NodeMenuStore {
  /** 편 메뉴의 노드와 메뉴 왼쪽 위 모서리의 화면 좌표. first는 키보드로 열었는지다. */
  at: { node: string; x: number; y: number; first: boolean } | null;
  /** 메뉴에서 요약을 요청한 노드 가운데 아직 만드는 중이거나 만들지 못한 노드 */
  asked: string[];
  /** 요약 항목이 있는 노드면 메뉴를 열고 참을 돌려준다. 폴더와 외부 노드는 열지 않는다. */
  show(node: string, x: number, y: number, first: boolean): boolean;
  close(): void;
  /** 노드의 요약을 요청한다. 정보 패널의 요약 요청과 같은 저장소 액션을 부른다. */
  ask(nodes: string[], refresh: boolean): void;
  /** 만들지 못한 요청의 알림을 닫는다. */
  dismiss(): void;
}

const phaseOf = (node: string) => useSummaries.getState().states[node]?.phase;

export const useNodeMenu = create<NodeMenuStore>()((set, get) => ({
  at: null,
  asked: [],
  show: (node, x, y, first) => {
    const graph = useAtlas.getState().graph;
    if (graph === null || asksOf(graph, useSummaries.getState(), node).length === 0) {
      return false;
    }
    set({ at: { node, x, y, first } });
    return true;
  },
  close: () => set({ at: null }),
  ask: (nodes, refresh) => {
    const pending = get().asked.filter((node) => !nodes.includes(node) && (phaseOf(node) === "making" || phaseOf(node) === "failed"));
    set({ asked: [...pending, ...nodes] });
    for (const node of nodes) {
      useSummaries.getState().make(node, refresh);
    }
  },
  dismiss: () => set({ asked: get().asked.filter((node) => phaseOf(node) !== "failed") }),
}));

export function NodeMenu() {
  const at = useNodeMenu((s) => s.at);
  const close = useNodeMenu((s) => s.close);
  const graph = useAtlas((s) => s.graph);
  const states = useSummaries((s) => s.states);
  const leads = useSummaries((s) => s.leads);
  const items = useMemo(
    (): MenuItem[] =>
      at === null || graph === null
        ? []
        : asksOf(graph, { states, leads }, at.node).map((ask) => ({
            key: ask.key,
            label: ask.label,
            disabled: ask.disabled,
            node: at.node,
            run: () => useNodeMenu.getState().ask(ask.nodes, ask.refresh),
          })),
    [at, graph, states, leads],
  );
  if (at === null || items.length === 0) {
    return null;
  }
  return <MenuList id="node-menu" label="LLM 요약" items={items} at={at} first={at.first} onClose={close} />;
}

/**
 * 메뉴에서 요청한 요약 가운데 만들지 못한 것의 알림. 까닭마다 한 줄을 적고 누르면 닫힌다. 그 노드를 고르면 정보 패널의 요약 칸이
 * 같은 까닭과 "다시 시도"를 보인다.
 */
export function SummaryNotice() {
  const asked = useNodeMenu((s) => s.asked);
  const dismiss = useNodeMenu((s) => s.dismiss);
  const states = useSummaries((s) => s.states);
  const graph = useAtlas((s) => s.graph);
  const lines = useMemo(() => {
    const nodes = graph === null ? null : nodeIndex(graph);
    const failed = new Map<string, string[]>();
    for (const id of asked) {
      const state = states[id];
      if (state?.phase === "failed") {
        failed.set(state.error, [...(failed.get(state.error) ?? []), id]);
      }
    }
    return [...failed].map(([error, ids]) => {
      const node = nodes?.get(ids[0]);
      return ids.length === 1 ? `LLM 요약을 만들지 못했다 · ${node === undefined ? ids[0] : titleOf(node)}: ${error}` : `LLM 요약 ${ids.length}개를 만들지 못했다 · ${error}`;
    });
  }, [asked, states, graph]);
  if (lines.length === 0) {
    return null;
  }
  return (
    <button className="summary-notice" role="alert" data-tip="닫기" onClick={dismiss}>
      {lines.join("\n")}
    </button>
  );
}
