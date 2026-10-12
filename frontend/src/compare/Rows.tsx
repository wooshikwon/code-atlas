// 비교 창의 커밋 그래프. 줄은 높이가 같으므로 스크롤 위치에서 보이는 줄의 범위를 구해 그 줄만 그리고, 아래 끝에 가까워지면 다음 묶음을 받는다.
// 세로 줄과 잇는 선, 커밋의 점은 SVG로 그리고 줄의 글은 그 옆에 적는다. 줄을 누르거나 키보드로 옮겨 Enter나 Space로 고른다.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { WORKTREE } from "../api/types";
import { useChanges } from "../state/changes";
import { useCompare } from "../state/compare";
import { markOf, reveal, ROW, shortHash, spanOf, type Mark, type Row, type RowLink } from "./log";

/** 첫 세로 줄의 가로 위치와 세로 줄 사이의 폭(px) */
const LANE_LEFT = 16;
const LANE_STEP = 14;
/** 갈라지거나 모이는 선의 곡선이 줄의 가운데에서 위아래로 뻗는 길이(px) */
const BEND = 14;
/** 줄의 글 사이 간격과 줄의 오른쪽 여백(px). styles.css의 `.compare-row`와 같은 값이다. */
const GAP = 6;
const ROW_RIGHT = 14;
/** 이름표와 표시가 글자 밖에 차지하는 폭(px). 좌우 안쪽 여백과 테두리다. */
const REF_FRAME = 10;
const MARK_FRAME = 12;
const SUBJECT_FONT = 12;
const REF_FONT = 10.5;
const HASH_FONT = 11;
const MARKS: Mark[] = ["기준", "대상", "갈라진 지점"];

const laneX = (lane: number) => LANE_LEFT + lane * LANE_STEP;
const rowY = (index: number) => index * ROW + ROW / 2;

/** 세로 줄 count개가 차지하는 폭. 줄의 글은 이 폭 뒤에서 시작한다. */
export function gutterOf(count: number): number {
  return laneX(count - 1) + LANE_STEP;
}

/** 작업 중인 상태의 줄에 적는 글. files는 커밋하지 않은 파일의 수다. */
function worktreeText(files: number): string {
  return files > 0 ? `작업 중인 상태 · 커밋하지 않은 파일 ${files}개` : "작업 중인 상태";
}

/**
 * 줄의 글이 잘리지 않는 창의 폭. 세로 줄의 폭에 가장 긴 줄의 제목, 이름표, 표시 하나, 해시의 폭을 더한다. 표시는 어느 줄에나 붙으므로
 * 가장 긴 표시의 폭을 줄마다 더한다.
 */
export function naturalWidth(rows: Row[], gutter: number, files: number): number {
  const context = document.createElement("canvas").getContext("2d");
  if (context === null) {
    return Number.POSITIVE_INFINITY;
  }
  const style = getComputedStyle(document.documentElement);
  const measure = (text: string, size: number, family: string, weight = 400) => {
    context.font = `${weight} ${size}px ${family}`;
    return context.measureText(text).width;
  };
  const mark = Math.max(...MARKS.map((text) => measure(text, REF_FONT, style.fontFamily, 600))) + MARK_FRAME;
  const hash = measure(shortHash("0".repeat(40)), HASH_FONT, style.getPropertyValue("--font-mono"));
  const longest = rows.reduce((most, row) => {
    const subject = measure(row.commit?.subject ?? worktreeText(files), SUBJECT_FONT, style.fontFamily);
    const refs = (row.commit?.refs ?? []).reduce((sum, ref) => sum + GAP + measure(ref, REF_FONT, style.fontFamily) + REF_FRAME, 0);
    return Math.max(most, subject + refs);
  }, 0);
  return Math.ceil(gutter + longest + GAP + mark + GAP + hash + ROW_RIGHT);
}

function linkPath(link: RowLink, index: number): string {
  const [x1, y1, x2, y2] = [laneX(link.from), rowY(index - 1), laneX(link.into), rowY(index)];
  return x1 === x2 ? `M${x1},${y1} V${y2}` : `M${x1},${y1} C${x1},${y1 + BEND} ${x2},${y2 - BEND} ${x2},${y2}`;
}

export function Rows({ rows, gutter }: { rows: Row[]; gutter: number }) {
  const picks = useCompare((s) => s.picks);
  const stat = useCompare((s) => s.stat);
  const more = useCompare((s) => s.history?.more === true);
  const pick = useCompare((s) => s.pick);
  const extend = useCompare((s) => s.extend);
  const files = useChanges((s) => s.changes?.files.filter((file) => file.status !== "unchanged").length ?? 0);
  const list = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(0);
  /** 키보드로 옮기는 줄의 번호. 옮기거나 누르기 전에는 -1이다. */
  const [active, setActive] = useState(-1);

  useLayoutEffect(() => {
    const element = list.current!;
    const measure = () => setHeight(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.focus({ preventScroll: true });
    return () => observer.disconnect();
  }, []);

  const { start, end } = spanOf(top, height, rows.length);
  useEffect(() => {
    if (more && height > 0 && end === rows.length) {
      void extend();
    }
  }, [more, height, end, rows.length, extend]);

  const move = (to: number) => {
    const element = list.current!;
    const index = Math.max(0, Math.min(to, rows.length - 1));
    setActive(index);
    element.scrollTop = reveal(index, element.scrollTop, element.clientHeight);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const page = Math.max(1, Math.floor(height / ROW));
    switch (event.key) {
      case "ArrowDown":
        move(active + 1);
        break;
      case "ArrowUp":
        move(active - 1);
        break;
      case "PageDown":
        move(active + page);
        break;
      case "PageUp":
        move(active - page);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "Enter":
      case " ":
        if (active >= 0 && active < rows.length) {
          pick(rows[active].id);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const drawn = rows.slice(start, end).map((row, offset) => ({ row, index: start + offset, mark: markOf(row.id, picks, stat), picked: picks.includes(row.id) }));
  const optionId = (index: number) => `compare-row-${index}`;
  return (
    <div
      ref={list}
      className="compare-rows"
      role="listbox"
      aria-label="커밋 그래프"
      aria-multiselectable
      aria-activedescendant={active >= start && active < end ? optionId(active) : undefined}
      tabIndex={0}
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div className="compare-rows-body" style={{ height: rows.length * ROW }}>
        <svg className="compare-lanes" width={gutter} height={(end - start) * ROW} style={{ top: start * ROW }} aria-hidden>
          <g transform={`translate(0 ${-start * ROW})`}>
            {drawn.flatMap(({ row, index }) =>
              row.links.map((link) => (
                <path key={`${index}:${link.from}:${link.into}:${link.to}`} className="compare-lane" data-loose={link.loose ? "" : undefined} d={linkPath(link, index)} />
              )),
            )}
            {drawn.map(({ row, index, mark, picked }) => {
              const [cx, cy] = [laneX(row.lane), rowY(index)];
              const loose = row.id === WORKTREE && !picked;
              return (
                <g key={row.id}>
                  <circle
                    className="compare-dot"
                    data-pick={picked ? "" : undefined}
                    data-fork={mark === "갈라진 지점" ? "" : undefined}
                    data-loose={loose ? "" : undefined}
                    cx={cx}
                    cy={cy}
                    r={picked || mark !== null ? 5 : 4}
                  />
                  {loose && <circle className="compare-dot-core" cx={cx} cy={cy} r={2.2} />}
                </g>
              );
            })}
          </g>
        </svg>
        {drawn.map(({ row, index, mark, picked }) => {
          const subject = row.commit?.subject ?? worktreeText(files);
          return (
            <div
              key={row.id}
              id={optionId(index)}
              className="compare-row"
              role="option"
              aria-selected={picked}
              aria-setsize={rows.length}
              aria-posinset={index + 1}
              data-id={row.id}
              data-active={index === active ? "" : undefined}
              data-worktree={row.commit === null ? "" : undefined}
              style={{ top: index * ROW, paddingLeft: gutter }}
              onClick={() => {
                setActive(index);
                pick(row.id);
              }}
            >
              <span className="compare-subject" data-full={subject}>
                {subject}
              </span>
              {row.commit?.refs.map((ref) => (
                <span key={ref} className="compare-ref">
                  {ref}
                </span>
              ))}
              <span className="compare-gap" />
              {mark !== null && (
                <span className="compare-mark" data-mark={mark === "대상" ? "target" : mark === "기준" ? "base" : "fork"}>
                  {mark}
                </span>
              )}
              {row.commit !== null && <span className="compare-hash">{shortHash(row.commit.hash)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
