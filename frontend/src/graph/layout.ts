// ELK 입력을 만들고 결과를 React Flow 좌표로 바꾼다. 노드 컴포넌트는 ELK 결과를 읽지 않고 여기서 바꾼 값만 받는다.
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { AtlasNode, Graph } from "../api/types";
import { aggregates, edgeKey, nodeIndex, unitOf, type EdgeKey } from "./scope";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Box extends Point, Size {}

export interface Layout {
  /** 부모 노드 기준 좌표. React Flow parentId와 함께 그대로 쓴다. */
  positions: Map<string, Point>;
  sizes: Map<string, Size>;
  /** 화면 기준 절대 좌표 */
  boxes: Map<string, Box>;
  /** 시작점, 꺾이는 점, 끝점 순서의 절대 좌표 */
  routes: Map<EdgeKey, Point[]>;
}

/** 글자 폭을 잰다. 브라우저는 canvas로 재고 시험은 글자 수로 어림한다. */
export type Measure = (text: string, bold?: boolean) => number;

export const FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
export const HEADER = 32;
export const PAD = 16;
export const TABLE_HEAD = 24;
export const TABLE_ROW = 18;
export const HEX_HEIGHT = 28;
export const MODULE_HEIGHT = 40;
const LABEL_MAX = 24;
const TABLE_ROWS_MAX = 5;
const CIRCLE_GAP = 6;

const ROOT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.spacing.nodeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": "48",
};

export function truncate(text: string): string {
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

export function labelOf(node: AtlasNode): string {
  return node.kind === "function" || node.kind === "method" ? `${node.name}()` : node.name;
}

/** 줄 수의 제곱근에 비례하는 지름. 16~48px로 자른다. */
export function circleDiameter(loc: number): number {
  return Math.min(48, Math.max(16, Math.round(4 * Math.sqrt(loc))));
}

/** 데이터 클래스 표의 필드 칸. 여섯 개 이상이면 다섯 칸과 "외 k개" 칸이다. */
export function tableRows(node: AtlasNode): string[] {
  const fields = node.fields ?? [];
  const rows = fields.map((f) => (f.type === null ? f.name : `${f.name}: ${f.type}`));
  return rows.length > TABLE_ROWS_MAX ? [...rows.slice(0, TABLE_ROWS_MAX), `외 ${rows.length - TABLE_ROWS_MAX}개`] : rows;
}

export function tableHeight(node: AtlasNode): number {
  return TABLE_HEAD + tableRows(node).length * TABLE_ROW + 4;
}

/** 파일 상자 머리에 적는 함수 수. 파일 안 함수와 메서드를 모두 센다. */
export function functionCounts(graph: Graph): Map<string, number> {
  const nodes = nodeIndex(graph);
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind !== "function" && node.kind !== "method") {
      continue;
    }
    let parent = node.parent === null ? undefined : nodes.get(node.parent);
    while (parent !== undefined && parent.kind !== "module" && parent.kind !== "package") {
      parent = parent.parent === null ? undefined : nodes.get(parent.parent);
    }
    if (parent !== undefined) {
      counts.set(parent.id, (counts.get(parent.id) ?? 0) + 1);
    }
  }
  return counts;
}

export function moduleHeader(node: AtlasNode, functions: number): string {
  return node.kind === "module" ? `함수 ${functions}개` : "";
}

const ORDER: Record<string, number> = { package: 0, module: 1 };

/** 형제 순서: 폴더, 파일, 소스 정의 순서. */
function siblingOrder(a: AtlasNode, b: AtlasNode): number {
  const rank = (ORDER[a.kind] ?? 2) - (ORDER[b.kind] ?? 2);
  if (rank !== 0) {
    return rank;
  }
  if (a.range !== null && b.range !== null && (ORDER[a.kind] ?? 2) === 2) {
    return a.range[0] - b.range[0];
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function leafSize(node: AtlasNode, measure: Measure, prefix: string): Size {
  const label = prefix + truncate(labelOf(node));
  switch (node.kind) {
    case "function":
    case "method": {
      const d = circleDiameter(node.loc);
      return { width: d + CIRCLE_GAP + measure(label), height: Math.max(d, 18) };
    }
    case "class":
      return { width: measure(label, true) + 28, height: HEX_HEIGHT };
    case "dataclass":
      return tableSize(node, measure, prefix);
    default:
      return {
        width: Math.max(Math.min(360, Math.max(120, 12 * Math.sqrt(node.loc))), measure(label, true) + 24),
        height: MODULE_HEIGHT,
      };
  }
}

function tableSize(node: AtlasNode, measure: Measure, prefix: string): Size {
  const widths = [measure(prefix + truncate(node.name), true), ...tableRows(node).map((r) => measure(truncate(r)))];
  return { width: Math.ceil(Math.max(...widths)) + 16, height: tableHeight(node) };
}

/**
 * 보이는 노드를 parent 사슬로 중첩한 ELK 입력. 선은 한 파일 상자 안의 선(함수 안 import 제외)과 파일 상자 사이
 * 집계 선이고, 뿌리에 선언한다. 파일 경계를 넘는 함수·클래스 선은 집계 선이 열 배정에 대신 쓰이고,
 * 경로는 `crossRoute`가 그린다. 다른 노드가 쓰지 않는 진입점은 열0에 고정한다.
 */
export function elkGraph(graph: Graph, visible: Set<string>, measure: Measure): ElkNode {
  const nodes = graph.nodes.filter((n) => visible.has(n.id));
  const children = new Map<string | null, AtlasNode[]>();
  for (const node of nodes) {
    const parent = node.parent !== null && visible.has(node.parent) ? node.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  for (const list of children.values()) {
    list.sort(siblingOrder);
  }

  const index = nodeIndex(graph);
  const edges: ElkExtendedEdge[] = [];
  const used = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.deferred || !visible.has(edge.source) || !visible.has(edge.target)) {
      continue;
    }
    used.add(edge.target);
    if (unitOf(index, edge.source) === unitOf(index, edge.target)) {
      edges.push({ id: edgeKey(edge), sources: [edge.source], targets: [edge.target] });
    }
  }
  for (const agg of aggregates(graph, visible)) {
    edges.push({ id: agg.key, sources: [agg.source], targets: [agg.target] });
  }

  const functions = functionCounts(graph);
  const build = (node: AtlasNode): ElkNode => {
    const prefix = node.entry ? "▶ " : "";
    const kids = children.get(node.id) ?? [];
    const options: Record<string, string> = {};
    if (node.entry && !used.has(node.id)) {
      options["elk.layered.layering.layerConstraint"] = "FIRST";
    }
    if (kids.length === 0) {
      return { id: node.id, ...leafSize(node, measure, prefix), layoutOptions: options };
    }
    const header = `${prefix}${truncate(labelOf(node))}  ${moduleHeader(node, functions.get(node.id) ?? 0)}`;
    let top = HEADER;
    let minWidth = measure(header, true) + 2 * PAD;
    if (node.kind === "dataclass") {
      const table = tableSize(node, measure, prefix);
      top = table.height + PAD;
      minWidth = table.width;
    }
    return {
      id: node.id,
      children: kids.map(build),
      layoutOptions: {
        ...options,
        "elk.padding": `[top=${top},left=${PAD},bottom=${PAD},right=${PAD}]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${Math.ceil(minWidth)}, ${top + PAD})`,
      },
    };
  };

  return { id: "root", layoutOptions: ROOT_OPTIONS, children: (children.get(null) ?? []).map(build), edges };
}

/** ELK 결과를 부모 기준 좌표, 절대 좌표, 절대 좌표 선 경로로 바꾼다. 선 좌표는 결과의 container 기준이다. */
export function fromElk(root: ElkNode): Layout {
  const result: Layout = { positions: new Map(), sizes: new Map(), boxes: new Map(), routes: new Map() };
  const origins = new Map<string, Point>([[root.id, { x: 0, y: 0 }]]);
  const edges: ElkExtendedEdge[] = [];

  const walk = (node: ElkNode, origin: Point) => {
    edges.push(...((node.edges ?? []) as ElkExtendedEdge[]));
    for (const child of node.children ?? []) {
      const x = child.x ?? 0;
      const y = child.y ?? 0;
      const size = { width: child.width ?? 0, height: child.height ?? 0 };
      const abs = { x: origin.x + x, y: origin.y + y };
      result.positions.set(child.id, { x, y });
      result.sizes.set(child.id, size);
      result.boxes.set(child.id, { ...abs, ...size });
      origins.set(child.id, abs);
      walk(child, abs);
    }
  };
  walk(root, { x: 0, y: 0 });

  for (const edge of edges) {
    const section = edge.sections?.[0];
    if (section === undefined) {
      continue;
    }
    const container = (edge as ElkExtendedEdge & { container?: string }).container ?? root.id;
    const o = origins.get(container) ?? { x: 0, y: 0 };
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    result.routes.set(
      edge.id,
      points.map((p) => ({ x: p.x + o.x, y: p.y + o.y })),
    );
  }
  return result;
}

const ROUTE_GAP = 12;

/**
 * ELK가 경로를 내지 않은 파일 경계 너머 선의 직각 경로. 가로로 떨어져 있으면 마주 보는 옆면을 가로-세로-가로로 잇고,
 * 가로로 겹치면 마주 보는 윗면·아랫면을 세로-가로-세로로 잇는다.
 */
export function crossRoute(source: Box, target: Box): Point[] {
  const sy = source.y + source.height / 2;
  const ty = target.y + target.height / 2;
  if (source.x + source.width <= target.x || target.x + target.width <= source.x) {
    const forward = source.x + source.width <= target.x;
    const sx = forward ? source.x + source.width : source.x;
    const tx = forward ? target.x : target.x + target.width;
    const mid = (sx + tx) / 2;
    return [
      { x: sx, y: sy },
      { x: mid, y: sy },
      { x: mid, y: ty },
      { x: tx, y: ty },
    ];
  }
  const sx = source.x + source.width / 2;
  const tx = target.x + target.width / 2;
  const down = source.y + source.height <= target.y;
  const start = down ? source.y + source.height : source.y;
  const end = down ? target.y : target.y + target.height;
  const mid = (start + end) / 2;
  return [
    { x: sx, y: start },
    { x: sx, y: mid },
    { x: tx, y: mid },
    { x: tx, y: end },
  ];
}

/** 함수 안 import 선의 경로. 출발 노드 아래로 내려가 두 노드 아래를 지나 도착 노드 아래로 들어간다. */
export function belowRoute(source: Box, target: Box): Point[] {
  const sx = source.x + source.width / 2;
  const tx = target.x + target.width / 2;
  const floor = Math.max(source.y + source.height, target.y + target.height) + ROUTE_GAP;
  return [
    { x: sx, y: source.y + source.height },
    { x: sx, y: floor },
    { x: tx, y: floor },
    { x: tx, y: target.y + target.height },
  ];
}

let canvas: CanvasRenderingContext2D | null = null;

export const measureText: Measure = (text, bold = false) => {
  canvas ??= document.createElement("canvas").getContext("2d");
  if (canvas === null) {
    return text.length * 7;
  }
  canvas.font = bold ? `600 ${FONT}` : FONT;
  return Math.ceil(canvas.measureText(text).width);
};

let elk: InstanceType<typeof ELK> | null = null;

/** ELK를 화면 스레드 밖에서 돌린다. elk-api가 요청 id로 응답을 맞춘다. */
function runElk(input: ElkNode): Promise<ElkNode> {
  elk ??= new ELK({ workerFactory: () => new Worker(elkWorkerUrl) });
  return elk.layout(input);
}

export async function layout(graph: Graph, visible: Set<string>): Promise<Layout> {
  const started = performance.now();
  const result = fromElk(await runElk(elkGraph(graph, visible, measureText)));
  console.info(`layout ${visible.size} nodes ${Math.round(performance.now() - started)}ms`);
  return result;
}
