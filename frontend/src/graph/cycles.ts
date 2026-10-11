// 모듈 import 그래프에서 서로를 import해 돌아오는 파일의 묶음(순환 묶음)과 그 안의 import 선을 찾는다.
import type { Graph } from "../api/types";
import { edgeKey, type EdgeKey } from "./scope";

export interface Cycles {
  /** 묶음마다 모듈·패키지 노드 id. 묶음과 묶음 안은 id순이다. */
  groups: string[][];
  /** 노드 id → groups의 번호 */
  member: Map<string, number>;
  /** 순환 선(양 끝이 같은 묶음에 든 import 선)의 edgeKey */
  edges: Set<EdgeKey>;
}

const UNIT_KINDS = new Set(["module", "package"]);

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 꼭짓점이 둘 이상인 강한 연결 요소. Tarjan 알고리즘을 재귀 없이 돌린다. 꼭짓점마다 다음에 볼 이웃의 번호를
 * 스택에 함께 두고, 이웃을 다 본 꼭짓점을 스택에서 꺼낼 때 그 값을 부른 꼭짓점의 low에 반영한다.
 */
function components(ids: string[], targets: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const result: string[][] = [];
  for (const root of ids) {
    if (index.has(root)) {
      continue;
    }
    const calls: { id: string; at: number }[] = [{ id: root, at: 0 }];
    while (calls.length > 0) {
      const call = calls[calls.length - 1];
      const { id } = call;
      if (call.at === 0) {
        index.set(id, index.size);
        low.set(id, index.get(id)!);
        stack.push(id);
        stacked.add(id);
      }
      const list = targets.get(id) ?? [];
      if (call.at < list.length) {
        const target = list[call.at++];
        if (!index.has(target)) {
          calls.push({ id: target, at: 0 });
        } else if (stacked.has(target)) {
          low.set(id, Math.min(low.get(id)!, index.get(target)!));
        }
        continue;
      }
      calls.pop();
      if (calls.length > 0) {
        const caller = calls[calls.length - 1].id;
        low.set(caller, Math.min(low.get(caller)!, low.get(id)!));
      }
      if (low.get(id) === index.get(id)) {
        const group: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          stacked.delete(member);
          group.push(member);
        } while (member !== id);
        if (group.length > 1) {
          result.push(group);
        }
      }
    }
  }
  return result;
}

/**
 * 순환 묶음을 찾는다. 꼭짓점은 hidden에 없는 모듈·패키지 노드이고, 변은 함수 안 import가 아니면서 양 끝이 서로 다른
 * 꼭짓점인 import 선이다. 선의 양 끝을 폴더로 올리지 않으므로 폴더 사이에서만 돌아오는 import는 묶음이 아니다.
 */
export function cycles(graph: Graph, hidden: Set<string>): Cycles {
  const ids = graph.nodes
    .filter((n) => UNIT_KINDS.has(n.kind) && !hidden.has(n.id))
    .map((n) => n.id)
    .sort(byId);
  const vertices = new Set(ids);
  const imports = graph.edges.filter(
    (e) => e.kind === "import" && !e.deferred && e.source !== e.target && vertices.has(e.source) && vertices.has(e.target),
  );
  const targets = new Map<string, string[]>();
  for (const edge of imports) {
    targets.set(edge.source, [...(targets.get(edge.source) ?? []), edge.target]);
  }

  const groups = components(ids, targets)
    .map((group) => group.sort(byId))
    .sort((a, b) => byId(a[0], b[0]));
  const member = new Map<string, number>();
  groups.forEach((group, i) => group.forEach((id) => member.set(id, i)));
  const edges = new Set(
    imports.filter((e) => member.has(e.source) && member.get(e.source) === member.get(e.target)).map(edgeKey),
  );
  return { groups, member, edges };
}
