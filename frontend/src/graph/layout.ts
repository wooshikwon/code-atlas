// ELK 입력을 만들고 결과를 React Flow 좌표로 바꾼다. 노드 컴포넌트는 ELK 결과를 읽지 않고 여기서 바꾼 값만 받는다.
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { AtlasEdge, AtlasNode, Graph } from "../api/types";
import { entryUnits, siblings, type Columns } from "./columns";
import { cycles } from "./cycles";
import { cycleMarks } from "./overlay";
import { aggKey, edgeKey, type EdgeKey } from "./scope";
import { lift, nodeIndex, type Pack, type Shown } from "./visible";

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
  /**
   * 상자의 변에서 옆 통로(배치 밖에서 정하는 경로가 꺾는 세로 줄)까지의 거리(`laneOf`). 도착 노드의 변과 통로 사이의 곧은 구간에
   * 들어오는 합계를 적는다.
   */
  lane: number;
}

/** 글자 폭을 잰다. 브라우저는 canvas로 재고 시험은 글자 수로 어림한다. */
export type Measure = (text: string, bold?: boolean) => number;

/** ELK를 한 번 돌린다. 브라우저는 worker로, 시험은 elk.bundled.js로 돌린다. */
export type RunElk = (graph: ElkNode) => Promise<ElkNode>;

const FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
export const HEADER = 32;
/** 자식을 그리는 상자의 안쪽 여백 */
export const PAD = 16;
export const TABLE_HEAD = 24;
export const TABLE_ROW = 18;
const HEX_HEIGHT = 28;
export const MODULE_WIDTH = 320;
export const MODULE_HEIGHT = 40;
/** 접힌 파일 상자와 접힌 폴더 상자 아래에 잡아 두는 줄의 높이 */
export const CAPTION_HEIGHT = 16;
export const CIRCLE = 16;
export const LEAF_HEIGHT = 18;
export const EXTERNAL_HEIGHT = 24;
/** 이름표 앞에 그리는 진입점 표지의 폭. 체크 아이콘 12px와 이름표까지의 4px다. */
export const ENTRY_MARK_WIDTH = 16;
/** 순환 묶음에 든 파일 상자와 그런 파일을 품은 접힌 폴더 상자의 이름표 앞에 그리는 순환 아이콘의 폭. 아이콘 12px와 이름표까지의 4px다. */
export const CYCLE_MARK_WIDTH = 16;
const LABEL_MAX = 36;
const TABLE_ROWS_MAX = 5;
/**
 * 배지는 노드 모양의 오른쪽 위 모서리(접힌 상자 안에 든 것의 수), 오른쪽 아래 모서리(모듈 변수 변경), 왼쪽 위 모서리(요약을 만드는 중인
 * 도는 원)에 단다. 배지의 세로 가운데를 모양의 위·아래 변에 맞추고 바깥쪽 끝을 모양의 그쪽 끝에서 BADGE_OVERHANG만큼 내보낸다.
 * 오른쪽 배지는 글자가 늘면 왼쪽으로 넓어지므로 모양 오른쪽으로 나온 폭은 글자 수와 관계없이 같다.
 */
export const BADGE_OVERHANG = 6;
/** 배지의 높이. 배지는 모양의 위·아래 변에서 이 높이의 절반만큼 나간다. */
export const BADGE_HEIGHT = 14;
/** 배지의 오른쪽 끝과 이름표 사이에 남기는 폭 */
export const BADGE_GAP = 3;
/** 원과 그 오른쪽 이름표 사이의 폭. 배지가 나온 폭과 배지 뒤에 남기는 폭을 더한 값이다. */
export const CIRCLE_GAP = BADGE_OVERHANG + BADGE_GAP;
export const LOC_GAP = 5;
/** 강조하는 경로의 출발 노드와 도착 노드 이름표 뒤에 적는 표지 */
export const END_NAMES = { from: "출발", to: "도착" } as const;
export type RouteEnd = keyof typeof END_NAMES;
/** 표지 앞에 띄우는 폭과 표지의 좌우 안쪽 여백 */
export const END_GAP = 6;
export const END_PAD = 6;
const COUNT_GAP = 12;
/** 펼친 파일 상자의 머리 줄에서 줄 수 뒤에 적는 변경 상태 글자 앞의 폭과 그 글자 가운데 넓은 쪽 */
const CHANGE_GAP = 5;
const CHANGE_MARK = "M";
const FOLDER_PAD = 36;
/** 펼친 폴더 영역에서 폴더 경로를 적는 머리 줄의 높이 */
export const REGION_HEAD = 28;
const STACK_GAP = 48;
const SHELF_GAP = 64;
const GRID_GAP = 24;
const SHELF_COLUMNS = 4;

/** 함수 안 import 선이 두 노드 아래로 돌아가는 줄과 노드 사이의 거리. 배치가 내는 선의 세로 줄과 옆 통로 사이도 이만큼 띄운다. */
const ROUTE_GAP = 10;

/** 선의 수를 적는 글자(`.edge-weight`, 11px)의 숫자 하나 폭과 줄 높이 */
export const DIGIT_WIDTH = 7;
export const NUMBER_HEIGHT = 14;
/** 숫자 둘레에 비우는 폭. 숫자를 선에서 끊는 바탕색 테두리(stroke 3px의 바깥쪽 절반)를 올림한 값이다. */
export const NUMBER_PAD = 2;
/** 화살촉의 길이. 세 분류 가운데 가장 긴 계승 화살촉(`edges/OrthogonalEdge.tsx`의 markerWidth)이다. */
export const ARROW_LENGTH = 13;
/** 합류점과 갈림점의 반지름. `edges/Trunk.tsx`가 합류점은 채운 원으로, 갈림점은 테두리만 두른 빈 원으로 그린다. */
export const JOINT_RADIUS = 2.5;
/** 갈림점의 테두리 굵기. 실행 선과 사용 선의 굵기와 같다. */
export const FORK_RIM = 1.5;

/** digits 자리 수가 선 위에서 차지하는 폭 */
export function numberWidth(digits: number): number {
  return digits * DIGIT_WIDTH + 2 * NUMBER_PAD;
}

/**
 * 상자의 변에서 옆 통로까지의 거리. 도착 노드 앞의 곧은 구간에 화살촉, digits 자리 수, 합류점이 겹치지 않고 놓이는 길이다.
 */
export function laneOf(digits: number): number {
  return ARROW_LENGTH + NUMBER_PAD + numberWidth(digits) + Math.ceil(JOINT_RADIUS);
}

/**
 * 화면에 적을 수 있는 가장 큰 수의 자릿수. 노드마다 그 노드 밖에서 안으로 들어오는 선의 sites 수를 더한 값 가운데 가장 큰 값이
 * 도착 노드 앞에 적는 합계의 상한이다. off에 든 노드와의 선은 세지 않는다.
 */
export function numberDigits(graph: Graph, off: Set<string>): number {
  const nodes = nodeIndex(graph);
  const arriving = new Map<string, number>();
  for (const edge of graph.edges) {
    if (off.has(edge.source) || off.has(edge.target)) {
      continue;
    }
    const outside = new Set<string>();
    for (let at = nodes.get(edge.source); at !== undefined; at = at.parent === null ? undefined : nodes.get(at.parent)) {
      outside.add(at.id);
    }
    for (let at = nodes.get(edge.target); at !== undefined && !outside.has(at.id); at = at.parent === null ? undefined : nodes.get(at.parent)) {
      arriving.set(at.id, (arriving.get(at.id) ?? 0) + edge.sites.length);
    }
  }
  return String(Math.max(1, ...arriving.values())).length;
}
/** 같은 열의 두 상자를 잇는 선이 상자의 옆면에서 드나드는 높이. 마주 보는 쪽 모서리에서 이만큼 안쪽이다. */
const CORNER_INSET = 6;

/**
 * 열 안의 노드를 `ordered`가 적은 순서대로 놓게 하는 ELK 옵션. semiInteractive를 켜면 ELK가 같은 열의 노드를 `elk.position`의 y가
 * 작은 것부터 놓도록 묶어 두고, 여러 열을 건너는 선이 지나는 높이만 교차가 줄어들게 고른다. 교차 최소화는 한 번만 돈다(thoroughness 1).
 * 무작위로 다시 시작하는 횟수만큼 계산 시간이 늘고, ELK 기본값인 일곱 번을 돌아도 sync-engine과 mdp에서 줄어드는 교차가 7% 이하다.
 * 모델 순서 옵션(`considerModelOrder`)은 쓰지 않는다. 그 옵션이 켜는 정렬 단계가 선이 수백 개인 배치에서 계산 시간의 90% 이상을 쓴다.
 * 구조 뷰와 함수 시점 뷰의 ELK 입력이 함께 쓴다.
 */
export function arrangeOptions(): Record<string, string> {
  return {
    "elk.layered.crossingMinimization.semiInteractive": "true",
    "elk.layered.crossingMinimization.greedySwitch.type": "OFF",
    "elk.layered.thoroughness": "1",
  };
}

/** 형제 노드마다 배열 순서를 `elk.position`의 y로 적는다. ELK는 이 값을 같은 열에 놓인 노드의 순서로만 읽는다. */
export function ordered(children: ElkNode[]): ElkNode[] {
  return children.map((child, i) => ({ ...child, layoutOptions: { ...child.layoutOptions, "elk.position": `(0,${i})` } }));
}

/** 자식을 그리지 않는 노드가 들어오는 선을 받는 포트의 id */
export function inPort(id: string): string {
  return `${id}#in`;
}

/** 자식을 그리지 않는 노드 id가 target으로 가는 선을 내보내는 포트의 id */
export function outPort(id: string, target: string): string {
  return `${id}#out#${target}`;
}

/**
 * 자식을 그리지 않는 노드는 왼쪽 변 가운데에 들어오는 포트 하나를, 오른쪽 변 가운데에 나가는 포트를 도착 노드(targets)마다 하나씩 둔다.
 * ELK의 직각 경로 계산은 포트로 이어진 선을 한 묶음으로 보고 묶음마다 세로 줄 하나를 낸다. 들어오는 포트가 하나이므로 같은 노드로
 * 가는 선이 세로 줄 하나를 함께 쓰고, 나가는 포트는 같은 점에 놓이므로 같은 노드에서 나가는 선이 첫 세로 줄까지 가로 줄 하나를 함께
 * 지난다. 나가는 포트를 도착 노드마다 따로 두어 묶음이 도착 노드마다 나뉘므로, 세로 줄 하나는 한 노드로 들어가는 선만 지난다.
 * 자식을 그리는 노드(폴더 영역, 펼친 파일 상자)는 배치 전에 크기를 모르므로 포트를 두지 않는다. 구조 뷰와 함수 시점 뷰의 ELK 입력이
 * 함께 쓴다.
 */
export function joined(node: ElkNode, targets: string[]): ElkNode {
  const [width, height] = [node.width ?? 0, node.height ?? 0];
  return {
    ...node,
    ports: [
      { id: inPort(node.id), x: 0, y: height / 2, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST" } },
      ...targets.map((target) => ({ id: outPort(node.id, target), x: width, y: height / 2, width: 0, height: 0, layoutOptions: { "elk.port.side": "EAST" } })),
    ],
    layoutOptions: { ...node.layoutOptions, "elk.portConstraints": "FIXED_POS" },
  };
}

/** 같은 열에 놓인 형제 노드 사이의 세로 간격 */
export const NODE_GAP = 24;

/**
 * 선과 노드 사이의 간격을 정하는 ELK 옵션. 배치가 내는 선의 세로 줄을 상자의 변에서 옆 통로(lane)보다 `ROUTE_GAP`만큼 더 떨어뜨려,
 * 도착 노드 앞의 곧은 구간에 들어오는 합계가 들어가고 세로 줄이 옆 통로와 겹치지 않게 한다. 구조 뷰와 함수 시점 뷰의 ELK 입력이 함께 쓴다.
 */
export function spacingOptions(lane: number): Record<string, string> {
  return { "elk.layered.spacing.edgeNodeBetweenLayers": String(lane + ROUTE_GAP) };
}

/** 열은 partition으로, 열 안 순서는 children 배열 순서로 고정한다. */
function elkOptions(lane: number): Record<string, string> {
  return {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.partitioning.activate": "true",
    ...arrangeOptions(),
    "elk.separateConnectedComponents": "false",
    "elk.spacing.nodeNode": String(NODE_GAP),
    "elk.layered.spacing.nodeNodeBetweenLayers": "48",
    ...spacingOptions(lane),
  };
}

const ROOT_PADDING = { "elk.padding": "[top=0,left=0,bottom=0,right=0]" };

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

/** 접힌 파일 상자와 접힌 폴더 상자 아래에 잡아 두는 줄의 글자. 미사용 후보 표시를 켜고 꺼도 배치가 같도록 후보 수와 관계없이 이 폭을 잡는다. */
const BOX_CAPTION = "미사용 후보 999";

/** 접힌 파일 상자와 접힌 폴더 상자 아래에 적는 글자. 안에 든 미사용 후보 수 unused가 0이면 적지 않는다. 상자 크기에 들지 않는다. */
export function boxCaption(unused: number): string {
  return unused === 0 ? "" : `미사용 후보 ${unused}`;
}

/** 손잡이 노드의 id. 손잡이는 파일 상자 box의 자식으로 배치한다. */
export function packId(box: string): string {
  return `${box}#pack`;
}

/**
 * 손잡이의 글. 펼침 단계에서는 그리지 않은 안쪽 자식 수를 `내부 함수 k개`로, 전부 펼침 단계에서는 같은 수와 "접기"를 적는다.
 * 미사용 후보 표시가 꺼져 있고(covered가 거짓) 그리지 않은 자식에 미사용 후보가 있으면 그 수를 뒤에 붙인다.
 */
export function packLabel(pack: Pack, covered: boolean): string {
  if (pack.open) {
    return `내부 함수 ${pack.ids.length}개 접기`;
  }
  return pack.unused > 0 && !covered ? `내부 함수 ${pack.ids.length}개 · 미사용 후보 ${pack.unused}` : `내부 함수 ${pack.ids.length}개`;
}

/** 손잡이의 좌우 안쪽 여백 */
export const PACK_PAD = 6;

/** 손잡이의 크기. 글자 폭에 여백을 더한 폭과 함수 노드의 한 줄 높이다. 분석 표시를 켜고 꺼도 배치가 같도록 미사용 후보 수를 적은 글의 폭을 잡는다. */
function packSize(pack: Pack, measure: Measure): Size {
  return { width: measure(packLabel(pack, false)) + 2 * PACK_PAD, height: LEAF_HEIGHT };
}

/** 이름표 둘레에 그리는 표시. cycle은 이름표 앞에 순환 아이콘을 다는지, end는 이름표 뒤에 적는 출발·도착 표지다. */
interface Marks {
  cycle: boolean;
  end?: RouteEnd;
}

/** 순환 아이콘, 진입점 표지, 이름표의 폭. loc이 참이면 이름표 오른쪽 줄 수 숫자의 폭을, 출발·도착 표지가 있으면 그 폭을 더한다. */
function labelWidth(node: AtlasNode, measure: Measure, bold: boolean, loc: boolean, marks: Marks): number {
  const label = (marks.cycle ? CYCLE_MARK_WIDTH : 0) + (node.entry ? ENTRY_MARK_WIDTH : 0) + measure(labelOf(node), bold);
  const tag = marks.end === undefined ? 0 : END_GAP + measure(END_NAMES[marks.end], true) + 2 * END_PAD;
  return (loc ? label + LOC_GAP + measure(String(node.loc)) : label) + tag;
}

function tableSize(node: AtlasNode, measure: Measure, marks: Marks): Size {
  const widths = [labelWidth(node, measure, true, true, marks), ...tableRows(node).map((r) => measure(r))];
  return { width: Math.ceil(Math.max(...widths)) + 16, height: tableHeight(node) };
}

/** 자식을 그리지 않는 노드의 크기. 접힌 파일 상자는 폭이 정해져 있어 표시의 폭을 더하지 않는다. */
function leafSize(node: AtlasNode, measure: Measure, marks: Marks): Size {
  switch (node.kind) {
    case "function":
    case "method":
      return { width: CIRCLE + CIRCLE_GAP + labelWidth(node, measure, false, true, marks), height: LEAF_HEIGHT };
    case "class":
      return { width: labelWidth(node, measure, true, false, marks) + 28, height: HEX_HEIGHT };
    case "dataclass":
      return tableSize(node, measure, marks);
    case "package":
      return { width: labelWidth(node, measure, true, false, marks) + FOLDER_PAD, height: MODULE_HEIGHT };
    case "external":
      return { width: labelWidth(node, measure, false, false, marks) + 24, height: EXTERNAL_HEIGHT };
    case "module":
      return { width: MODULE_WIDTH, height: MODULE_HEIGHT };
  }
}

/**
 * 자식을 그리는 노드의 안쪽 여백과 최소 크기. 펼친 폴더 영역은 머리 줄에 폴더 경로만 적는다. 펼친 파일 상자는 변경 상태 글자의 폭을
 * 변경 표시가 없을 때도 잡아 두어, 변경 표시가 생기거나 사라져도 배치가 바뀌지 않는다. 손잡이를 다는 상자는 handle(손잡이의 크기)을
 * 받아, 자식을 놓는 영역 아래에 형제 노드 사이의 간격과 손잡이 한 줄을 아래 여백에 더하고 손잡이의 폭이 들어가게 한다.
 */
function boxOptions(node: AtlasNode, functions: number, measure: Measure, marks: Marks, handle: Size | null): Record<string, string> {
  let top = node.kind === "package" ? REGION_HEAD : HEADER;
  let minWidth = labelWidth(node, measure, true, node.kind === "module", marks) + 2 * PAD;
  if (node.kind === "module") {
    minWidth += CHANGE_GAP + measure(CHANGE_MARK, true) + COUNT_GAP + measure(moduleHeader(node, functions));
  }
  if (node.kind === "dataclass") {
    const table = tableSize(node, measure, marks);
    top = table.height + PAD;
    minWidth = table.width;
  }
  const bottom = PAD + (handle === null ? 0 : NODE_GAP + handle.height);
  return {
    "elk.padding": `[top=${top},left=${PAD},bottom=${bottom},right=${PAD}]`,
    "elk.nodeSize.constraints": "MINIMUM_SIZE",
    "elk.nodeSize.minimum": `(${Math.ceil(Math.max(minWidth, handle === null ? 0 : handle.width + 2 * PAD))}, ${top + bottom})`,
  };
}

/** 형제 노드 사이의 선 하나. key는 `drawn`이 같은 양 끝에 붙이는 키와 같다. */
export interface Link {
  key: EdgeKey;
  source: string;
  target: string;
}

export interface ElkInput {
  /** 상자의 변에서 옆 통로까지의 거리. 배치 결과(`Layout.lane`)에 그대로 담는다. */
  lane: number;
  /** 연결 묶음마다 ELK 뿌리 하나. 위에서 아래로 쌓는 순서다. */
  components: ElkNode[];
  /** 선반 단위마다 ELK 노드 하나. 펼친 단위만 children을 가진다. */
  shelf: ElkNode[];
  /** 손잡이를 다는 상자의 id와 그 손잡이의 크기. 손잡이는 ELK에 넣지 않고 `arrange`가 상자 안 왼쪽 아래에 놓는다. */
  packs: Map<string, Size>;
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
 * 올려 그 부모에 선언하고, 자식을 그리지 않는 노드에 닿는 선은 그 노드의 포트(`joined`)에 닿게 한다. 노드마다 `columns`의 열 번호를 partition으로 주고 children을 열 안 순서로 넣어 그 순서를 `ordered`로 적는다.
 * ends는 강조하는 경로의 출발 노드와 도착 노드이고, 그 노드의 크기에 표지의 폭을 더한다.
 * 순환 아이콘을 다는 상자는 아이콘의 폭을 크기에 더한다. 접힌 파일 상자와 접힌 폴더 상자는 아래 글자의 줄을 상자 아래에 잡아 둔다.
 * 손잡이를 다는 파일 상자(`shown.packs`)는 자식을 놓는 영역 아래에 손잡이 한 줄을 비워 둔다(`boxOptions`).
 */
export function elkGraphs(graph: Graph, shown: Shown, columns: Columns, measure: Measure, ends: Map<string, RouteEnd>): ElkInput {
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
      .map((link) => ({
        id: link.key,
        sources: [children.has(link.source) ? link.source : outPort(link.source, link.target)],
        targets: [children.has(link.target) ? link.target : inPort(link.target)],
      }));
  /** 노드마다 그 노드에서 나가는 선의 도착 노드 */
  const targets = new Map<string, Set<string>>();
  for (const link of [...inside.values()].flat()) {
    targets.set(link.source, (targets.get(link.source) ?? new Set()).add(link.target));
  }

  const lane = laneOf(numberDigits(graph, shown.hidden));
  const options = elkOptions(lane);
  const functions = functionCounts(graph);
  const marked = cycleMarks(graph, cycles(graph, shown.hidden), shown);
  const marksOf = (id: string): Marks => ({ cycle: marked.has(id), end: ends.get(id) });
  const packs: ElkInput["packs"] = new Map();
  const build = (node: AtlasNode): ElkNode => {
    const kids = children.get(node.id) ?? [];
    const placed: Record<string, string> = {
      "elk.partitioning.partition": String(columns.column.get(node.id)!),
      "elk.alignment": "LEFT",
    };
    if (kids.length > 0) {
      const pack = shown.packs.get(node.id);
      const handle = pack === undefined ? null : packSize(pack, measure);
      if (handle !== null) {
        packs.set(node.id, handle);
      }
      return {
        id: node.id,
        children: ordered(kids.map(build)),
        edges: edgesOf(node.id),
        layoutOptions: { ...options, ...placed, ...boxOptions(node, functions.get(node.id) ?? 0, measure, marksOf(node.id), handle) },
      };
    }
    if (node.kind !== "module" && node.kind !== "package") {
      return joined({ id: node.id, ...leafSize(node, measure, marksOf(node.id)), layoutOptions: placed }, [...(targets.get(node.id) ?? [])]);
    }
    return joined(
      {
        id: node.id,
        ...leafSize(node, measure, marksOf(node.id)),
        labels: [{ text: BOX_CAPTION, width: measure(BOX_CAPTION), height: CAPTION_HEIGHT }],
        layoutOptions: { ...placed, "elk.nodeLabels.placement": "OUTSIDE V_BOTTOM H_LEFT" },
      },
      [...(targets.get(node.id) ?? [])],
    );
  };

  return {
    lane,
    components: columns.components.map((ids, i) => ({
      id: `component:${i}`,
      layoutOptions: { ...options, ...ROOT_PADDING },
      children: ordered(ids.map((id) => build(nodes.get(id)!))),
      edges: edgesOf(null, new Set(ids)),
    })),
    shelf: columns.shelf.map((id) => build(nodes.get(id)!)),
    packs,
  };
}

/** ELK 결과를 부모 기준 좌표, 절대 좌표, 절대 좌표 선 경로로 바꾼다. lane은 ELK 입력을 만들 때 쓴 옆 통로의 거리이고 offset은 뿌리의 화면 기준 위치다. */
export function fromElk(root: ElkNode, lane: number, offset: Point = { x: 0, y: 0 }): Layout {
  const result: Layout = { positions: new Map(), sizes: new Map(), boxes: new Map(), routes: new Map(), lane };
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
 * 격자는 가장 넓은 묶음의 폭에서 줄을 바꾸고, 한 칸보다 넓은 단위는 여러 칸을 쓴다. 손잡이는 손잡이를 다는 상자 안의 왼쪽 아래,
 * 안쪽 여백만큼 들어온 곳에 놓는다. 상자가 자식을 놓는 영역 아래에 손잡이 한 줄을 비워 두었으므로 손잡이는 어느 자식과도 겹치지 않는다.
 */
export async function arrange(input: ElkInput, run: RunElk): Promise<Layout> {
  const result: Layout = { positions: new Map(), sizes: new Map(), boxes: new Map(), routes: new Map(), lane: input.lane };
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
    add(fromElk(done, input.lane, { x: 0, y }));
    width = Math.max(width, done.width ?? 0);
    y += (done.height ?? 0) + STACK_GAP;
  }

  const cell = MODULE_WIDTH + GRID_GAP;
  const limit = Math.max(width, SHELF_COLUMNS * cell - GRID_GAP);
  let x = 0;
  let row = 0;
  y = input.components.length > 0 ? y - STACK_GAP + SHELF_GAP : 0;
  for (const node of input.shelf) {
    const root: ElkNode = { id: `shelf:${node.id}`, layoutOptions: { ...elkOptions(input.lane), ...ROOT_PADDING }, children: [node] };
    const done = node.children === undefined ? root : await run(root);
    const box = done.children![0];
    if (x > 0 && x + box.width! > limit) {
      x = 0;
      y += row + GRID_GAP;
      row = 0;
    }
    add(fromElk(done, input.lane, { x, y }));
    x += Math.ceil((box.width! + GRID_GAP) / cell) * cell;
    row = Math.max(row, (box.labels ?? []).reduce((sum, label) => sum + (label.height ?? 0), box.height!));
  }
  for (const [id, size] of input.packs) {
    const box = result.boxes.get(id);
    if (box !== undefined) {
      const place = { x: PAD, y: box.height - PAD - size.height };
      result.positions.set(packId(id), place);
      result.sizes.set(packId(id), size);
      result.boxes.set(packId(id), { x: box.x + place.x, y: box.y + place.y, ...size });
    }
  }
  return result;
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

/**
 * 한쪽이 다른 쪽을 품은 두 상자를 잇는 경로. 안쪽 상자의 왼쪽 변 가운데와 같은 높이의 바깥 상자 왼쪽 변을 가로로 잇는다.
 * 클래스에서 그 생성자 메서드로 가는 걸음처럼 품은 노드와 안의 노드를 잇는 경로의 걸음이 쓴다.
 */
export function insideRoute(source: Box, target: Box): Point[] {
  const inner = source.x > target.x ? source : target;
  const y = inner.y + inner.height / 2;
  return [
    { x: source.x, y },
    { x: target.x, y },
  ];
}

/**
 * 배치가 경로를 내지 않은 선의 경로. 진입점 단위 사이 선이 이 경로를 쓴다. 화면에 보이는 양 끝 상자의 위치로 정한다.
 * 도착 상자가 오른쪽에 있으면 출발 상자의 오른쪽 변 가운데에서 나와 도착 상자의 옆 통로(변에서 lane 앞)에서 세로로 꺾어 왼쪽 변
 * 가운데로 들어간다. 도착 상자가 왼쪽에 있으면 좌우를 뒤집은 경로다. 두 상자가 가로로 겹치면 같은 열이므로 두 상자의 오른쪽 옆 통로로
 * 돌아 도착 상자의 오른쪽 변으로 들어가고, 배치가 낸 선이 드나드는 옆면 가운데를 피해 서로 마주 보는 쪽 모서리에서 `CORNER_INSET`
 * 안쪽 높이로 드나든다.
 */
export function sideRoute(source: Box, target: Box, lane: number): Point[] {
  const middle = (box: Box) => box.y + box.height / 2;
  const [sr, tr] = [source.x + source.width, target.x + target.width];
  const route = (sx: number, sy: number, x: number, tx: number, ty: number): Point[] => [
    { x: sx, y: sy },
    { x, y: sy },
    { x, y: ty },
    { x: tx, y: ty },
  ];
  if (sr + lane <= target.x) {
    return route(sr, middle(source), target.x - lane, target.x, middle(target));
  }
  if (tr + lane <= source.x) {
    return route(source.x, middle(source), tr + lane, tr, middle(target));
  }
  /** 상대 상자 쪽 모서리에서 안쪽으로 들어온 높이 */
  const facing = (box: Box, other: Box) => {
    const inset = Math.min(CORNER_INSET, box.height / 2);
    return middle(other) < middle(box) ? box.y + inset : box.y + box.height - inset;
  };
  return route(sr, facing(source, target), Math.max(sr, tr) + lane, tr, facing(target, source));
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

/**
 * 돌고 있는 ELK 계산을 worker와 함께 끝낸다. worker는 요청을 차례로 처리하므로 버린 계산을 끝내야 다음 계산이 바로 시작한다.
 * 끝낸 계산의 응답은 오지 않고, 다음 `runElk`가 새 worker를 띄운다.
 */
export function stopElk(): void {
  elk?.terminateWorker();
  elk = null;
}

export async function layout(graph: Graph, shown: Shown, columns: Columns, ends: Map<string, RouteEnd>): Promise<Layout> {
  const started = performance.now();
  const result = await arrange(elkGraphs(graph, shown, columns, measureText, ends), runElk);
  console.info(`layout ${shown.nodes.size} nodes ${Math.round(performance.now() - started)}ms`);
  return result;
}
