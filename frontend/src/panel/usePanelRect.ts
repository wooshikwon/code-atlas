// 정보 패널의 비율 사각형을 저장소에서 읽어 관계 그래프 영역의 픽셀 사각형으로 바꾸고, 머리 줄과 손잡이를 끄는 동작을 사각형으로 바꾼다.
// 저장한 비율 사각형이 없으면 영역 폭의 40%를 차지하고 위·오른쪽·아래 끝에서 영역 폭의 1%씩 띄운 기본 사각형을 쓴다.
// 두 사각형 모두 영역의 크기가 바뀔 때마다 다시 계산한다.
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useAtlas, type Rect } from "../state/store";
import { drag } from "./drag";
import { initial, move, resize, scale, share, type Area, type Dir } from "./rect";

export type Grip = "move" | Dir;

interface PanelRect {
  ref: RefObject<HTMLDivElement | null>;
  /** 관계 그래프 영역의 크기를 재기 전에는 null이다. */
  rect: Rect | null;
  /** 머리 줄("move")이나 손잡이의 pointerdown에 넣는 처리기 */
  grip: (kind: Grip) => (event: ReactPointerEvent<HTMLElement>) => void;
  /** 저장한 비율 사각형을 지워 기본 사각형으로 돌아간다. */
  reset: () => void;
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

  const rect = area === null ? null : saved === null ? initial(area) : scale(saved, area);

  const grip = (kind: Grip) => (event: ReactPointerEvent<HTMLElement>) => {
    const panel = ref.current;
    if (event.button !== 0 || panel === null || rect === null || area === null) {
      return;
    }
    /** 끌어서 정한 사각형. 포인터가 움직이지 않았으면 null이고 저장하지 않는다. */
    let last: Rect | null = null;
    drag(
      event,
      (dx, dy) => {
        last = kind === "move" ? move(rect, dx, dy, area) : resize(rect, kind, dx, dy, area);
        place(panel, last);
      },
      () => {
        if (last !== null) {
          setPanel(share(last, area));
        }
      },
    );
  };

  return { ref, rect, grip, reset: () => setPanel(null) };
}
