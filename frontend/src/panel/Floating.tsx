// 가로창 모드의 정보 패널 틀. 관계 그래프 위에 떠 있는 사각형이고, 머리 줄을 끌어 옮기고 손잡이 여덟 개를 끌어 크기를 바꾼다.
import type { CSSProperties } from "react";
import { PanelBody } from "./InfoPanel";
import { MIN_CODE, MIN_SUMMARY, type Dir } from "./rect";
import { usePanelRect } from "./usePanelRect";

const DIRS: Dir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function Floating() {
  const { ref, rect, grip, reset } = usePanelRect();
  return (
    <div
      ref={ref}
      className="info-panel"
      style={
        rect === null
          ? undefined
          : ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height, "--panel-height": `${rect.height}px`, "--summary-min": `${MIN_SUMMARY}px`, "--code-min": `${MIN_CODE}px` } as CSSProperties)
      }
    >
      {rect !== null && <PanelBody frame={ref} grip={grip("move")} reset={reset} tip="끌어서 옮기고, 더블클릭하면 기본 위치와 크기로 돌아갑니다" />}
      {DIRS.map((dir) => (
        <div key={dir} className="info-panel-resize" data-dir={dir} onPointerDown={grip(dir)} />
      ))}
    </div>
  );
}
