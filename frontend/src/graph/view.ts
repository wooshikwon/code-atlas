// 그릴 선과 배치를 합쳐 노드와 선 컴포넌트가 그대로 그리는 값을 만든다.
import type { AtlasNode, EdgeGroup, EdgeKind, Graph } from "../api/types";
import { siblings } from "./columns";
import {
  ARROW_LENGTH,
  BADGE_HEIGHT,
  BADGE_OVERHANG,
  belowRoute,
  CAPTION_HEIGHT,
  HEADER,
  insideRoute,
  JOINT_RADIUS,
  NODE_GAP,
  NUMBER_HEIGHT,
  NUMBER_PAD,
  numberWidth,
  PAD,
  REGION_HEAD,
  sideRoute,
  type Box,
  type Layout,
  type Point,
} from "./layout";
import type { StepKind } from "./route";
import { aggKey, type DrawnEdge, type EdgeKey, type Tone } from "./scope";

export type EdgeView = {
  key: EdgeKey;
  source: string;
  target: string;
  group: EdgeGroup;
  points: Point[];
  tone: Tone;
  opacity: number;
  /**
   * 줄기에 들지 않고 따로 들어가는 선이 도착 노드 앞에 적는 들어오는 합계. 그 선 하나의 sites 수이고 가운데 점이 at이다.
   * sites 수가 1 이하이거나 줄기에 든 선이면 null이다(줄기가 합계를 적는다).
   */
  into: Point | null;

  /** 합친 선의 sites 수 합 */
  sites: number;
  /** 합친 선의 종류마다 sites 수 합 */
  kinds: Partial<Record<EdgeKind, number>>;
  /** 강조하는 경로의 걸음을 그리는 선이면 그 걸음의 종류 */
  route: StepKind | null;
  /** 도착이 같은 선과 합류하는 선인지. 함수 안 import 선, 한쪽이 다른 쪽을 품은 선, 실행 선이 없는 이음은 합류하지 않는다. */
  joins: boolean;
  /** 함수 안 import만 합친 선이어서 두 노드 아래로 돌아가는 경로다. 이 경로는 사이에 놓인 상자를 지날 수 있다. */
  below: boolean;
  /** 경로에서 줄기에 들어가기 전까지. 줄기에 들지 않은 선은 경로 전체다. */
  branch: Point[];
  /** 이 선이 든 줄기의 키. 줄기에 들지 않았으면 null이다. */
  trunk: EdgeKey | null;
};

/**
 * 같은 노드로 들어가는 선 둘 이상이 도착 노드 앞에서 함께 지나는 구간. 한 줄기의 가지는 모두 target으로 들어간다.
 * 줄기는 선 하나로 한 번 그리고 화살촉도 하나다.
 */
export type TrunkView = {
  key: EdgeKey;
  target: string;
  /** 줄기를 이루는 선분 묶음. 첫 묶음이 도착 노드에 닿고 나머지는 앞 묶음의 중간에 붙는다. */
  pieces: Point[][];
  /** 합류점. 가지가 줄기에 붙는 점과 줄기의 묶음이 다른 묶음에 붙는 점이다. */
  joints: Point[];
  /** 줄기에 든 선 */
  keys: EdgeKey[];
  /** 줄기에 든 선을 내보내는 노드 수 */
  sources: number;
  /** 줄기에 든 선의 sites 수 합. 도착 노드로 들어오는 합계로 화살촉 앞에 적는다. */
  sites: number;
  /** 합계를 적는 가운데 점 */
  at: Point;
  /** 줄기에 든 선의 분류 가운데 집계 규칙의 순서(실행, 사용, 계승)로 가장 앞선 것 */
  group: EdgeGroup;
  /** 줄기에 든 선 가운데 강조하는 경로의 걸음이 있다 */
  route: boolean;
};

/** 숫자가 닿으면 안 되는 곳 */
interface Blocked {
  /** 노드의 글자를 그리는 칸, 합류점, 도착 노드 앞의 들어오는 합계 */
  solid: Box[];
  /** 선분의 사각형과 그 선분을 그리는 선이나 줄기의 키, 선이면 그 출발 노드. 높이 `ROW`의 줄마다 그 줄에 걸친 선분을 모은다. */
  rows: Map<number, { box: Box; owner: EdgeKey; source: string | null }[]>;
}

/** 그릴 선과 그 선이 모여 만든 줄기 */
export interface Lines {
  views: EdgeView[];
  trunks: TrunkView[];
  blocked: Blocked;
}

/** 선이 하나도 없는 화면 */
export const NO_LINES: Lines = { views: [], trunks: [], blocked: { solid: [], rows: new Map() } };

/** 부모가 자식보다 앞에 오는 순서. 같은 층의 바탕 요소는 이 순서로 그리므로 부모 위에 자식이 놓인다. */
export function parentFirst(graph: Graph, visible: Set<string>): AtlasNode[] {
  const nodes = graph.nodes.filter((n) => visible.has(n.id));
  const parents = new Map(nodes.map((n) => [n.id, n.parent]));
  const depth = (id: string): number => {
    let d = 0;
    let parent = parents.get(id) ?? null;
    while (parent !== null && parents.has(parent)) {
      d++;
      parent = parents.get(parent) ?? null;
    }
    return d;
  };
  const depths = new Map(nodes.map((n) => [n.id, depth(n.id)]));
  return nodes.sort((a, b) => depths.get(a.id)! - depths.get(b.id)!);
}

/**
 * 배치에 든 상자의 포함 관계와, 선이 지나면 안 되는 사각형. 선은 자기 출발·도착과 그 조상이 아닌 상자의 안을 지나지 않는다.
 * 자식을 그리지 않는 파일 상자와 폴더 상자는 상자 아래에 잡아 둔 글자 줄까지 막는다.
 */
interface Rooms {
  /** 상자 id → 그 안에 그린 바로 아래 상자. 어느 상자에도 들지 않은 상자는 `TOP` 아래에 담는다. */
  kids: Map<string, string[]>;
  parent: (id: string) => string | null;
  block: (id: string) => Box;
}

const TOP = "";

function roomsOf(layout: Layout, nodes: Map<string, AtlasNode>): Rooms {
  const pack = "#pack";
  const parent = (id: string) => (id.endsWith(pack) ? id.slice(0, -pack.length) : (nodes.get(id)?.parent ?? null));
  const kids = new Map<string, string[]>();
  for (const id of layout.boxes.keys()) {
    const at = parent(id);
    const room = at !== null && layout.boxes.has(at) ? at : TOP;
    kids.set(room, [...(kids.get(room) ?? []), id]);
  }
  const block = (id: string): Box => {
    const box = layout.boxes.get(id)!;
    const kind = nodes.get(id)?.kind;
    const captioned = (kind === "module" || kind === "package") && !kids.has(id);
    return captioned ? { ...box, height: box.height + CAPTION_HEIGHT } : box;
  };
  return { kids, parent, block };
}

/** id에서 조상 top까지 거슬러 올라간 상자의 사슬. top이 앞에 온다. 배치에 없는 상자가 끼면 id 하나만 담는다. */
function chainOf(rooms: Rooms, layout: Layout, top: string, id: string): string[] {
  const chain = [id];
  for (let at = rooms.parent(id); chain[0] !== top; at = rooms.parent(at)) {
    if (at === null || !layout.boxes.has(at)) {
      return [id];
    }
    chain.unshift(at);
  }
  return chain;
}

/**
 * 바깥 상자 chain[0]의 옆 통로(x가 outer인 세로 줄)에서 안쪽 상자 chain의 끝까지 들어가는 경로. side가 -1이면 상자의 왼쪽 변으로,
 * 1이면 오른쪽 변으로 들어간다. 상자를 한 겹 들어갈 때마다 그 상자 안에서 다음 상자의 열 앞 통로까지 가는 가로 줄을 고른다.
 * 가로 줄의 높이는 끝 상자의 가운데 높이, 형제 상자의 위아래 간격의 가운데, 상자의 아래 여백 가운데 형제 상자를 지나지 않는 것으로
 * 끝 상자의 가운데 높이에 가장 가까운 값이다. 열 앞 통로는 왼쪽이면 그 상자의 왼쪽 변에서, 오른쪽이면 그 열에서 가장 넓은 상자의
 * 오른쪽 변에서 옆 통로의 거리(`Layout.lane`)만큼 떨어진 세로 줄이고, 열 사이 간격 안에 있어 상자를 지나지 않는다. 지나지 않는 가로 줄이 없는 겹이 있으면
 * null이다.
 */
function legs(rooms: Rooms, layout: Layout, chain: string[], side: -1 | 1, outer: number): Point[] | null {
  const jog = layout.lane;
  const end = layout.boxes.get(chain.at(-1)!)!;
  const aim = end.y + end.height / 2;
  const points: Point[] = [];
  let x = outer;
  for (let i = 0; i + 1 < chain.length; i++) {
    const room = layout.boxes.get(chain[i])!;
    const goal = layout.boxes.get(chain[i + 1])!;
    const blocks = (rooms.kids.get(chain[i]) ?? []).map(rooms.block);
    const column = blocks.filter((b) => Math.abs(b.x - goal.x) < SAME);
    const lane = side < 0 ? goal.x - jog : Math.max(...column.map((b) => b.x + b.width)) + jog;
    const [left, right] = [Math.min(x, lane), Math.max(x, lane)];
    const top = Math.min(...blocks.map((b) => b.y));
    const free = (y: number) =>
      y > top - 1 && y < room.y + room.height && !blocks.some((b) => y > b.y - 1 && y < b.y + b.height + 1 && right > b.x && left < b.x + b.width);
    const gaps = blocks.flatMap((b) => [b.y - NODE_GAP / 2, b.y + b.height + NODE_GAP / 2]);
    const found = [aim, ...(points.length > 0 ? [points.at(-1)!.y] : []), ...gaps, room.y + room.height - PAD / 2]
      .filter(free)
      .sort((a, b) => Math.abs(a - aim) - Math.abs(b - aim))[0];
    if (found === undefined) {
      return null;
    }
    points.push({ x, y: found }, { x: lane, y: found });
    x = lane;
  }
  return [...points, { x, y: aim }, { x: side < 0 ? end.x : end.x + end.width, y: aim }];
}

/** 이어진 같은 점과 한 직선 위의 가운데 점을 뺀 경로 */
function straightened(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const [before, last] = [result.at(-2), result.at(-1)];
    if (last !== undefined && samePoint(last, point)) {
      continue;
    }
    if (before !== undefined && last !== undefined && ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))) {
      result.pop();
    }
    result.push(point);
  }
  return result;
}

/**
 * 형제가 아닌 두 노드를 잇는 경로. 두 노드를 형제가 될 때까지 올린 상자 사이의 배치 경로 trunk를 따라가고, 올린 쪽 끝은 올린 상자
 * 밖의 세로 줄에서 원래 노드까지 상자를 지나지 않는 길(`legs`)로 잇는다. source와 target은 올린 상자에서 원래 노드까지의 사슬이고 올리지
 * 않은 쪽은 null이다. 그런 길이 없거나 사슬이 원래 노드 하나뿐인 쪽은 원래 노드의 가운데 높이에서 가로로 곧게 잇는다. trunk의 첫 선분과 끝 선분이 가로가 아니면
 * null이다.
 */
function alongRoute(trunk: Point[], source: string[] | null, target: string[] | null, rooms: Rooms, layout: Layout): Point[] | null {
  const last = trunk.length - 1;
  if (last < 1 || trunk[0].y !== trunk[1].y || trunk[last].y !== trunk[last - 1].y) {
    return null;
  }
  const forward = trunk[1].x >= trunk[0].x;
  const arriving = trunk[last].x >= trunk[last - 1].x;
  /**
   * 올린 상자 chain[0]에서 원래 노드까지의 길. 배치 경로에서 올린 상자에 가장 가까운 세로 줄(x가 bend)을 원래 노드 쪽 가로 줄의
   * 높이까지 늘여 잇는다. 늘인 뒤의 가로 줄이 올린 상자의 형제 상자를 지나면, 배치 경로를 올린 상자의 변(edge)까지 그대로 따라간 뒤
   * 변에서 옆 통로의 거리만큼 떨어진 세로 줄에서 꺾는다. 배치는 선의 세로 줄을 상자에서 이보다 멀리 두므로 이 통로는 비어 있다.
   * 올린 상자에서 바깥쪽으로 나가는 순서의 점을 낸다.
   */
  const side = (chain: string[], dir: -1 | 1, edge: Point, bend: number): Point[] => {
    const box = layout.boxes.get(chain.at(-1)!)!;
    const middle = box.y + box.height / 2;
    const inner = (outer: number): Point[] =>
      (chain.length > 1 ? legs(rooms, layout, chain, dir, outer) : null) ?? [{ x: outer, y: middle }, { x: dir < 0 ? box.x : box.x + box.width, y: middle }];
    const reach = inner(bend);
    const [left, right] = [Math.min(bend, edge.x), Math.max(bend, edge.x)];
    const around = (rooms.kids.get(rooms.parent(chain[0]) ?? TOP) ?? []).filter((id) => id !== chain[0] && layout.boxes.has(id)).map(rooms.block);
    const y = reach[0].y;
    if (!around.some((b) => y > b.y - 1 && y < b.y + b.height + 1 && right > b.x && left < b.x + b.width)) {
      return reach;
    }
    const lane = edge.x + dir * layout.lane;
    return [{ x: bend, y: edge.y }, { x: lane, y: edge.y }, ...inner(lane)];
  };
  /** 올린 상자 사이를 곧게 잇는 배치 경로에는 세로 줄이 없으므로 도착 쪽 상자 앞에 하나를 둔다. */
  const straight = trunk[1].x + (forward ? -layout.lane : layout.lane);
  const [leave, enter] = last === 1 ? [straight, straight] : [trunk[1].x, trunk[last - 1].x];
  const head = source === null ? [trunk[0], { x: leave, y: trunk[0].y }] : side(source, forward ? 1 : -1, trunk[0], leave).reverse();
  const tail = target === null ? [{ x: enter, y: trunk[last].y }, trunk[last]] : side(target, arriving ? -1 : 1, trunk[last], enter);
  return straightened([...head, ...trunk.slice(2, Math.max(2, last - 1)), ...tail]);
}

/**
 * 그릴 선마다 경로를 정하고 도착이 같은 선을 줄기로 묶는다(`trunkViews`). 배치가 낸 경로를 먼저 쓴다. 없으면 함수 안 import만 합친 선은 `belowRoute`로,
 * 한쪽이 다른 쪽을 품은 두 노드를 잇는 선은 `insideRoute`로, 형제가 아닌 두 노드를 잇는 선은 두 노드를 형제로 올린
 * 상자 사이의 배치 경로를 따라가는 경로로 만들고, 따라갈 경로가 없으면 `sideRoute`로 만든다. 오버라이드 이음은 오버라이드 선을
 * 거꾸로 가므로 올린 상자 사이에 반대 방향 배치 경로만 있으면 그 경로를 뒤집어 따라간다. 배치에 양 끝 상자가 없는 선은 뺀다.
 */
export function edgeViews(edges: DrawnEdge[], layout: Layout, nodes: Map<string, AtlasNode>): Lines {
  /** 선의 경로와 그 경로가 도착이 같은 선과 합류하는 경로인지 */
  const route = (edge: DrawnEdge, source: Box, target: Box): { points: Point[]; joins: boolean; below?: boolean } => {
    const joins = edge.edges.length > 0;
    const found = layout.routes.get(edge.key);
    if (found !== undefined) {
      return { points: found, joins };
    }
    if (edge.deferred) {
      return { points: belowRoute(source, target), joins: false, below: true };
    }
    const ends = siblings(nodes, edge.source, edge.target);
    if (ends === null) {
      return { points: insideRoute(source, target), joins: false };
    }
    const back = edge.route === "overridden" ? layout.routes.get(aggKey(ends[1], ends[0])) : undefined;
    const trunk = layout.routes.get(aggKey(ends[0], ends[1])) ?? (back === undefined ? undefined : [...back].reverse());
    const along =
      trunk === undefined
        ? null
        : alongRoute(
            trunk,
            ends[0] === edge.source ? null : chainOf(rooms, layout, ends[0], edge.source),
            ends[1] === edge.target ? null : chainOf(rooms, layout, ends[1], edge.target),
            rooms,
            layout,
          );
    return { points: along ?? sideRoute(source, target, layout.lane), joins };
  };

  const rooms = roomsOf(layout, nodes);
  const views: EdgeView[] = [];
  for (const edge of edges) {
    const source = layout.boxes.get(edge.source);
    const target = layout.boxes.get(edge.target);
    if (source === undefined || target === undefined) {
      continue;
    }
    const { points, joins, below = false } = route(edge, source, target);
    views.push({
      key: edge.key,
      source: edge.source,
      target: edge.target,
      group: edge.group,
      points,
      tone: edge.tone,
      opacity: edge.opacity,
      into: null,
      sites: edge.weight,
      kinds: edge.kinds,
      route: edge.route,
      joins,
      below,
      branch: points,
      trunk: null,
    });
  }
  return trunkViews(views, letteredBoxes(layout, nodes));
}

/** 줄기 위에 출발부터 도착까지의 경로를 한 번 더 그리는 선: 마우스를 올린 선, 순환 선, 경로의 걸음, 고른 노드에 닿는 선 */
export function emphasized(view: EdgeView, marks: { pointed: boolean; cycle: boolean }): boolean {
  return marks.pointed || marks.cycle || view.route !== null || view.tone === "strong";
}

export function trunkKey(target: string, index: number): EdgeKey {
  return `trunk|${target}|${index}`;
}

/** 좌표가 같은 점으로 보는 거리. ELK가 낸 좌표의 소수 오차보다 크고 선 굵기보다 작다. */
const SAME = 0.5;

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < SAME && Math.abs(a.y - b.y) < SAME;
}

/** 두 경로가 끝점에서부터 거슬러 함께 지나는 길이 */
function shared(a: Point[], b: Point[]): number {
  let length = 0;
  let [i, j] = [a.length - 1, b.length - 1];
  if (!samePoint(a[i], b[j])) {
    return 0;
  }
  while (i > 0 && j > 0) {
    const [la, lb] = [distance(a[i], a[i - 1]), distance(b[j], b[j - 1])];
    const short = Math.min(la, lb);
    if (short > 0 && !samePoint(toward(a[i], a[i - 1], short), toward(b[j], b[j - 1], short))) {
      break;
    }
    length += short;
    if (Math.abs(la - lb) >= SAME) {
      break;
    }
    i--;
    j--;
  }
  return length;
}

/** 경로의 끝점에서 거슬러 from만큼 간 점부터 to만큼 간 점까지(from > to). 도착 쪽이 뒤에 온다. */
function stretch(points: Point[], from: number, to: number): Point[] {
  const total = lengthOf(points);
  const result = [along(points, total - from)];
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    walked += distance(points[i - 1], points[i]);
    if (walked > total - from + SAME && walked < total - to - SAME) {
      result.push(points[i]);
    }
  }
  result.push(along(points, total - to));
  return result;
}

/** 진하기의 순서. 본문 잉크가 muted 잉크보다, 높은 불투명도가 낮은 불투명도보다 진하다. */
function darkness(view: Pick<EdgeView, "tone" | "opacity">): number {
  return (view.tone === "strong" ? 2 : 0) + view.opacity;
}

/**
 * 줄기의 진하기. 줄기 위에 전체 경로를 따로 그리는 선(apart)을 뺀 가지 가운데 가장 진한 값이고, 모든 가지를 따로 그리면
 * 가지 전체에서 고른다. members는 줄기에 든 선이다.
 */
export function trunkShade(members: EdgeView[], apart: (view: EdgeView) => boolean): Pick<EdgeView, "tone" | "opacity"> {
  const rest = members.filter((view) => !apart(view));
  const { tone, opacity } = (rest.length > 0 ? rest : members).reduce((a, b) => (darkness(b) > darkness(a) ? b : a));
  return { tone, opacity };
}

const GROUP_ORDER: EdgeGroup[] = ["run", "use", "derive"];

/** 가운데 점이 at인 count가 차지하는 사각형 */
function numberBox(at: Point, count: number): Box {
  const width = numberWidth(String(count).length);
  return { x: at.x - width / 2, y: at.y - NUMBER_HEIGHT / 2, width, height: NUMBER_HEIGHT };
}

/**
 * 도착 노드로 들어오는 합계 count를 적는 가운데 점. 늘 보이는 수는 이 합계 하나이고, 경로의 마지막 구간 위에서 끝점으로부터
 * clear(화살촉의 길이)와 숫자 둘레의 폭만큼 띄운 화살촉 앞에 적는다.
 */
function beforeEnd(points: Point[], clear: number, count: number): Point {
  const [before, end] = points.slice(-2);
  const size = before.y === end.y ? numberWidth(String(count).length) : NUMBER_HEIGHT;
  return toward(end, before, clear + NUMBER_PAD + size / 2);
}

/** 선분을 찾는 격자의 줄 높이 */
const ROW = 64;
/** 숫자를 놓을 곳을 찾아 구간을 따라 옮기는 걸음 */
const NUMBER_STEP = 4;
/** 꺾이는 모서리의 둥근 반지름. `roundedPath`의 기본값이다. */
const CORNER = 4;

function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 선과 줄기가 그리는 선분, 노드의 글자를 그리는 칸 lettered, 합류점, 들어오는 합계를 숫자가 닿으면 안 되는 곳으로 모은다. */
function blockedOf(views: EdgeView[], trunks: TrunkView[], lettered: Box[]): Blocked {
  const solid = [...lettered];
  const rows: Blocked["rows"] = new Map();
  const draw = (points: Point[], owner: EdgeKey, source: string | null) => {
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      const box = { x: Math.min(a.x, b.x) - 1, y: Math.min(a.y, b.y) - 1, width: Math.abs(a.x - b.x) + 2, height: Math.abs(a.y - b.y) + 2 };
      for (let row = Math.floor(box.y / ROW); row <= Math.floor((box.y + box.height) / ROW); row++) {
        rows.set(row, [...(rows.get(row) ?? []), { box, owner, source }]);
      }
    }
  };
  for (const view of views) {
    draw(view.branch, view.key, view.source);
    if (view.into !== null) {
      solid.push(numberBox(view.into, view.sites));
    }
  }
  for (const trunk of trunks) {
    trunk.pieces.forEach((piece) => draw(piece, trunk.key, null));
    solid.push(numberBox(trunk.at, trunk.sites));
    solid.push(...trunk.joints.map((joint) => ({ x: joint.x - JOINT_RADIUS, y: joint.y - JOINT_RADIUS, width: 2 * JOINT_RADIUS, height: 2 * JOINT_RADIUS })));
  }
  return { solid, rows };
}

/**
 * 활성화된 선(마우스를 올린 선, 고른 노드에 닿는 선, 경로의 걸음) active마다 그 선의 sites 수를 적는 가운데 점.
 * 줄기에 든 선만 적는다(따로 들어가는 선은 도착 노드 앞의 합계가 그 선의 수다). 수는 그 선만 지나는 곧은 구간 위에 둔다. 가장 긴
 * 구간의 가운데에서 시작해 구간을 따라 양쪽으로 옮기며, 노드의 글자를 그리는 칸·합류점·다른 숫자·다른 선과 겹치지 않고 꺾이는
 * 모서리에 닿지 않는 첫 점을 고른다. 그 구간에 없으면 다음으로 긴 구간에서 찾는다. 그 선만 지나는 구간에 놓을 곳이 없으면 같은
 * 노드에서 나가는 선과 함께 지나는 구간까지 넣어 다시 찾는다. sites 수가 1 이하이거나 그래도 놓을 곳이 없으면 적지 않는다.
 */
export function ownNumbers(lines: Lines, active: EdgeView[]): Map<EdgeKey, Point> {
  const placed: Box[] = [];
  /** shared는 box가 놓일 선 view와 같은 노드에서 나가는 선을 지나도 되는지다. */
  const free = (box: Box, view: EdgeView, shared: boolean) => {
    if (lines.blocked.solid.some((other) => overlap(box, other)) || placed.some((other) => overlap(box, other))) {
      return false;
    }
    for (let row = Math.floor(box.y / ROW); row <= Math.floor((box.y + box.height) / ROW); row++) {
      if ((lines.blocked.rows.get(row) ?? []).some((line) => line.owner !== view.key && !(shared && line.source === view.source) && overlap(box, line.box))) {
        return false;
      }
    }
    return true;
  };
  const result = new Map<EdgeKey, Point>();
  for (const view of active) {
    if (view.trunk === null || view.sites < 2) {
      continue;
    }
    const size = numberBox(view.points[0], view.sites);
    const segments = view.branch.slice(1).map((b, i) => ({ a: view.branch[i], b, length: distance(view.branch[i], b) }));
    segments.sort((p, q) => q.length - p.length);
    const spot = (shared: boolean): Point | null => {
      for (const { a, b, length } of segments) {
        const margin = (a.y === b.y ? size.width : size.height) / 2 + CORNER;
        for (let shift = 0; shift <= length / 2 - margin; shift += NUMBER_STEP) {
          for (const along of shift === 0 ? [length / 2] : [length / 2 - shift, length / 2 + shift]) {
            const at = toward(a, b, along);
            if (free(numberBox(at, view.sites), view, shared)) {
              return at;
            }
          }
        }
      }
      return null;
    };
    const at = spot(false) ?? spot(true);
    if (at !== null) {
      placed.push(numberBox(at, view.sites));
      result.set(view.key, at);
    }
  }
  return result;
}

/**
 * 도착 노드가 같은 선을 묶어, 경로의 끝에서부터 다른 선과 함께 지나는 구간을 줄기로 떼고 선마다 줄기 앞까지의 가지를 남긴다.
 * ELK가 같은 포트로 합친 경로와 ELK 밖에서 정한 경로(`alongRoute`, `sideRoute`)를 같은 방법으로 다룬다. `joins`가 거짓인 선은 묶지 않고,
 * 다른 선과 함께 지나는 구간이 없는 선은 줄기에 들지 않는다. 한 노드로 들어오는 선이 서로 다른 변에서 따로 모이면 줄기도 따로 낸다.
 * 도착 노드 앞의 들어오는 합계는 줄기에 든 선이면 줄기가, 따로 들어가는 선이면 그 선이 적는다. 두 노드 아래로 돌아가는 함수 안
 * import 선은 적지 않는다. lettered는 노드의 글자를 그리는 칸이다.
 */
export function trunkViews(views: EdgeView[], lettered: Box[]): Lines {
  const groups = new Map<string, EdgeView[]>();
  for (const view of views) {
    if (view.joins && view.points.length >= 2) {
      groups.set(view.target, [...(groups.get(view.target) ?? []), view]);
    }
  }
  const joined = new Map<EdgeKey, { branch: Point[]; trunk: EdgeKey }>();
  const trunks: TrunkView[] = [];
  for (const [target, group] of groups) {
    /** 선마다 다른 선과 함께 지나는 가장 긴 길이 */
    const reach = group.map((view) => Math.max(0, ...group.filter((other) => other !== view).map((other) => shared(view.points, other.points))));
    const members = group.map((view, i) => ({ view, reach: reach[i] })).filter((m) => m.reach >= SAME);
    members.sort((a, b) => b.reach - a.reach);
    /** 끝점이 같은 선끼리 줄기 하나다. */
    const trees: (typeof members)[] = [];
    for (const member of members) {
      const tree = trees.find((t) => samePoint(t[0].view.points.at(-1)!, member.view.points.at(-1)!));
      if (tree === undefined) {
        trees.push([member]);
      } else {
        tree.push(member);
      }
    }
    trees.forEach((tree, index) => {
      const key = trunkKey(target, index);
      const pieces: Point[][] = [];
      const joints: Point[] = [];
      const joint = (at: Point) => {
        if (!joints.some((p) => samePoint(p, at))) {
          joints.push(at);
        }
      };
      tree.forEach(({ view, reach }, i) => {
        const total = lengthOf(view.points);
        const covered = Math.max(0, ...tree.slice(0, i).map((m) => shared(view.points, m.view.points)));
        if (reach - covered >= SAME) {
          pieces.push(stretch(view.points, reach, covered));
          if (covered > 0) {
            joint(along(view.points, total - covered));
          }
        }
        if (total - reach >= SAME) {
          joint(along(view.points, total - reach));
        }
        joined.set(view.key, { branch: stretch(view.points, total, reach), trunk: key });
      });
      trunks.push({
        key,
        target,
        pieces,
        joints,
        keys: tree.map((m) => m.view.key),
        sources: new Set(tree.map((m) => m.view.source)).size,
        sites: tree.reduce((sum, m) => sum + m.view.sites, 0),
        at: beforeEnd(pieces[0], ARROW_LENGTH, tree.reduce((sum, m) => sum + m.view.sites, 0)),
        group: tree.map((m) => m.view.group).reduce((a, b) => (GROUP_ORDER.indexOf(b) < GROUP_ORDER.indexOf(a) ? b : a)),
        route: tree.some((m) => m.view.route !== null),
      });
    });
  }
  const parted = views.map((view) => {
    const part = joined.get(view.key);
    const counted = view.sites >= 2 && !view.below;
    return part === undefined ? { ...view, into: counted ? beforeEnd(view.points, ARROW_LENGTH, view.sites) : null } : { ...view, ...part };
  });
  return { views: parted, trunks, blocked: blockedOf(parted, trunks, lettered) };
}

/** 꺾이는 점마다 반지름 radius 원호를 넣은 SVG 경로. 선분이 짧으면 반지름을 선분 절반으로 줄인다. */
export function roundedPath(points: Point[], radius = 4): string {
  if (points.length === 0) {
    return "";
  }
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const here = points[i];
    const next = points[i + 1];
    const r = Math.min(radius, distance(prev, here) / 2, distance(here, next) / 2);
    const a = toward(here, prev, r);
    const b = toward(here, next, r);
    d += ` L${a.x},${a.y} Q${here.x},${here.y} ${b.x},${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

/** 경로를 따라 시작점에서 length만큼 간 점 */
function along(points: Point[], offset: number): Point {
  let left = offset;
  for (let i = 1; i < points.length; i++) {
    const length = distance(points[i - 1], points[i]);
    if (length >= left && length > 0) {
      return toward(points[i - 1], points[i], left);
    }
    left -= length;
  }
  return points.at(-1) ?? { x: 0, y: 0 };
}

function lengthOf(points: Point[]): number {
  return points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0);
}

/**
 * 글자를 그리는 칸. 자식을 그리지 않는 노드는 상자에 배지가 나가는 폭을 더한 칸이고 접힌 파일 상자는 상자 아래
 * 미사용 후보 수를 적는 줄까지 더한다. 자식을 그리는 파일 상자·클래스 노드와 펼친 폴더 영역은 머리 줄만이다.
 */
export function letteredBoxes(layout: Layout, nodes: Map<string, AtlasNode>): Box[] {
  const parents = new Set([...layout.boxes.keys()].map((id) => nodes.get(id)?.parent));
  const result: Box[] = [];
  for (const [id, box] of layout.boxes) {
    const kind = nodes.get(id)?.kind;
    if (!parents.has(id)) {
      result.push({
        x: box.x,
        y: box.y - BADGE_HEIGHT / 2,
        width: box.width + BADGE_OVERHANG,
        height: box.height + (kind === "module" ? Math.max(CAPTION_HEIGHT, BADGE_HEIGHT / 2) : BADGE_HEIGHT / 2) + BADGE_HEIGHT / 2,
      });
    } else {
      result.push({ ...box, height: kind === "package" ? REGION_HEAD : HEADER });
    }
  }
  return result;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function toward(from: Point, to: Point, length: number): Point {
  const total = distance(from, to);
  if (total === 0) {
    return from;
  }
  return { x: from.x + ((to.x - from.x) * length) / total, y: from.y + ((to.y - from.y) * length) / total };
}
