// 세로창 모드의 정보 패널 틀. 아래 오른쪽 칸을 채우고 손잡이를 그리지 않는다. 크기는 칸의 경계선이 정하므로 머리 줄은 끌리지 않는다.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { PanelBody } from "./InfoPanel";
import { MIN_CODE, MIN_SUMMARY } from "./rect";

export function Docked() {
  const ref = useRef<HTMLDivElement | null>(null);
  /** 칸의 높이. 재기 전에는 null이다. */
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const panel = ref.current;
    if (panel === null) {
      return;
    }
    const measure = () => setHeight(panel.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="info-panel"
      data-docked=""
      style={height === null ? undefined : ({ "--panel-height": `${height}px`, "--summary-min": `${MIN_SUMMARY}px`, "--code-min": `${MIN_CODE}px` } as CSSProperties)}
    >
      {height !== null && <PanelBody frame={ref} tip="더블클릭하면 요약 칸이 기본 높이로 돌아간다" />}
    </div>
  );
}
