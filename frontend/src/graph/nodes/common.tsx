// 노드 컴포넌트가 함께 쓰는 데이터 형태와 이름표·배지·보이지 않는 연결점.
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { AtlasNode, Change } from "../../api/types";
import { CHANGE_LETTERS } from "../../state/changes";
import { ENTRY_MARK, labelOf } from "../layout";

export interface AtlasNodeData extends Record<string, unknown> {
  node: AtlasNode;
  /** 파일 상자에 적는 함수 수 */
  functions: number;
  /** 안에 보이는 자식 노드가 있다 */
  expanded: boolean;
  selected: boolean;
  /** 초점 상태에서 흐름에 든 노드다 */
  flow: boolean;
  /** 선택한 노드가 든 파일 상자 안의 노드다 */
  local: boolean;
  /** 편재 노드면 숨긴 선의 출발 노드 수 */
  inflow: number | null;
  /** 배지에 적는 미확인 호출 수. 접힌 파일 상자와 접힌 폴더 상자는 안에 든 노드의 수를 합친 값이고 펼친 파일 상자는 0이다. */
  unresolved: number;
}

export type AtlasFlowNode = Node<AtlasNodeData>;

/** 움직이는 동안에는 위치만 바뀌므로 데이터와 크기가 같으면 노드 본문을 다시 그리지 않는다. */
export function sameNode(a: NodeProps<AtlasFlowNode>, b: NodeProps<AtlasFlowNode>): boolean {
  return a.data === b.data && a.width === b.width && a.height === b.height;
}

/** 선은 배치가 정한 경로로 그리므로 연결점은 React Flow가 선을 찾는 데만 쓴다. */
export function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} className="node-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="node-handle" isConnectable={false} />
    </>
  );
}

/**
 * 노드 뿌리 요소의 속성. 흐름에 든 노드는 `data-flow`를, 선택한 노드가 든 파일 상자 안의 노드는 `data-local`을,
 * 마지막 커밋 뒤에 바뀐 노드는 `data-change`를 받는다.
 */
export function nodeProps(base: string, data: AtlasNodeData, change: Change | null) {
  return {
    className: data.selected ? `${base} node-selected` : base,
    "data-flow": data.flow ? "" : undefined,
    "data-local": data.local ? "" : undefined,
    "data-change": change ?? undefined,
  };
}

export function Label({ data, bold = false }: { data: AtlasNodeData; bold?: boolean }) {
  return (
    <span className={bold ? "node-label node-label-bold" : "node-label"}>
      {data.node.entry && <span className="node-entry">{ENTRY_MARK}</span>}
      {labelOf(data.node)}
    </span>
  );
}

/** 이름표 오른쪽의 줄 수 숫자 */
export function Loc({ data }: { data: AtlasNodeData }) {
  return <span className="loc">{data.node.loc}</span>;
}

/** 파일 상자의 줄 수 숫자 뒤에 적는 변경 상태 글자 */
export function Mark({ change }: { change: Change | null }) {
  return change === null ? null : <span className="change-mark">{CHANGE_LETTERS[change]}</span>;
}

/** 미확인 호출 수는 오른쪽 위, 모듈 변수 변경은 오른쪽 아래에 단다. */
export function Badges({ data }: { data: AtlasNodeData }) {
  return (
    <>
      {data.unresolved > 0 && <span className="badge badge-unresolved">?{data.unresolved}</span>}
      {data.node.global_write && <span className="badge badge-global">g</span>}
    </>
  );
}

/** 편재 노드 배지. 노드 왼쪽에 숨긴 선의 출발 노드 수를 적는다. */
export function Inflow({ data }: { data: AtlasNodeData }) {
  return data.inflow === null ? null : <span className="node-inflow">←{data.inflow}</span>;
}
