import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { Badges, Handles, Label, Loc, nodeProps, sameNode, type AtlasFlowNode } from "./common";

/** 지름 16px 원과 그 오른쪽의 이름표·줄 수. */
export const FunctionNode = memo(function FunctionNode({ data }: NodeProps<AtlasFlowNode>) {
  return (
    <div {...nodeProps("node-function", data)}>
      <Handles />
      <span className="node-circle">
        <Badges data={data} />
      </span>
      <Label data={data} />
      <Loc data={data} />
    </div>
  );
}, sameNode);
