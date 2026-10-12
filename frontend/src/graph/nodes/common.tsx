// 노드 컴포넌트가 함께 쓰는 데이터 형태와 이름표·배지·보이지 않는 연결점.
// 노드 컴포넌트는 바탕 요소와 글자 요소를 같은 뼈대로 그리고(`layers.ts`), 요소에 따라 테두리·채움이나 글자·배지만 그린다.
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { AtlasNode, Change } from "../../api/types";
import { CHANGE_LETTERS } from "../../state/changes";
import { faceId, layerOf, type Part } from "../layers";
import { ASIDE_GAP, BADGE_OVERHANG, boxCaption, CIRCLE_GAP, END_GAP, END_NAMES, END_PAD, labelOf, type Box, type RouteEnd } from "../layout";
import { valueAside } from "../names";
import { lifted } from "../scope";
import { busyTip, candidatesTip, CHANGE_TIPS, cycleTip, ENTRY_TIP, globalTip, insideTip, locTip } from "../tips";

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
  /** 접힌 파일 상자와 접힌 폴더 상자의 배지에 적는 수. 파일 상자는 안에 든 함수·클래스·변수 수, 폴더 상자는 안에 든 파일 수다. 그 밖의 노드는 0이다. */
  inside: number;
  /** 이 함수·메서드에서 나가는 바꿈 선의 도착 변수 이름. 비지 않으면 모듈 변수 변경 배지를 단다. */
  writes: string[];
  /** 이 노드와 이 노드로 올린 안쪽 노드 가운데 LLM 요약을 만드는 중인 노드 수 */
  busy: number;
  /** 강조하는 경로 위의 노드면 출발 노드, 도착 노드, 그 사이의 노드 가운데 어느 것인지 */
  route: RouteEnd | "via" | null;
  /** 순환 아이콘을 다는 상자면 묶음마다 든 파일의 이름표. 아니면 null이다. */
  cycle: string[][] | null;
  /** 미사용 후보 표시가 표시하는 후보다 */
  unused: boolean;
  /** 접힌 파일 상자와 접힌 폴더 상자 아래에 적는 미사용 후보 수. 미사용 후보 표시를 껐으면 0이다. */
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

/**
 * 마우스를 올린 노드의 React Flow 노드가 받는 클래스. styles.css가 이 클래스에 굵은 이름표와 옅은 빛을 주고,
 * 한 단계 올린 진하기가 본문 잉크인 노드가 함께 받는 `tone-strong`에 본문 잉크 테두리를 준다.
 */
export const POINTED = "pointed";

/**
 * 마우스를 올린 잎 노드의 변이 바깥으로 나가는 길이(확대하기 전 px). 마우스를 올린 선은 한쪽으로 0.5px씩 굵어지므로 그보다 눈에 띄게 크고,
 * 위아래 이웃과의 간격(layout.ts의 `NODE_GAP`)의 절반인 12px보다 작아 이웃을 덮지 않는 범위에서 사진으로 고른 값이다. 비율이 아닌 길이로 두어
 * 넓은 파일 상자와 작은 함수 노드가 같은 길이만큼 커진다.
 */
export const GROW = 2;

/** 폭 width, 높이 height인 노드의 네 변이 `GROW`만큼 나가는 가로·세로 확대 비율 */
export function grown(width: number, height: number): { x: number; y: number } {
  return { x: (width + 2 * GROW) / width, y: (height + 2 * GROW) / height };
}

/** 노드 위의 요소 target이 눌리는 곳인지. 펼친 파일 상자와 폴더 영역은 머리 줄만 눌린다. */
export function pressable(data: AtlasNodeData, target: EventTarget): boolean {
  const container = data.expanded && (data.node.kind === "module" || data.node.kind === "package");
  return !container || (target as Element).closest(".node-module-head, .node-region-head") !== null;
}

/**
 * 마우스를 올린 노드 id의 React Flow 노드를 선의 hover처럼 진하기를 한 단계 올린(`scope.ts`의 `lifted`) 목록. 노드의 진하기는 muted 잉크
 * 테두리에 그 노드의 불투명도이므로 흐린 노드는 불투명도만 한 단계 오르고, 불투명도 100%인 노드는 테두리가 본문 잉크가 된다.
 * 굵은 이름표와 옅은 빛은 `POINTED` 클래스가 진하기와 관계없이 준다. 펼친 파일 상자와 폴더 영역은 머리 줄을 그리는 글자 요소만 바꾼다.
 * 안에 보이는 자식이 없는 잎 노드는 두 요소에 확대 비율(`grown`)을 `--grow-x`·`--grow-y`로 넣고, styles.css가 그 비율로 노드를 키운다.
 * 다른 노드는 같은 객체를 그대로 돌려주므로 다시 그리지 않는다.
 */
export function pointing<D extends AtlasNodeData>(nodes: Node<D>[], id: string | null): Node<D>[] {
  if (id === null) {
    return nodes;
  }
  const face = faceId(id);
  return nodes.map((node) => {
    const container = node.data.expanded && (node.data.node.kind === "module" || node.data.node.kind === "package");
    if (node.id !== face && (node.id !== id || container)) {
      return node;
    }
    const { tone, opacity } = lifted({ tone: "muted", opacity: Number(node.style?.opacity ?? 1) });
    const scale = node.data.expanded ? null : grown(node.width ?? 0, node.height ?? 0);
    const grow = scale === null || !Number.isFinite(scale.x + scale.y) ? {} : { "--grow-x": scale.x, "--grow-y": scale.y };
    return { ...node, className: tone === "strong" ? `${POINTED} tone-strong` : POINTED, style: { ...node.style, opacity, ...grow } };
  });
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
 * 선택한 노드가 든 파일 상자 안의 노드는 `data-local`을, 마지막 커밋 뒤에 바뀐 노드는 `data-change`를,
 * 강조하는 경로 위의 노드는 `data-route`를 받는다.
 * 순환 아이콘을 다는 상자는 `data-cycle`을, 미사용 후보 표시가 표시하는 후보는 `data-unused`를 받는다.
 */
export function nodeProps(base: string, data: AtlasNodeData, change: Change | null) {
  return {
    className: `${base} node-${data.part}${data.selected ? " node-selected" : ""}`,
    "data-flow": data.flow ? "" : undefined,
    "data-local": data.local ? "" : undefined,
    "data-change": change ?? undefined,
    "data-route": data.route ?? undefined,
    "data-cycle": data.cycle !== null ? "" : undefined,
    "data-unused": data.unused ? "" : undefined,
  };
}

/** 진입점 표지인 굵은 체크의 윤곽. 12px 칸에 그린다. */
export const ENTRY_PATH = "M1.2 6.5 L3 4.8 L4.9 7 L9.2 1.6 L11 3 L5.1 10.5 Z";

/** 굵은 체크 아이콘. 글자 색으로 채운다. */
export function EntryIcon() {
  return (
    <svg className="entry-icon" viewBox="0 0 12 12" width={12} height={12} aria-hidden>
      <path d={ENTRY_PATH} />
    </svg>
  );
}

/** 이름 앞의 진입점 표지. 폭은 layout.ts의 ENTRY_MARK_WIDTH가 잡는다. 마우스를 올리면 말풍선이 뜨고 접근성 이름은 "진입점"이다. */
export function EntryMark({ className }: { className?: string }) {
  return (
    <span className={className === undefined ? "entry-mark" : `entry-mark ${className}`} role="img" aria-label="진입점" data-tip={ENTRY_TIP}>
      <EntryIcon />
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

/** 이름표. 강조하는 경로의 출발 노드와 도착 노드는 이름표 뒤에 표지를 적는다. 표지의 폭은 layout.ts가 노드 크기에 더한다. */
export function Label({ data, bold = false }: { data: AtlasNodeData; bold?: boolean }) {
  return (
    <>
      <span className={bold ? "node-label node-label-bold" : "node-label"}>
        {data.cycle !== null && <CycleMark tip={cycleTip(data.node, data.cycle)} />}
        {data.node.entry && <EntryMark className="node-entry" />}
        {labelOf(data.node)}
      </span>
      {data.route !== null && data.route !== "via" && (
        <span className="route-end" style={{ marginLeft: END_GAP, padding: `0 ${END_PAD}px` }}>
          {END_NAMES[data.route]}
        </span>
      )}
    </>
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
 * 감싼 모양의 오른쪽 위 모서리에 접힌 상자 안에 든 것의 수를, 오른쪽 아래 모서리에 모듈 변수 변경을 달고, LLM 요약을 만드는 중이면
 * 도는 표시를 그린다. 도는 표시는 감싼 모양이 원(`circle`)이면 그 원의 테두리 위에서 도는 고리이고, 아니면 왼쪽 위 모서리의
 * 도는 원이다. 글자 요소에만 그린다. 배지의 바깥쪽 끝은 모양의 그쪽 끝에서 `BADGE_OVERHANG`만큼 나간다.
 * 배지마다 뜻을 적은 말풍선 글(`tips.ts`)을 `data-tip`에 담는다.
 */
export function Badges({ data, circle = false }: { data: AtlasNodeData; circle?: boolean }) {
  if (data.part === "body") {
    return null;
  }
  const style = { "--overhang": `${BADGE_OVERHANG}px` } as CSSProperties;
  return (
    <>
      {data.busy > 0 && (
        <span
          className={circle ? "busy-ring" : "badge badge-busy"}
          style={circle ? undefined : style}
          role="img"
          aria-label="요약을 만드는 중"
          data-tip={busyTip(data.node, data.busy)}
        />
      )}
      {data.inside > 0 && (
        <span className="badge badge-inside" style={style} data-tip={insideTip(data.node, data.inside)}>
          {data.inside}
        </span>
      )}
      {data.writes.length > 0 && (
        <span className="badge badge-global" style={style} data-tip={globalTip(data.writes)}>
          g
        </span>
      )}
    </>
  );
}

/** 함수·메서드의 지름 16px 원. 바탕 요소가 테두리와 채움을, 글자 요소가 배지와 선택 고리, 테두리 위에서 도는 고리를 그린다. */
export function Circle({ data }: { data: AtlasNodeData }) {
  return (
    <span className="node-circle" style={{ marginRight: CIRCLE_GAP }}>
      <Badges data={data} circle />
    </span>
  );
}

/** 지름 16px 원과 같은 칸에 그리는 마름모의 꼭짓점. 테두리 굵기 1.5px의 뾰족한 끝이 칸의 변에 닿는다. */
export const DIAMOND_POINTS = "8,1 15,8 8,15 1,8";
/** 선택 고리. 원의 선택 고리처럼 마름모의 테두리에서 2px 띄운 굵기 3px 테두리다. */
const DIAMOND_RING = "8,-4.5 20.5,8 8,20.5 -4.5,8";

/** 모듈 변수의 마름모. 바탕 요소가 테두리와 채움을, 글자 요소가 선택 고리를 그린다. 배지를 달지 않는다. */
export function Diamond({ data }: { data: AtlasNodeData }) {
  return (
    <svg className="node-diamond" viewBox="0 0 16 16" style={{ marginRight: CIRCLE_GAP }} aria-hidden>
      {data.part === "face" && data.selected && <polygon className="node-diamond-ring" points={DIAMOND_RING} />}
      <polygon points={DIAMOND_POINTS} />
    </svg>
  );
}

/** 변수 노드의 줄 수 숫자 뒤에 적는 값의 종류와 원소 수 */
export function Aside({ data }: { data: AtlasNodeData }) {
  return (
    <span className="node-aside" style={{ marginLeft: ASIDE_GAP }}>
      {valueAside(data.node)}
    </span>
  );
}

/** 접힌 파일 상자와 접힌 폴더 상자 아래의 글자. 미사용 후보 표시를 켰을 때의 미사용 후보 수를 적고 그 뜻을 말풍선 글에 담는다. */
export function Below({ data }: { data: AtlasNodeData }) {
  const text = boxCaption(data.candidates);
  return text === "" ? null : (
    <span className="node-below" data-tip={candidatesTip(data.node, data.candidates)}>
      {text}
    </span>
  );
}
