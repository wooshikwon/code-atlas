// 토글·접은 폴더·흐름에서 화면에 보이는 노드를 정하고, 보이지 않는 노드를 보이는 가장 가까운 조상으로 올린다.
import type { AtlasNode, Graph } from "../api/types";
import type { Flow } from "./flow";

export interface Shown {
  nodes: Set<string>;
  /** 자식을 그리는 파일 상자 */
  open: Set<string>;
  /** 토글로 숨긴 노드 */
  hidden: Set<string>;
}

const UNIT_KINDS = new Set(["module", "package"]);

export function nodeIndex(graph: Graph): Map<string, AtlasNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

/** 노드가 든 가장 가까운 파일 상자. 모듈·패키지 노드는 자기 자신이다. */
export function unitOf(nodes: Map<string, AtlasNode>, id: string): string {
  let node = nodes.get(id);
  while (node !== undefined && !UNIT_KINDS.has(node.kind) && node.parent !== null) {
    node = nodes.get(node.parent);
  }
  return node?.id ?? id;
}

/** id가 ancestor 자신이거나 그 자손인지 본다. */
export function within(nodes: Map<string, AtlasNode>, id: string, ancestor: string): boolean {
  let node = nodes.get(id);
  while (node !== undefined) {
    if (node.id === ancestor) {
      return true;
    }
    node = node.parent === null ? undefined : nodes.get(node.parent);
  }
  return false;
}

/** 토글로 숨긴 노드. 테스트 코드와 외부 노드는 토글이 켜졌을 때만 보인다. */
export function hidden(graph: Graph, opts: { showTests: boolean; showExternal: boolean }): Set<string> {
  return new Set(
    graph.nodes
      .filter((n) => (n.kind === "external" ? !opts.showExternal : n.test && !opts.showTests))
      .map((n) => n.id),
  );
}

function folded(nodes: Map<string, AtlasNode>, collapsed: Set<string>, node: AtlasNode): boolean {
  let parent = node.parent;
  while (parent !== null) {
    if (collapsed.has(parent)) {
      return true;
    }
    parent = nodes.get(parent)?.parent ?? null;
  }
  return false;
}

/**
 * 화면에 그리는 노드를 고른다.
 * 1. 접은 폴더는 폴더 노드만 남기고, 펼친 폴더는 폴더 노드와 파일 상자를 남긴다.
 * 2. 파일 상자 안의 노드는 흐름이 있을 때만 남긴다. 고른 노드가 든 파일 상자는 안의 노드를 모두 남기고,
 *    다른 파일 상자는 흐름 단위가 "node"일 때 나가는 흐름에 든 노드와 고른 노드로 선을 보내는 노드만 남긴다.
 * 3. 클래스 안 메서드가 남으면 그 클래스 노드도 남긴다.
 */
export function shown(
  graph: Graph,
  opts: { showTests: boolean; showExternal: boolean; collapsed: Set<string>; flow: Flow | null },
): Shown {
  const nodes = nodeIndex(graph);
  const off = hidden(graph, opts);
  const { collapsed, flow } = opts;
  const result: Shown = { nodes: new Set(), open: new Set(), hidden: off };
  for (const node of graph.nodes) {
    if (off.has(node.id) || folded(nodes, collapsed, node)) {
      continue;
    }
    if (node.kind === "external" || UNIT_KINDS.has(node.kind)) {
      result.nodes.add(node.id);
      continue;
    }
    if (flow === null) {
      continue;
    }
    const inFlow = flow.unit === "node" && (flow.out.has(node.id) || flow.incoming.has(node.id));
    if (!inFlow && !within(nodes, node.id, flow.file)) {
      continue;
    }
    let inner: AtlasNode | undefined = node;
    while (inner !== undefined && !UNIT_KINDS.has(inner.kind)) {
      result.nodes.add(inner.id);
      inner = inner.parent === null ? undefined : nodes.get(inner.parent);
    }
    if (inner !== undefined) {
      result.open.add(inner.id);
    }
  }
  return result;
}

/**
 * 노드를 화면에 보이는 가장 가까운 조상으로 올린다. 보이는 노드는 자기 자신이고,
 * 토글로 숨긴 노드와 보이는 조상이 없는 노드는 null이다.
 */
export function lift(nodes: Map<string, AtlasNode>, shown: Shown, id: string): string | null {
  if (shown.hidden.has(id)) {
    return null;
  }
  let node = nodes.get(id);
  while (node !== undefined && !shown.nodes.has(node.id)) {
    node = node.parent === null ? undefined : nodes.get(node.parent);
  }
  return node?.id ?? null;
}
