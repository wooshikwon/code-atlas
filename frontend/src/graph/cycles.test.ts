import { describe, expect, it } from "vitest";
import type { Graph } from "../api/types";
import { cycles } from "./cycles";
import { edge, node, repoFixture, routeFixture } from "./fixture";
import { hidden } from "./visible";

const off = hidden(routeFixture, { showTests: false, showExternal: false });
const all = hidden(routeFixture, { showTests: true, showExternal: false });

describe("cycles", () => {
  it("서로를 import해 돌아오는 파일을 묶음으로 내고 묶음과 묶음 안을 id순으로 둔다", () => {
    const result = cycles(routeFixture, off);
    expect(result.groups).toEqual([
      ["north.up", "south.down"],
      ["ring.a", "ring.b", "ring.c"],
    ]);
    expect(Object.fromEntries(result.member)).toEqual({
      "north.up": 0,
      "south.down": 0,
      "ring.a": 1,
      "ring.b": 1,
      "ring.c": 1,
    });
  });

  it("양 끝이 같은 묶음에 든 import 선만 순환 선이다", () => {
    expect([...cycles(routeFixture, off).edges].sort()).toEqual([
      "north.up|south.down|import",
      "ring.a|ring.b|import",
      "ring.b|ring.c|import",
      "ring.c|ring.a|import",
      "south.down|north.up|import",
    ]);
  });

  it("함수 안 import로만 돌아오는 파일은 묶음이 아니다", () => {
    const result = cycles(routeFixture, off);
    expect(result.member.has("lazy.one")).toBe(false);
    expect(result.member.has("lazy.two")).toBe(false);
    expect(cycles(repoFixture, hidden(repoFixture, { showTests: true, showExternal: true })).groups).toEqual([["cli", "main"]]);
  });

  it("폴더 사이에서만 돌아오는 import는 묶음이 아니다", () => {
    const result = cycles(routeFixture, off);
    expect(result.member.has("ring")).toBe(false);
    expect(result.member.has("lazy")).toBe(false);
    expect(result.edges.has("ring.a|lazy.two|import")).toBe(false);
    expect(result.edges.has("lazy.one|ring.b|import")).toBe(false);
  });

  it("테스트 코드를 켜면 테스트 코드를 거쳐 돌아오는 묶음이 더해진다", () => {
    expect(cycles(routeFixture, off).member.has("flow.walk")).toBe(false);
    const result = cycles(routeFixture, all);
    expect(result.groups).toEqual([
      ["flow.walk", "tests.fakes"],
      ["north.up", "south.down"],
      ["ring.a", "ring.b", "ring.c"],
    ]);
    expect(result.member.get("ring.b")).toBe(2);
    expect(result.edges.has("tests.fakes|flow.walk|import")).toBe(true);
    expect(result.edges.size).toBe(7);
  });

  it("한 묶음에 붙은 묶음 밖 파일과 서로 이어진 두 묶음을 나눈다", () => {
    const names = ["a", "b", "c", "d", "e"];
    const graph: Graph = {
      nodes: names.map((name) => node(name, "module", null)),
      edges: [
        edge("a", "b", "import"),
        edge("b", "a", "import"),
        edge("b", "c", "import"),
        edge("c", "d", "import"),
        edge("d", "c", "import"),
        edge("d", "e", "import"),
        edge("a", "a", "import"),
        edge("a", "e", "call"),
        edge("e", "a", "call"),
      ],
    };
    const result = cycles(graph, new Set());
    expect(result.groups).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect([...result.edges].sort()).toEqual(["a|b|import", "b|a|import", "c|d|import", "d|c|import"]);
  });

  it("노드 2,000개가 한 줄로 이어진 그래프에서 스택 넘침 없이 끝난다", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `m${String(i).padStart(4, "0")}`);
    const chain: Graph = {
      nodes: ids.map((id) => node(id, "module", null)),
      edges: ids.slice(1).map((id, i) => edge(ids[i], id, "import")),
    };
    expect(cycles(chain, new Set()).groups).toEqual([]);

    const loop: Graph = { nodes: chain.nodes, edges: [...chain.edges, edge(ids[1999], ids[0], "import")] };
    const result = cycles(loop, new Set());
    expect(result.groups).toEqual([ids]);
    expect(result.edges.size).toBe(2000);
  });
});
