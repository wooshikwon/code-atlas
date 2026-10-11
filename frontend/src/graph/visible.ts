// 토글·접은 폴더·흐름·강조하는 경로에서 화면에 보이는 노드를 정하고, 보이지 않는 노드를 보이는 가장 가까운 조상으로 올린다.
import type { AtlasNode, Graph } from "../api/types";
import type { Flow } from "./flow";
import type { Lit } from "./route";

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

/** 노드가 고른 노드와 같은 파일 상자에 든 노드인지 본다. 폴더를 골랐으면 그 폴더 아래 파일의 노드는 같은 상자가 아니다. */
export function local(nodes: Map<string, AtlasNode>, flow: Flow, id: string): boolean {
  return unitOf(nodes, id) === flow.file;
}

/** 노드마다 그 노드와 안에 든 노드의 미확인 호출 수를 합친다. off에 든 노드의 수는 세지 않는다. */
export function unresolvedWithin(graph: Graph, off: Set<string>): Map<string, number> {
  const nodes = nodeIndex(graph);
  const result = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.unresolved === 0 || off.has(node.id)) {
      continue;
    }
    for (let at: AtlasNode | undefined = node; at !== undefined; at = at.parent === null ? undefined : nodes.get(at.parent)) {
      result.set(at.id, (result.get(at.id) ?? 0) + node.unresolved);
    }
  }
  return result;
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
 * 4. 강조하는 경로 lit이 있으면 흐름을 보지 않는다. 경로 위 노드를 품은 접은 폴더는 펼친 것으로 다루고,
 *    파일 상자 안의 노드는 경로 위 노드만 남긴다.
 */
export function shown(
  graph: Graph,
  opts: { showTests: boolean; showExternal: boolean; collapsed: Set<string>; flow: Flow | null; lit: Lit | null },
): Shown {
  const nodes = nodeIndex(graph);
  const off = hidden(graph, opts);
  const { lit } = opts;
  const flow = lit === null ? opts.flow : null;
  const collapsed = new Set(opts.collapsed);
  for (const id of lit?.nodes ?? []) {
    for (let at = nodes.get(id); at !== undefined; at = at.parent === null ? undefined : nodes.get(at.parent)) {
      collapsed.delete(at.id);
    }
  }
  const result: Shown = { nodes: new Set(), open: new Set(), hidden: off };
  for (const node of graph.nodes) {
    if (off.has(node.id) || folded(nodes, collapsed, node)) {
      continue;
    }
    if (node.kind === "external" || UNIT_KINDS.has(node.kind)) {
      result.nodes.add(node.id);
      continue;
    }
    const inFlow = flow !== null && flow.unit === "node" && (flow.out.has(node.id) || flow.incoming.has(node.id));
    if (lit !== null ? !lit.nodes.has(node.id) : flow === null || (!inFlow && !local(nodes, flow, node.id))) {
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
