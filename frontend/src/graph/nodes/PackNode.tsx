import type { Node, NodeProps } from "@xyflow/react";
import { memo } from "react";
import { PACK_PAD } from "../layout";

/** 손잡이 하나. box는 손잡이를 단 상자의 노드 id다. */
export interface PackData extends Record<string, unknown> {
  box: string;
  /** `안쪽 12개`나 `안쪽 12개 접기` */
  label: string;
  /** 전부 펼침 단계의 손잡이다 */
  open: boolean;
  tip: string;
}

export type PackFlowNode = Node<PackData, "pack">;

export function isPack(node: Node): node is PackFlowNode {
  return node.type === "pack";
}

/**
 * 펼친 상자가 그리지 않은 안쪽 자식을 묶은 손잡이. 한 줄 높이에 그리지 않은 자식의 수를 muted 잉크로 적는다. 누르면 그 자식을 그리고,
 * 전부 펼침 단계에서는 같은 위치에서 다시 묶는다.
 */
export const PackNode = memo(function PackNode({ data }: NodeProps<PackFlowNode>) {
  return (
    <div className="node-pack" data-box={data.box} data-open={data.open ? "" : undefined} data-tip={data.tip} style={{ padding: `0 ${PACK_PAD}px` }}>
      {data.label}
    </div>
  );
});
