// 함수 시점 뷰에 그릴 노드와 실행 선을 정하고 ELK 입력을 만든다. 파일 상자와 열 배정을 쓰지 않는다.
import type { ElkNode } from "elkjs/lib/elk-api";
import type { AtlasEdge, AtlasNode, Graph } from "../api/types";
import {
  arrangeOptions,
  CIRCLE,
  CIRCLE_GAP,
  ENTRY_MARK_WIDTH,
  inPort,
  joined,
  labelOf,
  laneOf,
  LEAF_HEIGHT,
  NODE_GAP,
  ordered,
  outPort,
  spacingOptions,
  titleOf,
  type Layout,
  type Measure,
  type Size,
} from "./layout";
import { EDGE_OPACITY, edgeKey } from "./scope";
import { NO_TRUNKS, trunkViews, type EdgeView, type Lines } from "./view";
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
/** + 버튼과 노드 사이의 폭. 호출하는 쪽은 + 버튼이 원 왼쪽에 있으므로 원 왼쪽 위로 나가는 배지와 닿지 않게 원과 이름표 사이만큼 띄운다. */
const MORE_GAP = { caller: CIRCLE_GAP, callee: 4, center: 0 } as const;

/** 함수 시점 뷰의 선은 실행 선 하나씩이어서 도착 노드 앞에 적는 합계가 한 화면의 선 수를 넘지 않는다. */
export function callLane(calls: Calls): number {
  return laneOf(String(Math.max(1, calls.edges.reduce((sum, edge) => sum + edge.sites.length, 0))).length);
}

function callOptions(lane: number): Record<string, string> {
  return {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.edgeRouting": "ORTHOGONAL",
    ...arrangeOptions(),
    "elk.spacing.nodeNode": String(NODE_GAP),
    "elk.layered.spacing.nodeNodeBetweenLayers": "48",
    ...spacingOptions(lane),
    "elk.padding": "[top=0,left=0,bottom=0,right=0]",
  };
}

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

/** 노드 크기. 원과 그 오른쪽의 이름표 줄·파일 경로 줄이고, 더 펼 선이 남은 노드는 + 버튼의 폭을 더한다. */
export function callSize(calls: Calls, nodes: Map<string, AtlasNode>, node: AtlasNode, measure: Measure): Size {
  const side = calls.side.get(node.id)!;
  const label = (node.entry ? ENTRY_MARK_WIDTH : 0) + measure(callLabel(nodes, node), side === "center");
  const file = fileLabel(nodes, node);
  const text = Math.max(label, file === null ? 0 : measure(file));
  return {
    width: Math.ceil(CIRCLE + CIRCLE_GAP + text + (calls.more.has(node.id) ? MORE_GAP[side] + MORE : 0)),
    height: LEAF_HEIGHT + FILE_HEIGHT,
  };
}

/**
 * 모든 노드와 실행 선을 한 번에 배치하는 ELK 입력. 열은 ELK가 선으로 정하고, 열 안에서는 `Calls.nodes`의 순서대로 놓는다.
 * 선은 양 끝 노드의 포트에 닿아 출발 노드 뒤와 도착 노드 앞에서 합류한다.
 */
export function callElk(calls: Calls, size: (id: string) => Size): ElkNode {
  const targets = (id: string) => [...new Set(calls.edges.filter((edge) => edge.source === id).map((edge) => edge.target))];
  return {
    id: "calls",
    layoutOptions: callOptions(callLane(calls)),
    children: ordered(calls.nodes.map((id) => joined({ id, ...size(id) }, targets(id)))),
    edges: calls.edges.map((edge) => ({ id: edgeKey(edge), sources: [outPort(edge.source, edge.target)], targets: [inPort(edge.target)] })),
  };
}

/** 실행 선마다 배치가 낸 경로와 색을 정하고 도착이나 출발이 같은 선을 줄기로 묶는다. center에 닿는 선만 본문 잉크로 그린다. */
export function callEdges(calls: Calls, center: string, layout: Layout): Lines {
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
      opacity: EDGE_OPACITY.full,
      into: null,
      sites: edge.sites.length,
      kinds: { [edge.kind]: edge.sites.length },
      route: null,
      via: false,
      joins: true,
      below: false,
      branch: points,
      trunks: NO_TRUNKS,
    });
  }
  return trunkViews(views, [...layout.boxes.values()]);
}
