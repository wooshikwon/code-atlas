// 배치·그리는 범위·초점 단계를 합쳐 노드와 선 컴포넌트가 그대로 그리는 값을 만든다.
import type { AtlasEdge, AtlasNode, EdgeGroup, EdgeKind, Graph } from "../api/types";
import { OPACITY, type FocusLevel } from "./focus";
import { belowRoute, crossRoute, type Layout, type Point } from "./layout";
import { aggregates, edgeKey, type AggEdge, type EdgeKey } from "./scope";

export type Tone = "muted" | "outgoing" | "incoming";

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
};

/** 원래 선과 집계 선을 edge_key로 찾는다. */
export interface EdgeIndex {
  raw: Map<EdgeKey, AtlasEdge>;
  agg: Map<EdgeKey, AggEdge>;
}

export function edgeIndex(graph: Graph, visible: Set<string>): EdgeIndex {
  return {
    raw: new Map(graph.edges.map((e) => [edgeKey(e), e])),
    agg: new Map(aggregates(graph, visible).map((a) => [a.key, a])),
  };
}

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

function opacityOf(levels: Map<string, FocusLevel> | null, id: string): number {
  return levels === null ? 1 : OPACITY[levels.get(id) ?? 3];
}

/**
 * 그릴 선마다 경로·색·불투명도를 정한다. 경로는 ELK 결과를 먼저 쓰고, 없으면 함수 안 import는 `belowRoute`,
 * 파일 경계를 넘는 선은 `crossRoute`로 만든다. 초점 상태에서 출발점이 선택한 노드 안에 있으면 나가는 선,
 * 도착점이 선택한 노드 안에 있으면 들어오는 선이다. 나머지 선은 두 끝 노드 가운데 더 흐린 쪽 불투명도를 받는다.
 */
export function edgeViews(
  index: EdgeIndex,
  layout: Layout,
  keys: EdgeKey[],
  seeds: Set<string> | null,
  levels: Map<string, FocusLevel> | null,
): EdgeView[] {
  const views: EdgeView[] = [];
  for (const key of keys) {
    const raw = index.raw.get(key);
    const agg = index.agg.get(key);
    const edge = raw ?? agg;
    if (edge === undefined) {
      continue;
    }
    const source = layout.boxes.get(edge.source);
    const target = layout.boxes.get(edge.target);
    if (source === undefined || target === undefined) {
      continue;
    }
    const points =
      layout.routes.get(key) ?? (raw?.deferred === true ? belowRoute(source, target) : crossRoute(source, target));
    const out = seeds?.has(edge.source) === true;
    const into = seeds?.has(edge.target) === true;
    views.push({
      key,
      source: edge.source,
      target: edge.target,
      group: edge.group,
      points,
      tone: out ? "outgoing" : into ? "incoming" : "muted",
      opacity:
        out || into ? 1 : Math.min(opacityOf(levels, edge.source), opacityOf(levels, edge.target)),
      weight: agg !== undefined && agg.weight >= 2 ? agg.weight : null,
    });
  }
  return views;
}

/** 노드에 닿는 선 수. 외부 노드로 가는 선도 센다. */
export function degrees(graph: Graph): Map<string, { incoming: number; outgoing: number }> {
  const result = new Map<string, { incoming: number; outgoing: number }>();
  const entry = (id: string) => {
    let value = result.get(id);
    if (value === undefined) {
      value = { incoming: 0, outgoing: 0 };
      result.set(id, value);
    }
    return value;
  };
  for (const edge of graph.edges) {
    entry(edge.source).outgoing++;
    entry(edge.target).incoming++;
  }
  return result;
}

export const KIND_NAMES: Record<AtlasNode["kind"], string> = {
  package: "폴더",
  module: "파일",
  class: "클래스",
  dataclass: "데이터 클래스",
  function: "함수",
  method: "메서드",
  external: "외부",
};

export const GROUP_NAMES: Record<EdgeGroup, string> = { run: "실행", use: "사용", derive: "계승" };

export const EDGE_KIND_NAMES: Record<EdgeKind, string> = {
  call: "호출",
  construct: "생성",
  import: "import",
  pass: "전달",
  decorate: "데코레이터",
  type: "타입",
  inherit: "상속",
  override: "오버라이드",
};

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
