import type { NodeProps } from "@xyflow/react";
import { TABLE_HEAD, TABLE_ROW, tableRows, truncate } from "../layout";
import { Handles, Label, nodeClass, type AtlasFlowNode } from "./common";
import { Badges } from "./FunctionNode";

/** 머리 칸에 클래스 이름, 아래 칸마다 필드 하나. 메서드가 있으면 표 아래에 품는다. */
export function DataClassNode({ data }: NodeProps<AtlasFlowNode>) {
  return (
    <div className={nodeClass("node-dataclass", data)}>
      <Handles />
      <div className="node-table-head" style={{ height: TABLE_HEAD }}>
        <Label data={data} bold />
      </div>
      {tableRows(data.node).map((row, i) => (
        <div key={i} className="node-table-row" style={{ height: TABLE_ROW }} title={row}>
          {truncate(row)}
        </div>
      ))}
      <Badges data={data} />
    </div>
  );
}
