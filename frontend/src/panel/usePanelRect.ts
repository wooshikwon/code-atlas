// 정보 패널의 사각형을 저장소에서 읽어 관계 그래프 영역에 맞추고, 머리 줄과 손잡이를 끄는 동작을 사각형으로 바꾼다.
// 코드 뷰어가 없는 내용은 사용자가 손잡이로 높이를 바꾸기 전까지 패널 높이를 내용에 맞춘다.
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useAtlas, type Rect } from "../state/store";
import { clamp, move, resize, type Area, type Dir } from "./rect";

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 420;
const DEFAULT_GAP = 8;
/** 사용자가 손잡이로 패널 높이를 바꾼 적이 있으면 "1"을 담는 localStorage 키 */
const SIZED_KEY = "code-atlas:panel-sized:v1";

export type Grip = "move" | Dir;

interface PanelRect {
  ref: RefObject<HTMLDivElement | null>;
  /** 관계 그래프 영역의 크기를 재기 전에는 null이다. */
  rect: Rect | null;
  /** 패널 높이를 내용에 맞추고 rect의 높이를 넘지 않게 한다. */
  fitted: boolean;
  /** 머리 줄("move")이나 손잡이의 pointerdown에 넣는 처리기 */
  grip: (kind: Grip) => (event: ReactPointerEvent<HTMLElement>) => void;
}

/** fitted면 높이를 내용에 맞추고 rect의 높이를 넘지 않게 한다. */
function place(element: HTMLElement, rect: Rect, fitted: boolean): void {
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = fitted ? "" : `${rect.height}px`;
  element.style.maxHeight = fitted ? `${rect.height}px` : "";
}

/** compact는 내용에 코드 뷰어가 없을 때 참이다. */
export function usePanelRect(compact: boolean): PanelRect {
  const ref = useRef<HTMLDivElement | null>(null);
  const saved = useAtlas((s) => s.panel);
  const setPanel = useAtlas((s) => s.setPanel);
  const [area, setArea] = useState<Area | null>(null);
  const [sized, setSized] = useState(() => localStorage.getItem(SIZED_KEY) === "1");
  const fitted = compact && !sized;

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
    /** 위쪽·아래쪽 가장자리를 옮기는 손잡이는 패널 높이를 정한다. 내용에 맞춘 패널은 화면에 그린 높이에서 출발한다. */
    const sizing = kind !== "move" && (kind.includes("n") || kind.includes("s"));
    const from = fitted && sizing ? { ...rect, height: panel.offsetHeight } : rect;
    /** 세로로 끌지 않았을 때의 높이. 내용에 맞춘 높이가 최소 높이보다 낮으면 최소 높이다. */
    const rest = kind === "move" ? from.height : resize(from, kind, 0, 0, area).height;
    /** 끌어서 정한 사각형. 높이가 rest와 같으면 높이를 바꾼 것으로 치지 않고 저장한 높이를 유지한다. */
    let last: Rect | null = null;
    let tall = false;

    const onMove = (moved: PointerEvent) => {
      const dx = moved.clientX - clientX;
      const dy = moved.clientY - clientY;
      const next = kind === "move" ? move(from, dx, dy, area) : resize(from, kind, dx, dy, area);
      tall = sizing && next.height !== rest;
      last = tall ? next : { ...next, height: rect.height };
      place(panel, last, fitted && !tall);
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      handle.removeEventListener("lostpointercapture", onEnd);
      document.body.style.userSelect = "";
      if (last !== null) {
        setPanel(last);
        if (tall) {
          localStorage.setItem(SIZED_KEY, "1");
          setSized(true);
        }
      }
    };
    handle.setPointerCapture(pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
    handle.addEventListener("lostpointercapture", onEnd);
    document.body.style.userSelect = "none";
  };

  return { ref, rect, fitted, grip };
}
