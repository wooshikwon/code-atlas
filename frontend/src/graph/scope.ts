// 보이는 노드 사이에 그릴 선과 편재 노드를 정한다. 배치와 독립이므로 선을 바꿔 그려도 layout을 다시 부르지 않는다.
import type { AtlasEdge, AtlasNode, EdgeGroup, EdgeKind, Graph } from "../api/types";
import { opacities, type Flow } from "./flow";
import type { Tone } from "./view";
import { lift, nodeIndex, unitOf, within, type Shown } from "./visible";

export type EdgeKey = string;

/** 화면에 그리는 선 하나. 양 끝을 올려 합친 집계 선은 `agg|…` 키를, 올리지 않은 선은 edge_key를 쓴다. */
export interface DrawnEdge {
  key: EdgeKey;
  source: string;
  target: string;
  group: EdgeGroup;
  weight: number;
  kinds: Partial<Record<EdgeKind, number>>;
  tone: Tone;
  opacity: number;
  /** 합친 선이 모두 함수 안 import다. */
  deferred: boolean;
}

const GROUP_ORDER: EdgeGroup[] = ["run", "use", "derive"];
const BOX_KINDS = new Set(["module", "package", "external"]);

export function edgeKey(edge: AtlasEdge): EdgeKey {
  return `${edge.source}|${edge.target}|${edge.kind}`;
}

export function aggKey(source: string, target: string): EdgeKey {
  return `agg|${source}|${target}`;
}

/** 노드가 든 파일 상자를 화면에 보이는 가장 가까운 상자로 올린다. */
function boxOf(nodes: Map<string, AtlasNode>, shown: Shown, id: string): string | null {
  return lift(nodes, shown, unitOf(nodes, id));
}

function related(nodes: Map<string, AtlasNode>, a: string, b: string): boolean {
  return within(nodes, a, b) || within(nodes, b, a);
}

/**
 * 그리는 범위 규칙 3의 편재 노드와 그 노드로 선을 보내는 상자 수. 선의 양 끝을 보이는 상자로 올려 세고,
 * 상자 수의 절반 이상에서 선이 들어오는 상자를 고른다. 파일 상자를 펼쳐도 결과가 같다.
 */
export function ubiquitous(graph: Graph, shown: Shown): Map<string, number> {
  const nodes = nodeIndex(graph);
  const sources = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const source = boxOf(nodes, shown, edge.source);
    const target = boxOf(nodes, shown, edge.target);
    if (source === null || target === null || related(nodes, source, target)) {
      continue;
    }
    sources.set(target, (sources.get(target) ?? new Set()).add(source));
  }
  const boxes = [...shown.nodes].map((id) => nodes.get(id)!).filter((n) => BOX_KINDS.has(n.kind));
  const expanded = new Set(boxes.map((n) => n.parent));
  const count = boxes.filter((n) => !expanded.has(n.id)).length;
  return new Map([...sources].filter(([, from]) => from.size * 2 >= count).map(([id, from]) => [id, from.size]));
}

function merge(
  key: EdgeKey,
  source: string,
  target: string,
  edges: AtlasEdge[],
  flow: Flow | null,
  member: (id: string) => boolean,
  dim: Map<string, number>,
): DrawnEdge {
  const kinds: DrawnEdge["kinds"] = {};
  let group = edges[0].group;
  let weight = 0;
  for (const edge of edges) {
    weight += edge.sites.length;
    kinds[edge.kind] = (kinds[edge.kind] ?? 0) + edge.sites.length;
    if (GROUP_ORDER.indexOf(edge.group) < GROUP_ORDER.indexOf(group)) {
      group = edge.group;
    }
  }
  const touching = flow !== null && edges.some((e) => flow.seeds.has(e.source) !== flow.seeds.has(e.target));
  const tone: Tone = touching || edges.some((e) => member(e.source) && member(e.target)) ? "strong" : "muted";
  return {
    key,
    source,
    target,
    group,
    weight,
    kinds,
    tone,
    opacity: touching ? 1 : Math.min(dim.get(source)!, dim.get(target)!),
    deferred: edges.every((e) => e.deferred),
  };
}

/**
 * 모든 선의 양 끝을 보이는 가장 가까운 조상으로 올린 뒤 그리는 범위 규칙으로 그릴 선을 고른다.
 * 1. 고른 노드가 없으면 상자 사이의 선을 모두 그린다.
 * 2. 고른 노드가 있으면 고른 노드가 든 파일 상자 안의 선, 흐름에 든 노드 사이의 선, 고른 노드로 들어오는 선,
 *    접힌 상자 사이의 선을 그린다. 파일 상자를 골랐으면 그 파일 상자의 경계를 넘는 선을 파일 상자에서 잇는다.
 *    마우스를 올린 노드에 닿는 선은 모두 그린다.
 * 3. 편재 노드로 들어오는 접힌 상자 사이의 선은 뺀다. 편재 노드나 편재 노드를 쓰는 노드를 고르면 다시 넣는다.
 * 올린 양 끝이 같은 선은 집계 규칙으로 합치고, 올린 양 끝이 같거나 한쪽이 다른 쪽의 조상인 선은 버린다.
 * 고른 노드에 닿는 선과 흐름에 든 노드 사이의 선은 strong, 그 밖의 선은 muted다. 고른 노드에 닿지 않는 선은
 * 두 끝 노드 가운데 더 흐린 쪽 불투명도를 받는다.
 */
export function drawn(graph: Graph, shown: Shown, flow: Flow | null, hover: string | null): DrawnEdge[] {
  const nodes = nodeIndex(graph);
  const closed = (id: string) => BOX_KINDS.has(nodes.get(id)!.kind) && !shown.open.has(id);
  const member = (id: string) =>
    flow !== null && (flow.seeds.has(id) || flow.out.has(flow.unit === "file" ? unitOf(nodes, id) : id));

  const concealed = new Set(ubiquitous(graph, shown).keys());
  if (flow !== null) {
    const used = graph.edges.filter((e) => flow.seeds.has(e.source)).map((e) => e.target);
    for (const id of [...flow.seeds, ...used]) {
      const box = boxOf(nodes, shown, id);
      if (box !== null) {
        concealed.delete(box);
      }
    }
  }

  const inScope = (edge: AtlasEdge, source: string, target: string): boolean => {
    if (flow === null) {
      return !concealed.has(target);
    }
    if (within(nodes, edge.source, flow.file) && within(nodes, edge.target, flow.file)) {
      return true;
    }
    if (flow.seeds.has(edge.target) || (member(edge.source) && member(edge.target))) {
      return true;
    }
    return closed(source) && closed(target) && !concealed.has(target);
  };

  const pairs = new Map<string, { source: string; target: string; edges: AtlasEdge[]; lifted: boolean }>();
  for (const edge of graph.edges) {
    let source = lift(nodes, shown, edge.source);
    let target = lift(nodes, shown, edge.target);
    if (source === null || target === null) {
      continue;
    }
    if (flow?.unit === "file" && within(nodes, source, flow.file) !== within(nodes, target, flow.file)) {
      if (within(nodes, source, flow.file)) {
        source = flow.file;
      } else {
        target = flow.file;
      }
    }
    if (related(nodes, source, target)) {
      continue;
    }
    if (source !== hover && target !== hover && !inScope(edge, source, target)) {
      continue;
    }
    const id = `${source}|${target}`;
    const pair = pairs.get(id) ?? { source, target, edges: [], lifted: false };
    pair.edges.push(edge);
    pair.lifted ||= source !== edge.source || target !== edge.target;
    pairs.set(id, pair);
  }

  const dim = opacities(graph, flow);
  const result: DrawnEdge[] = [];
  for (const { source, target, edges, lifted } of pairs.values()) {
    if (lifted) {
      result.push(merge(aggKey(source, target), source, target, edges, flow, member, dim));
    } else {
      result.push(...edges.map((e) => merge(edgeKey(e), source, target, [e], flow, member, dim)));
    }
  }
  return result;
}
