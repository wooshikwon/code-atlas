// 상단 줄의 새로고침 버튼. 새로고침 기호만 그리고, 누르면 레포를 다시 분석해 그래프를 바꾼다(`state/reload.ts`). 보던 화면은 그대로 둔다.
// 분석한 뒤 바뀐 파일이 있으면 버튼의 오른쪽 위 모서리에 점을 그리고, 분석하는 동안에는 기호 대신 도는 원을 그린다.
// 바뀐 파일 수와 분석 단계는 말풍선과 접근성 이름에 글로 적는다.
import type { Status } from "../api/types";
import { reload } from "../state/reload";
import { phaseName, phaseText, running, staleLines, useStatus } from "../state/status";
import { useAtlas } from "../state/store";
import { modName } from "./keys";

/** 새로고침 버튼의 말풍선 글. busy는 새로고침하는 중이거나 서버가 분석하는 중이라는 뜻이다. */
export function reloadTip(busy: boolean, status: Status | null): string {
  if (busy) {
    return [
      status?.revision === 0 ? "레포를 분석하는 중" : "레포를 다시 분석하는 중",
      ...(running(status) && status !== null ? [phaseText(status)] : []),
    ].join("\n");
  }
  const name = `새로고침 ${modName("R")}`;
  const [count, ...paths] = status === null ? [] : staleLines(status.stale);
  return count === undefined ? [name, "레포를 다시 분석해 그래프를 바꾸고 보던 화면은 그대로 둡니다"].join("\n") : [`${count} · ${name}`, ...paths].join("\n");
}

/** 새로고침 버튼의 접근성 이름. 분석하는 중이면 분석 단계를, 분석 뒤 바뀐 파일이 있으면 그 수를 함께 적는다. */
export function reloadName(busy: boolean, status: Status | null): string {
  if (busy) {
    return `새로고침 · ${running(status) && status !== null ? phaseName(status) : "분석 중"}`;
  }
  const [count] = status === null ? [] : staleLines(status.stale);
  return count === undefined ? "새로고침" : `새로고침 · ${count}`;
}

export function Reload() {
  const reloading = useAtlas((s) => s.reloading);
  const error = useAtlas((s) => s.reloadError);
  const status = useStatus((s) => s.status);
  const busy = reloading || running(status);
  const stale = !busy && (status?.stale.count ?? 0) > 0;
  return (
    <div className="toolbar-reload">
      <button
        className="toolbar-button reload-button"
        aria-label={reloadName(busy, status)}
        aria-busy={busy}
        aria-disabled={busy}
        data-stale={stale ? "" : undefined}
        data-tip={reloadTip(busy, status)}
        onClick={() => void reload()}
      >
        {busy ? (
          <span className="reload-spin" aria-hidden />
        ) : (
          <svg className="reload-mark" viewBox="0 0 14 14" width={14} height={14} aria-hidden>
            <path d="M11.5 7a4.5 4.5 0 1 1-1.4-3.3" />
            <path d="M11.8 1.6v2.6h-2.6" />
          </svg>
        )}
        {stale && <span className="reload-dot" aria-hidden />}
      </button>
      {error !== null && (
        <button className="reload-error" role="alert" data-tip="닫기" onClick={() => useAtlas.setState({ reloadError: null })}>
          {error}
        </button>
      )}
    </div>
  );
}
