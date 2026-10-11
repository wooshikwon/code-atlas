// 상단 줄의 펼치는 목록이 함께 쓰는 접기 동작.
import { useEffect, type RefObject } from "react";

/** 목록이 펼쳐진 동안 root 밖을 누르거나 Esc를 누르면 목록을 접는다. */
export function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node) !== true) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, root, setOpen]);
}
