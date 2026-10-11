// 그릴 선과 배치를 합쳐 노드와 선 컴포넌트가 그대로 그리는 값을 만든다.
import type { AtlasNode, EdgeGroup, Graph } from "../api/types";
import { siblings } from "./columns";
import {
  BADGE_HEIGHT,
  BADGE_OVERHANG,
  belowRoute,
  CAPTION_HEIGHT,
  HEADER,
  insideRoute,
  NODE_GAP,
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
  /** 무게 2 이상인 집계 선만 숫자 이름표를 단다. at은 숫자의 가운데 점이다. */
  weight: { count: number; at: Point } | null;
  /** 합친 선의 sites 수 합 */
  sites: number;
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
  /** 줄기에 든 선의 sites 수 합 */
  sites: number;
  /** 합친 선의 수를 적는 점 */
  at: Point;
  /** 줄기에 든 선의 분류 가운데 집계 규칙의 순서(실행, 사용, 계승)로 가장 앞선 것 */
  group: EdgeGroup;
  /** 줄기에 든 선 가운데 강조하는 경로의 걸음이 있다 */
  route: boolean;
};

/** 그릴 선과 그 선이 모여 만든 줄기 */
export interface Lines {
  views: EdgeView[];
  trunks: TrunkView[];
}

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

const JOG = 12;

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
 * 오른쪽 변에서 `JOG`만큼 떨어진 세로 줄이고, 열 사이 간격 안에 있어 상자를 지나지 않는다. 지나지 않는 가로 줄이 없는 겹이 있으면
 * null이다.
 */
function legs(rooms: Rooms, layout: Layout, chain: string[], side: -1 | 1, outer: number): Point[] | null {
  const end = layout.boxes.get(chain.at(-1)!)!;
  const aim = end.y + end.height / 2;
  const points: Point[] = [];
  let x = outer;
  for (let i = 0; i + 1 < chain.length; i++) {
    const room = layout.boxes.get(chain[i])!;
    const goal = layout.boxes.get(chain[i + 1])!;
    const blocks = (rooms.kids.get(chain[i]) ?? []).map(rooms.block);
    const column = blocks.filter((b) => Math.abs(b.x - goal.x) < SAME);
    const lane = side < 0 ? goal.x - JOG : Math.max(...column.map((b) => b.x + b.width)) + JOG;
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
   * 변에서 `JOG`만큼 떨어진 옆 통로에서 꺾는다. 배치는 선의 세로 줄을 상자에서 이보다 멀리 두므로 이 통로는 비어 있다.
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
    const jog = edge.x + dir * JOG;
    return [{ x: bend, y: edge.y }, { x: jog, y: edge.y }, ...inner(jog)];
  };
  /** 올린 상자 사이를 곧게 잇는 배치 경로에는 세로 줄이 없으므로 도착 쪽 상자 앞에 하나를 둔다. */
  const straight = trunk[1].x + (forward ? -JOG : JOG);
  const [leave, enter] = last === 1 ? [straight, straight] : [trunk[1].x, trunk[last - 1].x];
  const head = source === null ? [trunk[0], { x: leave, y: trunk[0].y }] : side(source, forward ? 1 : -1, trunk[0], leave).reverse();
  const tail = target === null ? [{ x: enter, y: trunk[last].y }, trunk[last]] : side(target, arriving ? -1 : 1, trunk[last], enter);
  return straightened([...head, ...trunk.slice(2, Math.max(2, last - 1)), ...tail]);
}

/**
 * 그릴 선마다 경로를 정하고 도착이 같은 선을 줄기로 묶는다(`trunkViews`). 집계 선의 숫자는 가지 구간에 적는다. 배치가 낸 경로를 먼저 쓴다. 없으면 함수 안 import만 합친 선은 `belowRoute`로,
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
    return { points: along ?? sideRoute(source, target), joins };
  };

  const rooms = roomsOf(layout, nodes);
  const lettered = letteredBoxes(layout, nodes);
  const views: EdgeView[] = [];
  for (const edge of edges) {
    const source = layout.boxes.get(edge.source);
    const target = layout.boxes.get(edge.target);
    if (source === undefined || target === undefined) {
      continue;
    }
    const { points, joins, below = false } = route(edge, source, target);
    const counted = edge.key.startsWith("agg|") && edge.weight >= 2;
    views.push({
      key: edge.key,
      source: edge.source,
      target: edge.target,
      group: edge.group,
      points,
      tone: edge.tone,
      opacity: edge.opacity,
      weight: counted ? { count: edge.weight, at: points[0] } : null,
      sites: edge.weight,
      route: edge.route,
      joins,
      below,
      branch: points,
      trunk: null,
    });
  }
  const lines = trunkViews(views);
  for (const view of lines.views) {
    if (view.weight !== null) {
      view.weight.at = weightPoint(view.branch, String(view.weight.count).length, lettered);
    }
  }
  return lines;
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
/** 합친 선의 수를 줄기 위로 띄우는 높이와 도착 노드에서 띄우는 폭. 화살촉의 길이 9px와 숫자 높이의 절반을 비운다. */
const COUNT_LIFT = 8;
const COUNT_BACK = 12;

/**
 * 도착 노드가 같은 선을 묶어, 경로의 끝에서부터 다른 선과 함께 지나는 구간을 줄기로 떼고 선마다 줄기 앞까지의 가지를 남긴다.
 * ELK가 같은 포트로 합친 경로와 ELK 밖에서 정한 경로(`alongRoute`, `sideRoute`)를 같은 방법으로 다룬다. `joins`가 거짓인 선은 묶지 않고,
 * 다른 선과 함께 지나는 구간이 없는 선은 줄기에 들지 않는다. 한 노드로 들어오는 선이 서로 다른 변에서 따로 모이면 줄기도 따로 낸다.
 */
export function trunkViews(views: EdgeView[]): Lines {
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
      const [before, end] = pieces[0].slice(-2);
      const back = toward(end, before, Math.min(COUNT_BACK, distance(end, before)));
      trunks.push({
        key,
        target,
        pieces,
        joints,
        keys: tree.map((m) => m.view.key),
        sources: new Set(tree.map((m) => m.view.source)).size,
        sites: tree.reduce((sum, m) => sum + m.view.sites, 0),
        at: before.y === end.y ? { x: back.x, y: back.y - COUNT_LIFT } : { x: back.x + COUNT_LIFT, y: back.y },
        group: tree.map((m) => m.view.group).reduce((a, b) => (GROUP_ORDER.indexOf(b) < GROUP_ORDER.indexOf(a) ? b : a)),
        route: tree.some((m) => m.view.route !== null),
      });
    });
  }
  return { views: views.map((view) => ({ ...view, ...joined.get(view.key) })), trunks };
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

/** 경로 길이의 절반이 되는 점 */
export function midpoint(points: Point[]): Point {
  return along(points, lengthOf(points) / 2);
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

const DIGIT_WIDTH = 7;
const WEIGHT_HEIGHT = 14;
const WEIGHT_STEP = 4;

/**
 * 집계 선 숫자 이름표의 가운데 점. 경로 길이의 절반이 되는 점에서 시작해 경로를 따라 양쪽으로 4px씩 옮기며
 * digits 자리 숫자가 lettered의 어느 칸에도 닿지 않는 첫 점을 고른다. 그런 점이 없으면 절반이 되는 점이다.
 */
export function weightPoint(points: Point[], digits: number, lettered: Box[]): Point {
  const total = lengthOf(points);
  const half = { x: (digits * DIGIT_WIDTH) / 2 + 2, y: WEIGHT_HEIGHT / 2 };
  const free = (at: Point) =>
    !lettered.some((b) => at.x + half.x > b.x && at.x - half.x < b.x + b.width && at.y + half.y > b.y && at.y - half.y < b.y + b.height);
  for (let shift = 0; shift <= total / 2; shift += WEIGHT_STEP) {
    for (const length of shift === 0 ? [total / 2] : [total / 2 - shift, total / 2 + shift]) {
      const at = along(points, length);
      if (free(at)) {
        return at;
      }
    }
  }
  return midpoint(points);
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
