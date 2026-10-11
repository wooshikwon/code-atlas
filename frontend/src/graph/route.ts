// 두 끝점 사이의 실행 경로를 짧은 것부터 찾는다. 실행 선과 생성자 이음, 오버라이드 이음을 따라간다.
import type { AtlasNode, Graph } from "../api/types";

/** init은 클래스에서 그 생성자 메서드로 가는 생성자 이음, overridden은 부모 메서드에서 자식 메서드로 가는 오버라이드 이음이다. */
export type StepKind = "call" | "construct" | "init" | "overridden";

export interface Step {
  source: string;
  target: string;
  kind: StepKind;
}

/** 노드 id. 첫 원소는 출발 끝점의 노드, 마지막 원소는 도착 끝점의 노드다. */
export type Path = string[];

export interface Route {
  from: string;
  to: string;
  /** 짧은 것부터 PATH_LIMIT개까지. 길이가 같으면 노드 id 배열 순서다. */
  paths: Path[];
  /** PATH_LIMIT개 다음 경로가 있다 */
  more: boolean;
  /** paths에 든 걸음의 종류. 키는 `${source}|${target}`이다. */
  kinds: Map<string, StepKind>;
  /** 출발 끝점에서 걸음을 따라 닿는 함수·메서드 수. 출발 끝점의 함수·메서드도 센다. */
  reach: number;
  /** reach에 센 함수·메서드에 든 미확인 호출 수의 합 */
  unresolved: number;
  /** paths가 비었을 때 도착에서 출발로 가는 경로가 있는지 */
  reverse: boolean;
}

/** 강조하는 경로 하나 */
export interface Lit {
  path: Path;
  /** 경로 위 노드 */
  nodes: Set<string>;
  /** `${source}|${target}` → 걸음 종류 */
  kinds: Map<string, StepKind>;
}

export const PATH_LIMIT = 5;

const STEP_ORDER: StepKind[] = ["call", "construct", "init", "overridden"];
const CONSTRUCTORS = new Set(["__init__", "__post_init__", "__new__"]);
const CLASS_KINDS = new Set(["class", "dataclass"]);
const CALLABLE_KINDS = new Set(["function", "method"]);

/** 탐색이 출발 끝점과 도착 끝점을 한 노드씩으로 다루도록 그래프 앞뒤에 붙이는 가상 노드 */
const START = "\u0000start";
const END = "\u0000end";

function stepKey(source: string, target: string): string {
  return `${source}|${target}`;
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 경로 순서: 길이, 노드 id 배열 순서. */
function pathOrder(a: Path, b: Path): number {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return byId(a[i], b[i]);
    }
  }
  return 0;
}

/**
 * 노드마다 나가는 걸음. 실행 선마다 걸음 하나, 클래스에서 그 생성자 메서드로 생성자 이음, 오버라이드 선의 도착 노드에서
 * 출발 노드로 오버라이드 이음을 만든다. 같은 두 노드 사이에 걸음이 여럿이면 STEP_ORDER에서 앞선 하나만 남기고,
 * hidden에 든 노드로 가거나 그 노드에서 나오는 걸음은 내지 않는다. 걸음 목록은 도착 노드 id순이다.
 */
export function steps(graph: Graph, hidden: Set<string>): Map<string, Step[]> {
  const found = new Map<string, Step>();
  const add = (source: string, target: string, kind: StepKind) => {
    if (source === target || hidden.has(source) || hidden.has(target)) {
      return;
    }
    const key = stepKey(source, target);
    const before = found.get(key);
    if (before === undefined || STEP_ORDER.indexOf(kind) < STEP_ORDER.indexOf(before.kind)) {
      found.set(key, { source, target, kind });
    }
  };
  const kinds = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  for (const edge of graph.edges) {
    if (edge.kind === "call" || edge.kind === "construct") {
      add(edge.source, edge.target, edge.kind);
    } else if (edge.kind === "override") {
      add(edge.target, edge.source, "overridden");
    }
  }
  for (const node of graph.nodes) {
    if (node.kind === "method" && node.parent !== null && CONSTRUCTORS.has(node.name) && CLASS_KINDS.has(kinds.get(node.parent)!)) {
      add(node.parent, node.id, "init");
    }
  }

  const result = new Map<string, Step[]>();
  for (const step of found.values()) {
    result.set(step.source, [...(result.get(step.source) ?? []), step]);
  }
  for (const list of result.values()) {
    list.sort((a, b) => byId(a.target, b.target));
  }
  return result;
}

/** 끝점 노드와 안에 든 노드. hidden에 든 노드는 넣지 않고, 끝점 노드가 그래프에 없거나 hidden에 들면 빈 집합이다. */
export function endpoints(graph: Graph, id: string, hidden: Set<string>): Set<string> {
  const result = new Set<string>();
  if (hidden.has(id) || !graph.nodes.some((n) => n.id === id)) {
    return result;
  }
  const children = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.parent !== null && !hidden.has(node.id)) {
      children.set(node.parent, [...(children.get(node.parent) ?? []), node.id]);
    }
  }
  result.add(id);
  for (const at of result) {
    (children.get(at) ?? []).forEach((child) => result.add(child));
  }
  return result;
}

/**
 * START에서 END까지 가는 그래프. START는 출발 끝점의 노드마다, 도착 끝점의 노드는 END로만 간다. 출발 끝점의 노드로
 * 들어가는 걸음은 빼므로 경로는 출발 끝점을 한 번 나와 도착 끝점에 처음 닿을 때 끝난다.
 */
function between(out: Map<string, Step[]>, sources: Set<string>, targets: Set<string>): Map<string, string[]> {
  const next = new Map<string, string[]>([[START, [...sources].sort(byId)]]);
  for (const id of targets) {
    next.set(id, [END]);
  }
  for (const [id, list] of out) {
    if (!targets.has(id)) {
      next.set(id, list.map((step) => step.target).filter((target) => !sources.has(target)));
    }
  }
  return next;
}

function reversed(next: Map<string, string[]>): Map<string, string[]> {
  const back = new Map<string, string[]>();
  for (const [id, list] of next) {
    for (const target of list) {
      back.set(target, [...(back.get(target) ?? []), id]);
    }
  }
  return back;
}

/**
 * spur에서 END까지 가장 짧고 그 가운데 노드 id 배열 순서가 가장 앞선 경로. blocked에 든 노드와 spur를 다시 거치지 않고,
 * spur에서 banned에 든 노드로 가는 걸음을 쓰지 않는다. END에서 거꾸로 너비 우선 탐색을 해 남은 거리를 센 뒤,
 * spur에서 남은 거리가 하나씩 줄어드는 이웃 가운데 id가 가장 앞선 노드를 따라간다.
 */
function shortest(
  next: Map<string, string[]>,
  back: Map<string, string[]>,
  spur: string,
  blocked: Set<string>,
  banned: Set<string>,
): Path | null {
  const left = new Map<string, number>([[END, 0]]);
  const queue = [END];
  for (const id of queue) {
    for (const before of back.get(id) ?? []) {
      if (before !== spur && !left.has(before) && !blocked.has(before)) {
        left.set(before, left.get(id)! + 1);
        queue.push(before);
      }
    }
  }

  let at: string | null = null;
  for (const target of next.get(spur) ?? []) {
    const distance = left.get(target);
    if (distance !== undefined && !banned.has(target) && (at === null || distance < left.get(at)!)) {
      at = target;
    }
  }
  if (at === null) {
    return null;
  }
  const path = [spur, at];
  while (at !== END) {
    const distance: number = left.get(at)!;
    at = next.get(at)!.find((target) => left.get(target) === distance - 1)!;
    path.push(at);
  }
  return path;
}

/**
 * Yen 알고리즘으로 같은 노드를 두 번 지나지 않는 경로를 pathOrder 순서로 limit개까지 구한다. 직전 경로의 노드마다
 * 그 노드까지의 앞부분을 고정하고, 앞부분이 같은 기존 경로의 다음 걸음과 앞부분의 노드를 막은 채 다시 찾아 후보를 모은다.
 */
function shortestPaths(out: Map<string, Step[]>, sources: Set<string>, targets: Set<string>, limit: number): Path[] {
  const next = between(out, sources, targets);
  const back = reversed(next);
  const first = shortest(next, back, START, new Set(), new Set());
  if (first === null) {
    return [];
  }
  const found = [first];
  const pool: Path[] = [];
  const seen = new Set([first.join("\n")]);
  while (found.length < limit) {
    const last = found[found.length - 1];
    for (let i = 0; i < last.length - 1; i++) {
      const banned = new Set(found.filter((path) => last.every((id, j) => j > i || path[j] === id)).map((path) => path[i + 1]));
      const tail = shortest(next, back, last[i], new Set(last.slice(0, i)), banned);
      if (tail === null) {
        continue;
      }
      const candidate = [...last.slice(0, i), ...tail];
      const key = candidate.join("\n");
      if (!seen.has(key)) {
        seen.add(key);
        pool.push(candidate);
      }
    }
    if (pool.length === 0) {
      break;
    }
    pool.sort(pathOrder);
    found.push(pool.shift()!);
  }
  return found.map((path) => path.slice(1, -1));
}

/** 출발 끝점과 거기서 걸음을 따라 닿는 노드 가운데 함수·메서드의 수와 그 안의 미확인 호출 수의 합. */
function reached(nodes: Map<string, AtlasNode>, out: Map<string, Step[]>, sources: Set<string>): { reach: number; unresolved: number } {
  const seen = new Set(sources);
  let reach = 0;
  let unresolved = 0;
  for (const id of seen) {
    const node = nodes.get(id)!;
    if (CALLABLE_KINDS.has(node.kind)) {
      reach += 1;
      unresolved += node.unresolved;
    }
    (out.get(id) ?? []).forEach((step) => seen.add(step.target));
  }
  return { reach, unresolved };
}

/**
 * from에서 to로 가는 경로를 짧은 것부터 PATH_LIMIT개까지 찾는다. 끝점이 클래스·파일이면 안에 든 어느 노드에서든
 * 출발하고 어느 노드에든 닿으면 끝난다. from과 to가 같거나 한쪽이 다른 쪽을 품으면 paths가 비고 reverse는 거짓이다.
 */
export function route(graph: Graph, from: string, to: string, hidden: Set<string>): Route {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = steps(graph, hidden);
  const sources = endpoints(graph, from, hidden);
  const targets = endpoints(graph, to, hidden);
  const same = sources.has(to) || targets.has(from);

  const found = same ? [] : shortestPaths(out, sources, targets, PATH_LIMIT + 1);
  const paths = found.slice(0, PATH_LIMIT);
  const kinds = new Map<string, StepKind>();
  for (const path of paths) {
    for (let i = 0; i + 1 < path.length; i++) {
      const step = out.get(path[i])!.find((s) => s.target === path[i + 1])!;
      kinds.set(stepKey(step.source, step.target), step.kind);
    }
  }
  return {
    from,
    to,
    paths,
    more: found.length > PATH_LIMIT,
    kinds,
    ...reached(nodes, out, sources),
    reverse: !same && paths.length === 0 && shortestPaths(out, targets, sources, 1).length > 0,
  };
}

/** route.paths의 pick번째 경로와 그 걸음의 종류. 그 번호의 경로가 없으면 null이다. */
export function lit(route: Route, pick: number): Lit | null {
  const path = route.paths[pick];
  if (path === undefined) {
    return null;
  }
  const kinds = new Map<string, StepKind>();
  for (let i = 0; i + 1 < path.length; i++) {
    const key = stepKey(path[i], path[i + 1]);
    kinds.set(key, route.kinds.get(key)!);
  }
  return { path, nodes: new Set(path), kinds };
}
