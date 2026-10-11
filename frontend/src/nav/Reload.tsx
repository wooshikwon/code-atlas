// 상단 줄의 새로고침 버튼. 누르면 레포를 다시 분석해 그래프를 바꾸고 화면을 레포를 처음 연 상태로 되돌린다(`state/reload.ts`).
// 분석한 뒤 바뀐 파일이 있으면 새로고침 기호를 수정 표시의 색으로 그리고 그 수를 적는다. 분석하는 동안에는 기호 대신 도는 원과
// 분석 단계의 이름을 그린다.
import type { Status } from "../api/types";
import { reload } from "../state/reload";
import { phaseName, phaseText, running, staleLines, useStatus } from "../state/status";
import { useAtlas } from "../state/store";

/** 새로고침 버튼의 말풍선 글. busy는 새로고침하는 중이거나 서버가 분석하는 중이라는 뜻이다. */
export function reloadTip(busy: boolean, status: Status | null): string {
  if (busy) {
    return [
      status?.revision === 0 ? "레포를 분석하는 중 · 끝나면 그래프를 그린다" : "레포를 다시 분석하는 중 · 끝나면 그래프를 바꾼다",
      ...(running(status) && status !== null ? [phaseText(status)] : []),
    ].join("\n");
  }
  return [
    "새로고침 · 레포를 다시 분석한다",
    "보기 설정, 선택, 펼친 폴더, 경로 고정을 레포를 처음 연 상태로 되돌린다",
    ...(status === null ? [] : staleLines(status.stale)),
  ].join("\n");
}

export function Reload() {
  const reloading = useAtlas((s) => s.reloading);
  const error = useAtlas((s) => s.reloadError);
  const status = useStatus((s) => s.status);
  const busy = reloading || running(status);
  const stale = busy ? 0 : (status?.stale.count ?? 0);
  return (
    <div className="toolbar-reload">
      <button
        className="toolbar-button reload-button"
        aria-label="새로고침"
        aria-busy={busy}
        aria-disabled={busy}
        data-stale={stale > 0 ? "" : undefined}
        data-tip={reloadTip(busy, status)}
        onClick={() => void reload()}
      >
        {busy ? (
          <span className="reload-spin" aria-hidden />
        ) : (
          <svg className="reload-mark" viewBox="0 0 14 14" width={12} height={12} aria-hidden>
            <path d="M11.5 7a4.5 4.5 0 1 1-1.4-3.3" />
            <path d="M11.8 1.6v2.6h-2.6" />
          </svg>
        )}
        {busy ? (running(status) && status !== null ? phaseName(status) : "분석 중") : "새로고침"}
        {stale > 0 && (
          <span className="toolbar-stale" aria-label={`분석 뒤 바뀐 파일 ${stale}개`}>
            {stale}
          </span>
        )}
      </button>
      {error !== null && (
        <button className="reload-error" role="alert" data-tip="닫기" onClick={() => useAtlas.setState({ reloadError: null })}>
          {error}
        </button>
      )}
    </div>
  );
}
