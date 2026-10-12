// 파일트리를 화면에 그리는 행 배열로 편다. 폴더의 열림은 접은 폴더 집합에서, 파일 아래 목록은 선택에서 정한다.
// 검색 칸에 질의가 있으면 행 배열 대신 검색 결과 행을 낸다.
import type { AtlasNode, Change, ChangedFile, Changes, Graph, Tree, TreeEntry } from "../api/types";
import { nodeIndex } from "../graph/visible";
import { find, type Entry, type Hit } from "../search/index";
import type { IconKind } from "./Icon";

export interface TreeState {
  /** 접은 폴더(패키지 노드 id) */
  collapsed: Set<string>;
  /** 고른 노드 id */
  selected: string | null;
  /** 그래프 선택과 무관하게 정보 패널에 연 파일의 경로 */
  opened: string | null;
  showTests: boolean;
  /** 마지막 커밋 뒤의 변경 내용. 아직 받지 못했으면 null이다. */
  changes: Changes | null;
}

export interface Row {
  /** 폴더·파일은 레포 루트 기준 경로, 클래스·함수는 노드 id */
  key: string;
  kind: "dir" | "file" | "symbol";
  /** 이름 왼쪽에 그리는 종류 기호 */
  icon: IconKind;
  /** 1부터 세는 깊이 */
  level: number;
  label: string;
  /** 줄이지 않은 이름. 폴더·파일은 레포 루트 기준 경로, 클래스·함수는 이름표다. 행의 글자가 잘렸을 때 말풍선이 적는다. */
  title: string;
  /** 폴더면 패키지 노드 id, 파일이면 모듈 노드 id. 패키지 노드가 없는 폴더와 모듈 노드가 없는 파일은 null이다. */
  node: string | null;
  /** 누르면 정보 패널에 코드만 여는 파일의 경로. 분석한 파일 가운데 모듈 노드가 없는 `__init__.py`가 해당한다. */
  file: string | null;
  /** 아래 행을 펼쳤는지. 펼칠 행이 없으면 null이다. */
  expanded: boolean | null;
  selected: boolean;
  /** 마지막 커밋 뒤의 변경 상태. 접은 폴더는 안에 바뀐 파일이 있으면 수정이다. */
  change: Change | null;
}

/** 검색 결과 행 하나 */
export interface Result {
  hit: Hit;
  selected: boolean;
  change: Change | null;
}

/** 검색 결과를 몇 행까지 그리는지 */
const RESULT_LIMIT = 200;

/** 노드가 든 파일의 노드 id. 파일 밖 노드(파일 없는 폴더 패키지, 외부)면 null이다. */
function fileOf(nodes: Map<string, AtlasNode>, id: string | null): string | null {
  let node = id === null ? undefined : nodes.get(id);
  while (node !== undefined && node.kind !== "module" && node.kind !== "package") {
    node = node.parent === null ? undefined : nodes.get(node.parent);
  }
  return node?.path?.endsWith(".py") ? node.id : null;
}

function labelOf(nodes: Map<string, AtlasNode>, node: AtlasNode): string {
  if (node.kind === "method" && node.parent !== null) {
    return `${nodes.get(node.parent)?.name ?? ""}.${node.name}()`;
  }
  return node.kind === "function" ? `${node.name}()` : node.name;
}

/** 파일 노드 id마다 그 파일의 클래스·함수·메서드를 소스 정의 순서로 담는다. */
function symbols(graph: Graph, nodes: Map<string, AtlasNode>): Map<string, AtlasNode[]> {
  const inner = new Map<string, AtlasNode[]>();
  for (const node of graph.nodes) {
    if (node.kind === "module" || node.kind === "package" || node.kind === "external") {
      continue;
    }
    const file = fileOf(nodes, node.id);
    if (file === null) {
      continue;
    }
    const list = inner.get(file);
    if (list === undefined) {
      inner.set(file, [node]);
    } else {
      list.push(node);
    }
  }
  for (const list of inner.values()) {
    list.sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0));
  }
  return inner;
}

/** 파일트리가 담은 모든 경로 */
function pathsOf(entries: TreeEntry[], found = new Set<string>()): Set<string> {
  for (const entry of entries) {
    found.add(entry.path);
    pathsOf(entry.children ?? [], found);
  }
  return found;
}

/**
 * 파일트리에 없는 추가된 파일 fresh를 제 폴더에 끼워 넣는다. 그래프에 노드가 없는 파일이므로 node는 null이다.
 * 폴더는 안의 파일이 모두 테스트 코드일 때 테스트 코드다.
 */
function grown(entries: TreeEntry[], fresh: ChangedFile[]): TreeEntry[] {
  if (fresh.length === 0) {
    return entries;
  }
  const root = structuredClone(entries);
  const put = (list: TreeEntry[], entry: TreeEntry): TreeEntry => {
    list.push(entry);
    list.sort((a, b) => Number(a.kind !== "dir") - Number(b.kind !== "dir") || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entry;
  };
  for (const { path, test } of fresh) {
    const parts = path.split("/");
    let list = root;
    parts.slice(0, -1).forEach((name, depth) => {
      const folder =
        list.find((e) => e.kind === "dir" && e.name === name) ??
        put(list, { path: parts.slice(0, depth + 1).join("/"), name, kind: "dir", test, node: null, children: [] });
      folder.test &&= test;
      list = folder.children ??= [];
    });
    put(list, { path, name: parts.at(-1)!, kind: "file", test, node: null });
  }
  return root;
}

/**
 * 펼친 폴더, 파일, 고른 노드가 든 파일의 클래스·함수 목록을 위에서 아래로 그리는 순서로 낸다.
 * 고른 노드를 품은 폴더는 접은 폴더여도 펼친 것으로 그린다.
 * 레포를 열어 분석한 뒤 생긴 파일은 그래프에 노드가 없는 행으로 넣는다. 파일 행은 모듈 노드만 가리키므로
 * 모듈 노드가 없는 `__init__.py` 행은 node 없이 file에 경로를 담는다.
 */
export function rows(tree: Tree, graph: Graph, state: TreeState): Row[] {
  const nodes = nodeIndex(graph);
  const inner = symbols(graph, nodes);
  const chosen = fileOf(nodes, state.selected);
  const held = new Set<string>();
  for (let at = nodes.get(state.selected ?? "")?.parent; at != null; at = nodes.get(at)?.parent) {
    held.add(at);
  }
  const changed = new Map<string, Change>();
  for (const file of state.changes?.files ?? []) {
    if (file.status === "modified" || file.status === "added") {
      changed.set(file.path, file.status);
    }
  }
  const analyzed = pathsOf(tree.entries);
  const fresh = (state.changes?.files ?? []).filter((file) => file.status === "added" && !analyzed.has(file.path));
  const within = (folder: string) => [...changed.keys()].some((path) => path.startsWith(`${folder}/`));
  const out: Row[] = [];

  const walk = (entries: TreeEntry[], level: number) => {
    for (const entry of entries) {
      if (entry.test && !state.showTests) {
        continue;
      }
      const base = { key: entry.path, level, title: entry.path };
      if (entry.kind === "dir") {
        const expanded = entry.node === null || !state.collapsed.has(entry.node) || held.has(entry.node);
        const change = !expanded && within(entry.path) ? "modified" : null;
        const selected = entry.node !== null && entry.node === state.selected;
        const icon = expanded ? "folder-open" : "folder";
        out.push({ ...base, kind: "dir", icon, label: `${entry.name}/`, node: entry.node, file: null, expanded, selected, change });
        if (expanded) {
          walk(entry.children ?? [], level + 1);
        }
        continue;
      }
      const node = entry.node !== null && nodes.get(entry.node)?.kind === "module" ? entry.node : null;
      const file = node === null && analyzed.has(entry.path) ? entry.path : null;
      const selected = node === null ? file !== null && file === state.opened : node === state.selected;
      const list = node === null ? [] : (inner.get(node) ?? []);
      const expanded = list.length === 0 ? null : node === chosen;
      const change = changed.get(entry.path) ?? null;
      out.push({ ...base, kind: "file", icon: "file", label: entry.name, node, file, expanded, selected, change });
      if (expanded === true) {
        for (const node of list) {
          out.push({
            key: node.id,
            kind: "symbol",
            icon: node.kind as IconKind,
            level: level + 1,
            label: labelOf(nodes, node),
            title: labelOf(nodes, node),
            node: node.id,
            file: null,
            expanded: null,
            selected: node.id === state.selected,
            change: state.changes?.nodes[node.id] ?? null,
          });
        }
      }
    }
  };
  walk(grown(tree.entries, fresh), 1);
  return out;
}

/** 질의와 이름이 맞는 파일·클래스·함수를 find가 내는 순서로 낸다. 질의가 비면 빈 배열이다. */
export function results(entries: Entry[], query: string, selected: string | null, changes: Changes | null): Result[] {
  return find(entries, query, RESULT_LIMIT).map((hit) => ({
    hit,
    selected: hit.entry.id === selected,
    change: changes?.nodes[hit.entry.id] ?? null,
  }));
}

/** 부모 행의 번호. 맨 위 깊이의 행이면 -1이다. */
export function parentOf(list: Row[], index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (list[i].level < list[index].level) {
      return i;
    }
  }
  return -1;
}
