// 커서 밑을 지나는 선의 집합으로 선의 hover와 클릭을 판정한다. 구조 뷰와 함수 시점 뷰가 함께 쓴다.
// 선이 하나면 그 선을 강조하고 누르면 도착 노드를 고른다. 여럿이면 그 구간을 지나는 선만 강조하고 말풍선에 한 줄씩 적는다.
// 도착 노드가 모두 같으면 누를 때 그 노드를 고르고, 둘 이상이면 누른 자리에 선을 고르는 목록을 고정한다.
import { useReactFlow, type EdgeMouseHandler } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import type { FlowEdge } from "./edges/OrthogonalEdge";
import type { Box, Point } from "./layout";
import { type EdgeKey } from "./scope";
import { trunkTip } from "./tips";
import type { TooltipHandle } from "./Tooltip";
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

/** 선을 고르는 목록 하나. 누른 화면 좌표에 고정한다. open이 참이면 고른 선의 코드 줄 목록을 연다. */
interface Menu {
  x: number;
  y: number;
  items: { key: EdgeKey; target: string; text: string }[];
  open: boolean;
}

interface PickStore {
  menu: Menu | null;
  /** 목록에서 마우스를 올린 선 */
  hover: EdgeKey | null;
  show(menu: Menu): void;
  aim(key: EdgeKey | null): void;
  /** 목록을 닫는다. 열려 있었으면 참을 돌려준다. Esc가 선택을 풀기 전에 이 함수를 먼저 부른다. */
  close(): boolean;
}

export const usePick = create<PickStore>()((set, get) => ({
  menu: null,
  hover: null,
  show: (menu) => set({ menu, hover: null }),
  aim: (hover) => set({ hover }),
  close: () => {
    const opened = get().menu !== null;
    set({ menu: null, hover: null });
    return opened;
  },
}));

interface AimOptions {
  lines: Lines;
  /** 노드의 화면 기준 상자. 목록과 말풍선의 줄을 출발 노드의 위에서 아래, 왼쪽에서 오른쪽 순서로 놓는 데 쓴다. */
  boxes: Map<string, Box>;
  tip: RefObject<TooltipHandle | null>;
  name: (id: string) => string;
  /** 선 하나를 적는 줄: `출발 → 도착 · 분류 · M곳` */
  describe: (view: EdgeView) => string;
  /** 경로 고정 중이면 걸음인 선만 대상으로 본다. 고정 중이 아니면 null이다. */
  only: ((view: EdgeView) => boolean) | null;
  /** 누른 것을 받지 않을 때 참을 돌려준다(더블클릭의 둘째 클릭). */
  skip: (event: ReactMouseEvent) => boolean;
  /** 도착 노드를 고른다. */
  pick: (target: string) => void;
  /** 선이나 줄기의 코드 줄 목록을 연다. */
  open: (key: EdgeKey) => void;
}

/**
 * 선의 hover와 클릭 처리. pointed는 마우스를 올린 선으로 그릴 선의 키다. 커서 밑의 선이 하나면 그 선, 여럿이면 그 구간을 지나는 선이고,
 * 고정한 목록의 항목에 올리면 그 선 하나다. menu는 고정한 목록이다.
 */
export function useAim({ lines, boxes, tip, name, describe, only, skip, pick, open }: AimOptions) {
  const { screenToFlowPosition } = useReactFlow();
  const [aimed, setAimed] = useState<EdgeKey[]>([]);
  const menu = usePick((s) => s.menu);
  const hover = usePick((s) => s.hover);
  const state = useRef({ lines, boxes });
  state.current = { lines, boxes };
  useEffect(() => () => void usePick.getState().close(), []);

  /** 커서 밑의 선. 출발 노드의 위에서 아래, 왼쪽에서 오른쪽 순서다. */
  const under = (event: ReactMouseEvent): EdgeView[] => {
    const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const place = (view: EdgeView) => state.current.boxes.get(view.source) ?? { x: 0, y: 0 };
    return linesAt(state.current.lines.views, at).sort((a, b) => place(a).y - place(b).y || place(a).x - place(b).x);
  };
  const text = (views: EdgeView[]): string => {
    const target = sameTarget(views);
    const rows = views.map(describe);
    if (views.length < 2 || target === null) {
      return rows.join("\n");
    }
    const sites = views.reduce((sum, view) => sum + view.sites, 0);
    return [trunkTip(new Set(views.map((view) => view.source)).size, name(target), sites), ...rows].join("\n");
  };
  const over: EdgeMouseHandler<FlowEdge> = (event) => {
    if (usePick.getState().menu !== null) {
      return;
    }
    const views = under(event);
    const keys = (only === null ? views : views.filter(only)).map((view) => view.key);
    setAimed((before) => (before.join("\n") === keys.join("\n") ? before : keys));
    if (views.length === 0) {
      tip.current?.hide();
    } else {
      tip.current?.show(text(views), event.clientX, event.clientY);
    }
  };
  const onEdgeLeave = () => {
    setAimed([]);
    tip.current?.hide();
  };
  const onEdgeClick: EdgeMouseHandler<FlowEdge> = (event) => {
    tip.current?.hide();
    setAimed([]);
    const opened = usePick.getState().close();
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
    if (views.length === 1 || target !== null) {
      if (event.shiftKey) {
        open(views.length === 1 ? views[0].key : (views[0].trunk ?? trunkKey(views[0].target, 0)));
      } else {
        pick(views[0].target);
      }
      return;
    }
    if (!opened) {
      usePick.getState().show({
        x: event.clientX,
        y: event.clientY,
        items: views.map((view) => ({ key: view.key, target: view.target, text: describe(view) })),
        open: event.shiftKey,
      });
    }
  };

  const pointed = useMemo(() => new Set(menu !== null ? (hover === null ? [] : [hover]) : aimed), [menu, hover, aimed]);
  const element =
    menu === null ? null : (
      <LineMenu
        menu={menu}
        choose={(item) => {
          usePick.getState().close();
          if (menu.open) {
            open(item.key);
          } else {
            pick(item.target);
          }
        }}
      />
    );
  return { pointed, onEdgeEnter: over, onEdgeMove: over, onEdgeLeave, onEdgeClick, menu: element };
}

/** 누른 자리에 고정한 선 목록. 항목에 올리면 그 선을 강조하고 누르면 고른다. 목록 밖을 누르면 닫는다. */
function LineMenu({ menu, choose }: { menu: Menu; choose: (item: Menu["items"][number]) => void }) {
  const element = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      // 선을 누른 것은 그 선의 클릭 처리가 목록을 닫거나 바꾼다.
      const target = event.target as Element;
      if (element.current?.contains(target) !== true && target.closest(".react-flow__edge") === null) {
        usePick.getState().close();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);
  return createPortal(
    <ul ref={element} className="line-menu" role="menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => usePick.getState().aim(null)}>
      {menu.items.map((item) => (
        <li key={item.key} role="none">
          <button className="line-menu-item" role="menuitem" data-key={item.key} onMouseEnter={() => usePick.getState().aim(item.key)} onClick={() => choose(item)}>
            {item.text}
          </button>
        </li>
      ))}
    </ul>,
    document.body,
  );
}
