import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useChange } from "../../state/changes";
import { TABLE_HEAD, TABLE_ROW, tableRows } from "../layout";
import { Badges, Handles, Label, nodeProps, sameNode, type AtlasFlowNode } from "./common";

/**
 * 머리 칸에 클래스 이름, 아래 칸마다 필드 하나. 줄 수는 오른쪽 위 배지에 적는다. 메서드가 있으면 표 아래에 품는다.
 * 바탕 요소가 칸의 경계선을, 글자 요소가 칸의 글자를 그린다.
 */
export const DataClassNode = memo(function DataClassNode({ data }: NodeProps<AtlasFlowNode>) {
  const change = useChange(data.node.id);
  const face = data.part === "face";
  return (
    <div {...nodeProps("node-dataclass", data, change)}>
      <Handles data={data} />
      <div className="node-table-head" style={{ height: TABLE_HEAD }}>
        {face && <Label data={data} bold />}
      </div>
      {tableRows(data.node).map((row, i) => (
        <div key={i} className="node-table-row" style={{ height: TABLE_ROW }}>
          {face && <span className="node-field">{row}</span>}
        </div>
      ))}
      <Badges data={data} />
    </div>
  );
}, sameNode);
