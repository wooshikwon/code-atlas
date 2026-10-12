// 함수 시점 뷰. 가운데 함수와 그 함수를 호출하는 쪽·호출되는 쪽을 실행 선으로 이어 배치하고, 가운데 함수가 바뀌면 화면을 맞춘다.
import {
  getViewportForBounds,
  ReactFlow,
  type NodeMouseHandler,
  type NodeTypes,
  type OnMoveStart,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { AtlasNode } from "../api/types";
import { useNodeMenu } from "../nav/NodeMenu";
import type { History } from "../state/history";
import { useOverlay } from "../state/overlay";
import { useAtlas } from "../state/store";
import { makingKey, makingOf, useSummaries } from "../state/summaries";
import { useAim } from "./aim";
import { Arranging, watchLayout } from "./arranging";
import { callEdges, callElk, callLabel, callLane, callSize, callTitle, callview, fileLabel, type Calls } from "./calls";
import { edgeTypes, Markers, useFlowEdges } from "./edges/OrthogonalEdge";
import { useFlight, useFlying } from "./flight";
import { fromElk, measureText, runElk, type Box, type Layout } from "./layout";
import { Dock } from "./Dock";
import { play, reducedMotion, settled, tween } from "./motion";
import { CallNode, type CallFlowNode, type CallNodeData } from "./nodes/CallNode";
import { flowNodes, parts, pointing, type Drawn } from "./nodes/common";
import { UNUSED_OPACITY } from "./overlay";
import { baseOf, definedName, rowsOf, type CellName, type LineRow } from "./rows";
import { nodeTip, tipOf, valueTip } from "./tips";
import { NO_LINES } from "./view";
import { tooltip } from "./Tooltip";
import type { EdgeKey } from "./scope";
import { boundsOf, fitPadding, FRAME_ZOOM, stageOf, ZOOM_MAX, ZOOM_MIN } from "./viewport";
import { hidden, nodeIndex, writtenBy } from "./visible";

const nodeTypes: NodeTypes = { call: CallNode };
/** 함수 시점 뷰는 파일 사이의 import 선을 그리지 않으므로 순환 선이 없다. */
const NO_CYCLES = new Set<EdgeKey>();
const NO_BOXES = new Map<string, Box>();

/** 배치 한 번과 그 배치를 만든 입력. 노드와 선은 늘 같은 Scene에서 만든다. */
interface Scene {
  calls: Calls;
  center: string;
  layout: Layout;
}

/** 노드마다 움직이는 동안 바뀌지 않는 값. data의 참조를 유지해 노드 본문을 다시 그리지 않게 한다. unused는 미사용 후보 표시가 표시할 후보다. */
function itemsOf(
  scene: Scene,
  nodes: Map<string, AtlasNode>,
  selected: string | null,
  making: string[],
  unused: Set<string>,
  writes: Map<string, string[]>,
): Drawn<CallNodeData>[] {
  return scene.calls.nodes.map((id) => {
    const node = nodes.get(id)!;
    const data = parts({
      node,
      functions: 0,
      expanded: false,
      selected: id === selected,
      flow: false,
      local: false,
      inside: 0,
      writes: writes.get(id) ?? [],
      busy: making.includes(id) ? 1 : 0,
      cycle: null,
      unused: unused.has(id),
      candidates: 0,
      route: null,
      label: callLabel(nodes, node),
      file: fileLabel(nodes, node),
      side: scene.calls.side.get(id)!,
      more: scene.calls.more.has(id),
    });
    return { id, type: "call", opacity: unused.has(id) ? UNUSED_OPACITY : 1, ...data };
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
  const making = useSummaries(makingKey);
  const overlay = useOverlay((s) => s.kind);
  const candidates = useOverlay((s) => s.unused);
  const { fly, jump, halt } = useFlight();
  const flying = useFlying((s) => s.on);
  const selected = selection?.type === "node" ? selection.id : null;

  const [scene, setScene] = useState<Scene | null>(null);
  const [nodes, setNodes] = useState<CallFlowNode[]>([]);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 마우스를 올린 노드 id */
  const [aimedNode, setAimedNode] = useState<string | null>(null);

  const root = useRef<HTMLDivElement | null>(null);
  /** 지금 화면에 그린 배치. 움직임은 여기서 출발한다. */
  const onScreen = useRef<Layout | null>(null);
  /** 화면을 맞춰 둔 가운데 함수 */
  const framed = useRef<string | null>(null);
  /** 직전에 한 번 누른 노드와 누르기 전의 이력. 두 번째 클릭이 어디에 떨어져도 이 노드의 더블클릭으로 본다. */
  const clicked = useRef<{ id: string; from: History } | null>(null);

  const index = useMemo(() => (graph === null ? null : nodeIndex(graph)), [graph]);
  const writes = useMemo(() => (graph === null ? new Map<string, string[]>() : writtenBy(graph)), [graph]);
  const unused = useMemo(() => (overlay === "unused" ? candidates : new Set<string>()), [overlay, candidates]);
  const calls = useMemo(
    () => (graph === null ? null : callview(graph, center, expanded, hidden(graph, { showTests, showExternal }))),
    [graph, center, expanded, showTests, showExternal],
  );

  useEffect(() => {
    if (calls === null || index === null) {
      return;
    }
    return watchLayout(
      runElk(callElk(calls, (id) => callSize(calls, index, index.get(id)!, measureText))),
      (done) => setScene({ calls, center, layout: fromElk(done, callLane(calls)) }),
      setError,
    );
  }, [calls, index, center]);

  useEffect(() => {
    if (scene === null || index === null) {
      return;
    }
    const items = itemsOf(scene, index, selected, makingOf(making), unused, writes);
    const to = scene.layout;
    const from = onScreen.current;
    const still = reducedMotion();
    const draw = (at: Layout, fresh: Set<string> | null) => {
      onScreen.current = at;
      setNodes(flowNodes(items, at.boxes, fresh));
    };

    if (scene.center !== framed.current && root.current !== null) {
      framed.current = scene.center;
      const stage = stageOf(root.current);
      const { width, height } = stage.area;
      const view = getViewportForBounds(boundsOf(to.boxes.values()), width, height, ZOOM_MIN, FRAME_ZOOM, fitPadding(stage.area, stage.free));
      if (from === null) {
        jump(view);
      } else {
        fly(view, stage.free);
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
  }, [scene, index, selected, making, unused, fly, jump]);
  useEffect(() => halt, [halt]);

  const lines = useMemo(() => (scene === null ? NO_LINES : callEdges(scene.calls, scene.center, scene.layout)), [scene]);
  const cellName = (row: LineRow, id: string): CellName => {
    const node = index?.get(id);
    return node === undefined || index === null ? { path: "", name: id, full: id } : definedName(index, baseOf(index, null, row, id), node);
  };
  /**
   * 선의 hover와 클릭(`aim.tsx`). 선을 누르면 말풍선이 고정되고, 그 줄의 이름을 누르면 그 노드를 고른다. 이미 고른 노드면 그대로 둔다.
   * 관계를 누르거나 Shift를 누른 채 선을 누르면 그 선의 코드 줄 목록을 연다. 모든 노드가 함수이므로 줄은 그린 양 끝이다.
   */
  const aim = useAim({
    lines,
    boxes: scene?.layout.boxes ?? NO_BOXES,
    name: cellName,
    rows: (view) => (index === null ? [] : rowsOf(index, null, { ...view, edges: [] })),
    only: null,
    skip: (event) => {
      const again = repeated(event);
      clicked.current = null;
      return again;
    },
    go: (to) => {
      if (to !== selected) {
        select(to);
      }
    },
    open: selectEdge,
  });
  const edges = useFlowEdges(lines, aim.pointed, NO_CYCLES);

  const drawnNodes = useMemo(() => pointing(nodes, aimedNode), [nodes, aimedNode]);

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
    tooltip.hide();
    if ((event.target as Element).closest(".call-more") !== null) {
      clicked.current = null;
      expandFunction(node.data.node.id);
      return;
    }
    if (repeated(event)) {
      return;
    }
    clicked.current = { id: node.data.node.id, from: useAtlas.getState().history };
    select(node.data.node.id);
  };
  /** 노드를 우클릭하면 그 노드의 메뉴를 연다. 선택과 화면은 그대로 둔다. */
  const onNodeContextMenu: NodeMouseHandler<CallFlowNode> = (event, node) => {
    if (useNodeMenu.getState().show(node.data.node.id, event.clientX, event.clientY, false)) {
      event.preventDefault();
      tooltip.hide();
    }
  };
  const onPaneClick = (event: ReactMouseEvent) => {
    tooltip.hide();
    if (repeated(event)) {
      return;
    }
    clicked.current = null;
  };
  /**
   * 마우스 아래가 배지나 표시면 그 뜻을, 아니면 노드의 말풍선(`nodeTip`)을 띄운다. 올린 노드는 선의 hover처럼 진하기를 한 단계 올려 그린다.
   * 마우스 버튼을 누른 동안(화면을 끄는 동안)에는 아무것도 하지 않는다.
   */
  const onNodeOver: NodeMouseHandler<CallFlowNode> = (event, node) => {
    if (event.buttons !== 0) {
      return;
    }
    setAimedNode(node.data.node.id);
    const { id } = node.data.node;
    const title = index === null ? node.data.label : callTitle(index, node.data.node);
    const lead = node.data.node.kind === "variable" ? valueTip(node.data.node) : (useSummaries.getState().leads[id] ?? null);
    const text = tipOf(event.target) ?? nodeTip(node.data.label === title ? null : title, lead, node.data.unused);
    tooltip.show(text, event.clientX, event.clientY);
  };
  const onLeave = () => {
    setAimedNode(null);
    tooltip.hide();
  };
  /** 사용자가 화면을 끌거나 확대·축소하기 시작하면 그리는 중인 화면 이동을 멈춘다. 코드가 옮긴 화면은 event가 null이다. */
  const grabbed: OnMoveStart = (event) => {
    if (event !== null) {
      halt();
    }
  };
  if (scene === null) {
    return (
      <div className="graph">
        <div className="graph-empty">{error ?? (graph === null ? "불러오는 중" : "배치하는 중")}</div>
      </div>
    );
  }

  return (
    <div
      className="graph"
      ref={root}
      data-moving={moving ? "" : undefined}
      data-flying={flying ? "" : undefined}
      data-overlay={overlay ?? undefined}
    >
      <Markers />
      <ReactFlow
        nodes={drawnNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onNodeMouseEnter={onNodeOver}
        onNodeMouseMove={onNodeOver}
        onNodeMouseLeave={onLeave}
        onEdgeClick={aim.onEdgeClick}
        onEdgeMouseEnter={aim.onEdgeEnter}
        onEdgeMouseMove={aim.onEdgeMove}
        onEdgeMouseLeave={aim.onEdgeLeave}
        onPaneClick={onPaneClick}
        onMoveStart={grabbed}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        zIndexMode="manual"
        minZoom={ZOOM_MIN}
        maxZoom={ZOOM_MAX}
        proOptions={{ hideAttribution: true }}
      />
      <Dock />
      <Arranging />
      {aim.bubble}
    </div>
  );
}
