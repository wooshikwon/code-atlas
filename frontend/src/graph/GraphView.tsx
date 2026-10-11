// 관계 그래프. 저장소의 뷰 종류에 따라 구조 뷰나 함수 시점 뷰를 그린다. 구조 뷰는 저장소 상태에서 보이는 노드와
// 그릴 선을 정해 배치를 부르고, 배치가 바뀌면 노드를 움직이며 고른 노드로 화면을 옮긴다.
import {
  getViewportForBounds,
  ReactFlow,
  useReactFlow,
  useStore,
  ViewportPortal,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { AtlasNode, Graph } from "../api/types";
import { useOpened } from "../panel/opened";
import { focusOf, type History } from "../state/history";
import { useAtlas } from "../state/store";
import { makingKey, makingOf, useSummaries } from "../state/summaries";
import { CallView } from "./CallView";
import { columns, type Columns } from "./columns";
import { edgeTypes, flowEdges, Markers, type AtlasFlowEdge } from "./edges/OrthogonalEdge";
import { flow, opacities, type Flow } from "./flow";
import { functionCounts, layout, titleOf, type Layout, type Point } from "./layout";
import { Dock } from "./Dock";
import { play, reducedMotion, settled, tween } from "./motion";
import { GROUP_NAMES, KIND_NAMES } from "./names";
import { LAYER } from "./layers";
import { flowNodes, parts, type AtlasFlowNode, type AtlasNodeData, type Drawn } from "./nodes/common";
import { nodeType, nodeTypes } from "./nodes";
import { concealed, drawn, type EdgeKey } from "./scope";
import { Tooltip, type TooltipHandle } from "./Tooltip";
import { edgeViews, parentFirst } from "./view";
import { boundsOf, centerOn, fitPadding, NAMED_ZOOM, PAN_MS, stageOf, ZOOM_MAX, ZOOM_MIN } from "./viewport";
import { hidden, lift, local, nodeIndex, shown, unresolvedWithin, type Shown } from "./visible";

const SHELF_NAME = "연결 없음";
const SHELF_NAME_HEIGHT = 22;

/** 배치 한 번과 그 배치를 만든 입력. 노드와 선은 늘 같은 Scene에서 만든다. */
interface Scene {
  graph: Graph;
  columns: Columns;
  shown: Shown;
  flow: Flow | null;
  /** 초점을 둔 노드 */
  focus: string | null;
  layout: Layout;
}

function itemsOf(scene: Scene, nodes: Map<string, AtlasNode>, functions: Map<string, number>, making: string[]): Drawn<AtlasNodeData>[] {
  const order = parentFirst(scene.graph, scene.shown.nodes);
  const parents = new Set(order.map((n) => n.parent));
  const dim = opacities(scene.graph, scene.flow);
  const marks = concealed(scene.graph, scene.shown, scene.flow);
  const unresolved = unresolvedWithin(scene.graph, scene.shown.hidden);
  /** 요약을 만드는 중인 노드를 화면에 보이는 가장 가까운 조상으로 올린 노드 */
  const busy = new Set(making.map((id) => lift(nodes, scene.shown, id)));
  return order.map((node) => {
    const opacity = dim.get(node.id) ?? 1;
    const expanded = parents.has(node.id);
    const { body, face } = parts({
      node,
      functions: functions.get(node.id) ?? 0,
      expanded,
      selected: node.id === scene.focus,
      flow: scene.flow !== null && opacity > 0.2,
      local: scene.flow !== null && node.id !== scene.flow.file && local(nodes, scene.flow, node.id),
      inflow: marks.get(node.id) ?? null,
      unresolved: node.kind !== "module" && node.kind !== "package" ? node.unresolved : expanded ? 0 : (unresolved.get(node.id) ?? 0),
      busy: busy.has(node.id),
    });
    return { id: node.id, type: nodeType(node.kind), opacity, body, face };
  });
}

/** 선반 단위 가운데 가장 왼쪽 위 상자의 왼쪽 위. 선반이 비었으면 null이다. */
function shelfCorner(scene: Scene, at: Layout): Point | null {
  const boxes = scene.columns.shelf.map((id) => at.boxes.get(id)).filter((box) => box !== undefined);
  if (boxes.length === 0) {
    return null;
  }
  return { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)) };
}

export function GraphView() {
  const view = useAtlas((s) => s.view);
  /** 구조 뷰의 화면 위치와 확대 비율. 레포를 열어 화면을 맞추기 전에는 null이다. */
  const home = useRef<Viewport | null>(null);
  return view.kind === "function" ? (
    <CallView center={view.center} expanded={view.expanded} />
  ) : (
    <StructureView home={home} />
  );
}

function StructureView({ home }: { home: RefObject<Viewport | null> }) {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const selection = useAtlas((s) => s.selection);
  const depth = useAtlas((s) => s.depth);
  const collapsed = useAtlas((s) => s.collapsed);
  const select = useAtlas((s) => s.select);
  const selectEdge = useAtlas((s) => s.selectEdge);
  const toggleFolder = useAtlas((s) => s.toggleFolder);
  const open = useAtlas((s) => s.open);
  const making = useSummaries(makingKey);
  const { getViewport, setViewport } = useReactFlow();
  /** 확대 비율 구간. 구간이 바뀔 때만 다시 그린다. */
  const zoom = useStore((s) => (s.transform[2] < 0.4 ? 0 : s.transform[2] < NAMED_ZOOM ? 1 : 2));

  const [scene, setScene] = useState<Scene | null>(null);
  const [nodes, setNodes] = useState<AtlasFlowNode[]>([]);
  const [shelf, setShelf] = useState<Point | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 마우스를 올린 노드 id */
  const [hover, setHover] = useState<string | null>(null);
  /** 마우스를 올린 선 */
  const [pointed, setPointed] = useState<EdgeKey | null>(null);

  /** 이 컴포넌트를 그리기 시작할 때의 화면 */
  const [start] = useState(() => home.current ?? undefined);
  const root = useRef<HTMLDivElement | null>(null);
  const tip = useRef<TooltipHandle | null>(null);
  /** 지금 화면에 그린 배치. 움직임은 여기서 출발한다. */
  const onScreen = useRef<Layout | null>(null);
  /** 화면을 옮겨 둔 노드 */
  const panned = useRef<string | null>(null);
  /** 직전에 한 번 누른 노드와 누르기 전의 이력. 두 번째 클릭이 어디에 떨어져도 이 노드의 더블클릭으로 본다. */
  const clicked = useRef<{ id: string; from: History } | null>(null);
  /** 초점을 둔 노드. 선을 골라도 직전에 고른 노드의 초점을 유지한다. */
  const focus = focusOf(selection);

  const index = useMemo(
    () => (graph === null ? null : { nodes: nodeIndex(graph), functions: functionCounts(graph) }),
    [graph],
  );
  const cols = useMemo(
    () => (graph === null ? null : columns(graph, { showTests, showExternal })),
    [graph, showTests, showExternal],
  );
  const target = useMemo(() => {
    if (graph === null || index === null) {
      return null;
    }
    const toggles = { showTests, showExternal };
    const off = hidden(graph, toggles);
    const picked = focus !== null && index.nodes.has(focus) && !off.has(focus) ? flow(graph, focus, depth, off) : null;
    return { flow: picked, focus: picked === null ? null : focus, shown: shown(graph, { ...toggles, collapsed, flow: picked }) };
  }, [graph, index, showTests, showExternal, collapsed, focus, depth]);

  useEffect(() => {
    if (graph === null || cols === null || target === null) {
      return;
    }
    let stale = false;
    layout(graph, target.shown, cols)
      .then((result) => !stale && setScene({ graph, columns: cols, ...target, layout: result }))
      .catch((caught: unknown) => !stale && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      stale = true;
    };
  }, [graph, cols, target]);

  // 레포를 열면 정보 패널이 가리지 않는 영역에 그래프 전체를 맞춘다. 함수 시점 뷰에서 돌아오면 떠날 때의 화면에서 시작한다.
  useEffect(() => {
    if (scene === null || home.current !== null || root.current === null) {
      return;
    }
    const stage = stageOf(root.current);
    const { width, height } = stage.area;
    const bounds = boundsOf(scene.layout.boxes.values());
    home.current = getViewportForBounds(bounds, width, height, ZOOM_MIN, ZOOM_MAX, fitPadding(stage));
    void setViewport(home.current);
  }, [scene, home, setViewport]);
  useEffect(
    () => () => {
      if (home.current !== null) {
        home.current = getViewport();
      }
    },
    [home, getViewport],
  );

  useEffect(() => {
    if (scene === null || index === null) {
      return;
    }
    const items = itemsOf(scene, index.nodes, index.functions, makingOf(making));
    const to = scene.layout;
    const from = onScreen.current;
    const still = reducedMotion();
    const draw = (at: Layout, fresh: Set<string> | null) => {
      onScreen.current = at;
      setNodes(flowNodes(items, at.boxes, fresh));
      setShelf(shelfCorner(scene, at));
    };

    if (scene.focus !== panned.current) {
      panned.current = scene.focus;
      const box = scene.focus === null ? undefined : to.boxes.get(scene.focus);
      if (box !== undefined && root.current !== null) {
        const scale = Math.max(getViewport().zoom, NAMED_ZOOM);
        const view = { ...centerOn(box, stageOf(root.current).free, scale), zoom: scale };
        void setViewport(view, { duration: still ? 0 : PAN_MS });
      }
    }

    if (from === null || still || settled(from, to)) {
      draw(to, null);
      setMoving(false);
      return;
    }
    const fresh = new Set(items.filter((item) => !from.boxes.has(item.id)).map((item) => item.id));
    draw(tween(from, to, 0), fresh);
    setMoving(true);
    return play(
      from,
      to,
      (at) => draw(at, null),
      () => setMoving(false),
    );
  }, [scene, index, making, getViewport, setViewport]);

  const hovered = hover !== null && scene?.shown.nodes.has(hover) === true ? hover : null;
  const views = useMemo(
    () => (scene === null || index === null ? [] : edgeViews(drawn(scene.graph, scene.shown, scene.flow, hovered), scene.layout, index.nodes)),
    [scene, index, hovered],
  );
  const edges = useMemo(() => flowEdges(views, pointed), [views, pointed]);

  /**
   * 연달아 누른 두 번째 클릭이면 처음 누른 노드를 열고 참을 돌려준다. 함수·메서드 노드는 함수 시점 뷰로 들어간다.
   * 세 번째부터는 아무 일도 하지 않는다.
   */
  const repeated = (event: ReactMouseEvent): boolean => {
    if (event.detail < 2) {
      return false;
    }
    if (event.detail === 2 && clicked.current !== null) {
      open(clicked.current.id, clicked.current.from);
    }
    return true;
  };

  /**
   * 노드를 누른 동작. 접힌 폴더 상자는 한 단계 펼치고 펼친 폴더 영역의 머리 줄은 그 폴더를 접는다. 그 밖의 노드는 고른다.
   */
  const press = (id: string) => {
    if (index?.nodes.get(id)?.kind === "package") {
      clicked.current = null;
      toggleFolder(id);
      return;
    }
    clicked.current = { id, from: useAtlas.getState().history };
    select(id);
  };

  const onNodeClick: NodeMouseHandler<AtlasFlowNode> = (event, node) => {
    tip.current?.hide();
    if (repeated(event)) {
      return;
    }
    const opened = node.data.expanded && node.data.node.kind === "module";
    if (opened && (event.target as Element).closest(".node-module-head") === null) {
      clicked.current = null;
      return;
    }
    press(node.data.node.id);
  };
  const onPaneClick = (event: ReactMouseEvent) => {
    tip.current?.hide();
    if (repeated(event)) {
      return;
    }
    clicked.current = null;
    if (useOpened.getState().path !== null) {
      useOpened.getState().close();
    } else {
      select(null);
    }
  };
  /** 선을 누르면 도착 노드를 고른다. 이미 고른 노드면 그대로 둔다. Shift를 누른 채면 선을 골라 정보 패널에 지점 목록을 연다. */
  const onEdgeClick: EdgeMouseHandler<AtlasFlowEdge> = (event, edge) => {
    tip.current?.hide();
    setPointed(null);
    if (repeated(event)) {
      return;
    }
    clicked.current = null;
    if (event.shiftKey) {
      selectEdge(edge.id);
    } else if (edge.data !== undefined && !(selection?.type === "node" && selection.id === edge.data.target)) {
      press(edge.data.target);
      clicked.current = null;
    }
  };

  const onNodeEnter: NodeMouseHandler<AtlasFlowNode> = (event, node) => {
    setHover(node.data.node.id);
    tip.current?.show(`${titleOf(node.data.node)} · ${KIND_NAMES[node.data.node.kind]}`, event.clientX, event.clientY);
  };
  const onEdgeEnter: EdgeMouseHandler<AtlasFlowEdge> = (event, edge) => {
    setPointed(edge.id);
    const name = (id: string) => {
      const node = index?.nodes.get(id);
      return node === undefined ? id : titleOf(node);
    };
    if (edge.data !== undefined) {
      const { source, target, group, sites } = edge.data;
      tip.current?.show(`${name(source)} → ${name(target)} · ${GROUP_NAMES[group]} · ${sites}곳`, event.clientX, event.clientY);
    }
  };
  const onMove = (event: ReactMouseEvent) => tip.current?.move(event.clientX, event.clientY);
  const onNodeLeave = () => {
    setHover(null);
    tip.current?.hide();
  };
  const onEdgeLeave = () => {
    setPointed(null);
    tip.current?.hide();
  };

  if (scene === null) {
    return (
      <div className="graph">
        <div className="graph-empty">{error ?? (graph === null ? "불러오는 중" : "배치하는 중")}</div>
      </div>
    );
  }

  return (
    <div className="graph" ref={root} data-zoom={zoom} data-moving={moving ? "" : undefined}>
      <Markers />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeEnter}
        onNodeMouseMove={onMove}
        onNodeMouseLeave={onNodeLeave}
        onEdgeClick={onEdgeClick}
        onEdgeMouseEnter={onEdgeEnter}
        onEdgeMouseMove={onMove}
        onEdgeMouseLeave={onEdgeLeave}
        onPaneClick={onPaneClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        zIndexMode="manual"
        defaultViewport={start}
        minZoom={ZOOM_MIN}
        maxZoom={ZOOM_MAX}
        proOptions={{ hideAttribution: true }}
      >
        {shelf !== null && (
          <ViewportPortal>
            <span
              className="shelf-name"
              style={{ zIndex: LAYER.text, transform: `translate(${shelf.x}px, ${shelf.y - SHELF_NAME_HEIGHT}px)` }}
            >
              {SHELF_NAME}
            </span>
          </ViewportPortal>
        )}
      </ReactFlow>
      <Dock />
      <Tooltip ref={tip} />
    </div>
  );
}
