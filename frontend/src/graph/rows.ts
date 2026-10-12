// 선의 말풍선에 적는 줄. 화면에 그린 선 하나를 고른 노드의 단계에 맞춰 출발·도착·관계의 줄로 푼다. 줄이 되는지는 양 끝의 단계로 정하고,
// 세는 관계인지(`COUNTED_KINDS`)는 관계 칸에 수를 적을지만 정한다.
// 단계는 파일과 함수 두 가지다. 고른 노드가 함수(클래스, 메서드, 변수)면 그 노드에 닿는 선을 실제 함수 사이의 관계로,
// 파일이면 상대 끝을 파일로 풀고, 고른 노드가 없거나 고른 노드에 닿지 않는 선은 화면에 그린 양 끝을 그대로 적는다.
// 줄의 끝이 클래스·함수·메서드·변수면 기준 파일(`baseOf`)에서 갈라지는 곳부터의 경로를 이름 앞에 적는다(`definedName`).
// 시점 비교가 켜져 있으면 줄마다 그 줄에 든 관계의 변경 내용(`RowTally`)을 담고, 수만 달라진 관계는 관계 칸에 기준 시점의 수를 함께 적는다.
import type { AtlasEdge, AtlasNode, Comparison, EdgeKind } from "../api/types";
import { rowChange, type Lines } from "./compare";
import { titleOf } from "./layout";
import { kindsOf, nameOf, relationOf, relationsOf, STEP_NAMES } from "./names";
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
  /** 이름을 눌러 그 끝으로 갈 때 지나온 선으로 담는 키. 풀어 적을 끝이 없어 누를 수 없는 안내 줄은 null이다. */
  keys: EdgeKey[] | null;
  /** 관계 칸을 눌러 코드 줄 목록을 여는 선의 키. 원래 선 하나로 된 줄은 그 선이고 그 밖의 줄은 화면의 선이다. 코드 줄이 없으면 null이다. */
  list: EdgeKey | null;
  /** 시점 비교가 켜져 있을 때만 담는, 변경 칸에 적는 값 */
  change?: RowTally;
}

/** 말풍선 한 줄에 든 원래 선 가운데 추가된 선, 삭제된 선, 양쪽 시점에 있는 선의 수 */
export interface RowTally {
  added: number;
  deleted: number;
  kept: number;
}

export const CHANGE_NAMES = { added: "신규", deleted: "삭제", kept: "유지" } as const;

/**
 * 변경 칸에 적는 글의 토막. 든 선이 모두 추가된 선이면 `신규`, 모두 삭제된 선이면 `삭제`, 추가되거나 삭제된 선이 없으면 `유지`다.
 * 그 밖의 줄은 추가된 선과 삭제된 선의 수를 붙여 `신규 1`과 `삭제 1`로 적는다.
 */
export function changeParts(tally: RowTally): { kind: keyof typeof CHANGE_NAMES; text: string }[] {
  if (tally.added === 0 && tally.deleted === 0) {
    return [{ kind: "kept", text: CHANGE_NAMES.kept }];
  }
  const whole = tally.kept === 0 && (tally.added === 0 || tally.deleted === 0);
  return (["added", "deleted"] as const)
    .filter((kind) => tally[kind] > 0)
    .map((kind) => ({ kind, text: whole ? CHANGE_NAMES[kind] : `${CHANGE_NAMES[kind]} ${tally[kind]}` }));
}

type Kinds = Partial<Record<EdgeKind, number>>;

/** 원래 선 edges의 종류마다 sites 수 */
function counts(edges: AtlasEdge[]): Kinds {
  const kinds: Kinds = {};
  for (const edge of edges) {
    kinds[edge.kind] = (kinds[edge.kind] ?? 0) + edge.sites.length;
  }
  return kinds;
}

/**
 * 관계 칸의 글. before가 있으면 세는 관계 가운데 기준 시점의 수가 지금의 수 kinds와 다른 종류를 `호출 2곳 → 3곳`으로 적는다.
 */
function relationText(kinds: Kinds, before: Kinds | null): string {
  const counted = kindsOf({ ...before, ...kinds }, true);
  if (before === null || counted.length === 0) {
    return relationsOf(kinds);
  }
  return counted
    .map((kind) => {
      const [was, now] = [before[kind] ?? 0, kinds[kind] ?? 0];
      return was === now ? relationOf(kind, now) : `${relationOf(kind, was)} → ${now}곳`;
    })
    .join(" · ");
}

const DEFINITIONS = new Set<AtlasNode["kind"]>(["function", "method", "class", "dataclass", "variable"]);
const BOXES = new Set<AtlasNode["kind"] | undefined>(["module", "package"]);

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
 * - 함수 단계: 양 끝이 파일이나 폴더가 아닌 원래 선을 실제 출발·도착 정의마다 한 줄로 묶는다. 타입 관계도 줄이 되고, 파일과 파일
 *   사이의 관계인 import는 풀어 적을 끝이 없어 줄이 되지 않는다. 그런 선뿐이면 화면의 양 끝과 관계 글(`import 관계만 있음`)을
 *   누를 수 없는 안내 줄 하나로 낸다.
 * - 파일 단계: 고른 파일 쪽 끝은 화면에 그린 노드를, 상대 끝은 그 정의가 든 파일을 적어 상대 파일마다 한 줄로 묶는다.
 * - 그 밖: 화면에 그린 양 끝 한 줄이다. 실행 선이 없는 경로의 이음은 관계 대신 걸음의 이름을 적는다.
 * 줄은 원래 선이 그래프에 나오는 순서다. changes는 시점 비교의 선마다의 변경 내용이고 비교가 꺼져 있으면 null이다. 비교가 켜져 있으면
 * 관계 칸은 삭제되지 않은 선의 수를 적고, 삭제된 선만 든 줄은 기준 시점의 수를 적는다.
 */
export function rowsOf(nodes: Map<string, AtlasNode>, focus: string | null, line: RowLine, changes: Comparison["edges"] | null = null): LineRow[] {
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
  /** 원래 선 edges를 묶은 줄의 관계 칸과 변경 칸 */
  const told = (edges: AtlasEdge[]): Pick<LineRow, "relation" | "change"> => {
    if (changes === null) {
      return { relation: relationsOf(counts(edges)) };
    }
    const { added, deleted, before } = rowChange(edges, changes);
    const live = edges.filter((edge) => changes[edgeKey(edge)]?.change !== "deleted");
    return {
      relation: relationText(counts(live.length > 0 ? live : edges), live.length > 0 ? before : null),
      change: { added, deleted, kept: edges.length - added - deleted },
    };
  };
  const groups = new Map<string, { source: string; target: string; edges: AtlasEdge[] }>();
  const defined = (edge: AtlasEdge) => !BOXES.has(nodes.get(edge.source)?.kind) && !BOXES.has(nodes.get(edge.target)?.kind);
  for (const edge of stage === "function" ? line.edges.filter(defined) : line.edges) {
    const [source, target] = ends(edge);
    const id = `${source}|${target}`;
    const group = groups.get(id) ?? { source, target, edges: [] };
    group.edges.push(edge);
    groups.set(id, group);
  }
  if (groups.size === 0) {
    /** 실행 선이 없는 경로의 이음 */
    const bare = line.route !== null && Object.keys(line.kinds).length === 0;
    const whole = line.edges.length === 0 ? { relation: relationsOf(line.kinds), ...(changes === null ? {} : { change: { added: 0, deleted: 0, kept: 0 } }) } : told(line.edges);
    const relation = bare ? STEP_NAMES[line.route!] : whole.relation;
    return [{ line: line.key, source: line.source, target: line.target, ...whole, relation, keys: stage === "function" ? null : [line.key], list: bare ? null : line.key }];
  }
  return [...groups.values()].map(({ source, target, edges }) => {
    const whole = source === line.source && target === line.target;
    return {
      line: line.key,
      source,
      target,
      ...told(edges),
      keys: stage === "function" ? edges.map(edgeKey) : whole ? [line.key] : [aggKey(source, target)],
      list: !whole && edges.length === 1 ? edgeKey(edges[0]) : line.key,
    };
  });
}

/** 말풍선의 칸에 적는 노드 이름. path는 이름 앞에 적는 경로이고 칸이 넘치면 path부터 줄인다. full은 줄이지 않은 경로와 이름이다. */
export interface CellName {
  path: string;
  name: string;
  full: string;
  /** 시점 비교에서 이름 뒤에 작게 적는 그 노드의 줄 수. 바뀐 줄이 없거나 비교가 꺼져 있으면 없다. */
  lines?: Lines;
}

/**
 * 줄 row의 끝 id를 적을 때 기준으로 삼는 파일. 줄의 한 끝만 고른 노드 focus나 그 안의 노드이면 focus가 든 파일이고,
 * 고른 노드가 없거나 폴더이거나 줄이 고른 노드에 닿지 않으면 줄의 다른 쪽 끝이 든 파일(다른 쪽 끝이 폴더면 그 폴더)이다.
 */
export function baseOf(nodes: Map<string, AtlasNode>, focus: string | null, row: Pick<LineRow, "source" | "target">, id: string): string {
  const kind = focus === null ? undefined : nodes.get(focus)?.kind;
  if (focus !== null && kind !== undefined && (kind === "module" || DEFINITIONS.has(kind)) && within(nodes, row.source, focus) !== within(nodes, row.target, focus)) {
    return unitOf(nodes, focus);
  }
  return unitOf(nodes, id === row.source ? row.target : row.source);
}

/** 경로 path에서 경로 from과 앞에서부터 같은 폴더를 뺀 나머지. 두 경로의 마지막 마디(파일이나 폴더 자신)는 견주지 않는다. */
function apartFrom(path: string, from: string): string {
  const parts = path.split("/");
  const others = from.replace(/\/$/, "").split("/");
  /** 폴더 경로는 `/`로 끝나 마지막 마디가 빈 글자다. */
  const last = parts.length - (path.endsWith("/") ? 2 : 1);
  let same = 0;
  while (same < last && same < others.length - 1 && parts[same] === others[same]) {
    same += 1;
  }
  return parts.slice(same).join("/");
}

/**
 * 클래스·함수·메서드·변수 node를 기준 파일 base에서 갈라지는 곳부터 적은 이름. base 안의 정의는 이름만(`create_weekly()`),
 * 같은 폴더의 다른 파일에 든 정의는 파일 이름부터(`note_batch.py::create_weekly()`), 다른 폴더의 정의는 두 경로가 갈라지는
 * 첫 폴더부터(`parser/weekly.py::parse_week()`) 적는다. 메서드의 이름은 `클래스.메서드()`, 변수의 이름은 괄호 없는 이름이다.
 */
export function definedName(nodes: Map<string, AtlasNode>, base: string, node: AtlasNode): CellName {
  const name = nameOf(nodes, node);
  const unit = nodes.get(unitOf(nodes, node.id));
  if (unit === undefined || unit.id === node.id) {
    return { path: "", name, full: name };
  }
  const from = nodes.get(base);
  const whole = titleOf(unit);
  return { path: unit.id === base ? "" : `${from === undefined ? whole : apartFrom(whole, titleOf(from))}::`, name, full: `${whole}::${name}` };
}
