// LLM 요약 요청 묶음의 진행 칸. 차례를 기다린 요청이 있었던 묶음에서만 관계 그래프 영역 아래쪽에 뜬다. 끝난 수와 요청한 수,
// 가는 막대를 그리고, 차례를 기다리는 요청이 있으면 그 요청을 빼는 "취소"를 둔다. 가로 위치는 정보 패널과 왼쪽 아래 칸이
// 가리지 않는 사각형(`viewport.ts`의 clear)의 가운데다.
import { useLayoutEffect, useRef, useState } from "react";
import { useAtlas } from "../state/store";
import { useSummaries, type Batch } from "../state/summaries";
import { stageOf } from "./viewport";

/** 칸의 아래 끝과 가리지 않는 사각형의 아래 끝 사이. 왼쪽 아래 칸이 영역의 아래 끝에서 띄우는 폭과 같다. */
const MARGIN = 12;

/** 칸에 적는 글. 취소한 뒤에는 서버로 보낸 요청의 수 sent만 적는다. */
export function queueText(batch: Batch, waiting: number, sent: number): string {
  if (batch.cancelled && waiting === 0) {
    return `요약 만드는 중 ${sent}개`;
  }
  return `요약 ${batch.ended} / ${batch.total}${batch.failed > 0 ? ` · 실패 ${batch.failed}` : ""}`;
}

export function SummaryQueue() {
  const batch = useSummaries((s) => s.batch);
  const waiting = useSummaries((s) => s.waiting.length);
  const sent = useSummaries((s) => s.sent);
  const cancel = useSummaries((s) => s.cancel);
  const panel = useAtlas((s) => s.panel);
  const view = useAtlas((s) => s.view.kind);
  const ref = useRef<HTMLDivElement | null>(null);
  /** 칸의 가로 가운데와 아래 끝, 칸이 쓸 폭. 관계 그래프 영역의 왼쪽 끝과 아래 끝에서 잰다. */
  const [at, setAt] = useState<{ left: number; bottom: number; room: number } | null>(null);

  // 영역, 정보 패널, 왼쪽 아래 칸의 크기가 바뀌거나 패널을 옮기면 다시 잰다.
  useLayoutEffect(() => {
    const stage = ref.current?.parentElement;
    if (stage == null) {
      return;
    }
    const measure = () => {
      const { area, clear } = stageOf(stage);
      const next = { left: clear.x + clear.width / 2, bottom: area.height - clear.y - clear.height + MARGIN, room: clear.width - 2 * MARGIN };
      setAt((prev) => (prev !== null && prev.left === next.left && prev.bottom === next.bottom && prev.room === next.room ? prev : next));
    };
    const sizes = new ResizeObserver(measure);
    const watch = () => {
      sizes.disconnect();
      for (const element of [stage, ...stage.querySelectorAll(".info-panel, .dock-panels, .dock-buttons")]) {
        sizes.observe(element);
      }
      measure();
    };
    const children = new MutationObserver(watch);
    children.observe(stage, { childList: true });
    watch();
    return () => {
      sizes.disconnect();
      children.disconnect();
    };
  }, [batch.held, panel, view]);

  if (!batch.held) {
    return null;
  }
  const counted = !(batch.cancelled && waiting === 0);
  return (
    <div className="summary-queue" ref={ref} style={at === null ? undefined : { left: at.left, bottom: at.bottom, maxWidth: at.room }}>
      <span role="status">{queueText(batch, waiting, sent)}</span>
      {counted && (
        <div className="progress-bar" data-share={(batch.ended / batch.total).toFixed(3)} aria-hidden="true">
          <div className="progress-fill" style={{ width: `${(batch.ended / batch.total) * 100}%` }} />
        </div>
      )}
      {waiting > 0 && (
        <button className="summary-queue-cancel" data-tip={`아직 서버로 보내지 않은 요청 ${waiting}개를 뺀다`} onClick={cancel}>
          취소
        </button>
      )}
    </div>
  );
}
