// 그래프 왼쪽 아래 칸(`graph/Dock.tsx`)의 경로 찾기 버튼과 그 위에 펼치는 경로 탐색 창. 저장소의 finder를 읽고 쓴다.
// 출발 칸과 도착 칸이 차면 찾은 경로를 숫자 버튼으로 나열하고, 고른 경로의 단계 목록과 고정 안내, 끄기 버튼을 그린다.
import { useReactFlow } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { reducedMotion } from "../graph/motion";
import { PATH_LIMIT } from "../graph/route";
import { frameOn, PAN_MS, stageOf } from "../graph/viewport";
import { nodeIndex } from "../graph/visible";
import { build } from "../search/index";
import { pinned, useAtlas } from "../state/store";
import { EndField } from "./EndField";
import { emptyText, pickTip, stepCount, stepRows } from "./words";

/** 막힌 조작을 알리려고 고정 안내 줄을 뒤집어 두는 시간(ms) */
const FLASH_MS = 700;
/** 창의 높이가 넘지 않는 관계 그래프 영역 높이의 비율 */
const HEIGHT_SHARE = 0.6;
/** 창의 위 끝과 관계 그래프 영역의 위 끝 사이에 남기는 폭(px) */
const TOP_MARGIN = 12;

export function Finder() {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const finder = useAtlas((s) => s.finder);
  const show = useAtlas((s) => s.show);
  const swapEnds = useAtlas((s) => s.swapEnds);
  const pickPath = useAtlas((s) => s.pickPath);
  const clearFinder = useAtlas((s) => s.clearFinder);
  const { getInternalNode, getViewport, setViewport } = useReactFlow();
  const nodes = useMemo(() => (graph === null ? null : nodeIndex(graph)), [graph]);
  const entries = useMemo(() => (graph === null ? [] : build(graph, showTests)), [graph, showTests]);

  /** 고정 중에 막힌 액션이 불리면 안내 줄을 FLASH_MS 동안 뒤집는다. */
  const [flash, setFlash] = useState(false);
  const seen = useRef(finder.blocked);
  useEffect(() => {
    if (finder.blocked === seen.current) {
      return;
    }
    seen.current = finder.blocked;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [finder.blocked]);

  /**
   * 창의 최대 높이. 관계 그래프 영역 높이의 HEIGHT_SHARE와, 창의 아래 끝에서 영역의 위 끝까지의 높이 가운데 작은 값이다.
   * 왼쪽 아래 칸이 창의 아래 끝을 정하므로 영역이나 칸의 크기가 바뀔 때 다시 잰다.
   */
  const box = useRef<HTMLDivElement | null>(null);
  const [room, setRoom] = useState<number | null>(null);
  const drawn = finder.open && nodes !== null;
  useLayoutEffect(() => {
    const element = box.current;
    const root = element?.closest(".graph");
    if (element == null || root == null || element.parentElement === null) {
      return;
    }
    const measure = () => {
      const area = root.getBoundingClientRect();
      setRoom(Math.min(area.height * HEIGHT_SHARE, element.getBoundingClientRect().bottom - area.top - TOP_MARGIN));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, [drawn]);

  if (!drawn) {
    return null;
  }
  const { route, pick, focus } = finder;
  const path = route?.paths[pick];

  /** 단계의 노드를 정보 패널에 보이고 확대 비율을 그대로 둔 채 그 노드가 가리지 않는 영역에 들어오게 화면을 옮긴다. */
  const reveal = (event: ReactMouseEvent, id: string) => {
    show(id);
    const root = event.currentTarget.closest(".graph");
    const boxOf = (each: string) => {
      const at = getInternalNode(each);
      return at === undefined ? undefined : { ...at.internals.positionAbsolute, width: at.measured.width ?? 0, height: at.measured.height ?? 0 };
    };
    const focused = boxOf(id);
    if (root === null || focused === undefined || path === undefined) {
      return;
    }
    const boxes = path.map(boxOf).filter((each) => each !== undefined);
    void setViewport(frameOn(boxes, focused, stageOf(root).clear, getViewport().zoom), { duration: reducedMotion() ? 0 : PAN_MS });
  };

  return (
    <div className="finder" id="finder" ref={box} style={{ maxHeight: room ?? undefined }}>
      <div className="finder-head">
        <span>경로 찾기</span>
        <span>실행 선을 따라간다</span>
      </div>
      <div className="finder-ends">
        <div className="finder-fields">
          <EndField end="from" entries={entries} nodes={nodes} />
          <EndField end="to" entries={entries} nodes={nodes} />
        </div>
        <button
          type="button"
          className="finder-swap"
          title="출발과 도착 맞바꾸기"
          aria-label="출발과 도착 맞바꾸기"
          disabled={finder.from === null && finder.to === null}
          onClick={swapEnds}
        >
          ⇅
        </button>
      </div>
      {route != null && path !== undefined && (
        <>
          <div className="finder-picks">
            {route.paths.map((each, index) => (
              <button
                key={index}
                type="button"
                className="finder-pick"
                aria-pressed={index === pick}
                title={pickTip(each, nodes)}
                onClick={() => pickPath(index)}
              >
                <b>{index + 1}</b>
                <span>{stepCount(each)}단계</span>
              </button>
            ))}
          </div>
          <ol className="finder-steps">
            {stepRows(route, path, nodes).map((row, index) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="finder-step"
                  data-node={row.id}
                  aria-current={row.id === focus ? "true" : undefined}
                  title={`${row.name} · ${row.file}`}
                  onClick={(event) => reveal(event, row.id)}
                >
                  <span className="finder-step-number">{index + 1}</span>
                  {row.mark !== null && <span className="finder-step-mark">{row.mark}</span>}
                  <span className="finder-name">{row.name}</span>
                  <span className="finder-aside">{row.file}</span>
                </button>
              </li>
            ))}
          </ol>
          {route.more && (
            <p className="finder-more">
              짧은 것부터 {PATH_LIMIT}개 · 경로가 더 있다
            </p>
          )}
          <div className="finder-pinned" data-flash={flash ? "" : undefined}>
            <span>경로 고정 중 · 경로 밖은 눌리지 않는다</span>
            <button type="button" className="finder-clear" onClick={clearFinder}>
              끄기 ×
            </button>
          </div>
        </>
      )}
      {route != null && path === undefined && (
        <div className="finder-empty">
          {emptyText(route, nodes).map((line, index) => (
            <p key={line} className={index === 0 ? "finder-empty-title" : undefined}>
              {line}
            </p>
          ))}
          {route.reverse && (
            <button type="button" className="finder-reverse" onClick={swapEnds}>
              출발과 도착 맞바꾸기 ⇅
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function FinderButton() {
  const open = useAtlas((s) => s.finder.open);
  const pin = useAtlas((s) => pinned(s.finder));
  const toggleFinder = useAtlas((s) => s.toggleFinder);
  return (
    <button
      className="dock-button finder-button"
      onClick={toggleFinder}
      title={pin ? "경로 찾기 · 경로 고정 중" : "경로 찾기"}
      aria-label="경로 찾기"
      aria-expanded={open}
      aria-controls="finder"
      data-pinned={pin ? "" : undefined}
    >
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
        <path d="M3.5,10.5 L3.5,8 L12.5,8 L12.5,5.5" className="finder-icon" />
        <circle cx={3.5} cy={12.5} r={2} className="finder-icon" />
        <circle cx={12.5} cy={3.5} r={2} className="finder-icon-to" />
      </svg>
    </button>
  );
}
