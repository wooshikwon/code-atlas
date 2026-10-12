// 비교 창의 커밋 그래프가 그리는 줄. 작업 중인 상태의 줄을 커밋 목록의 맨 위에 더해 세로 줄을 배정하고(`graph/commits.ts`), 줄마다 붙는 표시와
// 비교 버튼에 적는 시점 이름, 스크롤 위치에서 그릴 줄의 범위를 구한다.
import { WORKTREE, type Commit, type History, type Stat } from "../api/types";
import { lanes, type Link } from "../graph/commits";

/** 줄 하나의 높이(px) */
export const ROW = 24;
/** 줄에 적는 해시의 글자 수 */
const SHORT = 7;
/** 보이는 범위의 위와 아래에 더 그리는 줄 수이자, 아래 끝에서 이 수 안으로 들어오면 다음 묶음을 받는 줄 수 */
export const AHEAD = 5;

/** 윗줄에서 이 줄로 내려오는 선. loose는 작업 중인 상태의 줄에서 지금 커밋으로 내려가는 선이고 점선으로 그린다. */
export interface RowLink extends Link {
  loose: boolean;
}

export interface Row {
  /** 커밋의 해시나 `worktree` */
  id: string;
  /** 작업 중인 상태의 줄은 null이다. */
  commit: Commit | null;
  lane: number;
  links: RowLink[];
}

export type Mark = "기준" | "대상" | "갈라진 지점";

/**
 * 커밋 그래프의 줄. 첫 줄은 작업 중인 상태이고 지금 커밋을 부모로 삼아 세로 줄을 받는다. 작업 중인 상태의 줄에서 지금 커밋의 줄까지
 * 내려가는 선에 loose를 붙인다.
 */
export function rowsOf(history: History): Row[] {
  const { head, commits } = history;
  const top: Commit = { hash: WORKTREE, parents: head === null ? [] : [head], time: 0, subject: "", refs: [] };
  /** 작업 중인 상태에서 내려가는 선이 윗줄에서 지나던 세로 줄. 지금 커밋의 줄을 지나면 null이다. */
  let down: number | null = null;
  return lanes([top, ...commits]).map(({ hash, lane, links }, index) => {
    const from = down;
    if (index === 0) {
      down = head === null ? null : lane;
    } else if (from !== null) {
      down = hash === head ? null : (links.find((link) => link.to === head && link.from === from)?.into ?? null);
    }
    return {
      id: hash,
      commit: index === 0 ? null : commits[index - 1],
      lane,
      links: links.map((link) => ({ ...link, loose: from !== null && link.to === head && link.from === from })),
    };
  });
}

/** 줄이 쓰는 세로 줄의 수. 커밋이 놓이는 세로 줄과 선이 지나는 세로 줄 가운데 가장 큰 번호에 1을 더한 값이다. */
export function laneCount(rows: Row[]): number {
  return rows.reduce((most, row) => Math.max(most, row.lane, ...row.links.map((link) => link.into)), 0) + 1;
}

/**
 * 줄에 붙는 표시. 고른 두 줄의 기준·대상을 받은 뒤(stat)에만 붙는다. 고른 줄 가운데 새 쪽이 `대상`, 다른 쪽이 `기준`이고,
 * 두 줄이 조상 관계가 아니면 갈라진 커밋의 줄이 `갈라진 지점`이다.
 */
export function markOf(id: string, picks: string[], stat: Stat | null): Mark | null {
  if (stat === null) {
    return null;
  }
  if (picks.includes(id)) {
    return id === stat.target ? "대상" : "기준";
  }
  return id === stat.fork ? "갈라진 지점" : null;
}

export function shortHash(hash: string): string {
  return hash.slice(0, SHORT);
}

/** 비교 버튼에 적는 시점의 이름. 그 줄의 첫 이름표(로컬 브랜치, 태그, 원격 브랜치 순서)이고, 없으면 짧은 해시다. 작업 중인 상태는 `작업 중`이다. */
export function pointName(id: string, commits: Commit[]): string {
  if (id === WORKTREE) {
    return "작업 중";
  }
  return commits.find((commit) => commit.hash === id)?.refs[0]?.name ?? shortHash(id);
}

/** 스크롤 위치 top과 보이는 높이 height에서 그릴 줄의 범위 [start, end). 보이는 줄의 위와 아래로 AHEAD줄을 더 그린다. */
export function spanOf(top: number, height: number, count: number): { start: number; end: number } {
  const start = Math.max(0, Math.floor(top / ROW) - AHEAD);
  const end = Math.min(count, Math.ceil((top + height) / ROW) + AHEAD);
  return { start: Math.min(start, end), end };
}

/** index번째 줄이 보이는 높이 height 안에 들어오게 옮긴 스크롤 위치. 이미 다 보이면 top 그대로다. */
export function reveal(index: number, top: number, height: number): number {
  return Math.max(Math.min(top, index * ROW), (index + 1) * ROW - height);
}
