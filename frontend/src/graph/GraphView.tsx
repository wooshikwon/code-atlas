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
import { focusOf, type History } from "../state/history";
import { useAtlas } from "../state/store";
import { CallView } from "./CallView";
import { columns, type Columns } from "./columns";
import { edgeTypes, Markers, type AtlasFlowEdge } from "./edges/OrthogonalEdge";
import { flow, opacities, type Flow } from "./flow";
import { functionCounts, layout, titleOf, type Layout, type Point } from "./layout";
import { Legend } from "./Legend";
import { play, reducedMotion, settled, tween } from "./motion";
import { GROUP_NAMES, KIND_NAMES } from "./names";
import type { AtlasFlowNode, AtlasNodeData } from "./nodes/common";
import { nodeType, nodeTypes } from "./nodes";
import { concealed, drawn } from "./scope";
import { Tooltip, type TooltipHandle } from "./Tooltip";
import { edgeViews, parentFirst } from "./view";
import { boundsOf, centerOn, fitPadding, NAMED_ZOOM, PAN_MS, stageOf, ZOOM_MAX, ZOOM_MIN } from "./viewport";
import { hidden, local, nodeIndex, shown, type Shown } from "./visible";

/** 선은 자식을 그리는 상자(깊이만큼 0부터)보다 위에, 그 밖의 노드보다 아래에 놓는다. */
const EDGE_Z = 50;
const LEAF_Z = 100;
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

/** 노드마다 움직이는 동안 바뀌지 않는 값. data의 참조를 유지해 노드 본문을 다시 그리지 않게 한다. */
interface Item {
  id: string;
  type: string;
  parent: string | undefined;
  opacity: number;
  /** 자식을 그리는 상자는 선 아래에, 그 밖의 노드는 선 위에 그린다. */
  z: number;
  /** 펼친 폴더는 상자를 그리지 않으므로 마우스를 받지 않는다. */
  inert: boolean;
  data: AtlasNodeData;
}

function itemsOf(scene: Scene, nodes: Map<string, AtlasNode>, functions: Map<string, number>): Item[] {
  const order = parentFirst(scene.graph, scene.shown.nodes);
  const parents = new Set(order.map((n) => n.parent));
  const dim = opacities(scene.graph, scene.flow);
  const marks = concealed(scene.graph, scene.shown, scene.flow);
  const depths = new Map<string, number>();
  return order.map((node) => {
    const opacity = dim.get(node.id) ?? 1;
    const expanded = parents.has(node.id);
    const parent = node.parent !== null && scene.shown.nodes.has(node.parent) ? node.parent : undefined;
    const depth = parent === undefined ? 0 : depths.get(parent)! + 1;
    depths.set(node.id, depth);
    return {
      id: node.id,
      type: nodeType(node.kind),
      parent,
      opacity,
      z: expanded ? depth : LEAF_Z,
      inert: expanded && node.kind === "package",
      data: {
        node,
        functions: functions.get(node.id) ?? 0,
        expanded,
        selected: node.id === scene.focus,
        flow: scene.flow !== null && opacity > 0.2,
        local: scene.flow !== null && node.id !== scene.flow.file && local(nodes, scene.flow, node.id),
        inflow: marks.get(node.id) ?? null,
      },
    };
  });
}

/** 배치 at의 좌표로 React Flow 노드를 만든다. fresh에 든 노드는 불투명도 0으로 그린다. */
function flowNodes(items: Item[], at: Layout, fresh: Set<string> | null): AtlasFlowNode[] {
  return items.map((item) => {
    const size = at.sizes.get(item.id) ?? { width: 0, height: 0 };
    return {
      id: item.id,
      type: item.type,
      parentId: item.parent,
      position: at.positions.get(item.id) ?? { x: 0, y: 0 },
      width: size.width,
      height: size.height,
      zIndex: item.z,
      draggable: false,
      connectable: false,
      style: {
        opacity: fresh?.has(item.id) === true ? 0 : item.opacity,
        pointerEvents: item.inert ? "none" : undefined,
      },
      data: item.data,
    };
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
  const open = useAtlas((s) => s.open);
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
    const items = itemsOf(scene, index.nodes, index.functions);
    const to = scene.layout;
    const from = onScreen.current;
    const still = reducedMotion();
    const draw = (at: Layout, fresh: Set<string> | null) => {
      onScreen.current = at;
      setNodes(flowNodes(items, at, fresh));
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
  }, [scene, index, getViewport, setViewport]);

  const hovered = hover !== null && scene?.shown.nodes.has(hover) === true ? hover : null;
  const edges = useMemo((): AtlasFlowEdge[] => {
    if (scene === null || index === null) {
      return [];
    }
    return edgeViews(drawn(scene.graph, scene.shown, scene.flow, hovered), scene.layout, index.nodes).map((view) => ({
      id: view.key,
      source: view.source,
      target: view.target,
      type: "orthogonal",
      data: view,
      zIndex: EDGE_Z,
    }));
  }, [scene, index, hovered]);

  /**
   * 연달아 누른 두 번째 클릭이면 처음 누른 노드를 열고 참을 돌려준다. 접힌 폴더 상자는 펼쳐지고 함수·메서드 노드는
   * 함수 시점 뷰로 들어간다. 세 번째부터는 아무 일도 하지 않는다.
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
    clicked.current = { id: node.id, from: useAtlas.getState().history };
    select(node.id);
  };
  const onPaneClick = (event: ReactMouseEvent) => {
    tip.current?.hide();
    if (repeated(event)) {
      return;
    }
    clicked.current = null;
    select(null);
  };
  const onEdgeClick: EdgeMouseHandler<AtlasFlowEdge> = (_, edge) => selectEdge(edge.id);

  const onNodeEnter: NodeMouseHandler<AtlasFlowNode> = (event, node) => {
    setHover(node.id);
    tip.current?.show(`${titleOf(node.data.node)} · ${KIND_NAMES[node.data.node.kind]}`, event.clientX, event.clientY);
  };
  const onEdgeEnter: EdgeMouseHandler<AtlasFlowEdge> = (event, edge) => {
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
  const onEdgeLeave = () => tip.current?.hide();

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
              style={{ transform: `translate(${shelf.x}px, ${shelf.y - SHELF_NAME_HEIGHT}px)` }}
            >
              {SHELF_NAME}
            </span>
          </ViewportPortal>
        )}
      </ReactFlow>
      <Legend />
      <Tooltip ref={tip} />
    </div>
  );
}
