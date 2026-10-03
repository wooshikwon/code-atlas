// 보이는 노드와 그리는 선을 정한다. 배치와 독립이므로 선을 바꿔 그려도 layout을 다시 부르지 않는다.
import type { AtlasEdge, AtlasNode, EdgeGroup, EdgeKind, Graph } from "../api/types";

export type EdgeKey = string;

/** 파일 상자 사이 집계 선. 무게는 합친 선들의 sites 수 합이다. */
export interface AggEdge {
  key: EdgeKey;
  source: string;
  target: string;
  group: EdgeGroup;
  weight: number;
  kinds: Partial<Record<EdgeKind, number>>;
}

const GROUP_ORDER: EdgeGroup[] = ["run", "use", "derive"];
const UNIT_KINDS = new Set(["module", "package"]);

export function edgeKey(edge: AtlasEdge): EdgeKey {
  return `${edge.source}|${edge.target}|${edge.kind}`;
}

export function aggKey(source: string, target: string): EdgeKey {
  return `agg|${source}|${target}`;
}

/** 외부 노드는 숨기고, 테스트 코드는 토글이 켜졌을 때만 보인다. */
export function visibleNodes(graph: Graph, showTests: boolean): Set<string> {
  return new Set(graph.nodes.filter((n) => n.kind !== "external" && (showTests || !n.test)).map((n) => n.id));
}

export function nodeIndex(graph: Graph): Map<string, AtlasNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

/** 노드가 든 가장 가까운 파일 상자. 모듈·패키지 노드는 자기 자신이다. */
export function unitOf(nodes: Map<string, AtlasNode>, id: string): string {
  let node = nodes.get(id);
  while (node !== undefined && !UNIT_KINDS.has(node.kind) && node.parent !== null) {
    node = nodes.get(node.parent);
  }
  return node?.id ?? id;
}

function drawable(edge: AtlasEdge, visible: Set<string>): boolean {
  return visible.has(edge.source) && visible.has(edge.target);
}

/** 서로 다른 파일 상자를 잇는 선을 출발·도착 상자 쌍마다 하나로 합친다. 함수 안 import는 합치지 않는다. */
export function aggregates(graph: Graph, visible: Set<string>): AggEdge[] {
  const nodes = nodeIndex(graph);
  const merged = new Map<EdgeKey, AggEdge>();
  for (const edge of graph.edges) {
    if (edge.deferred || !drawable(edge, visible)) {
      continue;
    }
    const source = unitOf(nodes, edge.source);
    const target = unitOf(nodes, edge.target);
    if (source === target) {
      continue;
    }
    const key = aggKey(source, target);
    const agg = merged.get(key) ?? { key, source, target, group: edge.group, weight: 0, kinds: {} };
    agg.weight += edge.sites.length;
    agg.kinds[edge.kind] = (agg.kinds[edge.kind] ?? 0) + edge.sites.length;
    if (GROUP_ORDER.indexOf(edge.group) < GROUP_ORDER.indexOf(agg.group)) {
      agg.group = edge.group;
    }
    merged.set(key, agg);
  }
  return [...merged.values()];
}

/**
 * 그리는 범위 규칙 1·2로 그릴 선을 고른다.
 * 1. 파일 상자 사이 집계 선과 한 파일 상자 안의 선을 그린다.
 * 2. 고르거나 마우스를 올린 노드에 닿는 선을 파일 경계를 넘는 선과 함수 안 import까지 모두 그린다.
 */
export function scope(graph: Graph, visible: Set<string>, selection: string | null, hover: string | null): EdgeKey[] {
  const nodes = nodeIndex(graph);
  const keys = aggregates(graph, visible).map((agg) => agg.key);
  const touched = new Set([selection, hover].filter((id): id is string => id !== null && nodes.has(id)));
  for (const edge of graph.edges) {
    if (!drawable(edge, visible)) {
      continue;
    }
    const inside = !edge.deferred && unitOf(nodes, edge.source) === unitOf(nodes, edge.target);
    if (inside || touched.has(edge.source) || touched.has(edge.target)) {
      keys.push(edgeKey(edge));
    }
  }
  return keys;
}
