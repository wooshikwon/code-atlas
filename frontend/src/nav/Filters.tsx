// 상단 줄의 필터 버튼과 그 아래에 열리는 필터 창. 창은 보기 설정(흐름 단계, 분석 덮개, 토글 세 개)과
// 레포 정보(통계, 브랜치, 진입점 목록) 두 구역이다. 버튼은 기본값과 다른 보기 설정의 수를 적는다.
import { useMemo, useRef, useState } from "react";
import { titleOf } from "../graph/layout";
import { EntryIcon } from "../graph/nodes/common";
import { hidden } from "../graph/visible";
import { useBranch } from "../state/changes";
import { useCycles } from "../state/cycles";
import { useOverlay, type OverlayKind } from "../state/overlay";
import { pinned, useAtlas, type Depth } from "../state/store";
import { changed, filterTip, OVERLAY_NAMES } from "./settings";
import { useDismiss } from "./menu";

const NONE = "없음";
const KINDS: (OverlayKind | null)[] = [null, "cycles", "unused"];

/** 덮개를 고르는 행. 이름 오른쪽에 순환 묶음 수와 미사용 후보 수를 적는다. */
function OverlayOptions() {
  const kind = useOverlay((s) => s.kind);
  const unused = useOverlay((s) => s.unused.size);
  const set = useOverlay((s) => s.set);
  const groups = useCycles()?.groups.length ?? 0;
  const counts: Record<OverlayKind, string> = { cycles: `묶음 ${groups}`, unused: `${unused}개` };
  return (
    <div className="filter-overlays" role="radiogroup" aria-label="분석 덮개">
      <span className="filter-label">분석 덮개</span>
      {KINDS.map((option) => (
        <button
          key={option ?? "none"}
          className="overlay-option"
          role="radio"
          aria-checked={option === kind}
          data-kind={option ?? "none"}
          onClick={() => set(option)}
        >
          <span className="overlay-option-name">{option === null ? NONE : OVERLAY_NAMES[option]}</span>
          {option !== null && <span className="overlay-option-count">{counts[option]}</span>}
        </button>
      ))}
    </div>
  );
}

/** 진입점 노드 이름. 이름을 고르면 구조 뷰에서 그 노드를 고르고 onPick을 부른다. */
function Entries({ onPick }: { onPick: () => void }) {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const show = useAtlas((s) => s.show);
  const entries = useMemo(() => {
    if (graph === null) {
      return [];
    }
    const off = hidden(graph, { showTests, showExternal });
    return graph.nodes.filter((n) => n.entry && !off.has(n.id));
  }, [graph, showTests, showExternal]);
  return (
    <div className="filter-entries">
      <span className="filter-label">진입점 {entries.length}</span>
      <ul className="filter-entry-list">
        {entries.map((node) => (
          <li key={node.id}>
            <button
              className="filter-entry"
              data-node={node.id}
              data-full={titleOf(node)}
              data-tip={node.kind === "module" || node.path === null ? undefined : node.path}
              onClick={() => {
                show(node.id);
                onPick();
              }}
            >
              <EntryIcon />
              {titleOf(node)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Filters() {
  const stats = useAtlas((s) => s.repo?.stats);
  const branch = useBranch();
  const depth = useAtlas((s) => s.depth);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const autoSummary = useAtlas((s) => s.autoSummary);
  const overlay = useOverlay((s) => s.kind);
  /** 경로 고정 중에는 흐름 단계 슬라이더와 보이는 노드를 바꾸는 토글 두 개를 누를 수 없다. */
  const pin = useAtlas((s) => pinned(s.finder));
  const setDepth = useAtlas((s) => s.setDepth);
  const toggleTests = useAtlas((s) => s.toggleTests);
  const toggleExternal = useAtlas((s) => s.toggleExternal);
  const toggleAutoSummary = useAtlas((s) => s.toggleAutoSummary);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useDismiss(open, root, setOpen);

  const names = changed({ depth, overlay, showTests, showExternal, autoSummary });
  const rate = stats === undefined || stats.call_sites === 0 ? "-" : `${Math.round((stats.resolved / stats.call_sites) * 1000) / 10}%`;

  return (
    <div className="toolbar-filters" ref={root}>
      <button
        className="toolbar-button filter-button"
        aria-label="필터"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="toolbar-filters"
        data-changed={names.length > 0 ? "" : undefined}
        data-tip={open ? undefined : filterTip(names)}
        onClick={() => setOpen(!open)}
      >
        <svg className="filter-icon" viewBox="0 0 14 14" width={14} height={14} aria-hidden>
          <path d="M1.5 2.5 H12.5 L8.5 7.5 V11.5 L5.5 12.5 V7.5 Z" />
        </svg>
        {names.length > 0 && <span className="filter-count">{names.length}</span>}
      </button>
      {open && (
        <div className="filter-panel" id="toolbar-filters" role="dialog" aria-label="필터">
          <section className="filter-section" aria-label="보기 설정">
            <h2 className="filter-title">보기 설정</h2>
            <label className="toolbar-toggle">
              흐름 단계
              <input type="range" min={1} max={3} value={depth} disabled={pin} onChange={(event) => setDepth(Number(event.target.value) as Depth)} />
              {depth}
            </label>
            <OverlayOptions />
            <label className="toolbar-toggle">
              <input type="checkbox" checked={showTests} onChange={toggleTests} disabled={pin} />
              테스트 코드
            </label>
            <label className="toolbar-toggle">
              <input type="checkbox" checked={showExternal} onChange={toggleExternal} disabled={pin} />
              외부 노드
            </label>
            <label className="toolbar-toggle" data-tip="노드를 고르면 캐시에 없는 LLM 요약을 만든다">
              <input type="checkbox" checked={autoSummary} onChange={toggleAutoSummary} />
              자동 요약
            </label>
          </section>
          <section className="filter-section" aria-label="레포 정보">
            <h2 className="filter-title">레포 정보</h2>
            {stats !== undefined && (
              <>
                <span className="filter-stats">
                  파일 {stats.files} · 노드 {stats.nodes} · 선 {stats.edges}
                </span>
                <span className="filter-stats">
                  호출 확인 {rate}
                  {(stats.timed_out ?? 0) > 0 && ` · 응답 없음 ${stats.timed_out}`}
                </span>
              </>
            )}
            {branch !== null && (
              <span className="filter-branch" data-tip="현재 git 브랜치">
                브랜치 {branch}
              </span>
            )}
            <Entries onPick={() => setOpen(false)} />
          </section>
        </div>
      )}
    </div>
  );
}
