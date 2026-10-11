// ELK 입력을 만들고 결과를 React Flow 좌표로 바꾼다. 노드 컴포넌트는 ELK 결과를 읽지 않고 여기서 바꾼 값만 받는다.
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { AtlasEdge, AtlasNode, Graph } from "../api/types";
import { entryUnits, siblings, type Columns } from "./columns";
import { aggKey, edgeKey, type EdgeKey } from "./scope";
import { lift, nodeIndex, type Shown } from "./visible";

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

/** ELK를 한 번 돌린다. 브라우저는 worker로, 시험은 elk.bundled.js로 돌린다. */
export type RunElk = (graph: ElkNode) => Promise<ElkNode>;

const FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
export const HEADER = 32;
const PAD = 16;
export const TABLE_HEAD = 24;
export const TABLE_ROW = 18;
const HEX_HEIGHT = 28;
export const MODULE_WIDTH = 320;
export const MODULE_HEIGHT = 40;
/** 접힌 파일 상자 아래에 적는 함수 수 글자의 높이 */
export const CAPTION_HEIGHT = 16;
export const CIRCLE = 16;
export const LEAF_HEIGHT = 18;
export const EXTERNAL_HEIGHT = 24;
export const ENTRY_MARK = "▶ ";
const LABEL_MAX = 36;
const TABLE_ROWS_MAX = 5;
/**
 * 배지는 노드 모양의 오른쪽 위 모서리(미확인 호출 수)와 오른쪽 아래 모서리(모듈 변수 변경)에 단다. 배지의 세로 가운데를
 * 모양의 위·아래 변에 맞추고 오른쪽 끝을 모양의 오른쪽 끝에서 BADGE_OVERHANG만큼 내보낸다. 글자가 늘면 배지가
 * 왼쪽으로 넓어지므로 모양 오른쪽으로 나온 폭은 글자 수와 관계없이 같다.
 */
export const BADGE_OVERHANG = 6;
/** 배지의 높이. 배지는 모양의 위·아래 변에서 이 높이의 절반만큼 나간다. */
export const BADGE_HEIGHT = 14;
/** 배지의 오른쪽 끝과 이름표 사이에 남기는 폭 */
export const BADGE_GAP = 3;
/** 원과 그 오른쪽 이름표 사이의 폭. 배지가 나온 폭과 배지 뒤에 남기는 폭을 더한 값이다. */
export const CIRCLE_GAP = BADGE_OVERHANG + BADGE_GAP;
export const LOC_GAP = 5;
const COUNT_GAP = 12;
const FOLDER_PAD = 36;
/** 펼친 폴더 영역에서 폴더 경로를 적는 머리 줄의 높이 */
export const REGION_HEAD = 28;
const STACK_GAP = 48;
const SHELF_GAP = 64;
const GRID_GAP = 24;
const SHELF_COLUMNS = 4;

/** 열은 partition으로, 열 안 순서는 children 배열 순서로 고정한다. 교차 최소화는 children 순서를 바꾸므로 끈다. */
const ELK_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.partitioning.activate": "true",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
  "elk.layered.crossingMinimization.strategy": "NONE",
  "elk.layered.crossingMinimization.greedySwitch.type": "OFF",
  "elk.separateConnectedComponents": "false",
  "elk.spacing.nodeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": "48",
};

const ROOT_OPTIONS = { ...ELK_OPTIONS, "elk.padding": "[top=0,left=0,bottom=0,right=0]" };

function cut(text: string): string {
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

/** 36자를 넘는 경로를 앞쪽 폴더부터 `…/`로 줄인다. 줄인 폴더가 없으면 `…/`를 붙이지 않는다. 폴더 경로는 `/`로 끝난다. */
function shortPath(path: string): string {
  if (path.length <= LABEL_MAX) {
    return path;
  }
  const end = path.endsWith("/") ? "/" : "";
  const parts = path.slice(0, path.length - end.length).split("/");
  let tail = parts.pop()! + end;
  while (parts.length > 0 && `…/${parts.at(-1)}/${tail}`.length <= LABEL_MAX) {
    tail = `${parts.pop()}/${tail}`;
  }
  return cut(parts.length > 0 ? `…/${tail}` : tail);
}

/** 줄이지 않은 이름표. 파일과 폴더는 소스 루트 기준 경로이고 폴더는 `/`로 끝난다. 함수·메서드는 `이름()`이다. */
export function titleOf(node: AtlasNode): string {
  switch (node.kind) {
    case "package":
      return `${node.id.replaceAll(".", "/")}/`;
    case "module":
      return `${node.id.replaceAll(".", "/")}.py`;
    case "function":
    case "method":
      return `${node.name}()`;
    default:
      return node.name;
  }
}

/** 노드에 그리는 이름표. 36자에서 자르고, 경로는 앞쪽 폴더부터 줄여 파일 이름을 남긴다. */
export function labelOf(node: AtlasNode): string {
  const title = titleOf(node);
  return node.kind === "package" || node.kind === "module" ? shortPath(title) : cut(title);
}

/** 데이터 클래스 표의 필드 칸. 여섯 개 이상이면 다섯 칸과 "외 k개" 칸이다. */
export function tableRows(node: AtlasNode): string[] {
  const fields = node.fields ?? [];
  const rows = fields.map((f) => cut(f.type === null ? f.name : `${f.name}: ${f.type}`));
  return rows.length > TABLE_ROWS_MAX ? [...rows.slice(0, TABLE_ROWS_MAX), `외 ${rows.length - TABLE_ROWS_MAX}개`] : rows;
}

function tableHeight(node: AtlasNode): number {
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

/** 진입점 표지와 이름표의 폭. loc이 참이면 이름표 오른쪽 줄 수 숫자의 폭을 더한다. */
function labelWidth(node: AtlasNode, measure: Measure, bold: boolean, loc: boolean): number {
  const label = measure((node.entry ? ENTRY_MARK : "") + labelOf(node), bold);
  return loc ? label + LOC_GAP + measure(String(node.loc)) : label;
}

function tableSize(node: AtlasNode, measure: Measure): Size {
  const widths = [labelWidth(node, measure, true, true), ...tableRows(node).map((r) => measure(r))];
  return { width: Math.ceil(Math.max(...widths)) + 16, height: tableHeight(node) };
}

/** 자식을 그리지 않는 노드의 크기 */
function leafSize(node: AtlasNode, measure: Measure): Size {
  switch (node.kind) {
    case "function":
    case "method":
      return { width: CIRCLE + CIRCLE_GAP + labelWidth(node, measure, false, true), height: LEAF_HEIGHT };
    case "class":
      return { width: labelWidth(node, measure, true, false) + 28, height: HEX_HEIGHT };
    case "dataclass":
      return tableSize(node, measure);
    case "package":
      return { width: labelWidth(node, measure, true, false) + FOLDER_PAD, height: MODULE_HEIGHT };
    case "external":
      return { width: labelWidth(node, measure, false, false) + 24, height: EXTERNAL_HEIGHT };
    case "module":
      return { width: MODULE_WIDTH, height: MODULE_HEIGHT };
  }
}

/** 자식을 그리는 노드의 안쪽 여백과 최소 크기. 펼친 폴더 영역은 머리 줄에 폴더 경로만 적는다. */
function boxOptions(node: AtlasNode, functions: number, measure: Measure): Record<string, string> {
  let top = node.kind === "package" ? REGION_HEAD : HEADER;
  let minWidth = labelWidth(node, measure, true, node.kind === "module") + 2 * PAD;
  if (node.kind === "module") {
    minWidth += COUNT_GAP + measure(moduleHeader(node, functions));
  }
  if (node.kind === "dataclass") {
    const table = tableSize(node, measure);
    top = table.height + PAD;
    minWidth = table.width;
  }
  return {
    "elk.padding": `[top=${top},left=${PAD},bottom=${PAD},right=${PAD}]`,
    "elk.nodeSize.constraints": "MINIMUM_SIZE",
    "elk.nodeSize.minimum": `(${Math.ceil(minWidth)}, ${top + PAD})`,
  };
}

/** 형제 노드 사이의 선 하나. key는 `drawn`이 같은 양 끝에 붙이는 키와 같다. */
export interface Link {
  key: EdgeKey;
  source: string;
  target: string;
}

export interface ElkInput {
  /** 연결 묶음마다 ELK 뿌리 하나. 위에서 아래로 쌓는 순서다. */
  components: ElkNode[];
  /** 선반 단위마다 ELK 노드 하나. 펼친 단위만 children을 가진다. */
  shelf: ElkNode[];
}

/**
 * 선의 양 끝을 보이는 노드로 올린 뒤 같은 부모 아래 형제가 될 때까지 다시 올려 형제 쌍마다 모은다.
 * 올린 선이 하나라도 있는 쌍은 집계 선 하나가, 그 밖의 쌍은 원래 선마다 하나가 된다.
 * 함수 안 import만 있는 쌍을 빼고 부모 노드 id 아래에 담는다. 진입점 단위 사이의 쌍은 두 단위가 같은 열0에 놓이므로
 * 담지 않고, 그 선은 `edgeViews`가 `sideRoute`로 잇는다.
 */
function links(graph: Graph, shown: Shown): Map<string | null, Link[]> {
  const nodes = nodeIndex(graph);
  const entries = entryUnits(graph, shown.hidden);
  const pairs = new Map<string, { source: string; target: string; edges: AtlasEdge[]; lifted: boolean }>();
  for (const edge of graph.edges) {
    const source = lift(nodes, shown, edge.source);
    const target = lift(nodes, shown, edge.target);
    const ends = source === null || target === null ? null : siblings(nodes, source, target);
    if (ends === null) {
      continue;
    }
    const id = `${ends[0]}|${ends[1]}`;
    const pair = pairs.get(id) ?? { source: ends[0], target: ends[1], edges: [], lifted: false };
    pair.edges.push(edge);
    pair.lifted ||= ends[0] !== edge.source || ends[1] !== edge.target;
    pairs.set(id, pair);
  }

  const inside = new Map<string | null, Link[]>();
  for (const { source, target, edges, lifted } of pairs.values()) {
    const used = edges.filter((e) => !e.deferred);
    if (used.length === 0 || (entries.has(source) && entries.has(target))) {
      continue;
    }
    const found = (lifted ? [aggKey(source, target)] : used.map(edgeKey)).map((key) => ({ key, source, target }));
    const parent = nodes.get(source)!.parent;
    inside.set(parent, [...(inside.get(parent) ?? []), ...found]);
  }
  return inside;
}

/**
 * 보이는 노드를 연결 묶음마다 parent 사슬로 중첩한 ELK 입력. 자식을 그리는 노드마다 따로 배치하므로 선은 형제 사이로
 * 올려 그 부모에 선언한다. 노드마다 `columns`의 열 번호를 partition으로 주고 children을 열 안 순서로 넣는다.
 */
export function elkGraphs(graph: Graph, shown: Shown, columns: Columns, measure: Measure): ElkInput {
  const nodes = nodeIndex(graph);
  const children = new Map<string, AtlasNode[]>();
  for (const node of graph.nodes) {
    if (shown.nodes.has(node.id) && node.parent !== null) {
      children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
    }
  }
  for (const list of children.values()) {
    list.sort((a, b) => columns.order.get(a.id)! - columns.order.get(b.id)!);
  }

  const inside = links(graph, shown);
  const edgesOf = (parent: string | null, members?: Set<string>): ElkExtendedEdge[] =>
    (inside.get(parent) ?? [])
      .filter((link) => members === undefined || members.has(link.source))
      .map((link) => ({ id: link.key, sources: [link.source], targets: [link.target] }));

  const functions = functionCounts(graph);
  const build = (node: AtlasNode): ElkNode => {
    const kids = children.get(node.id) ?? [];
    const options: Record<string, string> = {
      "elk.partitioning.partition": String(columns.column.get(node.id)!),
      "elk.alignment": "LEFT",
    };
    if (kids.length > 0) {
      return {
        id: node.id,
        children: kids.map(build),
        edges: edgesOf(node.id),
        layoutOptions: { ...ELK_OPTIONS, ...options, ...boxOptions(node, functions.get(node.id) ?? 0, measure) },
      };
    }
    if (node.kind !== "module") {
      return { id: node.id, ...leafSize(node, measure), layoutOptions: options };
    }
    const caption = moduleHeader(node, functions.get(node.id) ?? 0);
    return {
      id: node.id,
      ...leafSize(node, measure),
      labels: [{ text: caption, width: measure(caption), height: CAPTION_HEIGHT }],
      layoutOptions: { ...options, "elk.nodeLabels.placement": "OUTSIDE V_BOTTOM H_LEFT" },
    };
  };

  return {
    components: columns.components.map((ids, i) => ({
      id: `component:${i}`,
      layoutOptions: ROOT_OPTIONS,
      children: ids.map((id) => build(nodes.get(id)!)),
      edges: edgesOf(null, new Set(ids)),
    })),
    shelf: columns.shelf.map((id) => build(nodes.get(id)!)),
  };
}

/** ELK 결과를 부모 기준 좌표, 절대 좌표, 절대 좌표 선 경로로 바꾼다. offset은 뿌리의 화면 기준 위치다. */
export function fromElk(root: ElkNode, offset: Point = { x: 0, y: 0 }): Layout {
  const result: Layout = { positions: new Map(), sizes: new Map(), boxes: new Map(), routes: new Map() };
  const origins = new Map<string, Point>([[root.id, offset]]);
  const edges: [ElkExtendedEdge, string][] = [];

  const walk = (node: ElkNode, origin: Point) => {
    for (const edge of (node.edges ?? []) as ElkExtendedEdge[]) {
      edges.push([edge, node.id]);
    }
    for (const child of node.children ?? []) {
      const x = child.x ?? 0;
      const y = child.y ?? 0;
      const size = { width: child.width ?? 0, height: child.height ?? 0 };
      const abs = { x: origin.x + x, y: origin.y + y };
      result.positions.set(child.id, node === root ? abs : { x, y });
      result.sizes.set(child.id, size);
      result.boxes.set(child.id, { ...abs, ...size });
      origins.set(child.id, abs);
      walk(child, abs);
    }
  };
  walk(root, offset);

  for (const [edge, declared] of edges) {
    const section = edge.sections?.[0];
    if (section === undefined) {
      continue;
    }
    const container = (edge as ElkExtendedEdge & { container?: string }).container ?? declared;
    const o = origins.get(container) ?? offset;
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    result.routes.set(
      edge.id,
      points.map((p) => ({ x: p.x + o.x, y: p.y + o.y })),
    );
  }
  return result;
}

/**
 * 연결 묶음을 차례로 배치해 위에서 아래로 쌓고, 선반 단위를 마지막 묶음 아래 격자에 놓는다.
 * 격자는 가장 넓은 묶음의 폭에서 줄을 바꾸고, 한 칸보다 넓은 단위는 여러 칸을 쓴다.
 */
export async function arrange(input: ElkInput, run: RunElk): Promise<Layout> {
  const result: Layout = { positions: new Map(), sizes: new Map(), boxes: new Map(), routes: new Map() };
  const add = (part: Layout) => {
    part.positions.forEach((value, id) => result.positions.set(id, value));
    part.sizes.forEach((value, id) => result.sizes.set(id, value));
    part.boxes.forEach((value, id) => result.boxes.set(id, value));
    part.routes.forEach((value, key) => result.routes.set(key, value));
  };

  let width = 0;
  let y = 0;
  for (const root of input.components) {
    const done = await run(root);
    add(fromElk(done, { x: 0, y }));
    width = Math.max(width, done.width ?? 0);
    y += (done.height ?? 0) + STACK_GAP;
  }

  const cell = MODULE_WIDTH + GRID_GAP;
  const limit = Math.max(width, SHELF_COLUMNS * cell - GRID_GAP);
  let x = 0;
  let row = 0;
  y = input.components.length > 0 ? y - STACK_GAP + SHELF_GAP : 0;
  for (const node of input.shelf) {
    const root: ElkNode = { id: `shelf:${node.id}`, layoutOptions: ROOT_OPTIONS, children: [node] };
    const done = node.children === undefined ? root : await run(root);
    const box = done.children![0];
    if (x > 0 && x + box.width! > limit) {
      x = 0;
      y += row + GRID_GAP;
      row = 0;
    }
    add(fromElk(done, { x, y }));
    x += Math.ceil((box.width! + GRID_GAP) / cell) * cell;
    row = Math.max(row, (box.labels ?? []).reduce((sum, label) => sum + (label.height ?? 0), box.height!));
  }
  return result;
}

const ROUTE_GAP = 12;

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

/**
 * 배치가 경로를 내지 않은 선의 경로. 진입점 단위 사이 선이 이 경로를 쓴다. 화면에 보이는 양 끝 상자의 위치로 정한다.
 * 도착 상자가 오른쪽에 있으면 출발 상자의 오른쪽 변에서 나와 도착 상자 바로 앞에서 세로로 꺾어 왼쪽 변으로 들어간다.
 * 도착 상자가 왼쪽에 있으면 좌우를 뒤집은 경로다. 두 상자가 가로로 겹치면 같은 열이므로 두 상자의 오른쪽으로 나가
 * 도착 상자의 오른쪽 변으로 들어간다.
 */
export function sideRoute(source: Box, target: Box): Point[] {
  const sy = source.y + source.height / 2;
  const ty = target.y + target.height / 2;
  const [sr, tr] = [source.x + source.width, target.x + target.width];
  const [sx, x, tx] =
    sr + ROUTE_GAP <= target.x
      ? [sr, target.x - ROUTE_GAP, target.x]
      : tr + ROUTE_GAP <= source.x
        ? [source.x, tr + ROUTE_GAP, tr]
        : [sr, Math.max(sr, tr) + ROUTE_GAP, tr];
  return [
    { x: sx, y: sy },
    { x, y: sy },
    { x, y: ty },
    { x: tx, y: ty },
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
export const runElk: RunElk = (input) => {
  elk ??= new ELK({ workerFactory: () => new Worker(elkWorkerUrl) });
  return elk.layout(input);
};

export async function layout(graph: Graph, shown: Shown, columns: Columns): Promise<Layout> {
  const started = performance.now();
  const result = await arrange(elkGraphs(graph, shown, columns, measureText), runElk);
  console.info(`layout ${shown.nodes.size} nodes ${Math.round(performance.now() - started)}ms`);
  return result;
}
