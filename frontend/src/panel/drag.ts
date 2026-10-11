// 정보 패널의 머리 줄, 손잡이, 경계선을 끄는 동작. 포인터를 누른 요소가 포인터를 붙잡아, 끄는 동안 포인터가 코드 뷰어나 그래프 위를 지나도 끊기지 않는다.
import type { PointerEvent as ReactPointerEvent } from "react";

/** pointerdown부터 포인터를 뗄 때까지 누른 곳에서 옮긴 거리를 moved에 넘기고, 떼면 ended를 부른다. */
export function drag(event: ReactPointerEvent<HTMLElement>, moved: (dx: number, dy: number) => void, ended: () => void): void {
  event.preventDefault();
  const handle = event.currentTarget;
  const { pointerId, clientX, clientY } = event;
  const onMove = (at: PointerEvent) => moved(at.clientX - clientX, at.clientY - clientY);
  const onEnd = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onEnd);
    handle.removeEventListener("pointercancel", onEnd);
    handle.removeEventListener("lostpointercapture", onEnd);
    document.body.style.userSelect = "";
    ended();
  };
  handle.setPointerCapture(pointerId);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onEnd);
  handle.addEventListener("pointercancel", onEnd);
  handle.addEventListener("lostpointercapture", onEnd);
  document.body.style.userSelect = "none";
}
