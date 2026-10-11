// 상단 줄의 분석 덮개 메뉴. 버튼을 누르면 "없음", "순환 의존", "미사용 후보" 가운데 하나를 고르는 목록이 펼쳐진다.
// 상단 줄이 토글을 "설정" 목록으로 접는 단계(nav/fit.ts)에서는 버튼을 숨기고 같은 행을 "설정" 목록 안에 그린다(nav/Toggles.tsx).
import { useEffect, useRef, useState } from "react";
import { cycles } from "../graph/cycles";
import { hidden } from "../graph/visible";
import { useCycles } from "../state/cycles";
import { useOverlay, type OverlayKind } from "../state/overlay";
import { useAtlas } from "../state/store";
import { useDismiss } from "./menu";

export const OVERLAY_NAMES: Record<OverlayKind, string> = { cycles: "순환 의존", unused: "미사용 후보" };
const NONE = "없음";

const KINDS: (OverlayKind | null)[] = [null, "cycles", "unused"];

/** 덮개를 고르는 행. 이름 오른쪽에 순환 묶음 수와 미사용 후보 수를 적는다. 고르면 onPick을 부른다. */
export function OverlayOptions({ onPick }: { onPick?: () => void }) {
  const kind = useOverlay((s) => s.kind);
  const unused = useOverlay((s) => s.unused.size);
  const set = useOverlay((s) => s.set);
  const groups = useCycles()?.groups.length ?? 0;
  const counts: Record<OverlayKind, string> = { cycles: `묶음 ${groups}`, unused: `${unused}개` };
  return (
    <>
      {KINDS.map((option) => (
        <button
          key={option ?? "none"}
          className="overlay-option"
          role="menuitemradio"
          aria-checked={option === kind}
          data-kind={option ?? "none"}
          onClick={() => {
            set(option);
            onPick?.();
          }}
        >
          <span className="overlay-option-name">{option === null ? NONE : OVERLAY_NAMES[option]}</span>
          {option !== null && <span className="overlay-option-count">{counts[option]}</span>}
        </button>
      ))}
    </>
  );
}

export function Overlays() {
  const graph = useAtlas((s) => s.graph);
  const kind = useOverlay((s) => s.kind);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useDismiss(open, root, setOpen);

  // 레포를 열 때 순환 묶음이 하나라도 있으면 순환 덮개를 켠 채로 연다.
  useEffect(() => {
    if (graph === null) {
      return;
    }
    const { showTests, showExternal } = useAtlas.getState();
    if (cycles(graph, hidden(graph, { showTests, showExternal })).groups.length > 0) {
      useOverlay.getState().set("cycles");
    }
  }, [graph]);

  return (
    <div className="toolbar-overlays" ref={root}>
      <button
        className="toolbar-button overlay-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="toolbar-overlays"
        onClick={() => setOpen(!open)}
      >
        덮개 {kind === null ? NONE : OVERLAY_NAMES[kind]} ▾
      </button>
      {open && (
        <div className="toolbar-menu overlay-menu" id="toolbar-overlays" role="menu">
          <OverlayOptions onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
