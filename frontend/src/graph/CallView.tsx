// 함수 시점 뷰. 가운데 함수와 그 함수를 호출하는 쪽·호출되는 쪽을 실행 선으로 이어 배치하고, 가운데 함수가 바뀌면 화면을 맞춘다.
import {
  getViewportForBounds,
  ReactFlow,
  useReactFlow,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { AtlasNode } from "../api/types";
import type { History } from "../state/history";
import { useAtlas } from "../state/store";
import { callEdges, callElk, callLabel, callSize, callTitle, callview, fileLabel, type Calls } from "./callview";
import { edgeTypes, Markers, type AtlasFlowEdge } from "./edges/OrthogonalEdge";
import { fromElk, measureText, runElk, type Layout } from "./layout";
import { Legend } from "./Legend";
import { play, reducedMotion, settled, tween } from "./motion";
import { CallNode, type CallFlowNode, type CallNodeData } from "./nodes/CallNode";
import { Tooltip, type TooltipHandle } from "./Tooltip";
import { GROUP_NAMES, KIND_NAMES } from "./names";
import { boundsOf, fitPadding, FRAME_ZOOM, PAN_MS, stageOf, ZOOM_MAX, ZOOM_MIN } from "./viewport";
import { hidden, nodeIndex } from "./visible";

const nodeTypes: NodeTypes = { call: CallNode };

const EDGE_Z = 0;
const NODE_Z = 1;

/** 배치 한 번과 그 배치를 만든 입력. 노드와 선은 늘 같은 Scene에서 만든다. */
interface Scene {
  calls: Calls;
  center: string;
  layout: Layout;
}

/** 노드마다 움직이는 동안 바뀌지 않는 값. data의 참조를 유지해 노드 본문을 다시 그리지 않게 한다. */
function itemsOf(scene: Scene, nodes: Map<string, AtlasNode>, selected: string | null): { id: string; data: CallNodeData }[] {
  return scene.calls.nodes.map((id) => {
    const node = nodes.get(id)!;
    return {
      id,
      data: {
        node,
        functions: 0,
        expanded: false,
        selected: id === selected,
        flow: false,
        local: false,
        inflow: null,
        label: callLabel(nodes, node),
        file: fileLabel(nodes, node),
        side: scene.calls.side.get(id)!,
        more: scene.calls.more.has(id),
      },
    };
  });
}

export function CallView({ center, expanded }: { center: string; expanded: string[] }) {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const selection = useAtlas((s) => s.selection);
  const select = useAtlas((s) => s.select);
  const selectEdge = useAtlas((s) => s.selectEdge);
  const open = useAtlas((s) => s.open);
  const expandFunction = useAtlas((s) => s.expandFunction);
  const { setViewport } = useReactFlow();
  const selected = selection?.type === "node" ? selection.id : null;

  const [scene, setScene] = useState<Scene | null>(null);
  const [nodes, setNodes] = useState<CallFlowNode[]>([]);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const root = useRef<HTMLDivElement | null>(null);
  const tip = useRef<TooltipHandle | null>(null);
  /** 지금 화면에 그린 배치. 움직임은 여기서 출발한다. */
  const onScreen = useRef<Layout | null>(null);
  /** 화면을 맞춰 둔 가운데 함수 */
  const framed = useRef<string | null>(null);
  /** 직전에 한 번 누른 노드와 누르기 전의 이력. 두 번째 클릭이 어디에 떨어져도 이 노드의 더블클릭으로 본다. */
  const clicked = useRef<{ id: string; from: History } | null>(null);

  const index = useMemo(() => (graph === null ? null : nodeIndex(graph)), [graph]);
  const calls = useMemo(
    () => (graph === null ? null : callview(graph, center, expanded, hidden(graph, { showTests, showExternal }))),
    [graph, center, expanded, showTests, showExternal],
  );

  useEffect(() => {
    if (calls === null || index === null) {
      return;
    }
    let stale = false;
    runElk(callElk(calls, (id) => callSize(calls, index, index.get(id)!, measureText)))
      .then((done) => !stale && setScene({ calls, center, layout: fromElk(done) }))
      .catch((caught: unknown) => !stale && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      stale = true;
    };
  }, [calls, index, center]);

  useEffect(() => {
    if (scene === null || index === null) {
      return;
    }
    const items = itemsOf(scene, index, selected);
    const to = scene.layout;
    const from = onScreen.current;
    const still = reducedMotion();
    const draw = (at: Layout, fresh: Set<string> | null) => {
      onScreen.current = at;
      setNodes(
        items.map((item) => ({
          ...item,
          type: "call",
          position: at.positions.get(item.id) ?? { x: 0, y: 0 },
          ...(at.sizes.get(item.id) ?? { width: 0, height: 0 }),
          zIndex: NODE_Z,
          draggable: false,
          connectable: false,
          style: { opacity: fresh?.has(item.id) === true ? 0 : 1 },
        })),
      );
    };

    if (scene.center !== framed.current && root.current !== null) {
      framed.current = scene.center;
      const stage = stageOf(root.current);
      const { width, height } = stage.area;
      void setViewport(
        getViewportForBounds(boundsOf(to.boxes.values()), width, height, ZOOM_MIN, FRAME_ZOOM, fitPadding(stage)),
        { duration: from === null || still ? 0 : PAN_MS },
      );
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
  }, [scene, index, selected, setViewport]);

  const edges = useMemo((): AtlasFlowEdge[] => {
    if (scene === null) {
      return [];
    }
    return callEdges(scene.calls, scene.center, scene.layout).map((view) => ({
      id: view.key,
      source: view.source,
      target: view.target,
      type: "orthogonal",
      data: view,
      zIndex: EDGE_Z,
    }));
  }, [scene]);

  /**
   * 연달아 누른 두 번째 클릭이면 처음 누른 함수·메서드를 가운데로 옮기고 참을 돌려준다. 가운데 함수면 첫 클릭 전으로
   * 되돌리기만 한다. 세 번째부터는 아무 일도 하지 않는다.
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

  const onNodeClick: NodeMouseHandler<CallFlowNode> = (event, node) => {
    tip.current?.hide();
    if ((event.target as Element).closest(".call-more") !== null) {
      clicked.current = null;
      expandFunction(node.id);
      return;
    }
    if (repeated(event)) {
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

  const onNodeEnter: NodeMouseHandler<CallFlowNode> = (event, node) => {
    const title = index === null ? node.data.label : callTitle(index, node.data.node);
    tip.current?.show(`${title} · ${KIND_NAMES[node.data.node.kind]}`, event.clientX, event.clientY);
  };
  const onEdgeEnter: EdgeMouseHandler<AtlasFlowEdge> = (event, edge) => {
    const name = (id: string) => {
      const node = index?.get(id);
      return node === undefined || index === null ? id : callTitle(index, node);
    };
    if (edge.data !== undefined) {
      const { source, target, group, sites } = edge.data;
      tip.current?.show(`${name(source)} → ${name(target)} · ${GROUP_NAMES[group]} · ${sites}곳`, event.clientX, event.clientY);
    }
  };
  const onMove = (event: ReactMouseEvent) => tip.current?.move(event.clientX, event.clientY);
  const onLeave = () => tip.current?.hide();

  if (scene === null) {
    return (
      <div className="graph">
        <div className="graph-empty">{error ?? (graph === null ? "불러오는 중" : "배치하는 중")}</div>
      </div>
    );
  }

  return (
    <div className="graph" ref={root} data-moving={moving ? "" : undefined}>
      <Markers />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeEnter}
        onNodeMouseMove={onMove}
        onNodeMouseLeave={onLeave}
        onEdgeClick={onEdgeClick}
        onEdgeMouseEnter={onEdgeEnter}
        onEdgeMouseMove={onMove}
        onEdgeMouseLeave={onLeave}
        onPaneClick={onPaneClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        zIndexMode="manual"
        minZoom={ZOOM_MIN}
        maxZoom={ZOOM_MAX}
        proOptions={{ hideAttribution: true }}
      />
      <Legend />
      <Tooltip ref={tip} />
    </div>
  );
}
