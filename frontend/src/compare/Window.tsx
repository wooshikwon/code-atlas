// 비교 창. 비교 버튼 아래에 떠서 관계 그래프를 덮고, 커밋 그래프(`Rows.tsx`)와 아래쪽 한 줄(고른 두 시점 사이의 줄 수, `끄기`, `확인`)만 그린다.
// 처음 크기는 높이 400px에 줄의 글이 잘리지 않는 폭이고, 오른쪽 아래 손잡이로 바꾼 크기는 저장소가 기억한다. 폭 700px, 높이 400px과
// 관계 그래프 영역을 넘지 않는다. 창을 펴고 접어도 관계 그래프의 화면은 그대로다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { drag } from "../panel/drag";
import { MIN_WIDTH } from "../panel/rect";
import { useChanges } from "../state/changes";
import { useCompare, type Size } from "../state/compare";
import { pinned, useAtlas } from "../state/store";
import { Lines } from "./Button";
import { gutterOf, naturalWidth, Rows } from "./Rows";
import { laneCount, ROW, rowsOf } from "./log";

const MAX_WIDTH = 700;
const MAX_HEIGHT = 400;
/** 아래쪽 한 줄의 높이(px). styles.css의 `.compare-bar`와 같은 값이다. */
const BAR = 38;
/** 창의 가장 작은 높이. 줄 두 개를 고르므로 줄 두 개와 아래쪽 한 줄, 위아래 테두리를 남긴다. */
const MIN_HEIGHT = 2 * ROW + BAR + 2;
/** 창과 관계 그래프 영역의 끝 사이에 남기는 폭(px) */
const EDGE = 12;

/** 창이 차지할 수 있는 가장 큰 크기. 창의 왼쪽 위에서 관계 그래프 영역의 오른쪽 아래까지에서 EDGE를 뺀 값을 700×400에서 자른다. */
function roomOf(element: HTMLElement): Size {
  const stage = element.offsetParent!;
  return {
    width: Math.min(MAX_WIDTH, stage.clientWidth - element.offsetLeft - EDGE),
    height: Math.min(MAX_HEIGHT, stage.clientHeight - element.offsetTop - EDGE),
  };
}

function fit(size: Size, room: Size): Size {
  return {
    width: Math.min(Math.max(size.width, MIN_WIDTH), room.width),
    height: Math.min(Math.max(size.height, MIN_HEIGHT), room.height),
  };
}

export function CompareWindow() {
  const open = useCompare((s) => s.open);
  const history = useCompare((s) => s.history);
  const error = useCompare((s) => s.error);
  // 커밋 그래프를 받기 전에는 처음 크기를 정하지 못하므로 그리지 않는다. 받지 못했으면 까닭을 적은 창을 그린다.
  return open && (history !== null || error !== null) ? <Opened /> : null;
}

function Opened() {
  const history = useCompare((s) => s.history);
  const saved = useCompare((s) => s.size);
  const picked = useCompare((s) => s.picks.length);
  const stat = useCompare((s) => s.stat);
  const error = useCompare((s) => s.error);
  const on = useCompare((s) => s.result !== null);
  const resize = useCompare((s) => s.resize);
  const confirm = useCompare((s) => s.confirm);
  const clear = useCompare((s) => s.clear);
  const toggle = useCompare((s) => s.toggle);
  const box = useRef<HTMLDivElement | null>(null);
  const [room, setRoom] = useState<Size | null>(null);

  const rows = useMemo(() => (history === null ? [] : rowsOf(history)), [history]);
  const gutter = gutterOf(laneCount(rows));
  /** 창을 편 때의 줄로 구한 처음 폭. 다음 묶음을 받아도 바꾸지 않는다. */
  const [natural] = useState(() => naturalWidth(rows, gutter, useChanges.getState().changes?.files.filter((file) => file.status !== "unchanged").length ?? 0));

  useLayoutEffect(() => {
    const element = box.current!;
    const measure = () => setRoom(roomOf(element));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element.offsetParent!);
    return () => observer.disconnect();
  }, []);

  // 창을 접으면 키보드 초점을 창을 펴기 전에 초점이 있던 요소로 돌려준다.
  const [opener] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      if (opener instanceof HTMLElement && opener.isConnected && (document.activeElement === document.body || document.activeElement === null)) {
        opener.focus({ preventScroll: true });
      }
    },
    [opener],
  );

  const size = room === null ? null : fit(saved ?? { width: natural, height: MAX_HEIGHT }, room);

  const grip = (event: ReactPointerEvent<HTMLElement>) => {
    const element = box.current;
    if (event.button !== 0 || element === null || size === null) {
      return;
    }
    /** 끌어서 정한 크기. 포인터가 움직이지 않았으면 null이고 저장하지 않는다. */
    let last: Size | null = null;
    drag(
      event,
      (dx, dy) => {
        last = fit({ width: size.width + dx, height: size.height + dy }, roomOf(element));
        element.style.width = `${last.width}px`;
        element.style.height = `${last.height}px`;
      },
      () => {
        if (last !== null) {
          resize(last);
        }
      },
    );
  };

  /** 경로 고정 중이면 고정을 먼저 끈다. */
  const onConfirm = () => {
    const atlas = useAtlas.getState();
    if (pinned(atlas.finder)) {
      atlas.clearFinder();
    }
    void confirm();
  };
  const onClear = () => {
    toggle();
    void clear();
  };

  return (
    <div
      ref={box}
      id="compare-window"
      className="compare-window"
      role="dialog"
      aria-label="비교할 두 시점 고르기"
      style={size ?? undefined}
    >
      {history !== null && size !== null && <Rows rows={rows} gutter={gutter} />}
      <div className="compare-bar">
        {error !== null ? (
          <span className="compare-failed" role="alert">
            {error}
          </span>
        ) : stat !== null ? (
          <Lines added={stat.added} deleted={stat.deleted} />
        ) : (
          picked < 2 && <span className="compare-hint">비교할 줄 두 개를 골라 주세요</span>
        )}
        <span className="compare-gap" />
        {on && (
          <button type="button" className="compare-off" onClick={onClear}>
            끄기
          </button>
        )}
        <button type="button" className="compare-confirm" disabled={stat === null} onClick={onConfirm}>
          확인
        </button>
      </div>
      <div className="compare-grip" onPointerDown={grip} />
    </div>
  );
}
