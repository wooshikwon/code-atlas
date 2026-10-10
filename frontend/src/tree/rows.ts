// 파일트리를 화면에 그리는 행 배열로 편다. 폴더의 열림은 접은 폴더 집합에서, 파일 아래 목록은 선택에서 정한다.
import type { AtlasNode, Graph, Tree, TreeEntry } from "../api/types";
import { nodeIndex } from "../graph/scope";

export interface TreeState {
  /** 접은 폴더(패키지 노드 id) */
  collapsed: Set<string>;
  /** 고른 노드 id */
  selected: string | null;
  showTests: boolean;
}

export interface Row {
  /** 폴더·파일은 레포 루트 기준 경로, 클래스·함수는 노드 id */
  key: string;
  kind: "dir" | "file" | "symbol";
  /** 1부터 세는 깊이 */
  level: number;
  label: string;
  title: string;
  /** 폴더면 패키지 노드 id, 파일이면 모듈 노드 id. 패키지 노드가 없는 폴더는 null이다. */
  node: string | null;
  /** 아래 행을 펼쳤는지. 펼칠 행이 없으면 null이다. */
  expanded: boolean | null;
  selected: boolean;
}

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

/** 펼친 폴더, 파일, 고른 노드가 든 파일의 클래스·함수 목록을 위에서 아래로 그리는 순서로 낸다. */
export function rows(tree: Tree, graph: Graph, state: TreeState): Row[] {
  const nodes = nodeIndex(graph);
  const inner = symbols(graph, nodes);
  const chosen = fileOf(nodes, state.selected);
  const out: Row[] = [];

  const walk = (entries: TreeEntry[], level: number) => {
    for (const entry of entries) {
      if (entry.test && !state.showTests) {
        continue;
      }
      const selected = entry.node !== null && entry.node === state.selected;
      const base = { key: entry.path, level, title: entry.path, node: entry.node, selected };
      if (entry.kind === "dir") {
        const expanded = entry.node === null || !state.collapsed.has(entry.node);
        out.push({ ...base, kind: "dir", label: `${entry.name}/`, expanded });
        if (expanded) {
          walk(entry.children ?? [], level + 1);
        }
        continue;
      }
      const list = entry.node === null ? [] : (inner.get(entry.node) ?? []);
      const expanded = list.length === 0 ? null : entry.node === chosen;
      out.push({ ...base, kind: "file", label: entry.name, expanded });
      if (expanded === true) {
        for (const node of list) {
          out.push({
            key: node.id,
            kind: "symbol",
            level: level + 1,
            label: labelOf(nodes, node),
            title: node.id,
            node: node.id,
            expanded: null,
            selected: node.id === state.selected,
          });
        }
      }
    }
  };
  walk(tree.entries, 1);
  return out;
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
