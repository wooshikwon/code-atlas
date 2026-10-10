// 관계 그래프 위에 떠 있는 정보 패널. 저장소의 선택을 머리 줄, LLM 요약 칸, 지점 목록, 코드 뷰어로 바꾼다.
import { useMemo, useState } from "react";
import type { AtlasNode, EdgeKind, Graph, SiteRef } from "../api/types";
import { CodeView } from "../code/CodeView";
import { edgeKey, type EdgeKey } from "../graph/scope";
import { degrees } from "../graph/view";
import { useAtlas, type Selection } from "../state/store";
import { Header, type HeaderItem, type PickedEdge } from "./Header";
import type { Dir } from "./rect";
import { Sites } from "./Sites";
import { Summary } from "./Summary";
import { usePanelRect } from "./usePanelRect";

const DIRS: Dir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const SUMMARIZED = new Set<AtlasNode["kind"]>(["module", "class", "dataclass", "function", "method"]);
/** 코드 뷰어를 열지 않는 종류 */
const UNITS = new Set<AtlasNode["kind"]>(["module", "package"]);
const GROUP_ORDER = ["run", "use", "derive"] as const;

/** id가 ancestor이거나 그 자손인지 */
function within(nodes: Map<string, AtlasNode>, id: string, ancestor: string): boolean {
  for (let node = nodes.get(id); node !== undefined; node = node.parent === null ? undefined : nodes.get(node.parent)) {
    if (node.id === ancestor) {
      return true;
    }
  }
  return false;
}

/**
 * 선 키가 가리키는 선. `agg|출발|도착` 키면 출발 노드와 그 자손에서 도착 노드와 그 자손으로 가는 선을 합친다.
 * 화면에 그리지 않는 노드(shown이 거르는 테스트 코드·외부 노드)에 닿는 선은 합치지 않는다.
 */
function pickEdge(
  graph: Graph,
  nodes: Map<string, AtlasNode>,
  key: EdgeKey,
  shown: (node: AtlasNode | undefined) => boolean,
): PickedEdge | null {
  const [tag, source, target] = key.split("|");
  if (tag !== "agg") {
    const edge = graph.edges.find((e) => edgeKey(e) === key);
    return edge === undefined ? null : { ...edge, kinds: { [edge.kind]: edge.sites.length } };
  }
  const parts = graph.edges.filter(
    (e) =>
      shown(nodes.get(e.source)) &&
      shown(nodes.get(e.target)) &&
      within(nodes, e.source, source) &&
      within(nodes, e.target, target),
  );
  if (parts.length === 0) {
    return null;
  }
  const kinds: Partial<Record<EdgeKind, number>> = {};
  for (const edge of parts) {
    kinds[edge.kind] = (kinds[edge.kind] ?? 0) + edge.sites.length;
  }
  return {
    source,
    target,
    group: GROUP_ORDER.find((g) => parts.some((e) => e.group === g))!,
    kind: null,
    kinds,
    deferred: parts.every((e) => e.deferred),
    sites: parts.flatMap((e) => e.sites),
  };
}

/** 지점을 품은 가장 안쪽 노드의 줄 범위. 파일 안 어느 정의에도 들지 않으면 모듈 노드의 범위다. */
function rangeAround(graph: Graph, site: SiteRef): [number, number] | null {
  let found: [number, number] | null = null;
  for (const node of graph.nodes) {
    const range = node.range;
    if (node.path !== site.path || node.kind === "package" || range === null) {
      continue;
    }
    if (range[0] <= site.line && site.line <= range[1] && (found === null || range[1] - range[0] < found[1] - found[0])) {
      found = range;
    }
  }
  return found;
}

export function InfoPanel() {
  const repo = useAtlas((s) => s.repo);
  const graph = useAtlas((s) => s.graph);
  const selection = useAtlas((s) => s.selection);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  /** 지점 목록에서 눌러 코드 뷰어에 연 지점과 그때 고른 선. 선택이 바뀌면 쓰지 않는다. */
  const [opened, setOpened] = useState<{ selection: Selection; site: SiteRef } | null>(null);
  const site = opened?.selection === selection ? opened.site : null;

  const index = useMemo(
    () =>
      graph === null
        ? null
        : { nodes: new Map(graph.nodes.map((n) => [n.id, n])), degrees: degrees(graph) },
    [graph],
  );

  const edge = useMemo(() => {
    if (graph === null || index === null || selection?.type !== "edge") {
      return null;
    }
    const shown = (node: AtlasNode | undefined) =>
      node !== undefined && (showTests || !node.test) && (showExternal || node.kind !== "external");
    return pickEdge(graph, index.nodes, selection.key, shown);
  }, [graph, index, selection, showTests, showExternal]);

  const node = selection?.type === "node" ? index?.nodes.get(selection.id) : undefined;

  let item: HeaderItem | null = null;
  if (graph !== null && index !== null && node !== undefined) {
    const degree = index.degrees.get(node.id) ?? { incoming: 0, outgoing: 0 };
    const functions =
      node.kind === "module"
        ? graph.nodes.filter(
            (n) => (n.kind === "function" || n.kind === "method") && n.id !== node.id && within(index.nodes, n.id, node.id),
          ).length
        : 0;
    item = { type: "node", node, ...degree, functions };
  } else if (edge !== null) {
    item = { type: "edge", edge };
  } else if (repo !== null) {
    item = { type: "repo", name: repo.name };
  }

  const siteRange = graph !== null && site !== null ? rangeAround(graph, site) : null;
  /** 코드 뷰어에 열 범위. 파일·폴더를 골랐거나 선의 지점을 누르지 않았으면 null이다. */
  const code =
    node !== undefined && !UNITS.has(node.kind) && node.path !== null && node.range !== null
      ? { path: node.path, range: node.range }
      : site !== null && siteRange !== null
        ? { path: site.path, range: siteRange, highlight: site.line }
        : null;
  const { ref, rect, fitted, grip } = usePanelRect(code === null);

  return (
    <div
      ref={ref}
      className="info-panel"
      style={
        rect === null
          ? undefined
          : { left: rect.x, top: rect.y, width: rect.width, ...(fitted ? { maxHeight: rect.height } : { height: rect.height }) }
      }
    >
      {rect !== null && item !== null && index !== null && (
        <>
          <div className="info-panel-head" onPointerDown={grip("move")}>
            <Header item={item} nodes={index.nodes} />
          </div>
          {node !== undefined && SUMMARIZED.has(node.kind) && <Summary key={node.id} node={node.id} />}
          {edge !== null && <Sites sites={edge.sites} opened={site} open={(picked) => setOpened({ selection, site: picked })} />}
          {code !== null && <CodeView {...code} />}
        </>
      )}
      {DIRS.map((dir) => (
        <div key={dir} className="info-panel-resize" data-dir={dir} onPointerDown={grip(dir)} />
      ))}
    </div>
  );
}
