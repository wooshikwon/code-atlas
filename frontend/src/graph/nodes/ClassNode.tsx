import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useChange } from "../../state/changes";
import { Badges, Handles, Label, nodeProps, sameNode, type AtlasFlowNode } from "./common";

const INSET = 10;

/**
 * 육각형은 노드 크기에 맞춘 SVG 배경으로 그린다. 메서드를 품으면 이름표를 왼쪽 위에 적는다.
 * 마지막 커밋 뒤에 바뀐 클래스는 육각형의 왼쪽 두 변을 변경 표시 색으로 덧그린다.
 */
export const ClassNode = memo(function ClassNode({ data, width, height }: NodeProps<AtlasFlowNode>) {
  const w = width ?? 0;
  const h = height ?? 0;
  const points = `${INSET},0.75 ${w - INSET},0.75 ${w - 0.75},${h / 2} ${w - INSET},${h - 0.75} ${INSET},${h - 0.75} 0.75,${h / 2}`;
  const change = useChange(data.node.id);
  return (
    <div {...nodeProps(data.expanded ? "node-class node-class-expanded" : "node-class", data, change)}>
      <Handles />
      <svg className="node-hexagon" width={w} height={h}>
        <polygon points={points} />
        {change !== null && <polyline className="node-hexagon-change" points={`${INSET},1.5 1.5,${h / 2} ${INSET},${h - 1.5}`} />}
      </svg>
      <div className="node-header">
        <Label data={data} bold />
      </div>
      <Badges data={data} />
    </div>
  );
}, sameNode);
