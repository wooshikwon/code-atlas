// 관계 그래프 위에 떠 있는 정보 패널. 저장소의 선택을 머리 줄, "정보" 구역, 코드 줄 목록, LLM 요약 칸, 코드 뷰어로 바꾼다.
// 아무것도 고르지 않았으면 레포 머리 줄 아래에 켠 분석 덮개의 요약을 보인다.
// 경로 고정 중에는 선택 대신 finder.focus의 노드를 보인다.
import { useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { AtlasNode, Graph, SiteRef } from "../api/types";
import { CodeView } from "../code/CodeView";
import { flow } from "../graph/flow";
import { EDGE_KIND_NAMES, nameOf } from "../graph/names";
import { arriving, picked, trunkTarget } from "../graph/scope";
import { hidden, nodeIndex, shown, unresolvedWithin } from "../graph/visible";
import { focusOf } from "../state/history";
import { useOverlay } from "../state/overlay";
import { chosenOf, litOf, useAtlas, type Selection } from "../state/store";
import { drag } from "./drag";
import { contentsOf, followedOf, linksOf, linksText, relationText, restText, sizeText, type Links, type SiteGroup, type Split } from "./links";
import { Facts, type FactRow } from "./Facts";
import { Header, type HeaderItem } from "./Header";
import { useOpened } from "./opened";
import { Overview } from "./Overview";
import { divide, MIN_CODE, MIN_SUMMARY, type Dir } from "./rect";
import { Sites } from "./Sites";
import { Summary } from "./Summary";
import { usePanelRect } from "./usePanelRect";

const DIRS: Dir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const SUMMARIZED = new Set<AtlasNode["kind"]>(["module", "class", "dataclass", "function", "method"]);
/** 안에 든 노드의 미확인 호출 수까지 합쳐 적는 종류 */
const UNITS = new Set<AtlasNode["kind"]>(["module", "package"]);

/** "정보" 구역에서 코드 줄 목록을 여는 글: 지나온 선의 `관계`, `나가는 연결`·`들어오는 연결`의 세는 관계와 `그 밖` 묶음 */
type Listed = "via" | "out" | "into" | "out-rest" | "into-rest";

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
  const via = useAtlas((s) => s.via);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const collapsed = useAtlas((s) => s.collapsed);
  const unpacked = useAtlas((s) => s.unpacked);
  const overlay = useOverlay((s) => s.kind);
  const candidates = useOverlay((s) => s.unused);
  const depth = useAtlas((s) => s.depth);
  const finder = useAtlas((s) => s.finder);
  const split = useAtlas((s) => s.split);
  const setSplit = useAtlas((s) => s.setSplit);
  const summaryOpen = useAtlas((s) => s.summaryOpen);
  /** 그래프 선택과 무관하게 연 파일. 고른 노드나 선 대신 이 파일의 코드를 보인다. */
  const file = useOpened((s) => s.path);
  /**
   * "정보" 구역에서 눌러 연 코드 줄 목록과, 코드 줄 목록에서 눌러 코드 뷰어에 연 코드 줄. 그때의 선택과 지나온 선을 함께 담아,
   * 선택이나 지나온 선이 바뀌면 쓰지 않는다.
   */
  const [shownAt, setShownAt] = useState<{ selection: Selection; via: typeof via; listed: Listed | null; site: SiteRef | null } | null>(null);
  const current = shownAt !== null && shownAt.selection === selection && shownAt.via === via ? shownAt : null;
  const listed = current?.listed ?? null;
  const site = current?.site ?? null;

  const index = useMemo(() => (graph === null ? null : { nodes: nodeIndex(graph) }), [graph]);
  /** 토글로 숨긴 노드 */
  const off = useMemo(() => (graph === null ? null : hidden(graph, { showTests, showExternal })), [graph, showTests, showExternal]);

  /** 고정 중에 강조하는 경로 */
  const lit = useMemo(() => litOf(finder), [finder.route, finder.pick]);

  /** 그래프가 지금 화면을 그릴 때와 같은 흐름·강조하는 경로와 보이는 노드 */
  const scene = useMemo(() => {
    if (graph === null || index === null || off === null) {
      return null;
    }
    const toggles = { showTests, showExternal };
    const boxes = { collapsed, unpacked, marked: overlay === "unused" ? candidates : undefined, candidates };
    if (lit !== null) {
      return { flow: null, lit, shown: shown(graph, { ...toggles, ...boxes, flow: null, lit }) };
    }
    const focus = focusOf(selection);
    const focused = focus !== null && index.nodes.has(focus) && !off.has(focus) ? flow(graph, focus, depth, off) : null;
    return { flow: focused, lit, shown: shown(graph, { ...toggles, ...boxes, flow: focused, lit }) };
  }, [graph, index, off, selection, showTests, showExternal, collapsed, unpacked, overlay, candidates, depth, lit]);

  /** 고른 줄기의 도착 노드와 그 노드로 들어오는 그린 선 */
  const trunk = useMemo(() => {
    const target = selection?.type === "edge" ? trunkTarget(selection.key) : null;
    if (graph === null || scene === null || scene.lit !== null || target === null) {
      return null;
    }
    return { target, edges: arriving(graph, scene.shown, scene.flow, target) };
  }, [graph, scene, selection]);

  const edge = useMemo(() => {
    if (graph === null || scene === null || scene.lit !== null || selection?.type !== "edge" || trunkTarget(selection.key) !== null) {
      return null;
    }
    return picked(graph, scene.shown, scene.flow, selection.key);
  }, [graph, scene, selection]);

  const chosen = chosenOf({ finder, selection });
  const node = file === null && chosen !== null ? index?.nodes.get(chosen) : undefined;

  /** 선을 눌러 온 상태에서 지나온 선. 경로 고정 중이거나 연 파일을 보이는 동안, 선을 고른 동안에는 보이지 않는다. */
  const arrived = useMemo(
    () =>
      graph === null || index === null || off === null || via === null || lit !== null || file !== null || selection?.type === "edge"
        ? null
        : followedOf(graph, index.nodes, off, via),
    [graph, index, off, via, lit, file, selection],
  );

  /** 고른 노드의 연결과 안에 든 정의 수, 미확인 호출 수. 파일 상자와 폴더 상자는 안에 든 노드의 미확인 호출 수를 합친다. */
  const facts = useMemo(() => {
    if (graph === null || index === null || off === null || node === undefined) {
      return null;
    }
    return {
      ...linksOf(graph, index.nodes, off, node.id),
      contents: contentsOf(graph, index.nodes, off, node),
      unresolved: UNITS.has(node.kind) ? (unresolvedWithin(graph, off).get(node.id) ?? 0) : node.unresolved,
    };
  }, [graph, index, off, node]);

  let item: HeaderItem | null = null;
  if (file !== null) {
    item = { type: "file", path: file };
  } else if (node !== undefined) {
    item = { type: "node", node };
  } else if (edge !== null) {
    item = { type: "edge", source: edge.source, target: edge.target, group: edge.group, aggregated: edge.key.startsWith("agg|"), deferred: edge.deferred };
  } else if (trunk !== null) {
    item = { type: "trunk", target: trunk.target, sources: new Set(trunk.edges.map((e) => e.source)).size };
  } else if (repo !== null) {
    item = { type: "repo", name: repo.name };
  }

  /** "정보" 구역의 줄을 눌러 그 줄의 코드 줄 목록을 열거나 닫는다. 목록을 바꾸면 코드 뷰어에 연 코드 줄을 닫는다. */
  const list = (which: Listed) => setShownAt({ selection, via, listed: listed === which ? null : which, site: null });
  const linkRow = (id: "out" | "into", topic: string, { counted, rest }: Split): FactRow => {
    const more = restText(rest.kinds);
    return {
      id,
      topic,
      text: linksText(counted.kinds),
      brief: `${topic} ${counted.total}곳`,
      press: counted.total === 0 ? undefined : () => list(id),
      pressed: listed === id,
      more: more === null ? undefined : { text: more, press: () => list(`${id}-rest`), pressed: listed === `${id}-rest` },
    };
  };

  /** "정보" 구역의 줄. 선을 눌러 온 상태의 `연결`·`관계`가 맨 위에 오고, 고른 노드의 크기·포함·연결·미확인 호출이 그 아래에 온다. */
  const rows: FactRow[] = [];
  if (index !== null && arrived !== null) {
    const name = (id: string) => {
      const found = index.nodes.get(id);
      return found === undefined ? id : nameOf(index.nodes, found);
    };
    const from = arrived.sources.length === 1 ? name(arrived.sources[0]) : `노드 ${arrived.sources.length}개`;
    const text = `${from} → ${name(arrived.target)}`;
    rows.push({ id: "link", topic: "연결", text, brief: text });
    rows.push({ id: "via", topic: "관계", text: relationText(arrived.links.kinds), press: () => list("via"), pressed: listed === "via" });
  }
  if (node !== undefined && facts !== null) {
    const size = sizeText(node);
    if (size !== null) {
      rows.push({ id: "size", topic: "크기", text: size, brief: `${node.loc}줄` });
    }
    if (facts.contents.length > 0) {
      rows.push({ id: "contents", topic: "포함", text: facts.contents.map(({ name, count }) => `${name} ${count}개`).join(", ") });
    }
    rows.push(linkRow("out", "나가는 연결", facts.out), linkRow("into", "들어오는 연결", facts.into));
    if (facts.unresolved > 0) {
      rows.push({ id: "unresolved", topic: "미확인 호출", text: `${facts.unresolved}곳` });
    }
  } else if (edge !== null) {
    const text = relationText(edge.kinds);
    rows.push({ id: "kinds", topic: "관계", text, brief: text });
  } else if (trunk !== null) {
    const kinds: Links["kinds"] = {};
    for (const line of trunk.edges.flatMap((e) => e.edges)) {
      kinds[line.kind] = (kinds[line.kind] ?? 0) + line.sites.length;
    }
    const text = relationText(kinds);
    rows.push({ id: "kinds", topic: "관계", text, brief: text });
  }

  /**
   * 코드 줄 목록. 고른 선 하나는 묶음 하나이고, 줄기는 출발 노드마다 묶음 하나다. 같은 노드에서 종류가 다른 선이 오면 종류를 함께 적는다.
   * 노드를 골랐거나 선을 눌러 온 상태에서는 "정보" 구역에서 누른 줄의 목록이다. 지나온 선의 출발 노드가 하나면 묶음 이름을 적지 않는다.
   */
  const groups = useMemo((): SiteGroup[] | null => {
    if (index === null) {
      return null;
    }
    if (edge !== null) {
      return [{ name: null, sites: edge.edges.flatMap((line) => line.sites) }];
    }
    if (trunk !== null) {
      const name = (id: string) => {
        const found = index.nodes.get(id);
        return found === undefined ? id : nameOf(index.nodes, found);
      };
      return trunk.edges.map((e) => {
        const kind = e.key.startsWith("agg|") || trunk.edges.filter((other) => other.source === e.source).length === 1 ? "" : ` · ${EDGE_KIND_NAMES[e.edges[0].kind]}`;
        return { name: name(e.source) + kind, sites: e.edges.flatMap((line) => line.sites) };
      });
    }
    if (listed === "via" && arrived !== null) {
      const { groups: found } = arrived.links;
      return found.length === 1 ? [{ name: null, sites: found[0].sites }] : found;
    }
    if (listed === "out" || listed === "into") {
      return facts?.[listed].counted.groups ?? null;
    }
    if (listed === "out-rest" || listed === "into-rest") {
      return facts?.[listed === "out-rest" ? "out" : "into"].rest.groups ?? null;
    }
    return null;
  }, [index, edge, trunk, listed, arrived, facts]);

  const siteRange = graph !== null && site !== null ? rangeAround(graph, site) : null;
  /**
   * 코드 뷰어에 열 파일과 문법 색으로 그릴 범위. 연 파일은 범위가 파일 전체다. 코드 줄 목록에서 누른 코드 줄이 있으면 그 줄이 든 파일을
   * 열고, 없으면 고른 노드의 파일을 연다. 폴더를 골랐거나 아무것도 고르지 않았으면 null이다.
   */
  const code =
    file !== null
      ? { path: file, range: null }
      : site !== null
        ? { path: site.path, range: siteRange, highlight: site.line }
        : node !== undefined && node.kind !== "package" && node.path !== null
          ? { path: node.path, range: node.kind === "module" ? null : node.range }
          : null;
  const { ref, rect, grip, reset } = usePanelRect();
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
      style={
        rect === null
          ? undefined
          : ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height, "--summary-min": `${MIN_SUMMARY}px`, "--code-min": `${MIN_CODE}px` } as CSSProperties)
      }
    >
      {rect !== null && item !== null && index !== null && (
        <>
          <div className="info-panel-head" onPointerDown={grip("move")} onDoubleClick={restore} data-tip="끌어서 옮기고, 더블클릭하면 기본 위치와 크기로 돌아간다">
            <Header item={item} nodes={index.nodes} />
          </div>
          {rows.length > 0 && <Facts rows={rows} />}
          {file === null && groups !== null && (
            <Sites groups={groups} opened={site} open={(picked) => setShownAt({ selection, via, listed, site: picked === site ? null : picked })} />
          )}
          {item.type === "repo" && <Overview nodes={index.nodes} />}
          {summarized && <Summary node={node.id} split={code === null || !summaryOpen ? null : split} />}
          {summarized && summaryOpen && code !== null && (
            <div className="info-panel-divide" onPointerDown={part} onDoubleClick={() => setSplit(null)} data-tip="끌어서 요약 칸과 코드의 높이를 바꾸고, 더블클릭하면 기본 높이로 돌아간다" />
          )}
          {code !== null && <CodeView {...code} />}
        </>
      )}
      {DIRS.map((dir) => (
        <div key={dir} className="info-panel-resize" data-dir={dir} onPointerDown={grip(dir)} />
      ))}
    </div>
  );
}
