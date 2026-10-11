// 열 번호, 열 안 순서, 연결 묶음, "연결 없음" 선반을 정한다. 그래프와 두 토글에서만 계산하므로 선택과 접은 폴더에 따라 바뀌지 않는다.
import type { AtlasNode, Graph } from "../api/types";
import { hidden, nodeIndex } from "./visible";

export interface Columns {
  /** 노드 id → 형제 사이에서 받은 열 번호. 최상위 단위는 같은 연결 묶음의 단위끼리 센다. */
  column: Map<string, number>;
  /** 노드 id → 형제 사이의 순서 번호 */
  order: Map<string, number>;
  /** 선으로 이어진 최상위 단위의 묶음. 노드 수가 많은 묶음이 앞에 온다. */
  components: string[][];
  /** 선이 하나도 없는 최상위 단위. 폴더는 안의 노드에 닿는 선도 없어야 한다. 이름순이다. */
  shelf: string[];
}

const RANK: Partial<Record<AtlasNode["kind"], number>> = { package: 0, module: 1, external: 3 };

/** 형제 순서: 폴더, 파일, 소스 정의 줄 순서. */
function siblingOrder(a: AtlasNode, b: AtlasNode): number {
  const rank = (RANK[a.kind] ?? 2) - (RANK[b.kind] ?? 2);
  if (rank !== 0) {
    return rank;
  }
  if (a.range !== null && b.range !== null && RANK[a.kind] === undefined) {
    return a.range[0] - b.range[0];
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 진입점이거나 진입점을 품은 노드. off에 든 진입점은 세지 않는다. */
export function entryUnits(graph: Graph, off: Set<string>): Set<string> {
  const nodes = nodeIndex(graph);
  const result = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.entry || off.has(node.id)) {
      continue;
    }
    let unit: AtlasNode | undefined = node;
    while (unit !== undefined && !result.has(unit.id)) {
      result.add(unit.id);
      unit = unit.parent === null ? undefined : nodes.get(unit.parent);
    }
  }
  return result;
}

/**
 * 두 노드를 같은 부모 아래 형제가 될 때까지 조상으로 올린다. 두 노드가 같거나 한쪽이 다른 쪽의 조상이면 null이다.
 * 부모가 없는 노드끼리는 소스 루트 아래 형제다.
 */
export function siblings(nodes: Map<string, AtlasNode>, source: string, target: string): [string, string] | null {
  const chain = (id: string): string[] => {
    const ids: string[] = [];
    for (let node = nodes.get(id); node !== undefined; node = node.parent === null ? undefined : nodes.get(node.parent)) {
      ids.push(node.id);
    }
    return ids.reverse();
  };
  const a = chain(source);
  const b = chain(target);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return i < a.length && i < b.length ? [a[i], b[i]] : null;
}

/**
 * 형제 노드의 열 번호. 진입점 단위는 0이고 나머지는 1 + max(앞 단위의 열)이다. 진입점 단위로 들어가는 선은 쓰지 않는다.
 * 진입점 단위가 있으면 앞 단위가 없는 단위는 1이다. 순환은 깊이 우선 탐색에서 되돌아가는 선을 빼서 끊는다.
 */
function assign(ids: string[], pairs: [string, string][], entries: Set<string>): Map<string, number> {
  const targets = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const [source, target] of pairs) {
    if (!entries.has(target)) {
      targets.get(source)!.add(target);
    }
  }
  const index = new Map(ids.map((id, i) => [id, i]));
  const sources = new Map<string, string[]>(ids.map((id) => [id, []]));
  const state = new Map<string, "open" | "done">();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const target of [...targets.get(id)!].sort((a, b) => index.get(a)! - index.get(b)!)) {
      if (state.get(target) === "open") {
        continue;
      }
      sources.get(target)!.push(id);
      if (!state.has(target)) {
        visit(target);
      }
    }
    state.set(id, "done");
  };
  for (const id of [...ids.filter((id) => entries.has(id)), ...ids]) {
    if (!state.has(id)) {
      visit(id);
    }
  }

  const first = ids.some((id) => entries.has(id)) ? 1 : 0;
  const column = new Map<string, number>();
  const columnOf = (id: string): number => {
    let value = column.get(id);
    if (value === undefined) {
      const before = sources.get(id)!;
      value = entries.has(id) ? 0 : before.length === 0 ? first : 1 + Math.max(...before.map(columnOf));
      column.set(id, value);
    }
    return value;
  };
  ids.forEach(columnOf);
  return column;
}

/**
 * 부모 노드마다 그 자식의 열과 순서를 정한다. 선은 양 끝을 형제가 될 때까지 올려 쓰고, 함수 안 import는 열 배정에서 뺀다.
 * 최상위 단위는 함수 안 import까지 포함한 선으로 연결 묶음을 나누고, 선이 없는 단위를 선반에 모은다.
 * 안의 노드 사이에만 선이 있는 폴더는 단위 하나짜리 연결 묶음이다.
 */
export function columns(graph: Graph, opts: { showTests: boolean; showExternal: boolean }): Columns {
  const nodes = nodeIndex(graph);
  const off = hidden(graph, opts);
  const children = new Map<string | null, AtlasNode[]>();
  for (const node of graph.nodes) {
    if (!off.has(node.id)) {
      children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
    }
  }
  const order = new Map<string, number>();
  for (const list of children.values()) {
    list.sort(siblingOrder).forEach((node, i) => order.set(node.id, i));
  }

  const topOf = (id: string): string => {
    let node = nodes.get(id)!;
    while (node.parent !== null) {
      node = nodes.get(node.parent)!;
    }
    return node.id;
  };
  const pairs = new Map<string | null, [string, string][]>();
  /** 최상위 단위 → 선으로 이어진 다른 최상위 단위. 안에만 선이 있는 폴더는 빈 집합이다. */
  const linked = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const pair = off.has(edge.source) || off.has(edge.target) ? null : siblings(nodes, edge.source, edge.target);
    if (pair === null) {
      continue;
    }
    const parent = nodes.get(pair[0])!.parent;
    if (parent === null) {
      linked.set(pair[0], (linked.get(pair[0]) ?? new Set()).add(pair[1]));
      linked.set(pair[1], (linked.get(pair[1]) ?? new Set()).add(pair[0]));
    } else {
      const top = topOf(pair[0]);
      if (nodes.get(top)!.kind === "package" && !linked.has(top)) {
        linked.set(top, new Set());
      }
    }
    if (!edge.deferred) {
      pairs.set(parent, [...(pairs.get(parent) ?? []), pair]);
    }
  }

  const entries = entryUnits(graph, off);
  const column = new Map<string, number>();
  const units = (children.get(null) ?? []).map((n) => n.id);
  const components: string[][] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    if (seen.has(unit) || !linked.has(unit)) {
      continue;
    }
    const members = new Set([unit]);
    for (const id of members) {
      linked.get(id)!.forEach((other) => members.add(other));
    }
    members.forEach((id) => seen.add(id));
    components.push(units.filter((id) => members.has(id)));
  }
  const size = new Map<string, number>();
  const sizeOf = (id: string): number => {
    if (!size.has(id)) {
      size.set(id, 1 + (children.get(id) ?? []).reduce((sum, child) => sum + sizeOf(child.id), 0));
    }
    return size.get(id)!;
  };
  const total = (ids: string[]) => ids.reduce((sum, id) => sum + sizeOf(id), 0);
  components.sort((a, b) => total(b) - total(a) || order.get(a[0])! - order.get(b[0])!);

  for (const [parent, list] of children) {
    const ids = list.map((n) => n.id);
    const groups = parent === null ? [...components, ...ids.filter((id) => !linked.has(id)).map((id) => [id])] : [ids];
    for (const group of groups) {
      const members = new Set(group);
      const inside = (pairs.get(parent) ?? []).filter(([source]) => members.has(source));
      assign(group, inside, entries).forEach((value, id) => column.set(id, value));
    }
  }

  const name = (id: string) => nodes.get(id)!.name;
  const shelf = units
    .filter((id) => !linked.has(id))
    .sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : a < b ? -1 : 1));
  return { column, order, components, shelf };
}
