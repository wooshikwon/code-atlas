import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useChange } from "../../state/changes";
import { Circle, Handles, Label, Loc, nodeProps, sameNode, type AtlasFlowNode } from "./common";

/** 지름 16px 원과 그 오른쪽의 이름표·줄 수. */
export const FunctionNode = memo(function FunctionNode({ data }: NodeProps<AtlasFlowNode>) {
  const change = useChange(data.node.id);
  return (
    <div {...nodeProps("node-function", data, change)}>
      <Handles data={data} />
      <Circle data={data} />
      {data.part === "face" && (
        <>
          <Label data={data} />
          <Loc data={data} />
        </>
      )}
    </div>
  );
}, sameNode);
