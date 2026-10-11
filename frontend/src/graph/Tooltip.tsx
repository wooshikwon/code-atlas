// 노드와 선 위에 띄우는 말풍선. 문서 최상위의 고정 위치 요소 하나를 마우스 옆으로 옮긴다.
import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";

export interface TooltipHandle {
  /** 내용을 바꾸고 마우스 위치 옆에 보인다. text가 null이면 감춘다. */
  show(text: string | null, x: number, y: number): void;
  move(x: number, y: number): void;
  hide(): void;
}

const GAP_X = 14;
const GAP_Y = 16;
const EDGE = 8;

export function Tooltip({ ref }: { ref: Ref<TooltipHandle> }) {
  const element = useRef<HTMLDivElement | null>(null);
  const at = useRef({ x: 0, y: 0 });
  const [text, setText] = useState<string | null>(null);

  /** 마우스 오른쪽 아래에 놓고, 화면 오른쪽·아래 끝을 넘으면 마우스 반대쪽으로 뒤집는다. */
  const place = () => {
    const el = element.current;
    if (el === null) {
      return;
    }
    const { x, y } = at.current;
    const left = x + GAP_X + el.offsetWidth > window.innerWidth - EDGE ? x - GAP_X - el.offsetWidth : x + GAP_X;
    const top = y + GAP_Y + el.offsetHeight > window.innerHeight - EDGE ? y - GAP_Y - el.offsetHeight : y + GAP_Y;
    el.style.transform = `translate(${Math.max(EDGE, left)}px, ${Math.max(EDGE, top)}px)`;
  };

  useImperativeHandle(ref, () => ({
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
  }));

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
