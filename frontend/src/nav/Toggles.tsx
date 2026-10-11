// 상단 줄의 토글 세 개. 줄 폭이 넉넉하면 줄에 나란히 그리고, 모자라면 "설정" 버튼 아래 목록으로 접는다.
// 어느 쪽으로 그릴지는 styles.css의 container 조건이 정한다.
import { useRef, useState } from "react";
import { useAtlas } from "../state/store";
import { useDismiss } from "./menu";

export function Toggles() {
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const autoSummary = useAtlas((s) => s.autoSummary);
  const toggleTests = useAtlas((s) => s.toggleTests);
  const toggleExternal = useAtlas((s) => s.toggleExternal);
  const toggleAutoSummary = useAtlas((s) => s.toggleAutoSummary);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useDismiss(open, root, setOpen);

  return (
    <div className="toolbar-toggles" ref={root}>
      <button
        className="toolbar-button toolbar-toggles-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="toolbar-toggles"
        onClick={() => setOpen(!open)}
      >
        설정
      </button>
      <div className="toolbar-toggles-list" id="toolbar-toggles" data-open={open ? "" : undefined}>
        <label className="toolbar-toggle">
          <input type="checkbox" checked={showTests} onChange={toggleTests} />
          테스트 코드
        </label>
        <label className="toolbar-toggle">
          <input type="checkbox" checked={showExternal} onChange={toggleExternal} />
          외부 노드
        </label>
        <label className="toolbar-toggle" title="노드를 고르면 캐시에 없는 LLM 요약을 만든다">
          <input type="checkbox" checked={autoSummary} onChange={toggleAutoSummary} />
          자동 요약
        </label>
      </div>
    </div>
  );
}
