// 노드의 우클릭 메뉴에 적는 LLM 요약 항목. 요약이 있는지와 만드는 중인지는 요약 저장소(`state/summaries.ts`)의 상태에서 읽는다.
import type { AtlasNode, Graph, NodeKind } from "../api/types";
import { nodeIndex, within } from "../graph/visible";
import type { SummaryStore } from "../state/summaries";

/** 서버가 요약을 만드는 노드 종류. 폴더와 외부 노드는 요약이 없다. */
const SUMMARIZED = new Set<NodeKind>(["module", "class", "dataclass", "function", "method"]);
/** 폴더의 "모두 요약"이 요청하는 노드 종류 */
const FILES = new Set<NodeKind>(["module"]);

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

/** id와 그 아래의 노드 가운데 종류가 kinds에 들고, 토글로 숨긴 노드 off에 들지 않고, 요약이 없고 만드는 중도 아닌 노드 */
function bare(graph: Graph, nodes: Map<string, AtlasNode>, store: Kept, off: Set<string>, id: string, kinds: Set<NodeKind>): string[] {
  return graph.nodes
    .filter((each) => kinds.has(each.kind) && !off.has(each.id) && within(nodes, each.id, id) && !making(store, each.id) && !kept(store, each.id))
    .map((each) => each.id);
}

const all = (label: string, nodes: string[]): Ask => ({ key: "all", label: `${label} (${nodes.length}개)`, disabled: nodes.length === 0, nodes, refresh: false });

/**
 * 노드 id의 요약 항목. 파일·클래스·함수·메서드의 첫 항목은 그 노드의 요약이고 이름은 요약 상태를 따른다. 파일은 그 파일과 안에 든
 * 클래스·함수·메서드 가운데 요약이 없고 만드는 중도 아닌 것을 모두 요청하는 항목이 더해진다. 폴더는 요약이 없으므로 그 폴더 아래의
 * 파일(하위 폴더의 파일 포함) 가운데 요약이 없고 만드는 중도 아닌 것을 모두 요청하는 항목 하나만 있다. 토글로 숨긴 노드 off는
 * 모두 요청하는 항목의 대상에 들지 않는다. 외부 노드와 그래프에 없는 id는 항목이 없다.
 */
export function asksOf(graph: Graph, store: Kept, off: Set<string>, id: string): Ask[] {
  const nodes = nodeIndex(graph);
  const node = nodes.get(id);
  if (node?.kind === "package") {
    return [all("안에 든 파일 모두 요약", bare(graph, nodes, store, off, id, FILES))];
  }
  if (node === undefined || !SUMMARIZED.has(node.kind)) {
    return [];
  }
  const one: Ask = making(store, id)
    ? { key: "one", label: "요약 만드는 중", disabled: true, nodes: [], refresh: false }
    : kept(store, id)
      ? { key: "one", label: "요약 다시 만들기", disabled: false, nodes: [id], refresh: true }
      : { key: "one", label: "LLM 요약 요청", disabled: false, nodes: [id], refresh: false };
  return node.kind === "module" ? [one, all("이 파일과 안에 든 정의 모두 요약", bare(graph, nodes, store, off, id, SUMMARIZED))] : [one];
}
