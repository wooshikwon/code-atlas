// 커서 밑을 지나는 선의 집합으로 선의 hover와 클릭을 판정한다. 구조 뷰와 함수 시점 뷰가 함께 쓴다. 화면을 끄는 동안에는 hover를 받지 않는다.
// 선에 마우스를 올리면 그 구간을 지나는 선을 강조하고 말풍선(`LineBubble.tsx`)에 선마다 푼 줄(`rows.ts`)을 적는다.
// 선을 누르면 선이 하나여도 그 말풍선을 그곳에 고정하고, 줄의 출발·도착 이름을 누르면 그 노드로, 관계를 누르면 코드 줄 목록으로 간다.
import { useReactFlow, type EdgeMouseHandler } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { create } from "zustand";
import type { FlowEdge } from "./edges/OrthogonalEdge";
import type { Box, Point } from "./layout";
import { LineBubble, moveBubble, type Bubble } from "./LineBubble";
import type { CellName, LineRow } from "./rows";
import { type EdgeKey } from "./scope";
import { tooltip } from "./Tooltip";
import { trunkKey, type EdgeView, type Lines } from "./view";

/** 선의 누름 영역(`.edge-hit`, 폭 12px)의 절반. 커서에서 이 거리 안을 지나는 선을 커서 밑의 선으로 본다. */
export const REACH = 6;

/** 점 at에서 reach 안을 지나는 선. 선의 출발부터 도착까지의 경로로 본다. */
export function linesAt(views: EdgeView[], at: Point, reach = REACH): EdgeView[] {
  const near = (a: Point, b: Point) => {
    const [dx, dy] = [b.x - a.x, b.y - a.y];
    const span = dx * dx + dy * dy;
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / span));
    return Math.hypot(a.x + t * dx - at.x, a.y + t * dy - at.y) <= reach;
  };
  return views.filter((view) => view.points.slice(1).some((b, i) => near(view.points[i], b)));
}

/** 선의 도착 노드가 모두 같으면 그 노드, 아니면 null이다. */
export function sameTarget(views: EdgeView[]): string | null {
  return views.length > 0 && views.every((view) => view.target === views[0].target) ? views[0].target : null;
}

interface PickStore {
  /** 떠 있거나 고정한 말풍선 */
  bubble: Bubble | null;
  /** 고정한 말풍선에서 마우스를 올리거나 초점을 둔 줄의 선 */
  hover: EdgeKey | null;
  show(bubble: Bubble): void;
  aim(key: EdgeKey | null): void;
  /** 말풍선을 거둔다. 고정한 말풍선이었으면 참을 돌려준다. Esc가 선택을 풀기 전에 이 함수를 먼저 부른다. */
  close(): boolean;
}

export const usePick = create<PickStore>()((set, get) => ({
  bubble: null,
  hover: null,
  show: (bubble) => set({ bubble, hover: null }),
  aim: (hover) => set({ hover }),
  close: () => {
    const pinned = get().bubble?.pinned === true;
    if (get().bubble !== null) {
      set({ bubble: null, hover: null });
    }
    return pinned;
  },
}));

interface AimOptions {
  lines: Lines;
  /** 노드의 화면 기준 상자. 말풍선의 줄을 출발 노드의 위에서 아래, 왼쪽에서 오른쪽 순서로 놓는 데 쓴다. */
  boxes: Map<string, Box>;
  /** 줄의 출발 노드나 도착 노드 id를 말풍선의 칸에 적는 이름 */
  name: (row: LineRow, id: string) => CellName;
  /** 선 하나를 말풍선의 줄로 푼다. */
  rows: (view: EdgeView) => LineRow[];
  /** 경로 고정 중이면 걸음인 선만 강조한다. 고정 중이 아니면 null이다. */
  only: ((view: EdgeView) => boolean) | null;
  /** 누른 것을 받지 않을 때 참을 돌려준다(더블클릭의 둘째 클릭). */
  skip: (event: ReactMouseEvent) => boolean;
  /** 말풍선의 이름을 눌러 선 keys를 따라 노드 to로 간다. */
  go: (to: string, keys: EdgeKey[]) => void;
  /** 선이나 줄기의 코드 줄 목록을 연다. */
  open: (key: EdgeKey) => void;
}

/**
 * 선의 hover와 클릭 처리. pointed는 마우스를 올린 선으로 그릴 선의 키다. 커서 밑의 선이 하나면 그 선, 여럿이면 그 구간을 지나는 선이고,
 * 말풍선을 고정한 동안에는 그 말풍선의 선이며 줄에 올리면 그 줄의 선 하나다. bubble은 그릴 말풍선이다.
 */
export function useAim({ lines, boxes, name, rows, only, skip, go, open }: AimOptions) {
  const { screenToFlowPosition } = useReactFlow();
  const [aimed, setAimed] = useState<EdgeKey[]>([]);
  const bubble = usePick((s) => s.bubble);
  const hover = usePick((s) => s.hover);
  const state = useRef({ lines, boxes });
  state.current = { lines, boxes };
  useEffect(() => () => void usePick.getState().close(), []);
  // 배치가 바뀌거나 뷰를 떠나면 선과 노드가 커서 밑에서 옮겨 가므로 강조와 말풍선을 거둔다.
  useEffect(() => {
    setAimed([]);
    usePick.getState().close();
    tooltip.hide();
    return () => tooltip.hide();
  }, [boxes]);

  /** 커서 밑의 선. 출발 노드의 위에서 아래, 왼쪽에서 오른쪽 순서다. */
  const under = (event: ReactMouseEvent): EdgeView[] => {
    const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const place = (view: EdgeView) => state.current.boxes.get(view.source) ?? { x: 0, y: 0 };
    return linesAt(state.current.lines.views, at).sort((a, b) => place(a).y - place(b).y || place(a).x - place(b).x);
  };
  /**
   * 선 views를 푼 말풍선의 줄. 함수 단계에서 풀어 적을 끝이 없어 누를 수 없는 안내 줄은 다른 줄이 있으면 적지 않고, 줄이 그런 줄뿐이면 그대로 적는다.
   */
  const table = (views: EdgeView[]): LineRow[] => {
    const all = views.flatMap(rows);
    const live = all.filter((row) => row.keys !== null);
    return live.length > 0 ? live : all;
  };
  const lit = (views: EdgeView[]) => (only === null ? views : views.filter(only)).map((view) => view.key);
  const onEdgeLeave = () => {
    if (usePick.getState().bubble?.pinned === true) {
      return;
    }
    setAimed((before) => (before.length === 0 ? before : []));
    usePick.getState().close();
  };
  /** 마우스 버튼을 누른 동안(화면을 끄는 동안)에는 선을 강조하지 않고 말풍선을 띄우지 않는다. */
  const over: EdgeMouseHandler<FlowEdge> = (event) => {
    const shown = usePick.getState().bubble;
    if (shown?.pinned === true) {
      return;
    }
    const views = event.buttons !== 0 ? [] : under(event);
    if (views.length === 0) {
      onEdgeLeave();
      return;
    }
    const keys = lit(views);
    setAimed((before) => (before.join("\n") === keys.join("\n") ? before : keys));
    const drawn = views.map((view) => view.key).join("\n");
    if (shown !== null && shown.lines === drawn) {
      moveBubble(event.clientX, event.clientY);
    } else {
      usePick.getState().show({ x: event.clientX, y: event.clientY, rows: table(views), pinned: false, lit: keys, lines: drawn });
    }
  };
  const onEdgeClick: EdgeMouseHandler<FlowEdge> = (event) => {
    tooltip.hide();
    setAimed([]);
    usePick.getState().close();
    if (skip(event)) {
      return;
    }
    const all = under(event);
    const steps = only === null ? all : all.filter(only);
    const views = steps.length > 0 ? steps : all;
    const target = sameTarget(views);
    if (views.length === 0) {
      return;
    }
    if (event.shiftKey && (views.length === 1 || target !== null)) {
      open(views.length === 1 ? views[0].key : (views[0].trunks.in ?? trunkKey(views[0].target, "in", 0)));
      return;
    }
    usePick.getState().show({ x: event.clientX, y: event.clientY, rows: table(views), pinned: true, lit: lit(views), lines: views.map((view) => view.key).join("\n") });
  };

  const pointed = useMemo(
    () => new Set(bubble?.pinned === true ? (hover === null ? bubble.lit : bubble.lit.filter((key) => key === hover)) : aimed),
    [bubble, hover, aimed],
  );
  const element =
    bubble === null ? null : (
      <LineBubble
        bubble={bubble}
        name={name}
        aim={usePick.getState().aim}
        go={(row, id) => {
          usePick.getState().close();
          go(id, row.keys ?? []);
        }}
        list={(row) => {
          usePick.getState().close();
          if (row.list !== null) {
            open(row.list);
          }
        }}
        close={usePick.getState().close}
      />
    );
  return { pointed, onEdgeEnter: over, onEdgeMove: over, onEdgeLeave, onEdgeClick, bubble: element };
}
