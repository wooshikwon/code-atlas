// 그릴 선과 배치를 합쳐 노드와 선 컴포넌트가 그대로 그리는 값을 만든다.
import type { AtlasNode, EdgeGroup, Graph } from "../api/types";
import { siblings } from "./columns";
import { belowRoute, crossRoute, type Box, type Layout, type Point } from "./layout";
import { aggKey, type DrawnEdge, type EdgeKey, type Tone } from "./scope";

export type EdgeView = {
  key: EdgeKey;
  source: string;
  target: string;
  group: EdgeGroup;
  points: Point[];
  tone: Tone;
  opacity: number;
  /** 무게 2 이상인 집계 선만 숫자 이름표를 단다. */
  weight: number | null;
  /** 합친 선의 sites 수 합 */
  sites: number;
};

/** 부모가 자식보다 앞에 오는 순서. React Flow는 parentId가 가리키는 노드가 먼저 나와야 한다. */
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
 * 형제가 아닌 두 노드를 잇는 경로. 두 노드를 형제가 될 때까지 올린 상자 사이의 배치 경로 trunk를 따라가고,
 * 올린 쪽 끝만 원래 노드의 옆면 가운데로 옮긴다. trunk의 첫 선분과 끝 선분이 가로가 아니면 null이다.
 */
function alongRoute(trunk: Point[], source: Box | null, target: Box | null): Point[] | null {
  const last = trunk.length - 1;
  if (last < 1 || trunk[0].y !== trunk[1].y || trunk[last].y !== trunk[last - 1].y) {
    return null;
  }
  const forward = trunk[1].x >= trunk[0].x;
  const arriving = trunk[last].x >= trunk[last - 1].x;
  const start =
    source === null
      ? trunk[0]
      : { x: forward ? source.x + source.width : source.x, y: source.y + source.height / 2 };
  const end =
    target === null
      ? trunk[last]
      : { x: arriving ? target.x : target.x + target.width, y: target.y + target.height / 2 };
  if (last === 1) {
    const x = trunk[1].x + (forward ? -JOG : JOG);
    return start.y === end.y ? [start, end] : [start, { x, y: start.y }, { x, y: end.y }, end];
  }
  const points = trunk.map((p) => ({ ...p }));
  points[0] = start;
  points[1].y = start.y;
  points[last] = end;
  points[last - 1].y = end.y;
  return points;
}

/**
 * 그릴 선마다 경로를 정한다. 배치가 낸 경로를 먼저 쓴다. 없으면 함수 안 import만 합친 선은 `belowRoute`로,
 * 형제가 아닌 두 노드를 잇는 선은 두 노드를 형제로 올린 상자 사이의 배치 경로를 따라가는 경로로 만들고,
 * 따라갈 경로가 없으면 `crossRoute`로 만든다. 배치에 양 끝 상자가 없는 선은 뺀다.
 */
export function edgeViews(edges: DrawnEdge[], layout: Layout, nodes: Map<string, AtlasNode>): EdgeView[] {
  const route = (edge: DrawnEdge, source: Box, target: Box): Point[] => {
    const found = layout.routes.get(edge.key);
    if (found !== undefined) {
      return found;
    }
    if (edge.deferred) {
      return belowRoute(source, target);
    }
    const ends = siblings(nodes, edge.source, edge.target);
    const trunk = ends === null ? undefined : layout.routes.get(aggKey(ends[0], ends[1]));
    const along =
      ends === null || trunk === undefined
        ? null
        : alongRoute(trunk, ends[0] === edge.source ? null : source, ends[1] === edge.target ? null : target);
    return along ?? crossRoute(source, target);
  };

  const views: EdgeView[] = [];
  for (const edge of edges) {
    const source = layout.boxes.get(edge.source);
    const target = layout.boxes.get(edge.target);
    if (source === undefined || target === undefined) {
      continue;
    }
    views.push({
      key: edge.key,
      source: edge.source,
      target: edge.target,
      group: edge.group,
      points: route(edge, source, target),
      tone: edge.tone,
      opacity: edge.opacity,
      weight: edge.key.startsWith("agg|") && edge.weight >= 2 ? edge.weight : null,
      sites: edge.weight,
    });
  }
  return views;
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

/** 경로 길이의 절반이 되는 점. 집계 선 숫자 이름표를 여기 단다. */
export function midpoint(points: Point[]): Point {
  const total = points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0);
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const length = distance(points[i - 1], points[i]);
    if (length >= left && length > 0) {
      return toward(points[i - 1], points[i], left);
    }
    left -= length;
  }
  return points[0] ?? { x: 0, y: 0 };
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
