import type { NodeProps } from "@xyflow/react";
import { moduleHeader } from "../layout";
import { Handles, Label, nodeClass, type AtlasFlowNode } from "./common";

/** 펼친 파일 상자는 머리에, 접힌 파일 상자는 상자 아래에 함수 수를 적는다. */
export function ModuleNode({ data }: NodeProps<AtlasFlowNode>) {
  const count = moduleHeader(data.node, data.functions);
  return (
    <div className={nodeClass(data.expanded ? "node-module" : "node-module node-module-leaf", data)}>
      <Handles />
      <div className="node-header">
        <Label data={data} bold />
        {data.expanded && count !== "" && <span className="node-aside">{count}</span>}
      </div>
      {!data.expanded && count !== "" && <span className="node-below">{count}</span>}
    </div>
  );
}
