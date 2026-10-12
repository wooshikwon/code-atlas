// 노드의 우클릭 메뉴에 적는 LLM 요약 항목. 요약이 있는지와 만드는 중인지는 요약 저장소(`state/summaries.ts`)의 상태에서 읽는다.
import type { Graph, NodeKind } from "../api/types";
import { nodeIndex, within } from "../graph/visible";
import type { SummaryStore } from "../state/summaries";

/** 서버가 요약을 만드는 노드 종류. 폴더와 외부 노드는 요약이 없다. */
const SUMMARIZED = new Set<NodeKind>(["module", "class", "dataclass", "function", "method"]);

export interface Ask {
  key: "one" | "all";
  label: string;
  disabled: boolean;
  /** 항목을 고르면 요약을 요청하는 노드 */
  nodes: string[];
  /** 캐시에 있어도 다시 만드는 요청인지 */
  refresh: boolean;
}

type Kept = Pick<SummaryStore, "states" | "leads">;

const making = (store: Kept, id: string) => store.states[id]?.phase === "making";
const kept = (store: Kept, id: string) => store.states[id]?.phase === "done" || store.leads[id] !== undefined;

/**
 * 노드 id의 요약 항목. 첫 항목은 그 노드의 요약이고 이름은 요약 상태를 따른다. 파일은 안에 든 클래스·함수·메서드 가운데
 * 요약이 없고 만드는 중도 아닌 정의를 모두 요청하는 항목이 더해진다. 요약이 없는 종류의 노드와 그래프에 없는 id는 항목이 없다.
 */
export function asksOf(graph: Graph, store: Kept, id: string): Ask[] {
  const nodes = nodeIndex(graph);
  const node = nodes.get(id);
  if (node === undefined || !SUMMARIZED.has(node.kind)) {
    return [];
  }
  const one: Ask = making(store, id)
    ? { key: "one", label: "요약 만드는 중", disabled: true, nodes: [], refresh: false }
    : kept(store, id)
      ? { key: "one", label: "요약 다시 만들기", disabled: false, nodes: [id], refresh: true }
      : { key: "one", label: "LLM 요약 요청", disabled: false, nodes: [id], refresh: false };
  if (node.kind !== "module") {
    return [one];
  }
  const bare = graph.nodes
    .filter((each) => each.id !== id && SUMMARIZED.has(each.kind) && within(nodes, each.id, id) && !making(store, each.id) && !kept(store, each.id))
    .map((each) => each.id);
  return [one, { key: "all", label: `안에 든 정의 ${bare.length}개 모두 요약`, disabled: bare.length === 0, nodes: bare, refresh: false }];
}
