import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useChange } from "../../state/changes";
import { Aside, Diamond, Handles, Label, nodeProps, sameNode, type AtlasFlowNode } from "./common";

/** 지름 16px 원과 같은 칸의 마름모와 그 오른쪽의 이름표·값의 종류와 원소 수. */
export const VariableNode = memo(function VariableNode({ data }: NodeProps<AtlasFlowNode>) {
  const change = useChange(data.node.id);
  return (
    <div {...nodeProps("node-variable", data, change)}>
      <Handles data={data} />
      <Diamond data={data} />
      {data.part === "face" && (
        <>
          <Label data={data} />
          <Aside data={data} />
        </>
      )}
    </div>
  );
}, sameNode);
