// 커밋 그래프의 세로 줄 배정. 최신이 위인 커밋 목록을 위에서 아래로 한 번 훑어 줄마다 커밋이 놓이는 세로 줄과 그 줄로 내려오는 선을 정한다.
// 한 줄의 배정은 그 줄과 그 위의 줄만으로 정해지므로, 목록 뒤에 줄을 이어 붙여도 앞의 배정이 그대로다.
import type { Commit } from "../api/types";

/** 윗줄에서 이 줄로 내려오는 선 하나. 윗줄의 세로 줄 from에서 이 줄의 세로 줄 into로 잇는다. */
export interface Link {
  /** 이 선이 닿으려는 커밋의 해시. 이 줄의 커밋이면 선이 여기서 끝나고, 아니면 아래로 이어진다. */
  to: string;
  from: number;
  into: number;
}

export interface Lane {
  hash: string;
  /** 커밋이 놓이는 세로 줄의 번호. 0이 맨 왼쪽이다. */
  lane: number;
  /** 윗줄과 이 줄 사이에 그리는 선. 첫 줄은 비어 있다. */
  links: Link[];
}

/** 열려 있는 세로 줄에서 아랫줄로 내려가는 선. lane은 그 선이 내려가는 세로 줄이다. */
interface Strand {
  to: string;
  from: number;
  lane: number;
}

/**
 * 커밋 목록의 줄마다 세로 줄을 배정한다. 커밋은 자기를 기다리던 세로 줄 가운데 맨 왼쪽에 놓이고 나머지 줄은 그 커밋으로 모인다.
 * 기다리던 줄이 없는 커밋(브랜치의 끝)은 비어 있는 맨 왼쪽 줄을 받는다. 첫째 부모는 커밋의 세로 줄을 잇고, 나머지 부모는
 * 그 부모를 이미 기다리는 줄이 있으면 그 줄로, 없으면 비어 있는 맨 왼쪽 줄로 내려간다. 부모가 없는 커밋에서 세로 줄이 끝난다.
 * 목록에 없는 부모를 기다리는 줄은 끝까지 열려 있다.
 */
export function lanes(commits: Commit[]): Lane[] {
  /** 세로 줄마다 기다리는 커밋의 해시. 비어 있는 줄은 null이다. */
  const open: (string | null)[] = [];
  const free = () => {
    const empty = open.indexOf(null);
    return empty === -1 ? open.length : empty;
  };
  let strands: Strand[] = [];
  return commits.map((commit) => {
    const waiting = open.indexOf(commit.hash);
    const lane = waiting === -1 ? free() : waiting;
    const links = strands.map(({ to, from, lane: down }) => ({ to, from, into: to === commit.hash ? lane : down }));
    for (let i = 0; i < open.length; i += 1) {
      if (open[i] === commit.hash) {
        open[i] = null;
      }
    }
    strands = open.flatMap((to, down) => (to === null ? [] : [{ to, from: down, lane: down }]));
    commit.parents.forEach((parent, order) => {
      const down = order === 0 ? lane : open.includes(parent) ? open.indexOf(parent) : free();
      open[down] = parent;
      strands.push({ to: parent, from: lane, lane: down });
    });
    while (open.length > 0 && open[open.length - 1] === null) {
      open.pop();
    }
    return { hash: commit.hash, lane, links };
  });
}
