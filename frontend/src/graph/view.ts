// 그릴 선과 배치를 합쳐 노드와 선 컴포넌트가 그대로 그리는 값을 만든다.
import type { AtlasNode, EdgeGroup, EdgeKind, Graph } from "../api/types";
import { siblings } from "./columns";
import { cornerRadii, pathOf } from "./edges/strokes";
import {
  ARROW_LENGTH,
  BADGE_HEIGHT,
  BADGE_OVERHANG,
  belowRoute,
  CAPTION_HEIGHT,
  FORK_RIM,
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
  type Size,
} from "./layout";
import type { StepKind } from "./route";
import { aggKey, darkness, type DrawnEdge, type EdgeKey, type Shade, type Tone } from "./scope";

/** 선이 합류하는 쪽. in은 도착 노드 앞에서 모이는 쪽, out은 출발 노드 뒤에서 갈라지는 쪽이다. */
export type End = "in" | "out";

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

  /** 합친 선의 sites 가운데 세는 관계(`names.ts`의 `COUNTED_KINDS`)의 수 합 */
  sites: number;
  /** 합친 선의 종류마다 sites 수 합 */
  kinds: Partial<Record<EdgeKind, number>>;
  /** 강조하는 경로의 걸음을 그리는 선이면 그 걸음의 종류 */
  route: StepKind | null;
  /** 선을 눌러 온 상태에서 지나온 선이다 */
  via: boolean;
  /** 도착이나 출발이 같은 선과 합류하는 선인지. 함수 안 import 선, 한쪽이 다른 쪽을 품은 선, 실행 선이 없는 이음은 합류하지 않는다. */
  joins: boolean;
  /** 함수 안 import만 합친 선이어서 두 노드 아래로 돌아가는 경로다. 이 경로는 사이에 놓인 상자를 지날 수 있다. */
  below: boolean;
  /** 경로에서 나가는 줄기를 벗어난 뒤부터 들어오는 줄기에 들기 전까지. 줄기에 들지 않은 선은 경로 전체다. */
  branch: Point[];
  /** 이 선이 든 줄기의 키. in은 도착 노드 앞의 줄기, out은 출발 노드 뒤의 줄기이고 들지 않았으면 null이다. */
  trunks: Record<End, EdgeKey | null>;
  /** 시점 비교에서 삭제된 관계만 든 선이다. sites가 0이어서 수를 적지 않는다. */
  gone: boolean;
  /**
   * 삭제된 관계만 든 선이 수 대신 빨강 점을 놓는 가운데 점. 따로 들어가는 선은 화살촉 앞(into를 적는 곳)이고, 지금 있는 관계가 든 선과
   * 한 줄기로 합류하는 선은 그 선만 지나는 가지의 끝에서 `MARK_BACK`만큼 앞이다. 든 선이 모두 삭제된 관계만 든 선인 줄기에 들었으면
   * 줄기가 점을 그리므로 null이다.
   */
  mark: Point | null;
};

/** 어느 줄기에도 들지 않은 선의 `EdgeView.trunks` */
export const NO_TRUNKS: EdgeView["trunks"] = { in: null, out: null };

/**
 * 한 노드에 닿는 선이 그 노드 곁에서 함께 지나는 구간. end가 in이면 node로 들어가는 선이 node 앞에서 모인 줄기이고, out이면 node에서
 * 나가는 선이 갈라지기 전의 줄기다. 줄기는 선 하나로 한 번 그리고, 들어오는 줄기는 화살촉 하나를 단다.
 */
export type TrunkView = {
  key: EdgeKey;
  end: End;
  node: string;
  /** 줄기를 이루는 선분 묶음. 점은 선이 가는 방향 순서다. 첫 묶음이 node에 닿고 나머지는 앞 묶음의 중간에 붙는다. */
  pieces: Point[][];
  /**
   * 가지가 줄기에 붙는 점과 줄기의 묶음이 다른 묶음에 붙는 점. 들어오는 줄기에서는 합류점, 나가는 줄기에서는 갈림점이다.
   * 합류점과 같은 점인 갈림점은 담지 않는다. 그 점에서 갈라진 선이 가지 없이 바로 들어오는 줄기에 붙기 때문이다.
   */
  joints: Point[];
  /** 줄기에 든 선 */
  keys: EdgeKey[];
  /** 줄기에 든 선의 반대쪽 끝 노드 수. 들어오는 줄기는 출발 노드, 나가는 줄기는 도착 노드를 센다. */
  far: number;
  /** 줄기에 든 선의 sites 수 합. 들어오는 줄기는 이 값을 도착 노드로 들어오는 합계로 화살촉 앞에 적는다. */
  sites: number;
  /** 들어오는 합계를 적는 가운데 점. 나가는 줄기에는 늘 보이는 수가 없으므로 null이다. */
  at: Point | null;
  /** 줄기에 든 선의 분류 가운데 집계 규칙의 순서(실행, 사용, 계승)로 가장 앞선 것 */
  group: EdgeGroup;
  /** 줄기에 든 선 가운데 강조하는 경로의 걸음이 있다 */
  route: boolean;
  /** 든 선이 모두 삭제된 관계만 든 선인 들어오는 줄기가 합계 대신 빨강 점을 놓는 가운데 점(at을 적는 곳). 그 밖의 줄기는 null이다. */
  mark: Point | null;
};

/** 숫자가 닿으면 안 되는 곳 */
interface Blocked {
  /** 노드의 글자를 그리는 칸, 합류점, 갈림점, 도착 노드 앞의 들어오는 합계, 삭제된 관계만 든 선의 빨강 점 */
  solid: Box[];
  /** 선분의 사각형과 그 선분을 그리는 선이나 줄기의 키. 높이 `ROW`의 줄마다 그 줄에 걸친 선분을 모은다. */
  rows: Map<number, { box: Box; owner: EdgeKey }[]>;
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
 * 않은 쪽은 null이다. 그런 길이 없거나 사슬이 원래 노드 하나뿐인 쪽은 원래 노드의 가운데 높이에서 가로로 곧게 잇는다. 배치 경로의 첫 선분과 끝 선분이 가로가 아니면
 * null이다.
 */
function alongRoute(route: Point[], source: string[] | null, target: string[] | null, rooms: Rooms, layout: Layout): Point[] | null {
  const last = route.length - 1;
  if (last < 1 || Math.abs(route[0].y - route[1].y) >= SAME || Math.abs(route[last].y - route[last - 1].y) >= SAME) {
    return null;
  }
  /** 배치가 낸 가로 선분의 두 끝은 높이가 소수 오차만큼 다를 수 있으므로 양 끝 점의 높이를 이웃 점에 맞춘다. */
  const trunk = route.map((point, i) => (i === 0 ? { x: point.x, y: route[1].y } : i === last && last > 1 ? { x: point.x, y: route[last - 1].y } : point));
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
 * 그릴 선마다 경로를 정하고 도착이나 출발이 같은 선을 줄기로 묶는다(`trunkViews`). 배치가 낸 경로를 먼저 쓴다. 없으면 함수 안 import만 합친 선은 `belowRoute`로,
 * 한쪽이 다른 쪽을 품은 두 노드를 잇는 선은 `insideRoute`로, 형제가 아닌 두 노드를 잇는 선은 두 노드를 형제로 올린
 * 상자 사이의 배치 경로를 따라가는 경로로 만들고, 따라갈 경로가 없으면 `sideRoute`로 만든다. 오버라이드 이음은 오버라이드 선을
 * 거꾸로 가므로 올린 상자 사이에 반대 방향 배치 경로만 있으면 그 경로를 뒤집어 따라간다. 배치에 양 끝 상자가 없는 선은 뺀다.
 */
export function edgeViews(edges: DrawnEdge[], layout: Layout, nodes: Map<string, AtlasNode>): Lines {
  /** 선의 경로와 그 경로가 도착이나 출발이 같은 선과 합류하는 경로인지 */
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
      via: edge.via,
      joins,
      below,
      branch: points,
      trunks: NO_TRUNKS,
      gone: edge.gone,
      mark: null,
    });
  }
  return trunkViews(views, letteredBoxes(layout, nodes));
}

/** 줄기 위에 출발부터 도착까지의 경로를 한 번 더 그리는 선: 마우스를 올린 선, 순환 선, 경로의 걸음, 고른 노드에 닿는 선(본문 잉크로 그리는 선) */
export function emphasized(view: EdgeView, marks: { pointed: boolean; cycle: boolean }): boolean {
  return marks.pointed || marks.cycle || view.route !== null || view.tone === "strong";
}

export function trunkKey(node: string, end: End, index: number): EdgeKey {
  return `trunk|${node}|${end}|${index}`;
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

/**
 * 줄기의 진하기. 줄기 위에 전체 경로를 따로 그리는 선(apart)을 뺀 가지 가운데 가장 진한 값이고, 모든 가지를 따로 그리면
 * 가지 전체에서 고른다. members는 줄기에 든 선이다.
 */
export function trunkShade(members: EdgeView[], apart: (view: EdgeView) => boolean): Shade {
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

/** 삭제된 관계만 든 선의 빨강 점의 지름과, 합류점에서 가지를 따라 점의 가운데까지 띄우는 거리 */
export const MARK_SIZE = 7;
export const MARK_BACK = 9;

/** 가운데 점이 at인 빨강 점이 차지하는 사각형 */
function markBox(at: Point): Box {
  return { x: at.x - MARK_SIZE / 2, y: at.y - MARK_SIZE / 2, width: MARK_SIZE, height: MARK_SIZE };
}

/** 도착 노드로 들어오는 합계 count가 차지하는 크기 */
function numberSize(count: number): Size {
  return { width: numberWidth(String(count).length), height: NUMBER_HEIGHT };
}

/**
 * 도착 노드 앞에 크기 size인 표시(들어오는 합계나 빨강 점)를 놓는 가운데 점. 경로의 마지막 구간 위에서 끝점으로부터
 * clear(화살촉의 길이)와 숫자 둘레의 폭만큼 띄운 화살촉 앞이다. 늘 보이는 수는 이 합계 하나다.
 */
function beforeEnd(points: Point[], clear: number, size: Size): Point {
  const [before, end] = points.slice(-2);
  return toward(end, before, clear + NUMBER_PAD + (before.y === end.y ? size.width : size.height) / 2);
}

/** 선분을 찾는 격자의 줄 높이 */
const ROW = 64;
/** 숫자를 놓을 곳을 찾아 구간을 따라 옮기는 걸음 */
const NUMBER_STEP = 4;
/** 꺾이는 모서리의 둥근 반지름. `roundedPath`의 기본값이다. */
export const CORNER = 4;

function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 선과 줄기가 그리는 선분, 노드의 글자를 그리는 칸 lettered, 합류점, 갈림점, 들어오는 합계, 빨강 점을 숫자가 닿으면 안 되는 곳으로 모은다. */
function blockedOf(views: EdgeView[], trunks: TrunkView[], lettered: Box[]): Blocked {
  const solid = [...lettered];
  const rows: Blocked["rows"] = new Map();
  const draw = (points: Point[], owner: EdgeKey) => {
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      const box = { x: Math.min(a.x, b.x) - 1, y: Math.min(a.y, b.y) - 1, width: Math.abs(a.x - b.x) + 2, height: Math.abs(a.y - b.y) + 2 };
      for (let row = Math.floor(box.y / ROW); row <= Math.floor((box.y + box.height) / ROW); row++) {
        rows.set(row, [...(rows.get(row) ?? []), { box, owner }]);
      }
    }
  };
  for (const view of views) {
    draw(view.branch, view.key);
    if (view.into !== null) {
      solid.push(numberBox(view.into, view.sites));
    }
    if (view.mark !== null) {
      solid.push(markBox(view.mark));
    }
  }
  for (const trunk of trunks) {
    trunk.pieces.forEach((piece) => draw(piece, trunk.key));
    if (trunk.at !== null) {
      solid.push(numberBox(trunk.at, trunk.sites));
    }
    if (trunk.mark !== null) {
      solid.push(markBox(trunk.mark));
    }
    const radius = JOINT_RADIUS + (trunk.end === "out" ? FORK_RIM / 2 : 0);
    solid.push(...trunk.joints.map((joint) => ({ x: joint.x - radius, y: joint.y - radius, width: 2 * radius, height: 2 * radius })));
  }
  return { solid, rows };
}

/**
 * 활성화된 선(마우스를 올린 선, 고른 노드에 닿는 선, 경로의 걸음) active마다 그 선의 sites 수를 적는 가운데 점.
 * 들어오는 줄기에 든 선만 적는다(따로 들어가는 선은 도착 노드 앞의 합계가 그 선의 수다). 수는 그 선만 지나는 가지의 곧은 구간 위에 둔다.
 * 가장 긴 구간의 가운데에서 시작해 구간을 따라 양쪽으로 옮기며, 노드의 글자를 그리는 칸·합류점·갈림점·다른 숫자·다른 선과 겹치지 않고
 * 꺾이는 모서리에 닿지 않는 첫 점을 고른다. 그 구간에 없으면 다음으로 긴 구간에서 찾는다. sites 수가 1 이하이거나 가지에 놓을 곳이
 * 없으면 적지 않는다.
 */
export function ownNumbers(lines: Lines, active: EdgeView[]): Map<EdgeKey, Point> {
  const placed: Box[] = [];
  const free = (box: Box, view: EdgeView) => {
    if (lines.blocked.solid.some((other) => overlap(box, other)) || placed.some((other) => overlap(box, other))) {
      return false;
    }
    for (let row = Math.floor(box.y / ROW); row <= Math.floor((box.y + box.height) / ROW); row++) {
      if ((lines.blocked.rows.get(row) ?? []).some((line) => line.owner !== view.key && overlap(box, line.box))) {
        return false;
      }
    }
    return true;
  };
  const result = new Map<EdgeKey, Point>();
  for (const view of active) {
    if (view.trunks.in === null || view.sites < 2) {
      continue;
    }
    const size = numberBox(view.points[0], view.sites);
    const segments = view.branch.slice(1).map((b, i) => ({ a: view.branch[i], b, length: distance(view.branch[i], b) }));
    segments.sort((p, q) => q.length - p.length);
    const spot = (): Point | null => {
      for (const { a, b, length } of segments) {
        const margin = (a.y === b.y ? size.width : size.height) / 2 + CORNER;
        for (let shift = 0; shift <= length / 2 - margin; shift += NUMBER_STEP) {
          for (const along of shift === 0 ? [length / 2] : [length / 2 - shift, length / 2 + shift]) {
            const at = toward(a, b, along);
            if (free(numberBox(at, view.sites), view)) {
              return at;
            }
          }
        }
      }
      return null;
    };
    const at = spot();
    if (at !== null) {
      placed.push(numberBox(at, view.sites));
      result.set(view.key, at);
    }
  }
  return result;
}

/**
 * 한 노드에 닿는 선을 묶어, 그 노드에서부터 다른 선과 함께 지나는 구간을 줄기로 뗀다. end가 in이면 도착 노드가 같은 선을 경로의 끝에서부터,
 * out이면 출발 노드가 같은 선을 경로의 처음에서부터 본다. `joins`가 거짓인 선은 묶지 않고, 다른 선과 함께 지나는 구간이 없는 선은
 * 줄기에 들지 않는다. 한 노드에 닿는 선이 서로 다른 변에서 따로 모이면 줄기도 따로 낸다. taken은 선마다 경로에서 반대쪽 줄기가 이미 가져간
 * 길이이고, 줄기는 그 구간을 뺀 나머지에서만 뗀다. 선마다 든 줄기의 키(keys)와 경로에서 그 줄기를 따라가는 길이(lengths)를 함께 돌려준다.
 */
function bundles(views: EdgeView[], end: End, taken: Map<EdgeKey, number>): { trunks: TrunkView[]; keys: Map<EdgeKey, EdgeKey>; lengths: Map<EdgeKey, number> } {
  /** 줄기가 붙는 노드를 끝점으로 둔 점 순서. 그 순서의 경로를 넣으면 선이 가는 방향 순서로 되돌린다. */
  const facing = (points: Point[]) => (end === "in" ? points : [...points].reverse());
  const groups = new Map<string, { view: EdgeView; path: Point[] }[]>();
  for (const view of views) {
    if (view.joins && view.points.length >= 2) {
      const node = end === "in" ? view.target : view.source;
      groups.set(node, [...(groups.get(node) ?? []), { view, path: facing(view.points) }]);
    }
  }
  const keys = new Map<EdgeKey, EdgeKey>();
  const lengths = new Map<EdgeKey, number>();
  const trunks: TrunkView[] = [];
  for (const [node, group] of groups) {
    /** 선마다 다른 선과 함께 지나는 가장 긴 길이. 반대쪽 줄기가 가져간 구간은 넘지 않는다. */
    const reach = group.map(({ view, path }) =>
      Math.min(lengthOf(path) - (taken.get(view.key) ?? 0), Math.max(0, ...group.filter((other) => other.view !== view).map((other) => shared(path, other.path)))),
    );
    const members = group.map((member, i) => ({ ...member, reach: reach[i] })).filter((m) => m.reach >= SAME);
    members.sort((a, b) => b.reach - a.reach);
    /** 끝점이 같은 선끼리 줄기 하나다. */
    const trees: (typeof members)[] = [];
    for (const member of members) {
      const tree = trees.find((t) => samePoint(t[0].path.at(-1)!, member.path.at(-1)!));
      if (tree === undefined) {
        trees.push([member]);
      } else {
        tree.push(member);
      }
    }
    trees.forEach((tree, index) => {
      const key = trunkKey(node, end, index);
      const pieces: Point[][] = [];
      const joints: Point[] = [];
      const joint = (at: Point) => {
        if (!joints.some((p) => samePoint(p, at))) {
          joints.push(at);
        }
      };
      tree.forEach(({ view, path, reach }, i) => {
        const total = lengthOf(path);
        const covered = Math.max(0, ...tree.slice(0, i).map((m) => Math.min(m.reach, shared(path, m.path))));
        if (reach - covered >= SAME) {
          pieces.push(facing(stretch(path, reach, covered)));
          if (covered > 0) {
            joint(along(path, total - covered));
          }
        }
        if (total - reach >= SAME) {
          joint(along(path, total - reach));
        }
        keys.set(view.key, key);
        lengths.set(view.key, reach);
      });
      const sites = tree.reduce((sum, m) => sum + m.view.sites, 0);
      /** 삭제된 관계만 든 선을 뺀 선의 수. 그런 선이 하나만 남은 줄기는 따로 들어가는 선처럼 sites 수가 1 이하면 합계를 적지 않는다. */
      const live = tree.filter((m) => !m.view.gone).length;
      const counted = live === tree.length || live > 1 || sites >= 2;
      const before = (size: Size) => beforeEnd(pieces[0], ARROW_LENGTH, size);
      trunks.push({
        key,
        end,
        node,
        pieces,
        joints,
        keys: tree.map((m) => m.view.key),
        far: new Set(tree.map((m) => (end === "in" ? m.view.source : m.view.target))).size,
        sites,
        at: end === "in" && live > 0 && counted ? before(numberSize(sites)) : null,
        group: tree.map((m) => m.view.group).reduce((a, b) => (GROUP_ORDER.indexOf(b) < GROUP_ORDER.indexOf(a) ? b : a)),
        route: tree.some((m) => m.view.route !== null),
        mark: end === "in" && live === 0 ? before({ width: MARK_SIZE, height: MARK_SIZE }) : null,
      });
    });
  }
  return { trunks, keys, lengths };
}

/**
 * 한 노드에 닿는 선을 줄기로 묶고 선마다 두 줄기 사이의 가지를 남긴다. 도착 노드가 같은 선은 도착 노드 앞에서, 출발 노드가 같은 선은
 * 출발 노드 뒤에서 `bundles`로 묶는다. ELK가 포트로 합친 경로와 ELK 밖에서 정한 경로(`alongRoute`, `sideRoute`)를 같은 방법으로 다룬다.
 * 들어오는 줄기를 먼저 떼므로 두 줄기가 모두 지나는 구간은 들어오는 줄기에 든다. 도착 노드 앞의 들어오는 합계는 들어오는 줄기에 든 선이면
 * 줄기가, 따로 들어가는 선이면 그 선이 적는다. 두 노드 아래로 돌아가는 함수 안 import 선은 적지 않는다. lettered는 노드의 글자를 그리는 칸이다.
 * 합류점과 같은 점인 갈림점은 뺀다. 삭제된 관계만 든 선은 수 대신 빨강 점을 놓을 곳(`EdgeView.mark`, `TrunkView.mark`)을 받는다.
 */
export function trunkViews(views: EdgeView[], lettered: Box[]): Lines {
  const into = bundles(views, "in", new Map());
  const out = bundles(views, "out", into.lengths);
  const spot = (point: Point) => `${Math.round(point.x)}|${Math.round(point.y)}`;
  const joined = new Set(into.trunks.flatMap((trunk) => trunk.joints.map(spot)));
  const forks = out.trunks.map((trunk) => ({ ...trunk, joints: trunk.joints.filter((fork) => !joined.has(spot(fork))) }));
  const marked = new Set(into.trunks.filter((trunk) => trunk.mark !== null).map((trunk) => trunk.key));
  const parted = views.map((view) => {
    const trunks = { in: into.keys.get(view.key) ?? null, out: out.keys.get(view.key) ?? null };
    const counted = view.sites >= 2 && !view.below;
    const branch = trunks.in === null && trunks.out === null ? view.points : stretch(view.points, lengthOf(view.points) - (out.lengths.get(view.key) ?? 0), into.lengths.get(view.key) ?? 0);
    const mark = (): Point | null => {
      if (!view.gone || marked.has(trunks.in ?? "")) {
        return null;
      }
      return trunks.in === null ? beforeEnd(view.points, ARROW_LENGTH, { width: MARK_SIZE, height: MARK_SIZE }) : along(branch, Math.max(0, lengthOf(branch) - MARK_BACK));
    };
    return {
      ...view,
      trunks,
      branch,
      into: trunks.in === null && counted ? beforeEnd(view.points, ARROW_LENGTH, numberSize(view.sites)) : null,
      mark: mark(),
    };
  });
  const trunks = [...forks, ...into.trunks];
  return { views: parted, trunks, blocked: blockedOf(parted, trunks, lettered) };
}

/** 꺾이는 점마다 반지름 radius의 곡선을 넣은 SVG 경로. 선분이 짧으면 반지름을 선분 절반으로 줄인다. */
export function roundedPath(points: Point[], radius = CORNER): string {
  return pathOf(points, cornerRadii(points, radius));
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
