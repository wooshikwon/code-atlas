import { describe, expect, it } from "vitest";
import { WORKTREE, type Commit, type History, type Ref, type Stat } from "../api/types";
import { historyFixture } from "../graph/history.fixture";
import { laneCount, markOf, pointName, reveal, ROW, rowsOf, spanOf } from "./log";

const commit = (hash: string, parents: string[], refs: Ref[] = []): Commit => ({ hash, parents, time: 0, subject: hash, refs });
const history = (commits: Commit[], head: string | null): History => ({ git: true, head, branch: null, default: null, dirty: false, commits, more: false });
const stat = (base: string, target: string, fork: string | null = null): Stat => ({ base, target, fork, files: 1, added: 1, deleted: 1 });

describe("rowsOf", () => {
  it("작업 중인 상태의 줄을 맨 위에 더하고 지금 커밋으로 점선을 내린다", () => {
    const rows = rowsOf(history([commit("c", ["b"]), commit("b", ["a"]), commit("a", [])], "c"));
    expect(rows.map((row) => [row.id, row.lane])).toEqual([[WORKTREE, 0], ["c", 0], ["b", 0], ["a", 0]]);
    expect(rows[0].commit).toBeNull();
    expect(rows[1].commit?.hash).toBe("c");
    expect(rows.map((row) => row.links.map((link) => link.loose))).toEqual([[], [true], [false], [false]]);
  });

  it("지금 커밋이 첫 줄이 아니면 점선이 그 사이의 줄을 지나 지금 커밋의 줄에서 끝난다", () => {
    // x는 다른 브랜치의 끝이고 지금 커밋 c보다 새 커밋이다.
    const rows = rowsOf(history([commit("x", ["a"]), commit("c", ["a"]), commit("a", [])], "c"));
    expect(rows.map((row) => row.lane)).toEqual([0, 1, 0, 0]);
    expect(rows[1].links).toEqual([{ to: "c", from: 0, into: 0, loose: true }]);
    expect(rows[2].links).toEqual([
      { to: "c", from: 0, into: 0, loose: true },
      { to: "a", from: 1, into: 1, loose: false },
    ]);
    expect(rows[3].links.every((link) => !link.loose)).toBe(true);
  });

  it("커밋이 없으면 작업 중인 상태의 줄만 있다", () => {
    expect(rowsOf(history([], null))).toEqual([{ id: WORKTREE, commit: null, lane: 0, links: [] }]);
  });

  it("code-atlas 레포의 이력에서 점선이 지금 커밋까지 끊기지 않는다", () => {
    const head = historyFixture[40].hash;
    const rows = rowsOf(history(historyFixture, head));
    const at = rows.findIndex((row) => row.id === head);
    expect(rows.slice(1, at + 1).every((row) => row.links.filter((link) => link.loose).length === 1)).toBe(true);
    expect(rows.slice(at + 1).some((row) => row.links.some((link) => link.loose))).toBe(false);
    expect(rows[at].links.find((link) => link.loose)?.into).toBe(rows[at].lane);
  });
});

describe("laneCount", () => {
  it("커밋이 놓이는 세로 줄과 선이 지나는 세로 줄을 함께 센다", () => {
    expect(laneCount(rowsOf(history([commit("c", [])], "c")))).toBe(1);
    expect(laneCount(rowsOf(history([commit("x", ["a"]), commit("c", ["a"]), commit("a", [])], "c")))).toBe(2);
  });
});

describe("markOf", () => {
  it("기준·대상을 받기 전에는 표시가 없다", () => {
    expect(markOf("a", ["a", "b"], null)).toBeNull();
  });

  it("고른 줄 가운데 새 쪽이 대상이고 다른 쪽이 기준이다", () => {
    const picks = ["b", "a"];
    expect(["a", "b", "c"].map((id) => markOf(id, picks, stat("a", "b")))).toEqual(["기준", "대상", null]);
  });

  it("갈라진 커밋이 실제 기준이면 고른 줄에 기준, 갈라진 커밋의 줄에 갈라진 지점이 붙는다", () => {
    const picks = ["m", WORKTREE];
    expect(["m", WORKTREE, "f", "z"].map((id) => markOf(id, picks, stat("f", WORKTREE, "f")))).toEqual(["기준", "대상", "갈라진 지점", null]);
  });
});

describe("pointName", () => {
  const commits = [commit("0123456789abcdef", [], [{ name: "main", kind: "branch" }, { name: "origin/main", kind: "remote" }]), commit("fedcba9876543210", [])];

  it("첫 브랜치·태그 이름, 없으면 짧은 해시, 작업 중인 상태는 작업 중이다", () => {
    expect(pointName("0123456789abcdef", commits)).toBe("main");
    expect(pointName("fedcba9876543210", commits)).toBe("fedcba9");
    expect(pointName("aaaaaaaaaaaaaaaa", commits)).toBe("aaaaaaa");
    expect(pointName(WORKTREE, commits)).toBe("작업 중");
  });
});

describe("spanOf와 reveal", () => {
  it("보이는 줄의 위와 아래로 다섯 줄을 더 그리고 목록을 넘지 않는다", () => {
    expect(spanOf(0, 10 * ROW, 243)).toEqual({ start: 0, end: 15 });
    expect(spanOf(100 * ROW + 5, 10 * ROW, 243)).toEqual({ start: 95, end: 116 });
    expect(spanOf(240 * ROW, 10 * ROW, 243)).toEqual({ start: 235, end: 243 });
    expect(spanOf(0, 10 * ROW, 3)).toEqual({ start: 0, end: 3 });
  });

  it("줄이 보이는 범위 밖이면 그 줄이 끝에 걸리게 스크롤한다", () => {
    expect(reveal(3, 0, 10 * ROW)).toBe(0);
    expect(reveal(12, 0, 10 * ROW)).toBe(3 * ROW);
    expect(reveal(2, 5 * ROW, 10 * ROW)).toBe(2 * ROW);
  });
});
