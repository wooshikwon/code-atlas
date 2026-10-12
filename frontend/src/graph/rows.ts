// 선의 말풍선에 적는 줄. 화면에 그린 선 하나를 고른 노드의 단계에 맞춰 출발·도착·관계의 줄로 푼다.
// 단계는 파일과 함수 두 가지다. 고른 노드가 함수(클래스, 메서드)면 그 노드에 닿는 선을 실제 함수 사이의 관계로,
// 파일이면 상대 끝을 파일로 풀고, 고른 노드가 없거나 고른 노드에 닿지 않는 선은 화면에 그린 양 끝을 그대로 적는다.
import type { AtlasEdge, AtlasNode, EdgeKind } from "../api/types";
import { COUNTED_KINDS, relationsOf, STEP_NAMES } from "./names";
import { aggKey, edgeKey, type DrawnEdge, type EdgeKey } from "./scope";
import { unitOf, within } from "./visible";

/** 줄로 풀 선. edges는 그 선에 합친 원래 선이고, 양 끝을 그대로 적는 함수 시점 뷰의 선과 실행 선이 없는 경로의 이음은 비워 넘긴다. */
export type RowLine = Pick<DrawnEdge, "key" | "source" | "target" | "kinds" | "route" | "edges">;

/** 줄의 양 끝을 적는 단계. drawn은 화면에 그린 양 끝이다. */
export type Stage = "function" | "file" | "drawn";

export interface LineRow {
  /** 이 줄을 낸 화면의 선. 줄에 마우스를 올리면 이 선을 강조한다. */
  line: EdgeKey;
  /** 출발 노드와 도착 노드. 풀어 적은 끝은 화면에 그려져 있지 않은 노드일 수 있다. */
  source: string;
  target: string;
  /** 관계 칸에 적는 글 */
  relation: string;
  /** 이름을 눌러 그 끝으로 갈 때 지나온 선으로 담는 키. 누를 수 없는 줄은 null이다. */
  keys: EdgeKey[] | null;
  /** 관계 칸을 눌러 코드 줄 목록을 여는 선의 키. 원래 선 하나로 된 줄은 그 선이고 그 밖의 줄은 화면의 선이다. 코드 줄이 없으면 null이다. */
  list: EdgeKey | null;
}

const DEFINITIONS = new Set<AtlasNode["kind"]>(["function", "method", "class", "dataclass"]);

/**
 * 선 line의 양 끝을 적는 단계. 고른 노드 focus와 그 안의 노드에서 밖으로 나가거나 밖에서 들어오는 선만 고른 노드의 단계를 따르고,
 * 폴더와 외부 노드는 단계가 아니다.
 */
export function stageOf(nodes: Map<string, AtlasNode>, focus: string | null, line: RowLine): Stage {
  const kind = focus === null ? undefined : nodes.get(focus)?.kind;
  if (focus === null || kind === undefined || line.edges.length === 0 || within(nodes, line.source, focus) === within(nodes, line.target, focus)) {
    return "drawn";
  }
  return kind === "module" ? "file" : DEFINITIONS.has(kind) ? "function" : "drawn";
}

/**
 * 선 line을 말풍선의 줄로 푼다.
 * - 함수 단계: 세는 관계(`COUNTED_KINDS`)의 원래 선을 실제 출발·도착 정의마다 한 줄로 묶는다. 세는 관계가 없으면 화면의 양 끝과
 *   관계 글(`import 관계만 있음`)을 누를 수 없는 줄 하나로 낸다.
 * - 파일 단계: 고른 파일 쪽 끝은 화면에 그린 노드를, 상대 끝은 그 정의가 든 파일을 적어 상대 파일마다 한 줄로 묶는다.
 * - 그 밖: 화면에 그린 양 끝 한 줄이다. 실행 선이 없는 경로의 이음은 관계 대신 걸음의 이름을 적는다.
 * 줄은 원래 선이 그래프에 나오는 순서다.
 */
export function rowsOf(nodes: Map<string, AtlasNode>, focus: string | null, line: RowLine): LineRow[] {
  const stage = stageOf(nodes, focus, line);
  const inside = focus !== null && within(nodes, line.source, focus);
  const ends = (edge: AtlasEdge): [string, string] => {
    if (stage === "function") {
      return [edge.source, edge.target];
    }
    if (stage === "file") {
      return inside ? [line.source, unitOf(nodes, edge.target)] : [unitOf(nodes, edge.source), line.target];
    }
    return [line.source, line.target];
  };
  const groups = new Map<string, { source: string; target: string; edges: AtlasEdge[] }>();
  for (const edge of stage === "function" ? line.edges.filter((each) => COUNTED_KINDS.includes(each.kind)) : line.edges) {
    const [source, target] = ends(edge);
    const id = `${source}|${target}`;
    const group = groups.get(id) ?? { source, target, edges: [] };
    group.edges.push(edge);
    groups.set(id, group);
  }
  if (groups.size === 0) {
    /** 실행 선이 없는 경로의 이음 */
    const bare = line.route !== null && Object.keys(line.kinds).length === 0;
    const relation = bare ? STEP_NAMES[line.route!] : relationsOf(line.kinds);
    return [{ line: line.key, source: line.source, target: line.target, relation, keys: stage === "function" ? null : [line.key], list: bare ? null : line.key }];
  }
  return [...groups.values()].map(({ source, target, edges }) => {
    const kinds: Partial<Record<EdgeKind, number>> = {};
    for (const edge of edges) {
      kinds[edge.kind] = (kinds[edge.kind] ?? 0) + edge.sites.length;
    }
    const whole = source === line.source && target === line.target;
    return {
      line: line.key,
      source,
      target,
      relation: relationsOf(kinds),
      keys: stage === "function" ? edges.map(edgeKey) : whole ? [line.key] : [aggKey(source, target)],
      list: !whole && edges.length === 1 ? edgeKey(edges[0]) : line.key,
    };
  });
}
