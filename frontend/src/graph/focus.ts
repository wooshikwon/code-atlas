// 초점 상태에서 노드마다 선택한 노드와 떨어진 단계를 센다.
import type { Graph } from "../api/types";
import { nodeIndex } from "./scope";

/** 0 선택한 노드, 1 불투명도 100%, 2 50%, 3 10% */
export type FocusLevel = 0 | 1 | 2 | 3;

export const OPACITY: Record<FocusLevel, number> = { 0: 1, 1: 1, 2: 0.5, 3: 0.1 };

/** 선택한 노드와 그 안에 든 노드. 파일 상자를 고르면 파일 안 정의가 모두 출발점이 된다. */
export function seedsOf(graph: Graph, selection: string): Set<string> {
  const seeds = new Set([selection]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of graph.nodes) {
      if (node.parent !== null && seeds.has(node.parent) && !seeds.has(node.id)) {
        seeds.add(node.id);
        grew = true;
      }
    }
  }
  return seeds;
}

/**
 * 보이는 노드 사이의 모든 선(그리는 범위에서 숨긴 선 포함)을 방향과 관계없이 따라가 단계를 센다.
 * 거리 1~steps는 1, steps+1은 2, 그 밖은 3이다. 상자 노드는 안에 든 노드 가운데 가장 가까운 단계를 받는다.
 */
export function focus(graph: Graph, visible: Set<string>, selection: string, steps: number): Map<string, FocusLevel> {
  const neighbors = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!visible.has(edge.source) || !visible.has(edge.target)) {
      continue;
    }
    neighbors.set(edge.source, [...(neighbors.get(edge.source) ?? []), edge.target]);
    neighbors.set(edge.target, [...(neighbors.get(edge.target) ?? []), edge.source]);
  }

  const distance = new Map<string, number>();
  let frontier = [...seedsOf(graph, selection)].filter((id) => visible.has(id));
  frontier.forEach((id) => distance.set(id, 0));
  for (let d = 1; d <= steps + 1 && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of neighbors.get(id) ?? []) {
        if (!distance.has(other)) {
          distance.set(other, d);
          next.push(other);
        }
      }
    }
    frontier = next;
  }

  const levels = new Map<string, FocusLevel>();
  for (const id of visible) {
    const d = distance.get(id);
    levels.set(id, d === undefined ? 3 : d === 0 ? 0 : d <= steps ? 1 : 2);
  }
  const nodes = nodeIndex(graph);
  for (const [id, level] of [...levels]) {
    const lifted = Math.max(level, 1) as FocusLevel;
    let parent = nodes.get(id)?.parent ?? null;
    while (parent !== null && levels.has(parent)) {
      if (levels.get(parent)! > lifted) {
        levels.set(parent, lifted);
      }
      parent = nodes.get(parent)?.parent ?? null;
    }
  }
  return levels;
}
