import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useChange } from "../../state/changes";
import { moduleHeader } from "../layout";
import { Badges, Handles, Inflow, Label, Loc, Mark, nodeProps, sameNode, type AtlasFlowNode } from "./common";

/**
 * 접힌 파일 상자는 220×40 상자에 이름표와 줄 수를 적고 상자 아래에 함수 수를 적는다.
 * 펼친 파일 상자는 머리 줄에 이름표·줄 수·함수 수를 적고, 머리 줄만 클릭을 받는다.
 * 마지막 커밋 뒤에 바뀐 파일은 줄 수 뒤에 변경 상태 글자를 적는다. 접힌 파일 상자는 안에 든 함수까지 합친 미확인 호출 수를
 * 오른쪽 위 배지에 적고, 펼친 파일 상자는 안의 함수가 배지를 달므로 달지 않는다.
 */
export const ModuleNode = memo(function ModuleNode({ data }: NodeProps<AtlasFlowNode>) {
  const count = moduleHeader(data.node, data.functions);
  const change = useChange(data.node.id);
  const face = data.part === "face";
  if (data.expanded) {
    return (
      <div {...nodeProps("node-module node-module-open", data, change)}>
        <Handles data={data} />
        {face && (
          <>
            <div className="node-module-head">
              <Label data={data} bold />
              <Loc data={data} />
              <Mark change={change} />
              {count !== "" && <span className="node-aside">{count}</span>}
            </div>
            <Inflow data={data} />
          </>
        )}
      </div>
    );
  }
  return (
    <div {...nodeProps("node-module", data, change)}>
      <Handles data={data} />
      {face && (
        <>
          <div className="node-module-name">
            <Label data={data} bold />
            <Loc data={data} />
            <Mark change={change} />
          </div>
          {count !== "" && <span className="node-below">{count}</span>}
          <Inflow data={data} />
          <Badges data={data} />
        </>
      )}
    </div>
  );
}, sameNode);
