// 선의 말풍선. 커서 밑의 선을 줄마다 출발·도착·관계 세 칸으로 적고 맨 위에 칸 이름을 적는다. 시점 비교가 켜져 있으면 넷째 칸 변경을 더해
// 그 줄의 관계가 신규인지 삭제인지 유지인지 적고, 출발·도착 칸의 이름 뒤에 그 노드의 줄 수를 작게 적는다. 선에 마우스를 올린 동안에는 마우스 옆에
// 떠 있고 누를 수 없으며, 선을 누르면 같은 모양으로 그곳에 고정돼 칸을 누를 수 있다. 출발·도착 칸의 이름은 그 노드로 가고,
// 관계 칸은 그 관계의 코드 줄 목록을 연다. 고정한 말풍선은 방향키로 줄과 칸을 옮기고 말풍선 밖을 누르면 풀린다.
import { Fragment, useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Diff } from "./nodes/common";
import { changeParts, type CellName, type LineRow } from "./rows";
import type { EdgeKey } from "./scope";
import { placeBeside } from "./Tooltip";

/** 말풍선 하나. (x, y)는 말풍선을 띄운 마우스의 화면 좌표이고 lit은 고정한 동안 강조할 수 있는 선, lines는 줄로 푼 선의 키를 줄바꿈으로 이은 글이다. */
export interface Bubble {
  x: number;
  y: number;
  rows: LineRow[];
  pinned: boolean;
  lit: EdgeKey[];
  lines: string;
}

interface LineBubbleProps {
  bubble: Bubble;
  /** 줄 row의 출발 노드나 도착 노드 id를 칸에 적는 이름 */
  name: (row: LineRow, id: string) => CellName;
  /** 줄에 마우스를 올리거나 방향키로 초점을 옮기면 그 줄의 선, 마우스가 떠나면 null을 받는다. */
  aim: (key: EdgeKey | null) => void;
  /** 줄 row의 출발 노드나 도착 노드 id로 간다. */
  go: (row: LineRow, id: string) => void;
  /** 줄 row의 코드 줄 목록을 연다. */
  list: (row: LineRow) => void;
  close: () => void;
}

const COLUMNS = ["출발", "도착", "관계"];
const CHANGE_COLUMN = "변경";
/** 칸의 이름과 그 뒤에 적는 줄 수 사이의 폭 */
const CELL_DIFF_GAP = 6;
const MOVES: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

/** 지금 그린 말풍선의 요소. 마우스를 따라 옮길 때 쓴다. */
let drawn: HTMLElement | null = null;

/** 떠 있는 말풍선을 마우스 (x, y) 옆으로 옮긴다. */
export function moveBubble(x: number, y: number): void {
  if (drawn !== null) {
    placeBeside(drawn, x, y);
  }
}

export function LineBubble({ bubble, name, aim, go, list, close }: LineBubbleProps) {
  const element = useRef<HTMLDivElement | null>(null);
  const { rows, pinned } = bubble;
  const columns = rows.some((row) => row.change !== undefined) ? [...COLUMNS, CHANGE_COLUMN] : COLUMNS;

  useLayoutEffect(() => {
    drawn = element.current;
    moveBubble(bubble.x, bubble.y);
    return () => {
      drawn = null;
    };
  }, [bubble]);

  // 고정하면 첫 누를 칸에 초점을 두고, 말풍선 밖을 누르면 푼다. 선을 누른 것은 그 선의 클릭 처리가 말풍선을 바꾼다.
  useEffect(() => {
    if (!pinned) {
      return;
    }
    element.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (element.current?.contains(target) !== true && target.closest(".react-flow__edge") === null) {
        close();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [pinned, close]);

  /** 방향키로 초점을 옮긴다. 위아래는 같은 칸의 누를 수 있는 가장 가까운 줄로, 좌우는 같은 줄의 옆 칸으로 간다. */
  const move = (event: ReactKeyboardEvent) => {
    const step = MOVES[event.key];
    const from = document.activeElement instanceof HTMLElement ? document.activeElement.dataset : undefined;
    if (step === undefined || from?.row === undefined) {
      return;
    }
    event.preventDefault();
    const cell = (row: number, column: number) => element.current?.querySelector<HTMLElement>(`button[data-row="${row}"][data-column="${column}"]`) ?? null;
    let [row, column] = [Number(from.row) + step[0], Number(from.column) + step[1]];
    while (row >= 0 && row < rows.length && column >= 0 && column < COLUMNS.length && cell(row, column) === null) {
      [row, column] = [row + step[0], column + step[1]];
    }
    cell(row, column)?.focus();
  };

  /** 칸 하나. press가 있고 고정한 말풍선이면 누를 수 있다. */
  const cell = (row: number, column: number, kind: string, content: CellName, node: string | undefined, press: (() => void) | null) => {
    const text = (
      <>
        {content.path !== "" && (
          <span className="line-cell-path">
            <bdi>{content.path}</bdi>
          </span>
        )}
        <span className="line-cell-name">{content.name}</span>
        {content.lines !== undefined && <Diff lines={content.lines} gap={CELL_DIFF_GAP} />}
      </>
    );
    return (
      <td data-cell={kind} data-node={node}>
        {pinned && press !== null ? (
          <button type="button" className="line-cell" data-full={content.full} data-row={row} data-column={column} onClick={press} onFocus={(event) => event.currentTarget.matches(":focus-visible") && aim(rows[row].line)}>
            {text}
          </button>
        ) : (
          <span className="line-cell" data-full={content.full}>
            {text}
          </span>
        )}
      </td>
    );
  };

  return createPortal(
    <div ref={element} className="line-bubble" data-pinned={pinned ? "" : undefined} role={pinned ? "dialog" : "tooltip"} aria-label={`선의 ${columns.join(", ")}`} onKeyDown={move} onMouseLeave={() => aim(null)}>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} data-key={row.line} onMouseEnter={() => aim(row.line)}>
              {cell(i, 0, "source", name(row, row.source), row.source, row.keys === null ? null : () => go(row, row.source))}
              {cell(i, 1, "target", name(row, row.target), row.target, row.keys === null ? null : () => go(row, row.target))}
              {cell(i, 2, "relation", { path: "", name: row.relation, full: row.relation }, undefined, row.list === null ? null : () => list(row))}
              {row.change !== undefined && (
                <td data-cell="change">
                  <span className="line-cell">
                    <span className="line-cell-name">
                      {changeParts(row.change).map(({ kind, text }, at) => (
                        <Fragment key={kind}>
                          {at > 0 && " · "}
                          <span className="line-change" data-kind={kind}>
                            {text}
                          </span>
                        </Fragment>
                      ))}
                    </span>
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>,
    document.body,
  );
}
