import { describe, expect, it } from "vitest";
import { repoFixture } from "./fixture";
import { flow } from "./flow";
import { rowsOf, stageOf, type RowLine } from "./rows";
import { drawn } from "./scope";
import { hidden, nodeIndex, shown } from "./visible";

const toggles = { showTests: false, showExternal: false };
const off = hidden(repoFixture, toggles);
const nodes = nodeIndex(repoFixture);

/** 고른 노드 selection과 접은 폴더 collapsed에서 그린 선을 키로 찾는 표 */
function lines(selection: string | null, collapsed: string[] = []): Map<string, RowLine> {
  const focus = selection === null ? null : flow(repoFixture, selection, 2, off);
  const visible = shown(repoFixture, { ...toggles, collapsed: new Set(collapsed), flow: focus, lit: null });
  return new Map(drawn(repoFixture, visible, focus, null, null).map((edge) => [edge.key, edge]));
}

describe("stageOf", () => {
  it("고른 노드가 없거나 고른 노드에 닿지 않는 선은 화면에 그린 양 끝을 적는다", () => {
    expect(stageOf(nodes, null, lines(null, ["pkg"]).get("agg|main|pkg")!)).toBe("drawn");
    const apart = [...lines("main:run", ["pkg"]).values()].filter((line) => line.source !== "main:run" && line.target !== "main:run");
    expect(apart.length).toBeGreaterThan(0);
    expect(apart.map((line) => stageOf(nodes, "main:run", line))).toEqual(apart.map(() => "drawn"));
  });

  it("고른 노드에 닿는 선은 함수(클래스, 메서드)면 함수 단계, 파일이면 파일 단계다", () => {
    expect(stageOf(nodes, "main:run", lines("main:run", ["pkg"]).get("agg|main:run|pkg")!)).toBe("function");
    expect(stageOf(nodes, "main", lines("main", ["pkg"]).get("agg|main|pkg")!)).toBe("file");
  });

  it("폴더는 단계가 아니다", () => {
    expect(stageOf(nodes, "pkg", lines("pkg", ["pkg"]).get("agg|main|pkg")!)).toBe("drawn");
  });
});

describe("rowsOf", () => {
  it("고른 노드가 없으면 그린 양 끝 한 줄이고 이름을 누르면 그 선의 키를 지나온 선으로 담는다", () => {
    expect(rowsOf(nodes, null, lines(null, ["pkg"]).get("agg|main|pkg")!)).toEqual([
      { line: "agg|main|pkg", source: "main", target: "pkg", relation: "호출 3곳", keys: ["agg|main|pkg"], list: "agg|main|pkg" },
    ]);
  });

  it("함수를 고르면 접힌 폴더로 뭉친 선을 실제 상대 함수로 풀고 세는 관계만 줄로 낸다", () => {
    expect(rowsOf(nodes, "main:run", lines("main:run", ["pkg"]).get("agg|main:run|pkg")!)).toEqual([
      {
        line: "agg|main:run|pkg",
        source: "main:run",
        target: "pkg.mod:Store.load",
        relation: "호출 3곳",
        keys: ["main:run|pkg.mod:Store.load|call"],
        list: "main:run|pkg.mod:Store.load|call",
      },
    ]);
  });

  it("함수를 고른 선에 세는 관계가 없으면 그린 양 끝과 관계 글을 누를 수 없는 줄 하나로 낸다", () => {
    const line: RowLine = { key: "f|m|import", source: "main:run", target: "common", kinds: { import: 1 }, route: null, edges: [{ ...repoFixture.edges[0], source: "main:run", target: "common" }] };
    expect(rowsOf(nodes, "main:run", line)).toEqual([{ line: "f|m|import", source: "main:run", target: "common", relation: "import 관계만 있음", keys: null, list: "f|m|import" }]);
  });

  it("파일을 고르면 접힌 폴더로 뭉친 선의 상대 끝을 그 안의 파일로 풀고 고른 파일 쪽은 그린 노드를 적는다", () => {
    expect(rowsOf(nodes, "main", lines("main", ["pkg"]).get("agg|main|pkg")!)).toEqual([
      { line: "agg|main|pkg", source: "main", target: "pkg.mod", relation: "호출 3곳", keys: ["agg|main|pkg.mod"], list: "agg|main|pkg" },
    ]);
    expect(rowsOf(nodes, "main", lines("main", ["pkg"]).get("agg|pkg|main")!)).toEqual([
      { line: "agg|pkg|main", source: "pkg.mod", target: "main", relation: "호출 1곳", keys: ["agg|pkg.mod|main"], list: "pkg.mod:Store.save|main:helper|call" },
    ]);
  });

  it("파일 단계의 줄은 import만 있는 선도 누를 수 있다", () => {
    const [row] = rowsOf(nodes, "main", lines("main").get("main|common|import")!);
    expect(row).toMatchObject({ source: "main", target: "common", relation: "import 관계만 있음", keys: ["main|common|import"] });
  });

  it("실행 선이 없는 경로의 이음은 걸음의 이름을 적고 코드 줄 목록이 없다", () => {
    const step: RowLine = { key: "step|a|b", source: "a", target: "b", kinds: {}, route: "init", edges: [] };
    expect(rowsOf(nodes, null, step)).toEqual([{ line: "step|a|b", source: "a", target: "b", relation: "생성자 이음", keys: ["step|a|b"], list: null }]);
  });

  it("원래 선 없이 넘긴 함수 시점 뷰의 선은 그린 양 끝 한 줄이고 코드 줄 목록을 연다", () => {
    const call: RowLine = { key: "a|b|call", source: "a", target: "b", kinds: { call: 2 }, route: null, edges: [] };
    expect(rowsOf(nodes, null, call)).toEqual([{ line: "a|b|call", source: "a", target: "b", relation: "호출 2곳", keys: ["a|b|call"], list: "a|b|call" }]);
  });
});
