// 지금 토글에서 보이는 그래프의 순환 묶음. 그래프와 토글만으로 정해지므로 저장소에 두지 않고 화면이 계산한다.
// 시점 비교가 켜져 있으면 삭제된 노드와 선을 뺀 대상 시점의 그래프에서 찾는다.
import { useMemo } from "react";
import { liveGraph } from "../graph/compare";
import { cycles, type Cycles } from "../graph/cycles";
import { hidden } from "../graph/visible";
import { useCompare } from "./compare";
import { useAtlas } from "./store";

/** 그래프를 아직 받지 못했으면 null이다. */
export function useCycles(): Cycles | null {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const result = useCompare((s) => s.result);
  return useMemo(() => {
    if (graph === null) {
      return null;
    }
    const live = liveGraph(graph, result);
    return cycles(live, hidden(live, { showTests, showExternal }));
  }, [graph, result, showTests, showExternal]);
}
