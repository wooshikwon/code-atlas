import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useChange } from "../../state/changes";
import { Circle, Handles, Label, nodeProps, sameNode, shownChange, type AtlasFlowNode } from "./common";

/** 지름 16px 원과 그 오른쪽의 이름표. */
export const FunctionNode = memo(function FunctionNode({ data }: NodeProps<AtlasFlowNode>) {
  const change = shownChange(data, useChange(data.node.id));
  return (
    <div {...nodeProps("node-function", data, change)}>
      <Handles data={data} />
      <Circle data={data} />
      {data.part === "face" && <Label data={data} />}
    </div>
  );
}, sameNode);
