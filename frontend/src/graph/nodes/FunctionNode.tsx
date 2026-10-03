import type { NodeProps } from "@xyflow/react";
import { circleDiameter } from "../layout";
import { Handles, Label, nodeClass, type AtlasFlowNode, type AtlasNodeData } from "./common";

/** 미확인 호출 수는 오른쪽 위, 모듈 변수 변경은 오른쪽 아래에 단다. */
export function Badges({ data }: { data: AtlasNodeData }) {
  return (
    <>
      {data.node.unresolved > 0 && (
        <span className="badge badge-unresolved" title={`미확인 호출 ${data.node.unresolved}곳`}>
          ?{data.node.unresolved}
        </span>
      )}
      {data.node.global_write && (
        <span className="badge badge-global" title="global 문으로 모듈 변수를 바꾼다">
          g
        </span>
      )}
    </>
  );
}

/** 줄 수에 비례하는 원과 그 오른쪽 이름표. */
export function FunctionNode({ data }: NodeProps<AtlasFlowNode>) {
  const d = circleDiameter(data.node.loc);
  return (
    <div className={nodeClass("node-function", data)}>
      <Handles />
      <span className="node-circle" style={{ width: d, height: d }}>
        <Badges data={data} />
      </span>
      <Label data={data} />
    </div>
  );
}
