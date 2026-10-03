import type { NodeProps } from "@xyflow/react";
import { Handles, Label, nodeClass, type AtlasFlowNode } from "./common";

export function PackageNode({ data }: NodeProps<AtlasFlowNode>) {
  return (
    <div className={nodeClass("node-package", data)}>
      <Handles />
      <div className="node-header">
        <Label data={data} bold />
      </div>
    </div>
  );
}
