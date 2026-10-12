// 정보 패널의 "정보" 구역에 적는 값. 노드의 크기와 안에 든 정의 수, 나가는 연결과 들어오는 연결, 선을 눌러 온 상태의 지나온 선을 계산한다.
import type { AtlasEdge, AtlasNode, EdgeKind, Graph, SiteRef } from "../api/types";
import { EDGE_KIND_NAMES, nameOf, relationOf } from "../graph/names";
import { along, endsOf, type EdgeKey } from "../graph/scope";
import { unitOf, within } from "../graph/visible";

/** 코드 줄 묶음. name이 있으면 묶음 앞에 그 이름을 적는다. */
export interface SiteGroup {
  name: string | null;
  sites: SiteRef[];
}

/** 관계 묶음 하나. total은 관계가 일어난 코드 줄 수이고 kinds는 종류마다의 수, groups는 상대 노드마다 묶은 코드 줄이다. */
export interface Links {
  total: number;
  kinds: Partial<Record<EdgeKind, number>>;
  groups: SiteGroup[];
}

const BOXES = new Set<AtlasNode["kind"]>(["module", "package"]);
const CLASSES = new Set<AtlasNode["kind"]>(["class", "dataclass"]);

/** 원래 선 edges를 관계 묶음 하나로 합친다. peer는 선마다 코드 줄을 묶을 상대 노드의 id다. */
function linked(nodes: Map<string, AtlasNode>, edges: AtlasEdge[], peer: (edge: AtlasEdge) => string): Links {
  const kinds: Links["kinds"] = {};
  const groups = new Map<string, SiteRef[]>();
  let total = 0;
  for (const edge of edges) {
    total += edge.sites.length;
    kinds[edge.kind] = (kinds[edge.kind] ?? 0) + edge.sites.length;
    const id = peer(edge);
    groups.set(id, [...(groups.get(id) ?? []), ...edge.sites]);
  }
  const name = (id: string) => {
    const node = nodes.get(id);
    return node === undefined ? id : nameOf(nodes, node);
  };
  return { total, kinds, groups: [...groups].map(([id, sites]) => ({ name: name(id), sites })) };
}

/**
 * 노드 id에서 나가는 연결(out)과 그 노드로 들어오는 연결(into). 노드와 그 안에 든 노드의 경계를 넘는 선을 세고, off에 든 노드(토글로 숨긴
 * 테스트 코드와 외부 노드)와의 선은 세지 않는다. 코드 줄은 상대 노드마다 묶고, 파일 상자와 폴더 상자를 골랐으면 상대 노드가 든 파일 상자마다 묶는다.
 */
export function linksOf(graph: Graph, nodes: Map<string, AtlasNode>, off: Set<string>, id: string): { out: Links; into: Links } {
  const boxed = BOXES.has(nodes.get(id)?.kind ?? "function");
  const peer = (other: string) => (boxed ? unitOf(nodes, other) : other);
  const out: AtlasEdge[] = [];
  const into: AtlasEdge[] = [];
  for (const edge of graph.edges) {
    if (off.has(edge.source) || off.has(edge.target)) {
      continue;
    }
    const [from, to] = [within(nodes, edge.source, id), within(nodes, edge.target, id)];
    if (from && !to) {
      out.push(edge);
    } else if (to && !from) {
      into.push(edge);
    }
  }
  return { out: linked(nodes, out, (edge) => peer(edge.target)), into: linked(nodes, into, (edge) => peer(edge.source)) };
}

/** 지나온 선 하나. sources와 target은 누른 선의 출발 노드와 도착 노드이고(지금 고른 노드와 무관하다) links는 그 선에 든 관계를 출발 노드마다 묶은 것이다. */
export interface Followed {
  sources: string[];
  target: string;
  links: Links;
}

/** 선 키 keys가 가리키는 선. off에 든 노드와의 선은 세지 않는다. 키가 가리키는 선이 그래프에 없으면 null이다. */
export function followedOf(graph: Graph, nodes: Map<string, AtlasNode>, off: Set<string>, keys: EdgeKey[]): Followed | null {
  const ends = keys.map(endsOf);
  const edges = graph.edges.filter((edge) => !off.has(edge.source) && !off.has(edge.target) && along(nodes, keys, edge));
  if (ends.length === 0 || edges.length === 0) {
    return null;
  }
  const sources = [...new Set(ends.map((end) => end.source))];
  const source = (edge: AtlasEdge) => sources.find((id) => within(nodes, edge.source, id)) ?? edge.source;
  return { sources, target: ends[0].target, links: linked(nodes, edges, source) };
}

/** 안에 든 정의의 수. 파일 상자는 함수와 클래스, 클래스는 메서드, 폴더 상자는 파일을 센다. 그 밖의 노드와 안에 든 것이 없는 노드는 빈 배열이다. */
export function contentsOf(graph: Graph, nodes: Map<string, AtlasNode>, off: Set<string>, node: AtlasNode): { name: string; count: number }[] {
  const inside = graph.nodes.filter((n) => n.id !== node.id && !off.has(n.id) && within(nodes, n.id, node.id));
  const counted = (name: string, kinds: (kind: AtlasNode["kind"]) => boolean) => ({ name, count: inside.filter((n) => kinds(n.kind)).length });
  let counts: { name: string; count: number }[] = [];
  if (node.kind === "module") {
    counts = [counted("함수", (kind) => kind === "function"), counted("클래스", (kind) => CLASSES.has(kind))];
  } else if (CLASSES.has(node.kind)) {
    counts = [counted("메서드", (kind) => kind === "method")];
  } else if (node.kind === "package") {
    counts = [counted("파일", (kind) => kind === "module")];
  }
  return counts.filter(({ count }) => count > 0);
}

/**
 * 종류마다의 수 kinds를 합과 함께 `12개 (호출 9곳, import 3줄)`로 적는다. 종류가 하나면 `호출 12곳`이고 관계가 없으면 `없음`이다.
 * 종류의 이름과 단위, 순서는 `relationOf`와 `EDGE_KIND_NAMES`를 따른다.
 */
export function linksText(kinds: Links["kinds"]): string {
  const list = (Object.keys(EDGE_KIND_NAMES) as EdgeKind[]).filter((kind) => kinds[kind] !== undefined).map((kind) => relationOf(kind, kinds[kind]!));
  if (list.length === 0) {
    return "없음";
  }
  if (list.length === 1) {
    return list[0];
  }
  const total = Object.values(kinds).reduce((sum, count) => sum + count, 0);
  return `${total}개 (${list.join(", ")})`;
}

/** 노드의 줄 수와 정의의 줄 범위를 `42줄 (120~161)`로 적는다. 파일 상자와 폴더 상자는 줄 수만 적고, 외부 노드는 null이다. */
export function sizeText(node: AtlasNode): string | null {
  if (node.kind === "external") {
    return null;
  }
  return BOXES.has(node.kind) || node.range === null ? `${node.loc}줄` : `${node.loc}줄 (${node.range[0]}~${node.range[1]})`;
}

/**
 * 이름 줄에 적는 노드의 경로. path는 옅게 적는 앞쪽 경로이고 name은 끝까지 보이는 이름이다. 함수·메서드·클래스는 `파일 경로::`와 이름,
 * 파일은 폴더 경로와 파일 이름, 폴더는 부모 폴더 경로와 `폴더 이름/`이다. 파일 경로가 없는 노드는 이름만 적는다.
 */
export function pathOf(nodes: Map<string, AtlasNode>, node: AtlasNode): { path: string; name: string } {
  if (node.path === null) {
    return { path: "", name: nameOf(nodes, node) };
  }
  if (!BOXES.has(node.kind)) {
    return { path: `${node.path}::`, name: nameOf(nodes, node) };
  }
  const whole = node.kind === "package" ? `${node.path.replace(/\/?__init__\.py$/, "")}/` : node.path;
  const at = whole.replace(/\/$/, "").lastIndexOf("/") + 1;
  return { path: whole.slice(0, at), name: whole.slice(at) };
}
