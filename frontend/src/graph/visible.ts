// 토글·접은 폴더·흐름·강조하는 경로에서 화면에 보이는 노드를 정하고, 보이지 않는 노드를 보이는 가장 가까운 조상으로 올린다.
import type { AtlasNode, Graph } from "../api/types";
import type { Flow } from "./flow";
import type { Lit } from "./route";

/** 펼친 파일 상자의 손잡이. 손잡이는 파일 밖과 선이 없는 자식(안쪽 자식)을 묶는다. */
export interface Pack {
  /** 안쪽 자식. 그래프의 노드 순서다. */
  ids: string[];
  /** 안쪽 자식 가운데 함수와 클래스의 수 */
  definitions: number;
  /** 안쪽 자식 가운데 변수의 수 */
  variables: number;
  /** 전부 펼침 단계여서 안쪽 자식을 그렸는지 */
  open: boolean;
  /** 안쪽 자식과 그 안에 든 미사용 후보 수 */
  unused: number;
}

export interface Shown {
  nodes: Set<string>;
  /** 자식을 그리는 파일 상자 */
  open: Set<string>;
  /** 토글로 숨긴 노드 */
  hidden: Set<string>;
  /** 손잡이를 다는 파일 상자와 그 손잡이 */
  packs: Map<string, Pack>;
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

/**
 * 접힌 상자의 배지에 적는 수. 파일 상자는 바로 아래에 든 함수·클래스·변수 수이고 폴더는 안에 든 파일 수다. off에 든 노드는 세지 않는다.
 */
export function insideCounts(graph: Graph, off: Set<string>): Map<string, number> {
  const nodes = nodeIndex(graph);
  const result = new Map<string, number>();
  const add = (id: string) => result.set(id, (result.get(id) ?? 0) + 1);
  for (const node of graph.nodes) {
    if (off.has(node.id) || node.parent === null) {
      continue;
    }
    if (node.kind !== "module") {
      if (nodes.get(node.parent)?.kind === "module") {
        add(node.parent);
      }
      continue;
    }
    for (let at = nodes.get(node.parent); at !== undefined; at = at.parent === null ? undefined : nodes.get(at.parent)) {
      add(at.id);
    }
  }
  return result;
}

/** 폴더마다 오른쪽 위 배지에 적는 줄 수. 하위 폴더까지 그 폴더 아래에 든 파일의 줄 수 합이고, off에 든 파일은 세지 않는다. */
export function folderLines(graph: Graph, off: Set<string>): Map<string, number> {
  const nodes = nodeIndex(graph);
  const result = new Map<string, number>(graph.nodes.filter((n) => n.kind === "package").map((n) => [n.id, 0]));
  for (const node of graph.nodes) {
    if (node.kind !== "module" || off.has(node.id) || node.parent === null) {
      continue;
    }
    for (let at = nodes.get(node.parent); at !== undefined; at = at.parent === null ? undefined : nodes.get(at.parent)) {
      result.set(at.id, (result.get(at.id) ?? 0) + node.loc);
    }
  }
  return result;
}

/** 함수·메서드마다 그 노드에서 나가는 바꿈 선의 도착 변수 이름. 선이 그래프에 나오는 순서이고 같은 이름은 한 번만 담는다. */
export function writtenBy(graph: Graph): Map<string, string[]> {
  const nodes = nodeIndex(graph);
  const result = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const kind = nodes.get(edge.source)?.kind;
    const name = nodes.get(edge.target)?.name;
    if (edge.kind !== "write" || name === undefined || (kind !== "function" && kind !== "method")) {
      continue;
    }
    const names = result.get(edge.source) ?? [];
    if (!names.includes(name)) {
      result.set(edge.source, [...names, name]);
    }
  }
  return result;
}

/**
 * 토글로 숨긴 노드. 테스트 코드와 외부 노드는 토글이 켜졌을 때만 보인다. 값을 만든 호출의 대상이 외부 노드인 변수(`external_value`)는
 * 외부 노드 토글을 따른다.
 */
export function hidden(graph: Graph, opts: { showTests: boolean; showExternal: boolean }): Set<string> {
  return new Set(
    graph.nodes
      .filter((n) => ((n.kind === "external" || n.external_value) && !opts.showExternal) || (n.test && !opts.showTests))
      .map((n) => n.id),
  );
}

/**
 * 파일 상자마다 그 파일 밖의 노드와 선을 주고받는 바로 아래 자식. 선은 종류와 무관하게 세고, off에 든 노드(토글로 숨긴 테스트 코드와
 * 외부 노드)와의 선은 세지 않는다. 클래스는 자신이나 메서드에 밖과의 선이 있으면 밖과 이어진 자식이다.
 */
export function outward(graph: Graph, off: Set<string>): Map<string, Set<string>> {
  const nodes = nodeIndex(graph);
  const result = new Map<string, Set<string>>();
  const mark = (id: string, other: string) => {
    let child = nodes.get(id);
    while (child !== undefined && child.parent !== null) {
      const box = nodes.get(child.parent);
      if (box === undefined) {
        return;
      }
      if (box.kind === "module") {
        if (!within(nodes, other, box.id)) {
          result.set(box.id, (result.get(box.id) ?? new Set()).add(child.id));
        }
        return;
      }
      child = box;
    }
  };
  for (const edge of graph.edges) {
    if (off.has(edge.source) || off.has(edge.target)) {
      continue;
    }
    mark(edge.source, edge.target);
    mark(edge.target, edge.source);
  }
  return result;
}

/**
 * 파일 상자마다 손잡이가 묶는 바로 아래 자식(안쪽 자식). 밖과 이어진 자식(`outward`)도 진입점도 아닌 자식이다. 밖과 이어진 자식이 하나도
 * 없는 파일 상자는 가를 기준이 없고 안쪽 자식이 하나뿐인 파일 상자는 그 자식을 그리므로, 두 경우의 파일 상자는 담지 않는다.
 * 선택과 분석 표시에 따라 달라지지 않게 밖과 이어진 자식과 진입점만으로 판정한다.
 */
export function inward(graph: Graph, off: Set<string>): Map<string, Set<string>> {
  const linked = outward(graph, off);
  const result = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const outer = node.parent === null ? undefined : linked.get(node.parent);
    if (outer !== undefined && !off.has(node.id) && !outer.has(node.id) && !node.entry) {
      result.set(node.parent!, (result.get(node.parent!) ?? new Set()).add(node.id));
    }
  }
  for (const [box, inner] of result) {
    if (inner.size === 1) {
      result.delete(box);
    }
  }
  return result;
}

/** id가 안쪽 자식(`inward`)이거나 그 안에 든 노드면 그 자식이 든 파일 상자, 아니면 null이다. */
export function packedIn(graph: Graph, off: Set<string>, id: string): string | null {
  const nodes = nodeIndex(graph);
  const inner = inward(graph, off);
  for (let at = nodes.get(id); at !== undefined && at.parent !== null; at = nodes.get(at.parent)) {
    if (inner.get(at.parent)?.has(at.id) === true) {
      return at.parent;
    }
  }
  return null;
}

/**
 * 상자의 단계와 무관하게 꺼내 그리는 노드와 그 조상. 고른 노드, 고른 노드의 흐름에 든 노드(나가는 흐름, 고른 노드로 선을 보내는 노드),
 * 강조하는 경로 위 노드다. 파일 상자나 폴더를 골랐으면 흐름의 단위가 파일이므로 고른 상자 안의 정의는 꺼내지 않는다.
 * 꺼낼 자식의 새 조건은 여기에 더한다.
 */
export function drawnOut(graph: Graph, flow: Flow | null, lit: Lit | null): Set<string> {
  const nodes = nodeIndex(graph);
  const picked = lit !== null ? [...lit.nodes] : flow === null ? [] : [...(flow.unit === "node" ? flow.seeds : [flow.file]), ...flow.out.keys(), ...flow.incoming];
  const result = new Set<string>();
  for (const id of picked) {
    for (let at = nodes.get(id); at !== undefined && !result.has(at.id); at = at.parent === null ? undefined : nodes.get(at.parent)) {
      result.add(at.id);
    }
  }
  return result;
}

/**
 * 화면에 그리는 노드를 고른다.
 * - 폴더는 접힘과 펼침 두 단계다. collapsed에 있으면 폴더 노드만 그리고, 없으면 안의 파일 상자와 하위 폴더를 모두 그린다.
 * - 파일 상자는 접힘, 펼침, 전부 펼침 세 단계다. 고른 노드가 그 파일이거나 그 파일 안에 있을 때(`flow.file`) 펼침이고, 그때
 *   unpacked에 있으면 전부 펼침이며, 그 밖에는 접힘이다.
 * - 파일 상자 하나에서 그리는 바로 아래 자식은 `꺼낸 자식 ∪ (펼침 이상이면 밖과 이어진 자식 ∪ marked가 표시하는 노드를 품은 자식
 *   ∪ 진입점) ∪ (전부 펼침이면 나머지)`다. 꺼낸 자식은 `drawnOut`이 정하고, 접힌 폴더 안의 노드는 꺼내지 않는다.
 * - 펼침 이상인 파일 상자의 나머지 자식(안쪽 자식)은 손잡이 하나로 묶어 `packs`에 담는다. 안쪽 자식이 하나뿐이면 그 자식을 그리고,
 *   밖과 이어진 자식이 하나도 없는 파일 상자는 모든 자식을 그린다.
 * - 펼침 이상인 파일 상자의 클래스는 그려지면 메서드를 모두 그린다. 접힌 파일 상자의 클래스는 꺼낸 메서드만 그린다.
 * - 강조하는 경로 lit이 있으면 흐름을 보지 않는다. 경로 위 노드를 품은 접은 폴더는 펼친 것으로 다루고, 파일 상자는 모두 접힘이다.
 * marked는 미사용 후보 표시를 켰을 때의 미사용 후보이고 candidates는 분석 표시와 무관한 미사용 후보 전체다.
 */
export function shown(
  graph: Graph,
  opts: {
    showTests: boolean;
    showExternal: boolean;
    collapsed: Set<string>;
    flow: Flow | null;
    lit: Lit | null;
    unpacked?: Set<string>;
    marked?: Set<string>;
    candidates?: Set<string>;
  },
): Shown {
  const nodes = nodeIndex(graph);
  const off = hidden(graph, opts);
  const { lit, unpacked = new Set<string>(), marked = new Set<string>(), candidates = new Set<string>() } = opts;
  const flow = lit === null ? opts.flow : null;
  const collapsed = new Set(opts.collapsed);
  for (const id of lit?.nodes ?? []) {
    for (let at = nodes.get(id); at !== undefined; at = at.parent === null ? undefined : nodes.get(at.parent)) {
      collapsed.delete(at.id);
    }
  }
  const children = new Map<string | null, AtlasNode[]>();
  for (const node of graph.nodes) {
    if (!off.has(node.id)) {
      children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
    }
  }
  const inside = inward(graph, off);
  const pulled = drawnOut(graph, flow, lit);
  /** 노드와 그 안에 든 노드 가운데 set에 든 수 */
  const countIn = (node: AtlasNode, set: Set<string>): number =>
    (set.has(node.id) ? 1 : 0) + (children.get(node.id) ?? []).reduce((sum, child) => sum + countIn(child, set), 0);

  const result: Shown = { nodes: new Set(), open: new Set(), hidden: off, packs: new Map() };
  /** 클래스와 그 메서드. whole이 거짓이면 꺼낸 메서드만 그린다. */
  const addDefinition = (node: AtlasNode, whole: boolean) => {
    result.nodes.add(node.id);
    for (const method of children.get(node.id) ?? []) {
      if (whole || pulled.has(method.id)) {
        result.nodes.add(method.id);
      }
    }
  };
  const visit = (box: AtlasNode) => {
    result.nodes.add(box.id);
    const kids = children.get(box.id) ?? [];
    if (box.kind === "package") {
      if (!collapsed.has(box.id)) {
        kids.filter((kid) => UNIT_KINDS.has(kid.kind)).forEach(visit);
      }
      return;
    }
    if (kids.length === 0) {
      return;
    }
    const opened = flow?.file === box.id;
    const full = opened && unpacked.has(box.id);
    const packed = inside.get(box.id);
    /** 펼침 단계가 그리는 자식. 안쪽 자식이 아닌 자식과 marked가 표시하는 노드를 품은 자식이다. */
    const staged = packed === undefined ? kids : kids.filter((kid) => !packed.has(kid.id) || countIn(kid, marked) > 0);
    let drawn = kids.filter((kid) => pulled.has(kid.id) || (opened && staged.includes(kid)));
    let inner = kids.filter((kid) => !drawn.includes(kid));
    if (opened && inner.length === 1) {
      [drawn, inner] = [kids, []];
    }
    if (opened && inner.length > 0) {
      const variables = inner.filter((kid) => kid.kind === "variable").length;
      result.packs.set(box.id, {
        ids: inner.map((kid) => kid.id),
        definitions: inner.length - variables,
        variables,
        open: full,
        unused: inner.reduce((sum, kid) => sum + countIn(kid, candidates), 0),
      });
    }
    for (const kid of full ? kids : drawn) {
      addDefinition(kid, opened);
    }
    if (full || drawn.length > 0) {
      result.open.add(box.id);
    }
  };
  for (const node of children.get(null) ?? []) {
    if (node.kind === "external") {
      result.nodes.add(node.id);
    } else {
      visit(node);
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
