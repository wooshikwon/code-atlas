import type { Node, NodeProps } from "@xyflow/react";
import { memo } from "react";
import { counted, type Side } from "../callview";
import { ENTRY_MARK } from "../layout";
import { Badges, Handles, Loc, nodeProps, sameNode, type AtlasNodeData } from "./common";

export interface CallNodeData extends AtlasNodeData {
  /** 메서드면 `클래스.이름()` */
  label: string;
  /** 이름표 아래에 적는 파일 경로 */
  file: string | null;
  side: Side;
  /** 같은 방향으로 한 단계 더 펼 선이 남았다 */
  more: boolean;
}

export type CallFlowNode = Node<CallNodeData>;

/** 함수·메서드는 원, 클래스는 육각형, 데이터 클래스는 표 모양이다. */
function Shape({ data }: { data: CallNodeData }) {
  switch (data.node.kind) {
    case "class":
      return (
        <svg className="call-shape" viewBox="0 0 16 16">
          <polygon points="4,1.5 12,1.5 15.5,8 12,14.5 4,14.5 0.5,8" />
        </svg>
      );
    case "dataclass":
      return (
        <svg className="call-shape" viewBox="0 0 16 16">
          <rect x={1.5} y={1.5} width={13} height={13} />
          <line x1={1.5} y1={6} x2={14.5} y2={6} />
          <line x1={1.5} y1={10.5} x2={14.5} y2={10.5} />
        </svg>
      );
    default:
      return (
        <span className="node-circle">
          <Badges data={data} />
        </span>
      );
  }
}

/** 지름 16px 원, 이름표와 줄 수, 그 아래 파일 경로. 더 펼 선이 남은 양옆 노드는 바깥쪽에 + 버튼을 단다. */
export const CallNode = memo(function CallNode({ data }: NodeProps<CallFlowNode>) {
  const more = data.more && (
    <button className="call-more" title="한 단계 더 펼치기" aria-label="한 단계 더 펼치기">
      +
    </button>
  );
  return (
    <div {...nodeProps("node-call", data)} data-side={data.side}>
      <Handles />
      {data.side === "caller" && more}
      <Shape data={data} />
      <span className="call-text">
        <span className="call-name">
          <span className="node-label">
            {data.node.entry && <span className="node-entry">{ENTRY_MARK}</span>}
            {data.label}
          </span>
          {counted(data.node) && <Loc data={data} />}
        </span>
        {data.file !== null && <span className="call-file">{data.file}</span>}
      </span>
      {data.side === "callee" && more}
    </div>
  );
}, sameNode);
