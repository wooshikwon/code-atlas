// 보이는 노드 사이에 그릴 선과 편재 노드를 정한다. 배치와 독립이므로 선을 바꿔 그려도 layout을 다시 부르지 않는다.
import type { AtlasEdge, AtlasNode, EdgeGroup, EdgeKind, Graph } from "../api/types";
import type { Flow } from "./flow";
import { lift, local, nodeIndex, unitOf, within, type Shown } from "./visible";

export type EdgeKey = string;

/** 선의 진하기. strong은 본문 잉크, muted는 muted 잉크로 그린다. */
export type Tone = "strong" | "muted";

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
  /** 합친 원래 선 */
  edges: AtlasEdge[];
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

/** 노드에 닿는 선 수. 외부 노드로 가는 선도 센다. */
export function degrees(graph: Graph): Map<string, { incoming: number; outgoing: number }> {
  const result = new Map<string, { incoming: number; outgoing: number }>();
  const entry = (id: string) => {
    let value = result.get(id);
    if (value === undefined) {
      value = { incoming: 0, outgoing: 0 };
      result.set(id, value);
    }
    return value;
  };
  for (const edge of graph.edges) {
    entry(edge.source).outgoing++;
    entry(edge.target).incoming++;
  }
  return result;
}

/**
 * 지금 들어오는 선을 숨기는 편재 노드와 숨긴 선의 출발 노드 수. 초점이 없으면 편재 노드 전체이고,
 * 고른 노드를 품었거나 고른 노드가 쓰는 편재 노드는 숨긴 선을 다시 그리므로 뺀다.
 */
export function concealed(graph: Graph, shown: Shown, flow: Flow | null): Map<string, number> {
  const result = ubiquitous(graph, shown);
  if (flow === null) {
    return result;
  }
  const nodes = nodeIndex(graph);
  const used = graph.edges.filter((e) => flow.seeds.has(e.source)).map((e) => e.target);
  for (const id of [...flow.seeds, ...used]) {
    const box = boxOf(nodes, shown, id);
    if (box !== null) {
      result.delete(box);
    }
  }
  return result;
}

function merge(
  key: EdgeKey,
  source: string,
  target: string,
  edges: AtlasEdge[],
  flow: Flow | null,
  member: (id: string) => boolean,
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
  const inFlow = flow === null || touching || edges.some((e) => member(e.source) && member(e.target));
  return {
    key,
    source,
    target,
    group,
    weight,
    kinds,
    tone: touching ? "strong" : "muted",
    opacity: inFlow ? 1 : 0.2,
    deferred: edges.every((e) => e.deferred),
    edges,
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
 * 선의 진하기는 세 단계다. 고른 노드에 닿는 선(고른 노드와 그 자손의 경계를 넘는 선)은 strong에 불투명도 1,
 * 흐름에 든 노드 사이의 선은 muted에 불투명도 1, 그 밖의 선은 muted에 불투명도 0.2다. 고른 노드가 없으면
 * 모두 muted에 불투명도 1이다.
 */
export function drawn(graph: Graph, shown: Shown, flow: Flow | null, hover: string | null): DrawnEdge[] {
  const nodes = nodeIndex(graph);
  const closed = (id: string) => BOX_KINDS.has(nodes.get(id)!.kind) && !shown.open.has(id);
  const member = (id: string) =>
    flow !== null && (flow.seeds.has(id) || flow.out.has(flow.unit === "file" ? unitOf(nodes, id) : id));

  const off = concealed(graph, shown, flow);

  const inScope = (edge: AtlasEdge, source: string, target: string): boolean => {
    if (flow === null) {
      return !off.has(target);
    }
    if (local(nodes, flow, edge.source) && local(nodes, flow, edge.target)) {
      return true;
    }
    if (flow.seeds.has(edge.target) || (member(edge.source) && member(edge.target))) {
      return true;
    }
    return closed(source) && closed(target) && !off.has(target);
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

  const result: DrawnEdge[] = [];
  for (const { source, target, edges, lifted } of pairs.values()) {
    if (lifted) {
      result.push(merge(aggKey(source, target), source, target, edges, flow, member));
    } else {
      result.push(...edges.map((e) => merge(edgeKey(e), source, target, [e], flow, member)));
    }
  }
  return result;
}

/**
 * 그린 선 edges에서 상자 id가 쓰는 상자 수(outgoing), 그 상자가 쓰는 외부 모듈 수(external), 그 상자를 쓰는 상자 수(incoming).
 * 외부 모듈은 outgoing에 세지 않는다.
 */
export function neighbors(
  edges: DrawnEdge[],
  nodes: Map<string, AtlasNode>,
  id: string,
): { incoming: number; outgoing: number; external: number } {
  const users = new Set(edges.filter((e) => e.target === id).map((e) => e.source));
  const used = [...new Set(edges.filter((e) => e.source === id).map((e) => e.target))];
  const external = used.filter((target) => nodes.get(target)?.kind === "external").length;
  return { incoming: users.size, outgoing: used.length - external, external };
}

/**
 * 선 키가 가리키는 선과 그 선에 합친 원래 선. 집계 선은 `drawn`이 그 키로 합친 선이고, 마우스를 올려야 그려지는
 * 집계 선은 양 끝에 마우스를 올린 것으로 보고 찾는다. 집계 선이 아닌 키는 원래 선 하나다. 없으면 null이다.
 */
export function picked(graph: Graph, shown: Shown, flow: Flow | null, key: EdgeKey): DrawnEdge | null {
  const [tag, source, target] = key.split("|");
  if (tag !== "agg") {
    const edge = graph.edges.find((e) => edgeKey(e) === key);
    return edge === undefined ? null : merge(key, edge.source, edge.target, [edge], null, () => false);
  }
  for (const hover of [null, source, target]) {
    const found = drawn(graph, shown, flow, hover).find((e) => e.key === key);
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}
