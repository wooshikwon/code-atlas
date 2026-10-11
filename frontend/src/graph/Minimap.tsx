// 그래프 왼쪽 아래의 미니맵. 전체 그래프의 축소 그림 위에 지금 화면에 보이는 영역을 사각형으로 그리고,
// 누르거나 끌면 확대 비율을 그대로 둔 채 그 위치로 화면을 옮기고 전체 맞춤 상태를 끈다. 범례처럼 둥근 버튼으로 접고 편다.
// 경로 고정 중에는 강조하는 경로를 그 위에 그린다.
import { MiniMap, useReactFlow, useStore, type Node, type XYPosition } from "@xyflow/react";
import { useEffect, useLayoutEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { useAtlas } from "../state/store";
import { reducedMotion } from "./motion";
import type { AtlasNodeData } from "./nodes/common";
import { isPack, type PackFlowNode } from "./nodes/PackNode";
import { PAN_MS, stageOf } from "./viewport";

const SIZE = { width: 220, height: 140 };

/**
 * 미니맵에 그리는 노드의 클래스. 노드의 바탕 요소만 그린다. 펼친 폴더 영역과 펼친 파일 상자는 테두리와 옅은 바탕으로 그린다.
 * 진하기는 구조 뷰의 불투명도를 세 단계(1, 1 미만, 0.2 이하)로 따르고 고른 노드는 본문 잉크로 그린다. 손잡이는 손잡이를 단 상자의 진하기를 따르는 노드 하나로 그린다.
 */
export function minimapClass(node: Node<AtlasNodeData> | PackFlowNode): string {
  const opacity = Number(node.style?.opacity ?? 1);
  const shade = opacity <= 0.2 ? "dim" : opacity < 1 ? "half" : "full";
  if (isPack(node)) {
    return `minimap-pack minimap-${shade}`;
  }
  const { part, node: atlas, expanded, selected } = node.data;
  if (part === "face") {
    return "minimap-none";
  }
  const tone = selected ? "selected" : shade;
  return `minimap-${atlas.kind}${expanded ? " minimap-open" : ""} minimap-${tone}`;
}

/**
 * 강조하는 경로를 미니맵의 그림 위에 그린다. 걸음을 노드의 가운데를 잇는 본문 잉크 선으로, 거치는 노드를 점으로,
 * 출발 노드를 빈 원으로, 도착 노드를 채운 원으로 그린다. 미니맵의 svg가 그래프 좌표를 쓰므로 그 안에 그래프 좌표로 넣는다.
 */
function MinimapRoute({ path }: { path: string[] }) {
  const points = useStore((s) =>
    path
      .map((id) => s.nodeLookup.get(id))
      .filter((node) => node !== undefined)
      .map(({ internals, measured }) => {
        const { x, y } = internals.positionAbsolute;
        return `${Math.round(x + (measured.width ?? 0) / 2)},${Math.round(y + (measured.height ?? 0) / 2)}`;
      })
      .join(" "),
  );
  const [svg, setSvg] = useState<Element | null>(null);
  useLayoutEffect(() => setSvg(document.querySelector(".graph-minimap svg")), []);
  if (svg === null || points === "") {
    return null;
  }
  const dots = points.split(" ").map((point) => `M${point}h0`);
  return createPortal(
    <g className="minimap-route">
      <polyline className="minimap-route-line" points={points} />
      <path className="minimap-route-via" d={dots.slice(1, -1).join("")} />
      <path className="minimap-route-end" d={dots[0] + dots[dots.length - 1]} />
      <path className="minimap-route-from" d={dots[0]} />
    </g>,
    svg,
  );
}

export function Minimap() {
  const open = useAtlas((s) => s.minimapOpen);
  const path = useAtlas((s) => s.finder.route?.paths[s.finder.pick]);
  const { getViewport, setViewport } = useReactFlow();
  // 미니맵을 누르거나 끌면 화면이 옮겨지므로 전체 맞춤 상태를 끈다. React Flow의 MiniMap은 pointerdown 처리기를 받지 않는다.
  useEffect(() => {
    const element = open ? document.querySelector(".graph-minimap") : null;
    const release = () => useAtlas.setState({ fitted: false });
    element?.addEventListener("pointerdown", release);
    return () => element?.removeEventListener("pointerdown", release);
  }, [open]);
  if (!open) {
    return null;
  }
  /** 누른 그래프 좌표가 정보 패널과 왼쪽 아래 칸이 가리지 않는 영역의 가운데에 오도록 옮긴다. */
  const onClick = (event: ReactMouseEvent, at: XYPosition) => {
    const root = (event.target as Element).closest(".graph");
    if (root === null) {
      return;
    }
    const { clear } = stageOf(root);
    const zoom = getViewport().zoom;
    void setViewport(
      { x: clear.x + clear.width / 2 - at.x * zoom, y: clear.y + clear.height / 2 - at.y * zoom, zoom },
      { duration: reducedMotion() ? 0 : PAN_MS },
    );
  };
  return (
    <>
      <MiniMap<Node<AtlasNodeData> | PackFlowNode>
        className="graph-minimap"
        style={SIZE}
        nodeClassName={minimapClass}
        nodeBorderRadius={2}
        nodeStrokeWidth={1}
        pannable
        zoomable={false}
        onClick={onClick}
        ariaLabel="미니맵"
      />
      {path !== undefined && <MinimapRoute path={path} />}
    </>
  );
}

export function MinimapButton() {
  const open = useAtlas((s) => s.minimapOpen);
  const toggleMinimap = useAtlas((s) => s.toggleMinimap);
  return (
    <button
      className="dock-button minimap-button"
      onClick={toggleMinimap}
      title="미니맵"
      aria-label="미니맵"
      aria-expanded={open}
    >
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
        <rect x={1.5} y={2.5} width={13} height={11} rx={1.5} className="minimap-icon" />
        <rect x={7} y={6} width={6} height={5} className="minimap-icon" />
      </svg>
    </button>
  );
}
