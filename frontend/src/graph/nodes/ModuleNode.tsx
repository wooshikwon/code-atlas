import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { moduleHeader } from "../layout";
import { Handles, Inflow, Label, Loc, nodeProps, sameNode, type AtlasFlowNode } from "./common";

/**
 * 접힌 파일 상자는 220×40 상자에 이름표와 줄 수를 적고 상자 아래에 함수 수를 적는다.
 * 펼친 파일 상자는 머리 줄에 이름표·줄 수·함수 수를 적고, 머리 줄만 클릭을 받는다.
 */
export const ModuleNode = memo(function ModuleNode({ data }: NodeProps<AtlasFlowNode>) {
  const count = moduleHeader(data.node, data.functions);
  if (data.expanded) {
    return (
      <div {...nodeProps("node-module node-module-open", data)}>
        <Handles />
        <div className="node-module-head">
          <Label data={data} bold />
          <Loc data={data} />
          {count !== "" && <span className="node-aside">{count}</span>}
        </div>
        <Inflow data={data} />
      </div>
    );
  }
  return (
    <div {...nodeProps("node-module", data)}>
      <Handles />
      <div className="node-module-name">
        <Label data={data} bold />
        <Loc data={data} />
      </div>
      {count !== "" && <span className="node-below">{count}</span>}
      <Inflow data={data} />
    </div>
  );
}, sameNode);
