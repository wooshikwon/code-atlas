// 1단계 배치. 보이는 노드를 모두 펼쳐 ELK 한 번으로 배치한다.
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { AtlasNode, Graph } from "../api/types";
import {
  fromElk,
  functionCounts,
  HEADER,
  HEX_HEIGHT,
  measureText,
  MODULE_HEIGHT,
  moduleHeader,
  PAD,
  tableHeight,
  tableRows,
  type Layout,
  type Measure,
  type Size,
} from "./layout";
import { aggregates, edgeKey, nodeIndex, unitOf } from "./scope";

const LABEL_MAX = 24;
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
