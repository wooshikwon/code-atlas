// 상단 줄의 모드 버튼. 누르면 바뀌는 모드의 칸 묶음을 그린 기호만 그리고, 누르면 가로창 모드와 세로창 모드를 바꾼다.
// 버튼으로 고른 모드는 화면 설정에 저장해 창의 크기와 무관하게 쓴다.
import { useAtlas, type Mode } from "../state/store";
import { layoutTip, other } from "./layout";

/** 칸 묶음의 경계선. 세로창 모드는 위아래를 나누는 선과 아래 칸을 좌우로 나누는 선이고, 가로창 모드는 파일트리와 작업 영역을 나누는 선이다. */
const LINES: Record<Mode, string> = { portrait: "M3.5 8 H10.5 M6 8 V12.5", landscape: "M5 3.5 V10.5" };
/** 창의 테두리. 세로창 모드는 세로로 긴 사각형, 가로창 모드는 가로로 긴 사각형이다. */
const FRAMES: Record<Mode, { x: number; y: number; width: number; height: number }> = {
  portrait: { x: 3.5, y: 1.5, width: 7, height: 11 },
  landscape: { x: 1.5, y: 3.5, width: 11, height: 7 },
};

export function LayoutButton({ mode }: { mode: Mode }) {
  const setLayout = useAtlas((s) => s.setLayout);
  const to = other(mode);
  return (
    <button className="toolbar-button layout-button" aria-label={layoutTip(mode)} data-tip={layoutTip(mode)} onClick={() => setLayout(to)}>
      <svg className="layout-mark" viewBox="0 0 14 14" width={14} height={14} aria-hidden>
        <rect {...FRAMES[to]} rx={1} />
        <path d={LINES[to]} />
      </svg>
    </button>
  );
}
