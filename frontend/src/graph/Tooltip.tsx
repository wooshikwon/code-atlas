// 앱의 말풍선. 문서 최상위의 고정 위치 요소 하나를 마우스 옆으로 옮기고, App이 한 번 그린다.
// 그래프의 노드는 그래프 뷰가, 미니맵의 폴더와 파일은 미니맵이 `tooltip`으로 글을 띄우고, 선은 세 칸 말풍선(`LineBubble.tsx`)을 따로 띄운다. 그 밖의 요소는 `data-tip`·`data-full`에 글을 담고(`tips.ts`의 `tipOf`),
// 마우스를 올리거나 키보드 초점을 받았을 때 이 컴포넌트가 띄운다.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tipOf } from "./tips";

export interface TooltipHandle {
  /** 내용을 바꾸고 마우스 위치 옆에 보인다. text가 null이면 감춘다. */
  show(text: string | null, x: number, y: number): void;
  move(x: number, y: number): void;
  hide(): void;
}

const GAP_X = 14;
const GAP_Y = 16;
const EDGE = 8;
/** 키보드 초점을 받은 요소의 아래 끝과 말풍선 사이 */
const FOCUS_GAP = 4;

/** 요소 el을 마우스 (x, y)의 오른쪽 아래에 놓고, 화면 오른쪽·아래 끝을 넘으면 마우스 반대쪽으로 뒤집는다. 선의 말풍선(`LineBubble.tsx`)도 쓴다. */
export function placeBeside(el: HTMLElement, x: number, y: number): void {
  const left = x + GAP_X + el.offsetWidth > window.innerWidth - EDGE ? x - GAP_X - el.offsetWidth : x + GAP_X;
  const top = y + GAP_Y + el.offsetHeight > window.innerHeight - EDGE ? y - GAP_Y - el.offsetHeight : y + GAP_Y;
  el.style.transform = `translate(${Math.max(EDGE, left)}px, ${Math.max(EDGE, top)}px)`;
}

let drawn: TooltipHandle | null = null;

/** 화면에 그린 말풍선. `Tooltip`을 그리기 전에는 아무 일도 하지 않는다. */
export const tooltip: TooltipHandle = {
  show: (text, x, y) => drawn?.show(text, x, y),
  move: (x, y) => drawn?.move(x, y),
  hide: () => drawn?.hide(),
};

/** 그래프의 노드와 선, 미니맵 위인지. 그 위의 말풍선은 그래프 뷰와 미니맵이 띄운다. */
const inGraph = (target: EventTarget | null) => target instanceof Element && target.closest(".react-flow__viewport, .graph-minimap") !== null;

export function Tooltip() {
  const element = useRef<HTMLDivElement | null>(null);
  const at = useRef({ x: 0, y: 0 });
  const [text, setText] = useState<string | null>(null);

  const place = () => {
    if (element.current !== null) {
      placeBeside(element.current, at.current.x, at.current.y);
    }
  };

  useEffect(() => {
    const handle: TooltipHandle = {
      show: (next, x, y) => {
        at.current = { x, y };
        setText(next);
        place();
      },
      move: (x, y) => {
        at.current = { x, y };
        place();
      },
      hide: () => setText(null),
    };
    drawn = handle;

    /** 마우스 아래에서 글을 담은 요소. 그 요소 위에서 움직이는 동안 말풍선이 마우스를 따라간다. */
    let held = false;
    const over = (event: MouseEvent) => {
      if (inGraph(event.target) || event.buttons !== 0) {
        return;
      }
      const found = tipOf(event.target);
      held = found !== null;
      handle.show(found, event.clientX, event.clientY);
    };
    const move = (event: MouseEvent) => held && handle.move(event.clientX, event.clientY);
    const focus = (event: FocusEvent) => {
      const target = event.target;
      const found = target instanceof Element && target.matches(":focus-visible") ? tipOf(target) : null;
      if (found !== null) {
        const rect = (target as Element).getBoundingClientRect();
        handle.show(found, rect.left - GAP_X, rect.bottom + FOCUS_GAP - GAP_Y);
      }
    };
    const hide = () => {
      held = false;
      handle.hide();
    };
    /** 그래프의 노드와 선, 미니맵을 누를 때의 말풍선은 그래프 뷰와 미니맵이 클릭을 처리하며 감춘다. */
    const press = (event: MouseEvent) => !inGraph(event.target) && hide();
    document.addEventListener("mouseover", over);
    document.addEventListener("mousemove", move);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("mousedown", press, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    return () => {
      drawn = null;
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("mousedown", press, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
    };
  }, []);

  useLayoutEffect(place, [text]);

  if (text === null) {
    return null;
  }
  return createPortal(
    <div ref={element} className="tooltip" role="tooltip">
      {text}
    </div>,
    document.body,
  );
}
