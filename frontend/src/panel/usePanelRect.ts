// 정보 패널의 사각형을 저장소에서 읽어 관계 그래프 영역에 맞추고, 머리 줄과 손잡이를 끄는 동작을 사각형으로 바꾼다.
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useAtlas, type Rect } from "../state/store";
import { clamp, move, resize, type Area, type Dir } from "./rect";

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 420;
const DEFAULT_GAP = 8;

export type Grip = "move" | Dir;

interface PanelRect {
  ref: RefObject<HTMLDivElement | null>;
  /** 관계 그래프 영역의 크기를 재기 전에는 null이다. */
  rect: Rect | null;
  /** 머리 줄("move")이나 손잡이의 pointerdown에 넣는 처리기 */
  grip: (kind: Grip) => (event: ReactPointerEvent<HTMLElement>) => void;
}

function place(element: HTMLElement, rect: Rect): void {
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

export function usePanelRect(): PanelRect {
  const ref = useRef<HTMLDivElement | null>(null);
  const saved = useAtlas((s) => s.panel);
  const setPanel = useAtlas((s) => s.setPanel);
  const [area, setArea] = useState<Area | null>(null);

  useLayoutEffect(() => {
    const stage = ref.current?.parentElement;
    if (stage == null) {
      return;
    }
    const measure = () => setArea({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const rect =
    area === null
      ? null
      : clamp(
          saved ?? {
            x: area.width - DEFAULT_WIDTH - DEFAULT_GAP,
            y: DEFAULT_GAP,
            width: DEFAULT_WIDTH,
            height: Math.min(DEFAULT_HEIGHT, area.height - 2 * DEFAULT_GAP),
          },
          area,
        );

  const grip = (kind: Grip) => (event: ReactPointerEvent<HTMLElement>) => {
    const panel = ref.current;
    if (event.button !== 0 || panel === null || rect === null || area === null) {
      return;
    }
    event.preventDefault();
    const handle = event.currentTarget;
    const { pointerId, clientX, clientY } = event;
    let last: Rect | null = null;

    const onMove = (moved: PointerEvent) => {
      const dx = moved.clientX - clientX;
      const dy = moved.clientY - clientY;
      last = kind === "move" ? move(rect, dx, dy, area) : resize(rect, kind, dx, dy, area);
      place(panel, last);
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      handle.removeEventListener("lostpointercapture", onEnd);
      document.body.style.userSelect = "";
      if (last !== null) {
        setPanel(last);
      }
    };
    handle.setPointerCapture(pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
    handle.addEventListener("lostpointercapture", onEnd);
    document.body.style.userSelect = "none";
  };

  return { ref, rect, grip };
}
