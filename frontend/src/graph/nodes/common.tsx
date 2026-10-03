// 노드 컴포넌트가 함께 쓰는 데이터 형태와 보이지 않는 연결점.
import { Handle, Position, type Node } from "@xyflow/react";
import type { AtlasNode } from "../../api/types";
import type { FocusLevel } from "../focus";
import { labelOf, truncate } from "../layout";

export interface AtlasNodeData extends Record<string, unknown> {
  node: AtlasNode;
  /** 파일 상자 머리에 적는 함수 수 */
  functions: number;
  /** 초점 상태가 아니면 null */
  level: FocusLevel | null;
  selected: boolean;
  hovered: boolean;
  /** 안에 보이는 자식 노드가 있다 */
  expanded: boolean;
}

export type AtlasFlowNode = Node<AtlasNodeData>;

/** 선은 배치가 정한 경로로 그리므로 연결점은 React Flow가 선을 찾는 데만 쓴다. */
export function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} className="node-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="node-handle" isConnectable={false} />
    </>
  );
}

/** 2단계 밖 노드는 마우스를 올렸을 때만 이름표를 보인다. */
export function labelShown(data: AtlasNodeData): boolean {
  return data.level === null || data.level <= 1 || data.hovered;
}

export function Label({ data, bold = false }: { data: AtlasNodeData; bold?: boolean }) {
  const text = labelOf(data.node);
  return (
    <span className={bold ? "node-label node-label-bold" : "node-label"} title={text}>
      {data.node.entry && <span className="node-entry">▶ </span>}
      {truncate(text)}
    </span>
  );
}

export function nodeClass(base: string, data: AtlasNodeData): string {
  return [base, data.selected ? "node-selected" : "", labelShown(data) ? "" : "node-label-hidden"]
    .filter(Boolean)
    .join(" ");
}
