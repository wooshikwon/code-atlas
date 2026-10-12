// LLM 요약 요청 묶음의 진행 칸. 차례를 기다린 요청이 있었던 묶음에서만 관계 그래프 영역 아래쪽에 뜬다. 끝난 수와 요청한 수,
// 가는 막대를 그리고, 차례를 기다리는 요청이 있으면 그 요청을 빼는 "취소"를 두며, 오른쪽 끝에 묶음이 쓴 토큰 수를 적는다.
// 칸은 영역의 바닥 줄(왼쪽 아래 칸의 버튼 줄과 같은 높이)에서 정보 패널과 왼쪽 아래 칸이 덮지 않는 가장 넓은 가로 구간의 가운데에 뜬다.
// 그 구간에 칸이 들어가지 않으면 토큰 수를 감추고, 그래도 들어가지 않으면 둘이 가리지 않는 사각형(`viewport.ts`의 clear)의
// 가로 가운데, 아래 끝으로 옮긴다.
import { useLayoutEffect, useRef, useState } from "react";
import { useAtlas } from "../state/store";
import { useSummaries, type Batch } from "../state/summaries";
import { cacheTip, usageText } from "../state/usage";
import { bottomSpan, stageOf } from "./viewport";

/** 칸이 영역의 아래 끝, 가리는 칸에서 띄우는 폭. 왼쪽 아래 칸이 영역의 아래 끝에서 띄우는 폭과 같다. */
const MARGIN = 12;

/** 칸에 적는 진행 글. 취소한 뒤에는 서버로 보낸 요청의 수 sent만 적는다. */
export function queueText(batch: Batch, waiting: number, sent: number): string {
  if (batch.cancelled && waiting === 0) {
    return `요약 만드는 중 ${sent}개`;
  }
  return `요약 ${batch.ended} / ${batch.total}`;
}

export function SummaryQueue() {
  const batch = useSummaries((s) => s.batch);
  const waiting = useSummaries((s) => s.waiting.length);
  const sent = useSummaries((s) => s.sent);
  const cancel = useSummaries((s) => s.cancel);
  const panel = useAtlas((s) => s.panel);
  const view = useAtlas((s) => s.view.kind);
  const ref = useRef<HTMLDivElement | null>(null);
  /** 칸의 가로 가운데와 아래 끝, 칸이 쓸 폭, 토큰 수를 감추는지. 관계 그래프 영역의 왼쪽 끝과 아래 끝에서 잰다. */
  const [at, setAt] = useState<{ left: number; bottom: number; room: number; lean: boolean } | null>(null);

  // 영역, 정보 패널, 왼쪽 아래 칸, 칸 자신의 크기가 바뀌거나 패널을 옮기면 다시 잰다. 끄는 동안의 패널은 사각형을 style에 적는다.
  useLayoutEffect(() => {
    const box = ref.current;
    const stage = box?.parentElement;
    if (box == null || stage == null) {
      return;
    }
    const measure = () => {
      const { area, clear, covers } = stageOf(stage);
      const usage = box.querySelector<HTMLElement>(".summary-queue-usage");
      /** 줄어들기 전의 칸의 폭. 토큰 수를 적었을 때와 감췄을 때를 따로 잰다. */
      const widthOf = (shown: boolean) => {
        if (usage !== null) {
          usage.style.display = shown ? "inline" : "none";
        }
        return box.getBoundingClientRect().width;
      };
      const limit = box.style.maxWidth;
      box.style.maxWidth = "";
      const [full, bare] = [widthOf(true), widthOf(false)];
      const { height } = box.getBoundingClientRect();
      box.style.maxWidth = limit;
      if (usage !== null) {
        usage.style.display = "";
      }
      const span = bottomSpan(area, covers, height, MARGIN);
      const [floor, free] = [span.width - 2 * MARGIN, clear.width - 2 * MARGIN];
      const next =
        floor >= bare
          ? { left: span.x + span.width / 2, bottom: MARGIN, room: floor, lean: floor < full }
          : { left: clear.x + clear.width / 2, bottom: area.height - clear.y - clear.height + MARGIN, room: free, lean: free < full };
      setAt((prev) =>
        prev !== null && prev.left === next.left && prev.bottom === next.bottom && prev.room === next.room && prev.lean === next.lean ? prev : next,
      );
    };
    const sizes = new ResizeObserver(measure);
    const moves = new MutationObserver(measure);
    const watch = () => {
      sizes.disconnect();
      moves.disconnect();
      for (const element of [stage, box, ...stage.querySelectorAll(".info-panel, .dock-panels, .dock-buttons")]) {
        sizes.observe(element);
      }
      for (const element of stage.querySelectorAll(".info-panel")) {
        moves.observe(element, { attributes: true, attributeFilter: ["style"] });
      }
      measure();
    };
    const children = new MutationObserver(watch);
    children.observe(stage, { childList: true });
    watch();
    return () => {
      sizes.disconnect();
      moves.disconnect();
      children.disconnect();
    };
  }, [batch.held, panel, view]);

  if (!batch.held) {
    return null;
  }
  const counted = !(batch.cancelled && waiting === 0);
  return (
    <div
      className="summary-queue"
      ref={ref}
      data-lean={at?.lean ? "" : undefined}
      style={at === null ? undefined : { left: at.left, bottom: at.bottom, maxWidth: at.room }}
    >
      <span role="status">
        {queueText(batch, waiting, sent)}
        {batch.failed > 0 && <span className="summary-queue-failed"> 실패 {batch.failed}</span>}
      </span>
      {counted && (
        <div className="progress-bar" data-share={(batch.ended / batch.total).toFixed(3)} aria-hidden="true">
          <div className="progress-fill" style={{ width: `${(batch.ended / batch.total) * 100}%` }} />
        </div>
      )}
      {waiting > 0 && (
        <button className="summary-queue-cancel" data-tip={`아직 보내지 않은 요청 ${waiting}개를 뺍니다`} onClick={cancel}>
          취소
        </button>
      )}
      {batch.usage !== null && (
        <span className="summary-queue-usage" data-tip={cacheTip(batch.usage)}>
          {usageText(batch.usage)}
        </span>
      )}
    </div>
  );
}
