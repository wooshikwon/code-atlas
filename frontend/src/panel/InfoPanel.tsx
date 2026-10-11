// 관계 그래프 위에 떠 있는 정보 패널. 저장소의 선택을 머리 줄, LLM 요약 칸, 지점 목록, 코드 뷰어로 바꾼다.
// 아무것도 고르지 않았으면 레포 머리 줄 아래에 켠 분석 덮개의 요약을 보인다.
// 경로 고정 중에는 선택 대신 finder.focus의 노드를 보인다.
import { useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { AtlasNode, Graph, SiteRef } from "../api/types";
import { CodeView } from "../code/CodeView";
import { flow } from "../graph/flow";
import { degrees, drawn, neighbors, picked, type DrawnEdge } from "../graph/scope";
import { hidden, nodeIndex, shown, unresolvedWithin, within } from "../graph/visible";
import { focusOf } from "../state/history";
import { chosenOf, litOf, useAtlas, type Selection } from "../state/store";
import { drag } from "./drag";
import { Header, type HeaderItem, type PickedEdge } from "./Header";
import { useOpened } from "./opened";
import { Overview } from "./Overview";
import { divide, MIN_CODE, MIN_SUMMARY, type Dir } from "./rect";
import { Sites } from "./Sites";
import { Summary } from "./Summary";
import { usePanelRect } from "./usePanelRect";

const DIRS: Dir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const SUMMARIZED = new Set<AtlasNode["kind"]>(["module", "class", "dataclass", "function", "method"]);
/** 머리 줄 수치를 상자 단위로 세는 종류 */
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

/** 지점을 품은 가장 안쪽 정의의 줄 범위. 파일 안 어느 정의에도 들지 않으면 null이다. */
function rangeAround(graph: Graph, site: SiteRef): [number, number] | null {
  let found: [number, number] | null = null;
  for (const node of graph.nodes) {
    const range = node.range;
    if (node.path !== site.path || range === null || UNITS.has(node.kind)) {
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
  const finder = useAtlas((s) => s.finder);
  const split = useAtlas((s) => s.split);
  const setSplit = useAtlas((s) => s.setSplit);
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

  /** 고정 중에 강조하는 경로 */
  const lit = useMemo(() => litOf(finder), [finder.route, finder.pick]);

  /** 그래프가 지금 화면을 그릴 때와 같은 흐름·강조하는 경로와 보이는 노드 */
  const scene = useMemo(() => {
    if (graph === null || index === null) {
      return null;
    }
    const toggles = { showTests, showExternal };
    if (lit !== null) {
      return { flow: null, lit, shown: shown(graph, { ...toggles, collapsed, flow: null, lit }) };
    }
    const off = hidden(graph, toggles);
    const focus = focusOf(selection);
    const focused = focus !== null && index.nodes.has(focus) && !off.has(focus) ? flow(graph, focus, depth, off) : null;
    return { flow: focused, lit, shown: shown(graph, { ...toggles, collapsed, flow: focused, lit }) };
  }, [graph, index, selection, showTests, showExternal, collapsed, depth, lit]);

  const edge = useMemo(() => {
    if (graph === null || scene === null || scene.lit !== null || selection?.type !== "edge") {
      return null;
    }
    const found = picked(graph, scene.shown, scene.flow, selection.key);
    return found === null ? null : pickedEdge(found);
  }, [graph, scene, selection]);

  const chosen = chosenOf({ finder, selection });
  const node = file === null && chosen !== null ? index?.nodes.get(chosen) : undefined;

  /** 고른 파일 상자나 폴더 상자의 머리 줄 수치. 화면에 그린 선과 배지가 세는 범위에서 센다. */
  const box = useMemo(() => {
    if (graph === null || index === null || scene === null || node === undefined || !UNITS.has(node.kind)) {
      return null;
    }
    const { external, ...counts } = neighbors(drawn(graph, scene.shown, scene.flow, null, scene.lit), index.nodes, node.id);
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
  /** 코드 뷰어에 열 파일과 문법 색으로 그릴 범위. 폴더를 골랐거나 선의 지점을 누르지 않았으면 null이다. 연 파일과 고른 파일은 범위가 파일 전체다. */
  const code =
    file !== null
      ? { path: file, range: null }
      : node !== undefined && node.kind !== "package" && node.path !== null
        ? { path: node.path, range: node.kind === "module" ? null : node.range }
        : site !== null
          ? { path: site.path, range: siteRange, highlight: site.line }
          : null;
  const { ref, rect, docked, grip, reset } = usePanelRect();
  const summarized = node !== undefined && SUMMARIZED.has(node.kind);

  /** LLM 요약 칸과 코드 뷰어 사이의 경계선을 끌어 요약 칸의 높이를 바꾸고, 그 높이를 패널 높이로 나눈 값을 저장한다. */
  const part = (event: ReactPointerEvent<HTMLElement>) => {
    const panel = ref.current;
    const summary = panel?.querySelector<HTMLElement>(".info-panel-summary");
    const viewer = panel?.querySelector<HTMLElement>(".code");
    if (event.button !== 0 || panel === null || summary == null || viewer == null) {
      return;
    }
    const height = summary.offsetHeight;
    const room = height + viewer.offsetHeight;
    /** 끌어서 정한 요약 칸의 높이. 포인터가 움직이지 않았으면 null이고 저장하지 않는다. */
    let last: number | null = null;
    drag(
      event,
      (_dx, dy) => {
        last = divide(height, dy, room);
        summary.style.maxHeight = "none";
        summary.style.height = `${last}px`;
      },
      () => {
        if (last !== null) {
          setSplit(last / panel.clientHeight);
        }
      },
    );
  };

  /** 패널의 사각형과 요약 칸의 높이를 처음 값으로 돌린다. */
  const restore = () => {
    reset();
    setSplit(null);
  };

  return (
    <div
      ref={ref}
      className="info-panel"
      data-docked={docked ? "" : undefined}
      style={
        rect === null
          ? undefined
          : ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height, "--summary-min": `${MIN_SUMMARY}px`, "--code-min": `${MIN_CODE}px` } as CSSProperties)
      }
    >
      {rect !== null && item !== null && index !== null && (
        <>
          <div className="info-panel-head" onPointerDown={grip("move")} onDoubleClick={restore} title="끌어서 옮기고, 더블클릭하면 기본 위치와 크기로 돌아간다">
            <Header item={item} nodes={index.nodes} />
          </div>
          {item.type === "repo" && <Overview nodes={index.nodes} />}
          {summarized && <Summary node={node.id} split={code === null ? null : split} />}
          {summarized && code !== null && (
            <div className="info-panel-divide" onPointerDown={part} onDoubleClick={() => setSplit(null)} title="끌어서 요약 칸과 코드의 높이를 바꾸고, 더블클릭하면 기본 높이로 돌아간다" />
          )}
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
