// 시점 비교가 그래프에 더하는 표시. 비교 결과의 판정을 화면이 쓰는 값으로 바꾼다: 삭제된 것을 뺀 그래프, 흐린 단계로 그리는 노드와 선,
// 파일과 폴더마다의 줄 수 합, 화면의 선에 든 지금 있는 관계, 말풍선 한 줄의 변경 내용. 판정은 서버가 하고 여기서는 다시 하지 않는다.
import type { AtlasEdge, AtlasNode, ComparedFile, Comparison, EdgeKind, Graph } from "../api/types";
import { COUNTED_KINDS } from "./names";
import { edgeKey, type EdgeKey } from "./scope";
import { nodeIndex } from "./visible";

/** 추가된 줄 수와 삭제된 줄 수 */
export interface Lines {
  added: number;
  deleted: number;
}

/**
 * 흐린 단계로 그리는 노드와 원래 선. 노드는 삭제된 노드와 삭제된 관계의 끝으로만 그래프에 든 노드(only가 base)이고, 선은 삭제된 선이다.
 * 비교가 꺼져 있으면 둘 다 비어 있다.
 */
export function gone(result: Comparison | null): { nodes: Set<string>; edges: Set<EdgeKey> } {
  const nodes = new Set<string>();
  const edges = new Set<EdgeKey>();
  for (const [id, change] of Object.entries(result?.nodes ?? {})) {
    if (change.change === "deleted" || change.only === "base") {
      nodes.add(id);
    }
  }
  for (const [key, change] of Object.entries(result?.edges ?? {})) {
    if (change.change === "deleted") {
      edges.add(key);
    }
  }
  return { nodes, edges };
}

/**
 * 대상 시점의 그래프. graph에서 `gone`의 노드와 선, 그 노드에 닿는 선을 뺀다. 경로 찾기, 리니지 뷰, 순환 묶음, 미사용 후보의 수,
 * 접힌 상자의 배지가 이 그래프로 계산한다. 뺄 것이 없으면 받은 그래프 그대로 돌려준다.
 */
export function liveGraph(graph: Graph, result: Comparison | null): Graph {
  const off = gone(result);
  if (off.nodes.size === 0 && off.edges.size === 0) {
    return graph;
  }
  return {
    nodes: graph.nodes.filter((n) => !off.nodes.has(n.id)),
    edges: graph.edges.filter((e) => !off.edges.has(edgeKey(e)) && !off.nodes.has(e.source) && !off.nodes.has(e.target)),
  };
}

/** 화면의 선이 합친 원래 선 edges에서 삭제된 선을 뺀 것. 비면 삭제된 관계만 든 선이다. gone은 `gone`의 edges다. */
export function liveSites(edges: AtlasEdge[], gone: Set<EdgeKey>): AtlasEdge[] {
  return gone.size === 0 ? edges : edges.filter((e) => !gone.has(edgeKey(e)));
}

/**
 * 한 파일에 든 정의 list를 소스 정의 순서로 늘어놓는다. 삭제된 정의는 대상 시점의 본문에서 놓였을 줄(`slot`)의 뒤에 끼우고, 같은 줄에
 * 끼우는 삭제된 정의끼리는 기준 시점의 줄 순서다. changes는 비교 결과의 nodes이고 비교가 꺼져 있으면 null이다.
 */
export function inSource(list: AtlasNode[], changes: Comparison["nodes"] | null): AtlasNode[] {
  const key = (node: AtlasNode) => {
    const slot = changes?.[node.id]?.slot;
    return [slot ?? node.range?.[0] ?? 0, slot === undefined ? 0 : 1, node.range?.[0] ?? 0];
  };
  return [...list].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

function parentPath(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf("/"), 0));
}

/**
 * 파일 노드와 폴더 노드마다 그 안에서 바뀐 줄 수의 합. 비교 결과의 files를 파일 노드에서 조상 폴더로 올라가며 더하므로 폴더의 수가
 * 아래 파일의 합이고 최상위의 합이 `/api/compare/stat`의 수와 같다. 파일 노드가 없는 파일(정의가 없는 `__init__.py`)의 줄 수는
 * 그 파일이 든 폴더부터 더한다. 그 폴더의 패키지 노드는 path가 폴더이거나 그 `__init__.py`다. 줄 수가 0인 노드는 담지 않는다.
 */
export function lineTotals(graph: Graph, files: ComparedFile[]): Map<string, Lines> {
  const nodes = nodeIndex(graph);
  const boxes = new Map<string, AtlasNode>();
  for (const node of graph.nodes) {
    if ((node.kind === "module" || node.kind === "package") && node.path !== null) {
      boxes.set(`${node.kind}:${node.path}`, node);
    }
  }
  const totals = new Map<string, Lines>();
  for (const file of files) {
    if (file.added === 0 && file.deleted === 0) {
      continue;
    }
    const start = boxes.get(`module:${file.path}`) ?? boxes.get(`package:${file.path}`) ?? boxes.get(`package:${parentPath(file.path)}`);
    for (let at = start; at !== undefined; at = at.parent === null ? undefined : nodes.get(at.parent)) {
      const sum = totals.get(at.id) ?? { added: 0, deleted: 0 };
      totals.set(at.id, { added: sum.added + file.added, deleted: sum.deleted + file.deleted });
    }
  }
  return totals;
}

/** 말풍선 한 줄의 변경 칸에 적는 값 */
export interface RowChange {
  /** 줄에 든 원래 선 가운데 추가된 선의 수 */
  added: number;
  /** 삭제된 선의 수 */
  deleted: number;
  /**
   * 기준 시점에 이 줄에 있던 세는 관계(`COUNTED_KINDS`)의 종류마다의 수. 양쪽 시점에 있고 수만 달라진 선이 줄에 있을 때만 담고,
   * 그런 선이 없으면 null이다. 관계 칸이 `호출 2곳 → 3곳`으로 적는다.
   */
  before: Partial<Record<EdgeKind, number>> | null;
}

/** 말풍선 한 줄에 든 원래 선 edges의 변경 내용. changes는 비교 결과의 edges다. */
export function rowChange(edges: AtlasEdge[], changes: Comparison["edges"]): RowChange {
  let added = 0;
  let deleted = 0;
  let recounted = false;
  const before: Partial<Record<EdgeKind, number>> = {};
  for (const edge of edges) {
    const change = changes[edgeKey(edge)];
    if (change?.change === "added") {
      added += 1;
      continue;
    }
    deleted += change?.change === "deleted" ? 1 : 0;
    recounted ||= change !== undefined && change.change === null && change.before !== null && change.before !== edge.sites.length;
    if (COUNTED_KINDS.includes(edge.kind)) {
      before[edge.kind] = (before[edge.kind] ?? 0) + (change?.before ?? edge.sites.length);
    }
  }
  return { added, deleted, before: recounted ? before : null };
}
