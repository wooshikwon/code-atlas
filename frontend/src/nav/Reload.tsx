// 상단 줄의 새로고침 버튼. 누르면 레포를 다시 분석해 그래프를 바꾸고 화면을 레포를 처음 연 상태로 되돌린다(`state/reload.ts`).
// 분석한 뒤 내용이 바뀐 파일이 있으면 그 수를 버튼에 적고, 분석하는 동안에는 도는 원을 그린다.
import { useRef } from "react";
import { Tooltip, type TooltipHandle } from "../graph/Tooltip";
import { useStaleCount } from "../state/changes";
import { reload } from "../state/reload";
import { useAtlas } from "../state/store";

/** 새로고침 버튼의 말풍선 글 */
export function reloadTip(reloading: boolean, stale: number): string {
  if (reloading) {
    return "레포를 다시 분석하는 중 · 끝나면 그래프를 바꾼다";
  }
  return [
    "새로고침 · 레포를 다시 분석한다",
    "보기 설정, 선택, 펼친 폴더, 경로 고정을 레포를 처음 연 상태로 되돌린다",
    ...(stale > 0 ? [`분석 뒤 바뀐 파일 ${stale}개`] : []),
  ].join("\n");
}

export function Reload() {
  const reloading = useAtlas((s) => s.reloading);
  const error = useAtlas((s) => s.reloadError);
  const stale = useStaleCount();
  const tip = useRef<TooltipHandle | null>(null);
  return (
    <div className="toolbar-reload">
      <button
        className="toolbar-button reload-button"
        aria-label="새로고침"
        aria-busy={reloading}
        aria-disabled={reloading}
        onClick={() => {
          tip.current?.hide();
          void reload();
        }}
        onMouseEnter={(event) => tip.current?.show(reloadTip(reloading, stale), event.clientX, event.clientY)}
        onMouseMove={(event) => tip.current?.move(event.clientX, event.clientY)}
        onMouseLeave={() => tip.current?.hide()}
      >
        {reloading && <span className="reload-spin" aria-hidden />}
        {reloading ? "분석 중" : "새로고침"}
        {!reloading && stale > 0 && (
          <span className="toolbar-stale" aria-label={`분석 뒤 바뀐 파일 ${stale}개`}>
            {stale}
          </span>
        )}
      </button>
      <Tooltip ref={tip} />
      {error !== null && (
        <button className="reload-error" role="alert" title="닫기" onClick={() => useAtlas.setState({ reloadError: null })}>
          {error}
        </button>
      )}
    </div>
  );
}
