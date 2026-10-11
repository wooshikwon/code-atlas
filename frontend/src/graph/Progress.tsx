// 분석 결과가 없는 동안 관계 그래프 영역 가운데에 그리는 진행 표시. 단계의 이름과 진행 수, 가로 막대를 그리고,
// 분석하지 못했으면 까닭과 다시 분석하는 버튼을 그린다.
import { reload } from "../state/reload";
import { phaseText, progressOf, useStatus } from "../state/status";
import { useAtlas } from "../state/store";

export function Progress() {
  const status = useStatus((s) => s.status);
  /** 분석 결과를 받지 못한 까닭 */
  const error = useAtlas((s) => s.error);
  const reloading = useAtlas((s) => s.reloading);

  if (status?.phase === "failed" && !reloading) {
    return (
      <div className="progress" role="alert">
        <div className="progress-phase">{phaseText(status)}</div>
        {status.error !== null && <div className="progress-error">{status.error}</div>}
        <button className="toolbar-button progress-retry" onClick={() => void reload()}>
          다시 분석
        </button>
      </div>
    );
  }
  // 분석이 끝난 판은 그래프를 받는 중이다.
  const waiting = status === null || status.phase === "failed" || status.phase === "ready";
  const share = waiting ? null : progressOf(status);
  return (
    <div className="progress" role="status">
      <div className="progress-phase">{waiting ? "불러오는 중" : phaseText(status)}</div>
      <div className="progress-bar" data-share={share === null ? undefined : share.toFixed(3)}>
        <div className="progress-fill" style={share === null ? undefined : { width: `${share * 100}%` }} />
      </div>
      {error !== null && <div className="progress-error">{error}</div>}
    </div>
  );
}
