// 구조 뷰. 배치는 그래프와 테스트 코드 토글이 바뀔 때만 다시 계산하고, 고르기·마우스 올리기는 선과 불투명도만 바꾼다.
import { ReactFlow, useReactFlow, type EdgeMouseHandler, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtlas } from "../state/store";
import { edgeTypes, Markers, type AtlasFlowEdge } from "./edges/OrthogonalEdge";
import { focus, OPACITY, seedsOf } from "./focus";
import { InfoBox, type InfoItem } from "./InfoBox";
import { functionCounts, layout, type Layout } from "./layout";
import { Legend } from "./Legend";
import type { AtlasFlowNode } from "./nodes/common";
import { nodeType, nodeTypes } from "./nodes";
import { nodeIndex, scope, visibleNodes } from "./scope";
import { degrees, edgeIndex, edgeViews, parentFirst } from "./view";

/** 왼쪽 아래 범례가 노드를 가리지 않도록 왼쪽에 범례 폭만큼 여백을 둔다. */
export const FIT_PADDING = { top: "16px", right: "16px", bottom: "16px", left: "300px" } as const;

interface Laid {
  layout: Layout;
  visible: Set<string>;
}

export function GraphView() {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const selection = useAtlas((s) => s.selection);
  const depth = useAtlas((s) => s.depth);
  const select = useAtlas((s) => s.select);
  const selectEdge = useAtlas((s) => s.selectEdge);
  const { fitView } = useReactFlow();
  const [laid, setLaid] = useState<Laid | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 마우스를 올린 노드 id 또는 edge_key */
  const [hovered, setHovered] = useState<string | null>(null);
  const selected = selection?.type === "node" ? selection.id : null;
  const pinned = selection?.type === "edge" ? selection.key : null;

  useEffect(() => {
    if (graph === null) {
      return;
    }
    let cancelled = false;
    const visible = visibleNodes(graph, showTests);
    layout(graph, visible)
      .then((result) => !cancelled && setLaid({ layout: result, visible }))
      .catch((caught: unknown) => !cancelled && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      cancelled = true;
    };
  }, [graph, showTests]);

  useEffect(() => {
    if (laid !== null) {
      requestAnimationFrame(() => void fitView({ padding: FIT_PADDING }));
    }
  }, [laid, fitView]);

  const derived = useMemo(() => {
    if (graph === null || laid === null) {
      return null;
    }
    return {
      nodes: nodeIndex(graph),
      order: parentFirst(graph, laid.visible),
      index: edgeIndex(graph, laid.visible),
      degrees: degrees(graph),
      functions: functionCounts(graph),
      parents: new Set(graph.nodes.filter((n) => laid.visible.has(n.id)).map((n) => n.parent)),
    };
  }, [graph, laid]);

  const focused = selected !== null && laid?.visible.has(selected) === true ? selected : null;
  const hoveredNode = hovered !== null && derived?.nodes.has(hovered) === true ? hovered : null;

  const levels = useMemo(
    () => (graph === null || laid === null || focused === null ? null : focus(graph, laid.visible, focused, depth)),
    [graph, laid, focused, depth],
  );
  const seeds = useMemo(() => (graph === null || focused === null ? null : seedsOf(graph, focused)), [graph, focused]);

  const nodes = useMemo((): AtlasFlowNode[] => {
    if (laid === null || derived === null) {
      return [];
    }
    return derived.order.map((node) => {
      const size = laid.layout.sizes.get(node.id) ?? { width: 0, height: 0 };
      const level = levels?.get(node.id) ?? null;
      return {
        id: node.id,
        type: nodeType(node.kind),
        parentId: node.parent !== null && laid.visible.has(node.parent) ? node.parent : undefined,
        position: laid.layout.positions.get(node.id) ?? { x: 0, y: 0 },
        width: size.width,
        height: size.height,
        draggable: false,
        connectable: false,
        style: { opacity: level === null ? 1 : OPACITY[level] },
        data: {
          node,
          functions: derived.functions.get(node.id) ?? 0,
          level,
          selected: node.id === focused,
          hovered: node.id === hoveredNode,
          expanded: derived.parents.has(node.id),
        },
      };
    });
  }, [laid, derived, levels, focused, hoveredNode]);

  const edges = useMemo((): AtlasFlowEdge[] => {
    if (graph === null || laid === null || derived === null) {
      return [];
    }
    const keys = scope(graph, laid.visible, focused, hoveredNode);
    return edgeViews(derived.index, laid.layout, keys, seeds, levels).map((view) => ({
      id: view.key,
      source: view.source,
      target: view.target,
      type: "orthogonal",
      data: view,
      interactionWidth: 12,
    }));
  }, [graph, laid, derived, focused, hoveredNode, seeds, levels]);

  const clear = useCallback(() => select(null), [select]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && clear();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clear]);

  const onNodeClick: NodeMouseHandler<AtlasFlowNode> = (_, node) => select(node.id);
  const onNodeEnter: NodeMouseHandler<AtlasFlowNode> = (_, node) => setHovered(node.id);
  const onEdgeEnter: EdgeMouseHandler<AtlasFlowEdge> = (_, edge) => setHovered(edge.id);
  const onEdgeClick: EdgeMouseHandler<AtlasFlowEdge> = (_, edge) => selectEdge(edge.id);
  const onLeave = () => setHovered(null);

  const info = useMemo((): { item: InfoItem; pinned: boolean } | null => {
    if (derived === null) {
      return null;
    }
    const node = (id: string | null) => (id === null ? undefined : derived.nodes.get(id));
    const edgeOf = (key: string | null) =>
      key !== null && (derived.index.raw.has(key) || derived.index.agg.has(key)) ? key : null;
    const hoveredNodeItem = node(hoveredNode);
    if (hoveredNodeItem !== undefined) {
      return { item: { type: "node", node: hoveredNodeItem }, pinned: false };
    }
    const hoveredEdge = edgeOf(hovered);
    if (hoveredEdge !== null) {
      return { item: { type: "edge", key: hoveredEdge }, pinned: hoveredEdge === pinned };
    }
    if (edgeOf(pinned) !== null) {
      return { item: { type: "edge", key: pinned! }, pinned: true };
    }
    const selected = node(focused);
    return selected === undefined ? null : { item: { type: "node", node: selected }, pinned: false };
  }, [derived, hovered, hoveredNode, pinned, focused]);

  if (graph === null || laid === null || derived === null) {
    return (
      <div className="graph">
        <div className="graph-empty">{error ?? (graph === null ? "불러오는 중" : "배치하는 중")}</div>
      </div>
    );
  }

  return (
    <div className="graph">
      <Markers />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeEnter}
        onNodeMouseLeave={onLeave}
        onEdgeClick={onEdgeClick}
        onEdgeMouseEnter={onEdgeEnter}
        onEdgeMouseLeave={onLeave}
        onPaneClick={clear}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.05}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
      />
      <Legend />
      {info !== null && (
        <InfoBox
          item={info.item}
          pinned={info.pinned}
          nodes={derived.nodes}
          index={derived.index}
          degrees={derived.degrees}
          functions={derived.functions}
          openSite={() => undefined}
        />
      )}
    </div>
  );
}
