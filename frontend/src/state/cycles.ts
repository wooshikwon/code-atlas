// 지금 토글에서 보이는 그래프의 순환 묶음. 그래프와 토글만으로 정해지므로 저장소에 두지 않고 화면이 계산한다.
import { useMemo } from "react";
import { cycles, type Cycles } from "../graph/cycles";
import { hidden } from "../graph/visible";
import { useAtlas } from "./store";

/** 그래프를 아직 받지 못했으면 null이다. */
export function useCycles(): Cycles | null {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  return useMemo(
    () => (graph === null ? null : cycles(graph, hidden(graph, { showTests, showExternal }))),
    [graph, showTests, showExternal],
  );
}
