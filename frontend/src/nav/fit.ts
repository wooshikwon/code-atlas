// 상단 줄을 줄 폭에 맞추는 단계. 한 줄에 두었을 때 탐색 경로에 남는 폭이 TRAIL_ROOM보다 좁으면 다음 단계로 간다.
// 단계는 상단 줄의 폭과 탐색 경로를 뺀 요소의 폭으로만 정하므로 노드를 골라 탐색 경로가 길어져도 바뀌지 않는다.
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/**
 * 줄이는 순서. full은 통계 문구 전체와 토글 세 개를 한 줄에 그린다. brief는 통계 문구를 호출 확인 비율만 적는다.
 * menu는 토글과 덮개 버튼을 "설정" 목록으로 접는다. rows는 뒤로·앞으로 버튼과 탐색 경로를 첫 줄에, 나머지를 둘째 줄에 둔다.
 * rows에서도 모자라면 둘째 줄의 요소가 다음 줄로 넘어가고, 탐색 경로는 어느 단계에서나 앞 단계부터 줄어든다.
 */
export const FITS = ["full", "brief", "menu", "rows"] as const;
export type Fit = (typeof FITS)[number];

/** 한 줄일 때 탐색 경로에 남겨 두는 폭(px) */
export const TRAIL_ROOM = 320;

/** 줄 폭 bar에서 탐색 경로 앞의 폭 lead와 나머지 요소의 폭 tools를 빼고 탐색 경로에 남는 폭이 TRAIL_ROOM보다 좁은지 본다. */
export function cramped(bar: number, lead: number, tools: number): boolean {
  return bar - lead - tools < TRAIL_ROOM;
}

/**
 * 상단 줄 bar를 그릴 단계. 첫 줄 nav 안의 탐색 경로(`.toolbar-trail`) 앞쪽 폭과 나머지 요소 tools의 폭을 재서 정한다.
 * 줄 폭이나 tools의 내용 content가 바뀌면 full에서 다시 잰다.
 */
export function useFit(bar: RefObject<HTMLElement | null>, tools: RefObject<HTMLElement | null>, content: string): Fit {
  const [width, setWidth] = useState(0);
  const key = `${width}|${content}`;
  const [step, setStep] = useState({ key, level: 0 });
  const level = step.key === key ? step.level : 0;

  useLayoutEffect(() => {
    const row = bar.current;
    const trail = row?.querySelector(".toolbar-trail");
    if (row == null || trail == null || tools.current === null || level === FITS.length - 1) {
      return;
    }
    const style = getComputedStyle(row);
    const inner = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const lead = trail.getBoundingClientRect().left - row.getBoundingClientRect().left - parseFloat(style.paddingLeft);
    if (cramped(inner, lead, tools.current.offsetWidth + parseFloat(style.columnGap))) {
      setStep({ key, level: level + 1 });
    }
  });
  useEffect(() => {
    const row = bar.current;
    if (row === null) {
      return;
    }
    const observer = new ResizeObserver(() => setWidth(row.clientWidth));
    observer.observe(row);
    return () => observer.disconnect();
  }, [bar]);

  return FITS[level];
}
