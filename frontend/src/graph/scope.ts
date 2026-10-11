// 보이는 노드 사이에 그릴 선을 정한다. 배치와 독립이므로 선을 바꿔 그려도 layout을 다시 부르지 않는다.
import type { AtlasEdge, AtlasNode, EdgeGroup, EdgeKind, Graph } from "../api/types";
import type { Flow } from "./flow";
import type { Lit, StepKind } from "./route";
import { lift, local, nodeIndex, unitOf, within, type Shown } from "./visible";

export type EdgeKey = string;

/** 선의 진하기. strong은 본문 잉크, muted는 muted 잉크로 그린다. */
export type Tone = "strong" | "muted";

/**
 * 화면에 그리는 선 하나. 양 끝을 올려 합친 집계 선은 `agg|…` 키를, 올리지 않은 선은 edge_key를 쓴다.
 * 경로의 걸음 가운데 실행 선이 없는 이음은 `step|…` 키를 쓰고 edges가 비어 있다.
 */
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
  /** 강조하는 경로의 걸음을 그리는 선이면 그 걸음의 종류 */
  route: StepKind | null;
  /** 선을 눌러 온 상태에서 지나온 선이다(`followed`) */
  via: boolean;
}

/**
 * 선의 불투명도. 고른 노드가 없으면 모든 선이 IDLE이라 노드의 테두리와 글자보다 연하다. 노드를 고르면 고른 노드에 닿는 선과
 * 흐름에 든 노드 사이의 선은 FULL, 그 밖의 선은 REST다. 경로를 강조하는 동안에는 경로의 걸음이 FULL, 그 밖의 선이 REST다.
 * 선 가운데 숫자는 선과 같은 색과 불투명도로 그린다.
 */
export const EDGE_OPACITY = { full: 1, idle: 0.5, rest: 0.2 } as const;

const GROUP_ORDER: EdgeGroup[] = ["run", "use", "derive"];
const BOX_KINDS = new Set(["module", "package", "external"]);

export function edgeKey(edge: AtlasEdge): EdgeKey {
  return `${edge.source}|${edge.target}|${edge.kind}`;
}

export function aggKey(source: string, target: string): EdgeKey {
  return `agg|${source}|${target}`;
}

export function stepKey(source: string, target: string): EdgeKey {
  return `step|${source}|${target}`;
}

function related(nodes: Map<string, AtlasNode>, a: string, b: string): boolean {
  return within(nodes, a, b) || within(nodes, b, a);
}

type Shade = Pick<DrawnEdge, "tone" | "opacity" | "route">;

/** 흐름에서 정한 선의 진하기. edges는 선 하나에 합친 원래 선이다. */
function shadeOf(edges: AtlasEdge[], flow: Flow | null, member: (id: string) => boolean): Shade {
  const touching = flow !== null && edges.some((e) => flow.seeds.has(e.source) !== flow.seeds.has(e.target));
  const inFlow = touching || edges.some((e) => member(e.source) && member(e.target));
  return {
    tone: touching ? "strong" : "muted",
    opacity: flow === null ? EDGE_OPACITY.idle : inFlow ? EDGE_OPACITY.full : EDGE_OPACITY.rest,
    route: null,
  };
}

/** 원래 선 edges를 선 하나로 합친다. edges가 비면 분류는 실행이고 무게는 0이다. */
function merge(key: EdgeKey, source: string, target: string, edges: AtlasEdge[], shade: Shade): DrawnEdge {
  const kinds: DrawnEdge["kinds"] = {};
  let group = edges[0]?.group ?? "run";
  let weight = 0;
  for (const edge of edges) {
    weight += edge.sites.length;
    kinds[edge.kind] = (kinds[edge.kind] ?? 0) + edge.sites.length;
    if (GROUP_ORDER.indexOf(edge.group) < GROUP_ORDER.indexOf(group)) {
      group = edge.group;
    }
  }
  return { key, source, target, group, weight, kinds, ...shade, via: false, deferred: edges.length > 0 && edges.every((e) => e.deferred), edges };
}

/**
 * 강조하는 경로의 걸음마다 선 하나. 실행 선이 있는 걸음은 그 선의 edge_key와 원래 선을 담고, 생성자 이음과 오버라이드 이음은
 * `step|…` 키에 원래 선 없이 낸다.
 */
function strides(graph: Graph, lit: Lit): DrawnEdge[] {
  const shade = (route: StepKind): Shade => ({ tone: "strong", opacity: EDGE_OPACITY.full, route });
  const result: DrawnEdge[] = [];
  for (let i = 0; i + 1 < lit.path.length; i++) {
    const [source, target] = [lit.path[i], lit.path[i + 1]];
    const kind = lit.kinds.get(`${source}|${target}`)!;
    const edge = graph.edges.find((e) => e.source === source && e.target === target && e.kind === kind);
    result.push(
      edge === undefined
        ? merge(stepKey(source, target), source, target, [], shade(kind))
        : merge(edgeKey(edge), source, target, [edge], shade(kind)),
    );
  }
  return result;
}

/**
 * 모든 선의 양 끝을 보이는 가장 가까운 조상으로 올린 뒤 그리는 범위 규칙으로 그릴 선을 고른다.
 * 1. 고른 노드가 없으면 상자 사이의 선을 모두 그린다.
 * 2. 고른 노드가 있으면 고른 노드가 든 파일 상자 안의 선, 흐름에 든 노드 사이의 선, 고른 노드로 들어오는 선,
 *    접힌 상자 사이의 선을 그린다. 파일 상자를 골랐으면 그 파일 상자의 경계를 넘는 선을 파일 상자에서 잇는다.
 *    마우스를 올린 노드에 닿는 선은 모두 그린다.
 * 올린 양 끝이 같은 선은 집계 규칙으로 합치고, 올린 양 끝이 같거나 한쪽이 다른 쪽의 조상인 선은 버린다.
 * 선의 진하기는 다섯 단계이고 경로 고정이 가장 앞선다. 강조하는 경로 lit이 있으면 흐름과 hover를 보지 않고,
 * 경로의 걸음마다 선 하나를 strong에 불투명도 1로, 접힌 상자 사이의 선을 muted에 불투명도 0.2로 그린다.
 * lit이 없으면 고른 노드에 닿는 선(고른 노드와 그 자손의 경계를 넘는 선)은 strong에 불투명도 1,
 * 흐름에 든 노드 사이의 선은 muted에 불투명도 1, 그 밖의 선은 muted에 불투명도 0.2다. 고른 노드가 없으면
 * 모두 muted에 불투명도 0.5다.
 */
export function drawn(graph: Graph, shown: Shown, flow: Flow | null, hover: string | null, lit: Lit | null): DrawnEdge[] {
  if (lit !== null) {
    flow = null;
    hover = null;
  }
  const nodes = nodeIndex(graph);
  const closed = (id: string) => BOX_KINDS.has(nodes.get(id)!.kind) && !shown.open.has(id);
  const member = (id: string) =>
    flow !== null && (flow.seeds.has(id) || flow.out.has(flow.unit === "file" ? unitOf(nodes, id) : id));

  const shade = (edges: AtlasEdge[]): Shade =>
    lit === null ? shadeOf(edges, flow, member) : { tone: "muted", opacity: EDGE_OPACITY.rest, route: null };

  const inScope = (edge: AtlasEdge, source: string, target: string): boolean => {
    if (lit !== null) {
      return closed(source) && closed(target);
    }
    if (flow === null) {
      return true;
    }
    if (local(nodes, flow, edge.source) && local(nodes, flow, edge.target)) {
      return true;
    }
    if (flow.seeds.has(edge.target) || (member(edge.source) && member(edge.target))) {
      return true;
    }
    return closed(source) && closed(target);
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
      result.push(merge(aggKey(source, target), source, target, edges, shade(edges)));
    } else {
      result.push(...edges.map((e) => merge(edgeKey(e), source, target, [e], shade([e]))));
    }
  }
  return lit === null ? result : [...result, ...strides(graph, lit)];
}

/**
 * 선 키가 가리키는 선과 그 선에 합친 원래 선. 집계 선은 `drawn`이 그 키로 합친 선이고, 마우스를 올려야 그려지는
 * 집계 선은 양 끝에 마우스를 올린 것으로 보고 찾는다. 집계 선이 아닌 키는 원래 선 하나다. 없으면 null이다.
 */
export function picked(graph: Graph, shown: Shown, flow: Flow | null, key: EdgeKey): DrawnEdge | null {
  const [tag, source, target] = key.split("|");
  if (tag !== "agg") {
    const edge = graph.edges.find((e) => edgeKey(e) === key);
    return edge === undefined ? null : merge(key, edge.source, edge.target, [edge], shadeOf([edge], null, () => false));
  }
  for (const hover of [null, source, target]) {
    const found = drawn(graph, shown, flow, hover, null).find((e) => e.key === key);
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}

/** 선 키의 출발 노드와 도착 노드. 집계 선 키는 `agg|출발|도착`이고 그 밖의 키는 `출발|도착|종류`다. */
export function endsOf(key: EdgeKey): { source: string; target: string } {
  const parts = key.split("|");
  return parts[0] === "agg" ? { source: parts[1], target: parts[2] } : { source: parts[0], target: parts[1] };
}

/**
 * 원래 선 edge가 선 키 keys 가운데 하나가 가리키는 선에 드는지. 집계 선 키는 출발이 그 키의 출발 노드 안에, 도착이 도착 노드 안에 든
 * 선을 모두 가리키고, 그 밖의 키는 edge_key가 같은 선 하나를 가리킨다.
 */
export function along(nodes: Map<string, AtlasNode>, keys: EdgeKey[], edge: AtlasEdge): boolean {
  return keys.some((key) => {
    if (!key.startsWith("agg|")) {
      return edgeKey(edge) === key;
    }
    const { source, target } = endsOf(key);
    return within(nodes, edge.source, source) && within(nodes, edge.target, target);
  });
}

/**
 * 그린 선 edges 가운데 지나온 선 via에 드는 원래 선을 하나라도 합친 선을 가장 진한 단계(strong에 불투명도 1)로 올리고 via 표시를 단다.
 * 지나온 선의 도착 폴더를 펼쳐 선이 갈라졌으면 갈라진 선이 모두 표시를 받는다.
 */
export function followed(edges: DrawnEdge[], nodes: Map<string, AtlasNode>, via: EdgeKey[] | null): DrawnEdge[] {
  if (via === null) {
    return edges;
  }
  return edges.map((edge) =>
    edge.edges.some((e) => along(nodes, via, e)) ? { ...edge, tone: "strong", opacity: EDGE_OPACITY.full, via: true } : edge,
  );
}

/** 줄기 키 `trunk|도착 노드|번호`의 도착 노드. 줄기 키가 아니면 null이다. */
export function trunkTarget(key: EdgeKey): string | null {
  const [tag, target] = key.split("|");
  return tag === "trunk" ? target : null;
}

/** 노드 target으로 들어오는 그린 선. 함수 안 import만 합친 선은 줄기에 들지 않으므로 뺀다. */
export function arriving(graph: Graph, shown: Shown, flow: Flow | null, target: string): DrawnEdge[] {
  return drawn(graph, shown, flow, null, null).filter((edge) => edge.target === target && !edge.deferred);
}
