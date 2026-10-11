// 노드 컴포넌트가 함께 쓰는 데이터 형태와 이름표·배지·보이지 않는 연결점.
// 노드 컴포넌트는 바탕 요소와 글자 요소를 같은 뼈대로 그리고(`layers.ts`), 요소에 따라 테두리·채움이나 글자·배지만 그린다.
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { AtlasNode, Change } from "../../api/types";
import { CHANGE_LETTERS } from "../../state/changes";
import { faceId, layerOf, type Part } from "../layers";
import { BADGE_OVERHANG, CIRCLE_GAP, ENTRY_MARK, labelOf, type Box } from "../layout";
import { busyTip, CHANGE_TIPS, cycleTip, ENTRY_TIP, globalTip, inflowTip, locTip, unresolvedTip } from "../tips";

export interface AtlasNodeData extends Record<string, unknown> {
  node: AtlasNode;
  /** 이 React Flow 노드가 그리는 요소 */
  part: Part;
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
  /** 이 노드와 이 노드로 올린 안쪽 노드 가운데 LLM 요약을 만드는 중인 노드 수 */
  busy: number;
  /** 순환 아이콘을 다는 상자면 묶음마다 든 파일의 이름표. 아니면 null이다. */
  cycle: string[][] | null;
  /** 미사용 덮개가 표시하는 후보다 */
  unused: boolean;
  /** 접힌 파일 상자 아래에 적는 미사용 후보 수. 미사용 덮개를 껐으면 0이다. */
  candidates: number;
}

export type AtlasFlowNode = Node<AtlasNodeData>;

/** 움직이는 동안 바뀌지 않는 노드 하나의 값. data는 요소마다 하나씩 두어 참조를 유지한다. */
export interface Drawn<D extends AtlasNodeData> {
  id: string;
  type: string;
  opacity: number;
  body: D;
  face: D;
}

/** 노드 종류와 같은 값으로 요소마다의 data를 만든다. */
export function parts<D extends object>(data: D): Record<Part, D & { part: Part }> {
  return { body: { ...data, part: "body" }, face: { ...data, part: "face" } };
}

/**
 * 노드마다 화면 기준 상자 at에 놓은 React Flow 노드 두 개. 바탕 요소를 모두 앞에, 글자 요소를 모두 뒤에 둔다.
 * 층은 노드 종류와 요소로만 정한다. 글자 요소는 글자와 배지만 마우스를 받으므로 감싼 요소는 마우스를 받지 않는다.
 * 펼친 폴더 영역의 바탕 요소도 마우스를 받지 않아 영역의 빈 곳은 그래프 바탕처럼 눌리고 끌린다.
 * fresh에 든 노드는 불투명도 0으로 그린다.
 */
export function flowNodes<D extends AtlasNodeData>(items: Drawn<D>[], at: Map<string, Box>, fresh: Set<string> | null): Node<D>[] {
  const node = (item: Drawn<D>, data: D): Node<D> => {
    const box = at.get(item.id) ?? { x: 0, y: 0, width: 0, height: 0 };
    const face = data.part === "face";
    return {
      id: face ? faceId(item.id) : item.id,
      type: item.type,
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      zIndex: layerOf(data.node.kind, data.part, data.expanded),
      draggable: false,
      connectable: false,
      focusable: !face,
      style: {
        opacity: fresh?.has(item.id) === true ? 0 : item.opacity,
        pointerEvents: face || (data.expanded && data.node.kind === "package") ? "none" : undefined,
      },
      data,
    };
  };
  return [...items.map((item) => node(item, item.body)), ...items.map((item) => node(item, item.face))];
}

/** 움직이는 동안에는 위치만 바뀌므로 데이터와 크기가 같으면 노드 본문을 다시 그리지 않는다. */
export function sameNode(a: NodeProps<AtlasFlowNode>, b: NodeProps<AtlasFlowNode>): boolean {
  return a.data === b.data && a.width === b.width && a.height === b.height;
}

/** 선은 배치가 정한 경로로 그리므로 연결점은 React Flow가 선을 찾는 데만 쓴다. 바탕 요소에만 둔다. */
export function Handles({ data }: { data: AtlasNodeData }) {
  if (data.part === "face") {
    return null;
  }
  return (
    <>
      <Handle type="target" position={Position.Left} className="node-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="node-handle" isConnectable={false} />
    </>
  );
}

/**
 * 노드 뿌리 요소의 속성. 바탕 요소는 `node-body`, 글자 요소는 `node-face`를 받는다. 흐름에 든 노드는 `data-flow`를,
 * 선택한 노드가 든 파일 상자 안의 노드는 `data-local`을, 마지막 커밋 뒤에 바뀐 노드는 `data-change`를 받는다.
 * 순환 아이콘을 다는 상자는 `data-cycle`을, 미사용 덮개가 표시하는 후보는 `data-unused`를 받는다.
 */
export function nodeProps(base: string, data: AtlasNodeData, change: Change | null) {
  return {
    className: `${base} node-${data.part}${data.selected ? " node-selected" : ""}`,
    "data-flow": data.flow ? "" : undefined,
    "data-local": data.local ? "" : undefined,
    "data-change": change ?? undefined,
    "data-cycle": data.cycle !== null ? "" : undefined,
    "data-unused": data.unused ? "" : undefined,
  };
}

/** 진입점 표지 ▶. 마우스를 올리면 말풍선이 뜨고 접근성 이름은 "진입점"이다. */
export function EntryMark({ className }: { className?: string }) {
  return (
    <span className={className} role="img" aria-label="진입점" data-tip={ENTRY_TIP}>
      {ENTRY_MARK}
    </span>
  );
}

/** 순환 아이콘 ⟳. 12px 칸에 그리고 폭은 layout.ts의 CYCLE_MARK_WIDTH가 잡는다. tip을 주면 마우스를 올렸을 때 말풍선이 뜬다. */
export function CycleMark({ tip }: { tip?: string }) {
  return (
    <span className="cycle-mark" role="img" aria-label="순환 묶음" data-tip={tip}>
      <svg viewBox="0 0 12 12" width={12} height={12}>
        <path d="M10 6 A4 4 0 1 1 8 2.54" />
        <path d="M8.5 0.5 L8.2 2.7 L6 2.4" />
      </svg>
    </span>
  );
}

export function Label({ data, bold = false }: { data: AtlasNodeData; bold?: boolean }) {
  return (
    <span className={bold ? "node-label node-label-bold" : "node-label"}>
      {data.cycle !== null && <CycleMark tip={cycleTip(data.node, data.cycle)} />}
      {data.node.entry && <EntryMark className="node-entry" />}
      {labelOf(data.node)}
    </span>
  );
}

/** 이름표 오른쪽의 줄 수 숫자 */
export function Loc({ data }: { data: AtlasNodeData }) {
  return (
    <span className="loc" data-tip={locTip(data.node)}>
      {data.node.loc}
    </span>
  );
}

/** 파일 상자의 줄 수 숫자 뒤에 적는 변경 상태 글자 */
export function Mark({ change }: { change: Change | null }) {
  return change === null ? null : (
    <span className="change-mark" data-tip={CHANGE_TIPS[change]}>
      {CHANGE_LETTERS[change]}
    </span>
  );
}

/**
 * 감싼 모양의 오른쪽 위 모서리에 미확인 호출 수를, 오른쪽 아래 모서리에 모듈 변수 변경을 단다. 글자 요소에만 그린다.
 * 배지의 오른쪽 끝은 모양의 오른쪽 끝에서 `BADGE_OVERHANG`만큼 나간다. LLM 요약을 만드는 중이면 오른쪽 위 모서리에
 * 도는 원을 달고, 미확인 호출 수 배지가 있으면 그 왼쪽에 나란히 둔다. 배지마다 뜻을 적은 말풍선 글(`tips.ts`)을 `data-tip`에 담는다.
 */
export function Badges({ data }: { data: AtlasNodeData }) {
  if (data.part === "body") {
    return null;
  }
  const style = { "--overhang": `${BADGE_OVERHANG}px` } as CSSProperties;
  return (
    <>
      {(data.busy > 0 || data.unresolved > 0) && (
        <span className="badges" style={style}>
          {data.busy > 0 && <span className="badge badge-busy" role="img" aria-label="요약을 만드는 중" data-tip={busyTip(data.node, data.busy)} />}
          {data.unresolved > 0 && (
            <span className="badge badge-unresolved" data-tip={unresolvedTip(data.node, data.unresolved, data.expanded)}>
              ?{data.unresolved}
            </span>
          )}
        </span>
      )}
      {data.node.global_write && (
        <span className="badge badge-global" style={style} data-tip={globalTip(data.node)}>
          g
        </span>
      )}
    </>
  );
}

/** 함수·메서드의 지름 16px 원. 바탕 요소가 테두리와 채움을, 글자 요소가 배지와 선택 고리를 그린다. */
export function Circle({ data }: { data: AtlasNodeData }) {
  return (
    <span className="node-circle" style={{ marginRight: CIRCLE_GAP }}>
      <Badges data={data} />
    </span>
  );
}

/** 편재 노드 배지. 노드 왼쪽에 숨긴 선의 출발 노드 수를 적는다. */
export function Inflow({ data }: { data: AtlasNodeData }) {
  return data.inflow === null ? null : (
    <span className="node-inflow" data-tip={inflowTip(data.inflow)}>
      ←{data.inflow}
    </span>
  );
}
