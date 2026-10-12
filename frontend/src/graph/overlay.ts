// 분석 표시가 그래프에 더하는 표시. 순환 아이콘을 다는 상자, 순환 선, 파일과 폴더마다의 미사용 후보 수를 정한다.
// 배치는 순환 아이콘의 폭만 쓰고, 분석 표시를 켜고 꺼도 결과가 같은 `cycleMarks`만 부른다.
import type { AtlasNode, Graph } from "../api/types";
import type { Cycles } from "./cycles";
import type { Flow } from "./flow";
import type { Lit } from "./route";
import { EDGE_OPACITY, edgeKey, picked, type DrawnEdge, type EdgeKey } from "./scope";
import { lift, nodeIndex, unitOf, type Shown } from "./visible";

/** 미사용 후보 표시가 표시하는 후보의 불투명도. 초점 불투명도가 더 낮으면 그 값을 쓴다. */
export const UNUSED_OPACITY = 0.4;

/**
 * 순환 아이콘을 다는 상자와 그 상자에 적을 묶음마다의 파일 id. 묶음에 든 파일 상자와, 묶음에 든 파일을 품은 접힌 폴더 상자다.
 * 접힌 폴더가 여러 묶음의 파일을 품으면 묶음을 모두 담는다. 펼친 폴더 영역에는 달지 않는다.
 */
export function cycleMarks(graph: Graph, cycles: Cycles, shown: Shown): Map<string, string[][]> {
  const nodes = nodeIndex(graph);
  const open = new Set([...shown.nodes].map((id) => nodes.get(id)?.parent));
  const groups = new Map<string, Set<number>>();
  for (const [id, group] of cycles.member) {
    const box = lift(nodes, shown, id);
    if (box === null || (nodes.get(box)!.kind === "package" && open.has(box))) {
      continue;
    }
    groups.set(box, (groups.get(box) ?? new Set()).add(group));
  }
  return new Map([...groups].map(([box, found]) => [box, [...found].sort((a, b) => a - b).map((i) => cycles.groups[i])]));
}

/**
 * 순환 의존 표시를 켰을 때 그릴 선과 그 가운데 순환 선의 키. 순환 선은 양 끝이 화면에 보이는 파일 상자인 묶음 안 import 선이고,
 * 접힌 폴더로 올라간 집계 선은 순환 선이 아니다. 두 파일 상자 사이의 집계 선이 그 import 선을 합쳤으면 집계 선이 순환 선이다.
 * 그리는 범위 규칙으로 빠진 순환 선은 다시 넣는다. 순환 선은 초점과 관계없이 불투명도 1로 그려 critical 색의 대비를 지킨다.
 * 경로 고정 중(lit이 있다)에는 경로가 먼저 읽히도록 순환 선도 경로 밖 선의 불투명도로 그리고 색만 남긴다.
 */
export function cycleLines(
  graph: Graph,
  shown: Shown,
  flow: Flow | null,
  lit: Lit | null,
  edges: DrawnEdge[],
  cycles: Cycles,
): { edges: DrawnEdge[]; keys: Set<EdgeKey> } {
  const nodes = nodeIndex(graph);
  const file = (id: string) => shown.nodes.has(id) && nodes.get(id)?.kind === "module";
  const keys = new Set<EdgeKey>();
  const added: DrawnEdge[] = [];
  for (const edge of graph.edges) {
    const key = edgeKey(edge);
    if (!cycles.edges.has(key) || !file(edge.source) || !file(edge.target)) {
      continue;
    }
    const found = edges.find((e) => e.source === edge.source && e.target === edge.target && e.edges.includes(edge));
    if (found !== undefined) {
      keys.add(found.key);
      continue;
    }
    const line = picked(graph, shown, flow, key);
    if (line !== null) {
      added.push(line);
      keys.add(key);
    }
  }
  const opacity = lit === null ? EDGE_OPACITY.full : EDGE_OPACITY.rest;
  return { edges: [...edges, ...added].map((e) => (keys.has(e.key) ? { ...e, opacity } : e)), keys };
}

/** 파일과 그 파일을 품은 폴더마다 그 안에 든 미사용 후보 수. 그래프에 없는 id는 세지 않는다. */
export function unusedCounts(graph: Graph, unused: Set<string>): Map<string, number> {
  const nodes = nodeIndex(graph);
  const counts = new Map<string, number>();
  for (const id of unused) {
    const file: AtlasNode | undefined = nodes.get(unitOf(nodes, id));
    if (!nodes.has(id) || file?.kind !== "module") {
      continue;
    }
    for (let at: AtlasNode | undefined = file; at !== undefined; at = at.parent === null ? undefined : nodes.get(at.parent)) {
      counts.set(at.id, (counts.get(at.id) ?? 0) + 1);
    }
  }
  return counts;
}
