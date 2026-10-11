// 상단 줄의 토글 세 개. 줄 폭이 넉넉하면 줄에 나란히 그리고, 모자라면 "설정" 버튼 아래 목록으로 접는다.
// 접은 목록은 토글 아래 "분석 덮개" 구역에 덮개를 고르는 행을 함께 담는다.
// 어느 쪽으로 그릴지는 nav/fit.ts가 상단 줄에 적는 단계(data-fit)가 정한다.
import { useLayoutEffect, useRef, useState } from "react";
import { pinned, useAtlas } from "../state/store";
import { useDismiss } from "./menu";
import { OverlayOptions } from "./Overlays";

export function Toggles() {
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const autoSummary = useAtlas((s) => s.autoSummary);
  /** 경로 고정 중에는 보이는 노드를 바꾸는 토글 두 개를 누를 수 없다. */
  const pin = useAtlas((s) => pinned(s.finder));
  const toggleTests = useAtlas((s) => s.toggleTests);
  const toggleExternal = useAtlas((s) => s.toggleExternal);
  const toggleAutoSummary = useAtlas((s) => s.toggleAutoSummary);
  const [open, setOpen] = useState(false);
  /** 목록을 버튼의 어느 쪽 끝에 맞추는지. 오른쪽 끝에 맞춘 목록이 상단 줄의 왼쪽 끝을 넘으면 왼쪽 끝에 맞춘다. */
  const [side, setSide] = useState<"right" | "left">("right");
  const root = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  useDismiss(open, root, setOpen);
  useLayoutEffect(() => {
    const bar = root.current?.closest(".toolbar");
    if (!open || bar == null || list.current === null) {
      setSide("right");
    } else if (list.current.getBoundingClientRect().left < bar.getBoundingClientRect().left) {
      setSide("left");
    }
  }, [open]);

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
      <div className="toolbar-toggles-list" id="toolbar-toggles" ref={list} data-open={open ? "" : undefined} data-side={side}>
        <label className="toolbar-toggle">
          <input type="checkbox" checked={showTests} onChange={toggleTests} disabled={pin} />
          테스트 코드
        </label>
        <label className="toolbar-toggle">
          <input type="checkbox" checked={showExternal} onChange={toggleExternal} disabled={pin} />
          외부 노드
        </label>
        <label className="toolbar-toggle" title="노드를 고르면 캐시에 없는 LLM 요약을 만든다">
          <input type="checkbox" checked={autoSummary} onChange={toggleAutoSummary} />
          자동 요약
        </label>
        <div className="toolbar-toggles-overlays" role="group" aria-label="분석 덮개">
          <span className="toolbar-toggles-label">분석 덮개</span>
          <OverlayOptions />
        </div>
      </div>
    </div>
  );
}
