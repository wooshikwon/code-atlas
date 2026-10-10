// 고른 노드에서 나가는 흐름의 단계와 노드 불투명도를 정한다.
import type { Graph } from "../api/types";
import { nodeIndex, unitOf } from "./visible";

export interface Flow {
  /** 고른 노드가 파일 상자면 "file"이고, 이때 out과 incoming의 키는 파일 노드 id다. */
  unit: "file" | "node";
  /** 고른 노드가 든 파일 상자 */
  file: string;
  /** 고른 노드와 그 자손 */
  seeds: Set<string>;
  /** seeds에서 나가는 선을 따라가 만나는 노드와 그 단계. 단계는 1부터 센다. */
  out: Map<string, number>;
  /** seeds로 선을 보내는 노드 */
  incoming: Set<string>;
}

export type Opacity = 1 | 0.5 | 0.2;

/**
 * 고른 노드에서 세 분류의 선을 나가는 방향으로 depth단계까지 따라가 단계를 센다. 함수 안 import 선도 따라가고,
 * hidden에 든 노드는 거치지 않는다. 파일 상자를 고르면 선의 양 끝을 파일 노드로 올린 파일 그래프에서 센다.
 */
export function flow(graph: Graph, selection: string, depth: number, hidden: Set<string>): Flow {
  const nodes = nodeIndex(graph);
  const unit = nodes.get(selection)?.kind === "module" ? "file" : "node";

  const children = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.parent !== null && !hidden.has(node.id)) {
      children.set(node.parent, [...(children.get(node.parent) ?? []), node.id]);
    }
  }
  const seeds = new Set([selection]);
  for (const id of seeds) {
    (children.get(id) ?? []).forEach((child) => seeds.add(child));
  }

  const start = unit === "file" ? new Set([selection]) : seeds;
  const targets = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const edge of graph.edges) {
    if (hidden.has(edge.source) || hidden.has(edge.target)) {
      continue;
    }
    const source = unit === "file" ? unitOf(nodes, edge.source) : edge.source;
    const target = unit === "file" ? unitOf(nodes, edge.target) : edge.target;
    if (source === target || (start.has(source) && start.has(target))) {
      continue;
    }
    if (start.has(target)) {
      incoming.add(source);
      continue;
    }
    targets.set(source, [...(targets.get(source) ?? []), target]);
  }

  const out = new Map<string, number>();
  let frontier = [...start];
  for (let step = 1; step <= depth && frontier.length > 0; step++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const target of targets.get(id) ?? []) {
        if (!out.has(target)) {
          out.set(target, step);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  return { unit, file: unitOf(nodes, selection), seeds, out, incoming };
}

/**
 * 노드 하나의 불투명도. 고른 노드와 그 자손, 고른 노드로 선을 보내는 노드는 1이다. 나가는 흐름에 든 노드는
 * 마지막 단계이고 depth가 2 이상이면 0.5, 그보다 앞 단계면 1이다. 그 밖은 0.2다.
 */
export function opacity(flow: Flow | null, depth: number, id: string): Opacity {
  if (flow === null || flow.seeds.has(id) || flow.incoming.has(id)) {
    return 1;
  }
  const step = flow.out.get(id);
  if (step === undefined) {
    return 0.2;
  }
  return step === depth && depth >= 2 ? 0.5 : 1;
}

/** 노드마다 불투명도를 정한다. 상자는 자기 값과 안에 든 노드의 값 가운데 가장 큰 값을 받는다. */
export function opacities(graph: Graph, flow: Flow | null, depth: number): Map<string, Opacity> {
  const nodes = nodeIndex(graph);
  const result = new Map(graph.nodes.map((n) => [n.id, opacity(flow, depth, n.id)]));
  for (const node of graph.nodes) {
    const own = result.get(node.id)!;
    let parent = node.parent;
    while (parent !== null && result.has(parent)) {
      if (result.get(parent)! < own) {
        result.set(parent, own);
      }
      parent = nodes.get(parent)?.parent ?? null;
    }
  }
  return result;
}
