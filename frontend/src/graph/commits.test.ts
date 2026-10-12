import { describe, expect, it } from "vitest";
import type { Commit } from "../api/types";
import { lanes, type Lane } from "./commits";
import { historyFixture } from "./history.fixture";

const commit = (hash: string, ...parents: string[]): Commit => ({ hash, parents, time: 0, subject: hash, refs: [] });

const placed = (rows: Lane[]) => rows.map((row) => `${row.hash}@${row.lane}`).join(" ");
const drawn = (row: Lane) => row.links.map((link) => `${link.to}:${link.from}>${link.into}`).sort();

/** 줄 from의 커밋에서 부모 parent로 내려가는 선을 줄마다 따라가 부모의 줄에 닿으면 참이다. */
function reaches(rows: Lane[], from: number, parent: string): boolean {
  let at = rows[from].lane;
  for (let row = from + 1; row < rows.length; row += 1) {
    const link = rows[row].links.find((l) => l.to === parent && l.from === at);
    if (link === undefined) {
      return false;
    }
    if (rows[row].hash === parent) {
      return link.into === rows[row].lane;
    }
    at = link.into;
  }
  return false;
}

describe("lanes", () => {
  it("한 줄 이력은 모든 커밋이 세로 줄 0에 놓이고 윗줄에서 선 하나가 내려온다", () => {
    const rows = lanes([commit("c", "b"), commit("b", "a"), commit("a")]);
    expect(placed(rows)).toBe("c@0 b@0 a@0");
    expect(rows.map(drawn)).toEqual([[], ["b:0>0"], ["a:0>0"]]);
  });

  it("갈라졌다 합쳐진 이력은 병합 커밋의 둘째 부모가 새 세로 줄로 내려가고 갈라진 커밋에서 모인다", () => {
    const rows = lanes([commit("m", "c", "f"), commit("f", "a"), commit("c", "a"), commit("a")]);
    expect(placed(rows)).toBe("m@0 f@1 c@0 a@0");
    expect(rows.map(drawn)).toEqual([[], ["c:0>0", "f:0>1"], ["a:1>1", "c:0>0"], ["a:0>0", "a:1>0"]]);
  });

  it("합쳐지지 않은 브랜치의 끝은 비어 있는 세로 줄을 받고 갈라진 커밋으로 모인다", () => {
    const rows = lanes([commit("x", "a"), commit("c", "b"), commit("y", "x0"), commit("b", "a"), commit("a")]);
    expect(placed(rows)).toBe("x@0 c@1 y@2 b@1 a@0");
    expect(drawn(rows[4])).toEqual(["a:0>0", "a:1>0", "x0:2>2"]);
  });

  it("세로 줄이 끝나 비면 다음 브랜치의 끝이 그 줄을 받는다", () => {
    const rows = lanes([commit("c", "a"), commit("f", "a"), commit("a"), commit("z", "y"), commit("y")]);
    expect(placed(rows)).toBe("c@0 f@1 a@0 z@0 y@0");
    expect(drawn(rows[3])).toEqual([]);
  });

  it("둘째 부모를 이미 기다리는 세로 줄이 있으면 그 줄로 내려간다", () => {
    const rows = lanes([commit("f", "a"), commit("m", "c", "a"), commit("c", "a"), commit("a")]);
    expect(placed(rows)).toBe("f@0 m@1 c@1 a@0");
    expect(drawn(rows[2])).toEqual(["a:0>0", "a:1>0", "c:1>1"]);
    expect(drawn(rows[3])).toEqual(["a:0>0", "a:1>0"]);
  });

  it("목록에 없는 부모를 기다리는 세로 줄은 끝까지 열려 있다", () => {
    const rows = lanes([commit("c", "b"), commit("d", "gone"), commit("b")]);
    expect(placed(rows)).toBe("c@0 d@1 b@0");
    expect(drawn(rows[2])).toEqual(["b:0>0", "gone:1>1"]);
  });
});

describe("code-atlas 레포의 이력", () => {
  const rows = lanes(historyFixture);
  const index = new Map(historyFixture.map((c, row) => [c.hash, row]));

  it("병합 커밋 48개가 든 이력을 읽는다", () => {
    expect(historyFixture.length).toBeGreaterThan(240);
    expect(historyFixture.filter((c) => c.parents.length > 1)).toHaveLength(48);
  });

  it("모든 커밋에서 부모마다 내려가는 선이 부모의 줄에 닿는다", () => {
    const broken = historyFixture.flatMap((c, row) => c.parents.filter((p) => index.has(p) && !reaches(rows, row, p)).map((p) => `${c.hash}→${p}`));
    expect(broken).toEqual([]);
  });

  it("한 줄에서 서로 다른 커밋으로 가는 선이 같은 세로 줄로 내려오지 않고, 지나가는 선이 커밋의 세로 줄을 지나지 않는다", () => {
    for (const row of rows) {
      const down = new Map<number, string>();
      for (const link of row.links) {
        expect(down.get(link.into) ?? link.to).toBe(link.to);
        down.set(link.into, link.to);
        expect(link.to === row.hash || link.into !== row.lane).toBe(true);
      }
    }
  });

  it("나란히 가는 브랜치만큼만 세로 줄을 쓴다", () => {
    expect(Math.max(...rows.map((row) => row.lane))).toBeLessThan(8);
  });

  it("200줄 뒤에 다음 묶음을 이어 붙여도 앞 200줄의 배정이 그대로다", () => {
    expect(lanes(historyFixture.slice(0, 200))).toEqual(rows.slice(0, 200));
    expect(lanes(historyFixture.slice(0, 37))).toEqual(rows.slice(0, 37));
  });
});
