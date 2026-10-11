// 관계 그래프 위에 떠 있는 정보 패널. 저장소의 선택을 머리 줄, LLM 요약 칸, 지점 목록, 코드 뷰어로 바꾼다.
import { useMemo, useState } from "react";
import type { AtlasNode, Graph, SiteRef } from "../api/types";
import { CodeView } from "../code/CodeView";
import { flow } from "../graph/flow";
import { degrees, drawn, neighbors, picked, type DrawnEdge } from "../graph/scope";
import { hidden, nodeIndex, shown, unresolvedWithin, within } from "../graph/visible";
import { focusOf } from "../state/history";
import { useAtlas, type Selection } from "../state/store";
import { Header, type HeaderItem, type PickedEdge } from "./Header";
import { useOpened } from "./opened";
import type { Dir } from "./rect";
import { Sites } from "./Sites";
import { Summary } from "./Summary";
import { usePanelRect } from "./usePanelRect";

const DIRS: Dir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const SUMMARIZED = new Set<AtlasNode["kind"]>(["module", "class", "dataclass", "function", "method"]);
/** 코드 뷰어를 열지 않고 머리 줄 수치를 상자 단위로 세는 종류 */
const UNITS = new Set<AtlasNode["kind"]>(["module", "package"]);
/** 그래프가 그린 선 edge를 머리 줄과 지점 목록에 쓰는 값으로 바꾼다. 집계 선이면 kind가 null이다. */
function pickedEdge(edge: DrawnEdge): PickedEdge {
  return {
    source: edge.source,
    target: edge.target,
    group: edge.group,
    kind: edge.key.startsWith("agg|") ? null : edge.edges[0].kind,
    kinds: edge.kinds,
    deferred: edge.deferred,
    sites: edge.edges.flatMap((e) => e.sites),
  };
}

/** 지점을 품은 가장 안쪽 노드의 줄 범위. 파일 안 어느 정의에도 들지 않으면 모듈 노드의 범위다. */
function rangeAround(graph: Graph, site: SiteRef): [number, number] | null {
  let found: [number, number] | null = null;
  for (const node of graph.nodes) {
    const range = node.range;
    if (node.path !== site.path || range === null) {
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
  const collapsed = useAtlas((s) => s.collapsed);
  const depth = useAtlas((s) => s.depth);
  /** 그래프 선택과 무관하게 연 파일. 고른 노드나 선 대신 이 파일의 코드를 보인다. */
  const file = useOpened((s) => s.path);
  /** 지점 목록에서 눌러 코드 뷰어에 연 지점과 그때 고른 선. 선택이 바뀌면 쓰지 않는다. */
  const [opened, setOpened] = useState<{ selection: Selection; site: SiteRef } | null>(null);
  const site = opened?.selection === selection ? opened.site : null;

  const index = useMemo(
    () =>
      graph === null
        ? null
        : { nodes: nodeIndex(graph), degrees: degrees(graph) },
    [graph],
  );

  /** 그래프가 지금 화면을 그릴 때와 같은 흐름과 보이는 노드 */
  const scene = useMemo(() => {
    if (graph === null || index === null) {
      return null;
    }
    const toggles = { showTests, showExternal };
    const off = hidden(graph, toggles);
    const focus = focusOf(selection);
    const focused = focus !== null && index.nodes.has(focus) && !off.has(focus) ? flow(graph, focus, depth, off) : null;
    return { flow: focused, shown: shown(graph, { ...toggles, collapsed, flow: focused }) };
  }, [graph, index, selection, showTests, showExternal, collapsed, depth]);

  const edge = useMemo(() => {
    if (graph === null || scene === null || selection?.type !== "edge") {
      return null;
    }
    const found = picked(graph, scene.shown, scene.flow, selection.key);
    return found === null ? null : pickedEdge(found);
  }, [graph, scene, selection]);

  const node = file === null && selection?.type === "node" ? index?.nodes.get(selection.id) : undefined;

  /** 고른 파일 상자나 폴더 상자의 머리 줄 수치. 화면에 그린 선과 배지가 세는 범위에서 센다. */
  const box = useMemo(() => {
    if (graph === null || index === null || scene === null || node === undefined || !UNITS.has(node.kind)) {
      return null;
    }
    const { external, ...counts } = neighbors(drawn(graph, scene.shown, scene.flow, null), index.nodes, node.id);
    return {
      ...counts,
      external: showExternal ? external : null,
      unresolved: unresolvedWithin(graph, scene.shown.hidden).get(node.id) ?? 0,
    };
  }, [graph, index, scene, node, showExternal]);

  let item: HeaderItem | null = null;
  if (file !== null) {
    item = { type: "file", path: file };
  } else if (graph !== null && index !== null && node !== undefined) {
    const degree = index.degrees.get(node.id) ?? { incoming: 0, outgoing: 0 };
    const functions =
      node.kind === "module"
        ? graph.nodes.filter(
            (n) => (n.kind === "function" || n.kind === "method") && n.id !== node.id && within(index.nodes, n.id, node.id),
          ).length
        : 0;
    item = { type: "node", node, ...degree, external: null, unresolved: node.unresolved, ...box, functions };
  } else if (edge !== null) {
    item = { type: "edge", edge };
  } else if (repo !== null) {
    item = { type: "repo", name: repo.name };
  }

  const siteRange = graph !== null && site !== null ? rangeAround(graph, site) : null;
  /** 코드 뷰어에 열 범위. 파일·폴더를 골랐거나 선의 지점을 누르지 않았으면 null이다. 연 파일은 파일 전체다. */
  const code =
    file !== null
      ? { path: file, range: null }
      : node !== undefined && !UNITS.has(node.kind) && node.path !== null && node.range !== null
        ? { path: node.path, range: node.range }
        : site !== null && siteRange !== null
          ? { path: site.path, range: siteRange, highlight: site.line }
          : null;
  const { ref, rect, grip, reset } = usePanelRect();

  return (
    <div
      ref={ref}
      className="info-panel"
      style={rect === null ? undefined : { left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      {rect !== null && item !== null && index !== null && (
        <>
          <div className="info-panel-head" onPointerDown={grip("move")} onDoubleClick={reset} title="끌어서 옮기고, 더블클릭하면 기본 위치와 크기로 돌아간다">
            <Header item={item} nodes={index.nodes} />
          </div>
          {node !== undefined && SUMMARIZED.has(node.kind) && <Summary key={node.id} node={node.id} />}
          {file === null && edge !== null && <Sites sites={edge.sites} opened={site} open={(picked) => setOpened({ selection, site: picked })} />}
          {code !== null && <CodeView {...code} />}
        </>
      )}
      {DIRS.map((dir) => (
        <div key={dir} className="info-panel-resize" data-dir={dir} onPointerDown={grip(dir)} />
      ))}
    </div>
  );
}
