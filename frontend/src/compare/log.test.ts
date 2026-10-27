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
    expect(rows[1].links).toMatchObject([{ to: "c", from: 0, into: 0, loose: true }]);
    expect(rows[2].links).toMatchObject([
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

describe("선의 말풍선", () => {
  // main은 m2에서 feature를 합쳤다. feature의 끝 f2에는 이름표가 있고, 지운 브랜치의 커밋 d는 m1에서 합쳤다.
  const commits = [
    commit("m2", ["m1", "f2"], [{ name: "main", kind: "branch" }, { name: "v1", kind: "tag" }]),
    commit("f2", ["f1"], [{ name: "origin/feature", kind: "remote" }]),
    commit("f1", ["m0"]),
    commit("m1", ["m0", "d"]),
    commit("d", ["m0"]),
    commit("m0", []),
  ];
  const rows = rowsOf(history(commits, "m2"));
  const tips = (id: string) => rows.find((row) => row.id === id)!.links.map((link) => [link.to, link.tip]);

  it("첫째 부모로 내려가는 선은 자식 커밋의 브랜치이고 이름표가 없는 커밋은 자식에게서 이름을 받는다", () => {
    expect(tips("f1")).toContainEqual(["f1", "브랜치 origin/feature"]);
    expect(tips("m1")).toContainEqual(["m1", "브랜치 main"]);
    expect(tips("m0")).toContainEqual(["m0", "브랜치 origin/feature"]);
  });

  it("둘째 부모로 내려가는 선은 합친 선이고 이름표가 없는 쪽은 합친 브랜치의 이름을 빌린다", () => {
    expect(tips("f2")).toEqual([["m1", "브랜치 main"], ["f2", "합친 선 · 브랜치 origin/feature → main"]]);
    expect(tips("d")).toContainEqual(["d", "합친 선 · main에 합친 브랜치 → main"]);
    expect(tips("m0")).toContainEqual(["m0", "main에 합친 브랜치"]);
  });

  it("작업 중인 상태에서 내려가는 선은 지금 커밋으로 가는 선이다", () => {
    expect(tips("m2")).toEqual([["m2", "작업 중인 상태에서 지금 커밋으로 내려가는 선"]]);
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
