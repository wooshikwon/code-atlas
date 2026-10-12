import type { Node, NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useChange } from "../../state/changes";
import type { Side } from "../calls";
import { CIRCLE_GAP } from "../layout";
import { Circle, DIAMOND_POINTS, EntryMark, Handles, nodeProps, sameNode, shownChange, type AtlasNodeData } from "./common";

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

/** 함수·메서드는 원, 클래스는 육각형, 데이터 클래스는 표 모양, 변수는 마름모다. 글자 요소는 선택했을 때의 테두리만 그린다. */
function Shape({ data }: { data: CallNodeData }) {
  const style = { marginRight: CIRCLE_GAP };
  switch (data.node.kind) {
    case "class":
      return (
        <svg className="call-shape" viewBox="0 0 16 16" style={style}>
          <polygon points="4,1.5 12,1.5 15.5,8 12,14.5 4,14.5 0.5,8" />
        </svg>
      );
    case "dataclass":
      return (
        <svg className="call-shape" viewBox="0 0 16 16" style={style}>
          <rect x={1.5} y={1.5} width={13} height={13} />
          <line x1={1.5} y1={6} x2={14.5} y2={6} />
          <line x1={1.5} y1={10.5} x2={14.5} y2={10.5} />
        </svg>
      );
    case "variable":
      return (
        <svg className="call-shape" viewBox="0 0 16 16" style={style}>
          <polygon points={DIAMOND_POINTS} />
        </svg>
      );
    default:
      return <Circle data={data} />;
  }
}

/**
 * 지름 16px 원, 이름표, 그 아래 파일 경로. 더 펼 선이 남은 양옆 노드는 바깥쪽에 + 버튼을 단다.
 * + 버튼은 글자 요소가 그리고 바탕 요소는 같은 폭을 비운다.
 */
export const CallNode = memo(function CallNode({ data }: NodeProps<CallFlowNode>) {
  const change = shownChange(data, useChange(data.node.id));
  const face = data.part === "face";
  const more =
    data.more &&
    (face ? (
      <button className="call-more" data-tip="한 단계 더 펼치기" aria-label="한 단계 더 펼치기">
        +
      </button>
    ) : (
      <span className="call-more-slot" />
    ));
  return (
    <div {...nodeProps("node-call", data, change)} data-side={data.side}>
      <Handles data={data} />
      {data.side === "caller" && more}
      <Shape data={data} />
      {face && (
        <span className="call-text">
          <span className="call-name">
            <span className="node-label">
              {data.node.entry && <EntryMark node={data.node} className="node-entry" />}
              {data.label}
            </span>
          </span>
          {data.file !== null && <span className="call-file">{data.file}</span>}
        </span>
      )}
      {data.side === "callee" && more}
    </div>
  );
}, sameNode);
