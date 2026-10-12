// 관계 그래프 영역 왼쪽 위의 비교 버튼. 비교 창(`Window.tsx`)을 펴고 접는다. 비교가 꺼져 있으면 `비교`만, 켜져 있으면 고른 두 시점과
// 그 사이의 줄 수를, 비교할 시점을 분석하는 동안에는 진행 수를 적는다. git 저장소가 아닌 레포에서는 그리지 않는다.
import { useChanges } from "../state/changes";
import { useCompare } from "../state/compare";
import { comparingText, useStatus } from "../state/status";
import { pointName } from "./log";

/** 추가된 줄 수와 삭제된 줄 수. 비교 창의 아래 줄도 쓴다. */
export function Lines({ added, deleted }: { added: number; deleted: number }) {
  return (
    <span className="compare-lines">
      <span className="compare-added">+{added.toLocaleString("en-US")}</span>
      <span className="compare-deleted">−{deleted.toLocaleString("en-US")}</span>
    </span>
  );
}

export function CompareButton() {
  const git = useChanges((s) => s.changes?.git === true);
  const open = useCompare((s) => s.open);
  const running = useCompare((s) => s.running);
  const error = useCompare((s) => s.error);
  const shown = useCompare((s) => s.shown);
  const chosen = useCompare((s) => s.chosen);
  const commits = useCompare((s) => s.history?.commits);
  const toggle = useCompare((s) => s.toggle);
  const status = useStatus((s) => s.status);
  if (!git) {
    return null;
  }
  return (
    <button type="button" className="compare-button" aria-expanded={open} aria-controls="compare-window" onClick={toggle}>
      <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
        <circle cx={3.5} cy={3} r={1.8} />
        <circle cx={3.5} cy={11} r={1.8} />
        <circle cx={10.5} cy={5.5} r={1.8} />
        <path d="M3.5 4.8v4.4M10.5 7.3c0 2-3 1.6-5.4 2.6" />
      </svg>
      <b>비교</b>
      {running && <span role="status">{comparingText(status)}</span>}
      {!running && shown !== null && (
        <>
          <span>
            {pointName(chosen ?? shown.base, commits ?? [])} → {pointName(shown.target, commits ?? [])}
          </span>
          <span className="compare-button-dot">·</span>
          <Lines added={shown.added} deleted={shown.deleted} />
        </>
      )}
      {!running && !open && error !== null && (
        <span className="compare-failed" role="alert" data-tip={error}>
          요청 실패
        </span>
      )}
    </button>
  );
}
