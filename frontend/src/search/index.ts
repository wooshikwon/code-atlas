// 검색 색인. 노드 이름과 경로에서 노드 id를 찾는다. 그래프의 좌표와 배치를 모른다.
import { Fzf } from "fzf";
import type { Graph } from "../api/types";
import { nodeIndex } from "../graph/visible";
import type { History } from "../state/history";

export type EntryKind = "file" | "class" | "dataclass" | "function" | "method";

export interface Entry {
  id: string;
  /** 파일은 파일 이름, 메서드는 `클래스.메서드`, 그 밖은 노드 이름 */
  name: string;
  /** 레포 루트 기준 파일 경로 */
  path: string;
  kind: EntryKind;
}

export interface Hit {
  entry: Entry;
  /** 질의와 일치한 칸. 최근에 고른 노드로 낸 결과면 null이다. */
  field: "name" | "path" | null;
  /** field 문자열에서 일치한 글자의 위치 */
  positions: Set<number>;
}

/** 파일·클래스·데이터 클래스·함수·메서드를 검색 항목으로 만든다. 테스트 코드는 토글이 켜졌을 때만 넣는다. */
export function build(graph: Graph, showTests: boolean): Entry[] {
  const nodes = nodeIndex(graph);
  const entries: Entry[] = [];
  for (const node of graph.nodes) {
    if (node.path === null || node.kind === "external" || (node.test && !showTests)) {
      continue;
    }
    if (node.kind === "module" || node.kind === "package") {
      if (node.path.endsWith(".py")) {
        entries.push({ id: node.id, name: node.path.split("/").at(-1)!, path: node.path, kind: "file" });
      }
      continue;
    }
    const owner = node.kind === "method" && node.parent !== null ? nodes.get(node.parent) : undefined;
    const name = owner === undefined ? node.name : `${owner.name}.${node.name}`;
    entries.push({ id: node.id, name, path: node.path, kind: node.kind });
  }
  return entries;
}

/** 이력에서 고른 노드 id를 최근 것부터 한 번씩 담는다. */
export function recent(history: History): string[] {
  const ids = new Set<string>();
  for (const place of [...history.entries].reverse()) {
    if (place.selection?.type === "node") {
      ids.add(place.selection.id);
    }
  }
  return [...ids];
}

/** name에서 먼저 찾고 결과가 limit보다 적으면 path에서 이어서 찾는다. 질의가 비면 recent의 노드를 그 순서로 낸다. */
export function find(entries: Entry[], query: string, limit = 50, recent: string[] = []): Hit[] {
  const text = query.trim();
  if (text === "") {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return recent
      .flatMap((id) => byId.get(id) ?? [])
      .slice(0, limit)
      .map((entry) => ({ entry, field: null, positions: new Set<number>() }));
  }
  const hits: Hit[] = new Fzf(entries, { selector: (entry) => entry.name, limit })
    .find(text)
    .map((result) => ({ entry: result.item, field: "name", positions: result.positions }));
  if (hits.length < limit) {
    const found = new Set(hits.map((hit) => hit.entry.id));
    const rest = entries.filter((entry) => !found.has(entry.id));
    for (const result of new Fzf(rest, { selector: (entry) => entry.path, limit: limit - hits.length }).find(text)) {
      hits.push({ entry: result.item, field: "path", positions: result.positions });
    }
  }
  return hits;
}
