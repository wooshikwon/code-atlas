// 함수 시점 뷰에 그릴 노드와 실행 선을 정하고 ELK 입력을 만든다. 파일 상자와 열 배정을 쓰지 않는다.
import type { ElkNode } from "elkjs/lib/elk-api";
import type { AtlasEdge, AtlasNode, Graph } from "../api/types";
import { CIRCLE, labelOf, LEAF_HEIGHT, titleOf, type Layout, type Measure, type Size } from "./layout";
import { edgeKey } from "./scope";
import type { EdgeView } from "./view";
import { unitOf } from "./visible";

export type Side = "caller" | "center" | "callee";

export interface Calls {
  /** 호출하는 쪽, 가운데 함수, 호출되는 쪽 순서 */
  nodes: string[];
  /** 실행 선(호출, 생성) */
  edges: AtlasEdge[];
  side: Map<string, Side>;
  /** 같은 방향으로 한 단계 더 펼 선이 남은 양옆 노드 */
  more: Set<string>;
}

/** 이름표 아래 파일 경로 줄의 높이 */
const FILE_HEIGHT = 14;
/** + 버튼의 한 변 */
const MORE = 16;
const MORE_GAP = 4;
const CIRCLE_GAP = 6;
const LOC_GAP = 5;

const CALL_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.spacing.nodeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": "48",
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
};

function firstLine(edge: AtlasEdge): number {
  return Math.min(...edge.sites.map((site) => site.line));
}

/**
 * 가운데 함수 center, center를 호출하는 함수, center가 호출하는 함수와 생성하는 클래스를 고른다.
 * expanded에 든 양옆 노드는 같은 방향으로 한 단계 더 편다. 실행 선만 담고, hidden에 든 노드에 닿는 선은 뺀다.
 * 호출되는 쪽은 호출 지점의 줄 순서로 놓는다.
 */
export function callview(graph: Graph, center: string, expanded: string[], hidden: Set<string>): Calls {
  const into = new Map<string, AtlasEdge[]>();
  const from = new Map<string, AtlasEdge[]>();
  for (const edge of graph.edges) {
    if (edge.group !== "run" || edge.source === edge.target || hidden.has(edge.source) || hidden.has(edge.target)) {
      continue;
    }
    into.set(edge.target, [...(into.get(edge.target) ?? []), edge]);
    from.set(edge.source, [...(from.get(edge.source) ?? []), edge]);
  }
  for (const list of from.values()) {
    list.sort((a, b) => firstLine(a) - firstLine(b));
  }

  const side = new Map<string, Side>([[center, "center"]]);
  const edges = new Map<string, AtlasEdge>();
  const found = { caller: [] as string[], callee: [] as string[] };
  const linksOf = (id: string, to: "caller" | "callee") => (to === "caller" ? into : from).get(id) ?? [];
  const spread = (id: string, to: "caller" | "callee") => {
    for (const edge of linksOf(id, to)) {
      const other = to === "caller" ? edge.source : edge.target;
      edges.set(edgeKey(edge), edge);
      if (!side.has(other)) {
        side.set(other, to);
        found[to].push(other);
      }
    }
  };
  spread(center, "caller");
  spread(center, "callee");
  for (const id of expanded) {
    const to = side.get(id);
    if (to === "caller" || to === "callee") {
      spread(id, to);
    }
  }

  const more = new Set<string>();
  for (const [id, to] of side) {
    if (to !== "center" && linksOf(id, to).some((edge) => !edges.has(edgeKey(edge)))) {
      more.add(id);
    }
  }
  return { nodes: [...found.caller, center, ...found.callee], edges: [...edges.values()], side, more };
}

/** 메서드를 품은 클래스 노드. 메서드가 아니면 undefined다. */
function ownerOf(nodes: Map<string, AtlasNode>, node: AtlasNode): AtlasNode | undefined {
  return node.kind === "method" && node.parent !== null ? nodes.get(node.parent) : undefined;
}

/** 함수 시점 뷰의 줄이지 않은 이름표. 클래스 노드 없이 그리므로 메서드는 `클래스.이름()`이다. */
export function callTitle(nodes: Map<string, AtlasNode>, node: AtlasNode): string {
  const owner = ownerOf(nodes, node);
  return owner === undefined ? titleOf(node) : `${titleOf(owner)}.${titleOf(node)}`;
}

/** 함수 시점 뷰의 노드에 그리는 이름표. 클래스 이름과 메서드 이름을 따로 24자에서 자른다. */
export function callLabel(nodes: Map<string, AtlasNode>, node: AtlasNode): string {
  const owner = ownerOf(nodes, node);
  return owner === undefined ? labelOf(node) : `${labelOf(owner)}.${labelOf(node)}`;
}

/** 이름표 아래에 적는 파일 경로. 파일 안에 들지 않은 노드면 null이다. */
export function fileLabel(nodes: Map<string, AtlasNode>, node: AtlasNode): string | null {
  const unit = nodes.get(unitOf(nodes, node.id));
  return unit === undefined || unit.id === node.id ? null : labelOf(unit);
}

/** 클래스를 뺀 노드는 이름표 오른쪽에 줄 수를 적는다. */
export function counted(node: AtlasNode): boolean {
  return node.kind !== "class";
}

/** 노드 크기. 원과 그 오른쪽의 이름표 줄·파일 경로 줄이고, 더 펼 선이 남은 노드는 + 버튼의 폭을 더한다. */
export function callSize(calls: Calls, nodes: Map<string, AtlasNode>, node: AtlasNode, measure: Measure): Size {
  const label = measure(callLabel(nodes, node), calls.side.get(node.id) === "center");
  const name = counted(node) ? label + LOC_GAP + measure(String(node.loc)) : label;
  const file = fileLabel(nodes, node);
  const text = Math.max(name, file === null ? 0 : measure(file));
  return {
    width: Math.ceil(CIRCLE + CIRCLE_GAP + text + (calls.more.has(node.id) ? MORE_GAP + MORE : 0)),
    height: LEAF_HEIGHT + FILE_HEIGHT,
  };
}

/** 모든 노드와 실행 선을 한 번에 배치하는 ELK 입력. 노드 수가 적으므로 partition을 쓰지 않는다. */
export function callElk(calls: Calls, size: (id: string) => Size): ElkNode {
  return {
    id: "calls",
    layoutOptions: CALL_OPTIONS,
    children: calls.nodes.map((id) => ({ id, ...size(id) })),
    edges: calls.edges.map((edge) => ({ id: edgeKey(edge), sources: [edge.source], targets: [edge.target] })),
  };
}

/** 실행 선마다 배치가 낸 경로와 색을 정한다. center에 닿는 선만 본문 잉크로 그린다. */
export function callEdges(calls: Calls, center: string, layout: Layout): EdgeView[] {
  const views: EdgeView[] = [];
  for (const edge of calls.edges) {
    const key = edgeKey(edge);
    const points = layout.routes.get(key);
    if (points === undefined) {
      continue;
    }
    views.push({
      key,
      source: edge.source,
      target: edge.target,
      group: edge.group,
      points,
      tone: edge.source === center || edge.target === center ? "strong" : "muted",
      opacity: 1,
      weight: null,
      sites: edge.sites.length,
    });
  }
  return views;
}
