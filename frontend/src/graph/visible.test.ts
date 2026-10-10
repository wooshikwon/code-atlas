import { describe, expect, it } from "vitest";
import { repoFixture } from "./fixture";
import { flow } from "./flow";
import { hidden, lift, nodeIndex, shown } from "./visible";

const nodes = nodeIndex(repoFixture);
const toggles = { showTests: false, showExternal: false };
const off = hidden(repoFixture, toggles);
const closed = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: null });

describe("shown", () => {
  it("흐름이 없으면 폴더와 파일 상자만 남기고 파일 상자를 펼치지 않는다", () => {
    expect([...closed.nodes].sort()).toEqual(
      ["app", "app.text", "app.web", "cli", "common", "main", "pkg", "pkg.mod", "pkg.util", "scratch"].sort(),
    );
    expect(closed.open.size).toBe(0);
  });

  it("테스트 코드와 외부 노드는 토글을 켰을 때만 남긴다", () => {
    const all = shown(repoFixture, { showTests: true, showExternal: true, collapsed: new Set(), flow: null });
    for (const id of ["tests.test_mod", "pkg.conftest", "ext:json"]) {
      expect(closed.nodes.has(id)).toBe(false);
      expect(all.nodes.has(id)).toBe(true);
    }
    expect(all.nodes.has("tests.test_mod:test_load")).toBe(false);
  });

  it("접은 폴더는 폴더 노드만 남긴다", () => {
    const folded = shown(repoFixture, { ...toggles, collapsed: new Set(["pkg"]), flow: null });
    expect(folded.nodes.has("pkg")).toBe(true);
    expect(folded.nodes.has("pkg.mod")).toBe(false);
    expect(folded.nodes.has("app.web")).toBe(true);
  });

  it("파일 상자를 고르면 그 파일 상자만 펼쳐 안의 노드를 모두 남긴다", () => {
    const result = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: flow(repoFixture, "pkg.mod", 2, off) });
    expect([...result.open]).toEqual(["pkg.mod"]);
    expect([...result.nodes].filter((id) => id.includes(":")).sort()).toEqual([
      "pkg.mod:Row",
      "pkg.mod:Store",
      "pkg.mod:Store.load",
      "pkg.mod:Store.save",
      "pkg.mod:parse",
    ]);
  });

  it("함수를 고르면 그 파일 상자는 모두, 다른 파일 상자는 흐름에 든 노드와 선을 보내는 노드만 남긴다", () => {
    const result = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: flow(repoFixture, "main:run", 1, off) });
    expect([...result.open].sort()).toEqual(["cli", "main", "pkg.mod"]);
    expect([...result.nodes].filter((id) => id.includes(":")).sort()).toEqual([
      "cli:main",
      "main:helper",
      "main:run",
      "pkg.mod:Store",
      "pkg.mod:Store.load",
    ]);
  });

  it("접은 폴더 안에서는 흐름에 든 노드도 남기지 않는다", () => {
    const result = shown(repoFixture, {
      ...toggles,
      collapsed: new Set(["pkg"]),
      flow: flow(repoFixture, "main:run", 1, off),
    });
    expect(result.nodes.has("pkg.mod:Store.load")).toBe(false);
    expect([...result.open].sort()).toEqual(["cli", "main"]);
  });
});

describe("lift", () => {
  it("보이는 노드는 그대로, 보이지 않는 노드는 보이는 가장 가까운 조상으로 올린다", () => {
    expect(lift(nodes, closed, "pkg.mod")).toBe("pkg.mod");
    expect(lift(nodes, closed, "pkg.mod:Store.load")).toBe("pkg.mod");
    const folded = shown(repoFixture, { ...toggles, collapsed: new Set(["pkg"]), flow: null });
    expect(lift(nodes, folded, "pkg.mod:Store.load")).toBe("pkg");
  });

  it("숨긴 외부 노드와 테스트 코드는 올리지 않는다", () => {
    expect(closed.hidden).toEqual(off);
    expect(lift(nodes, closed, "ext:json")).toBeNull();
    expect(lift(nodes, closed, "tests.test_mod:test_load")).toBeNull();
    expect(lift(nodes, closed, "pkg.conftest:setup")).toBeNull();
  });

  it("테스트 코드를 켜면 접은 폴더 안의 테스트 코드를 그 폴더로 올린다", () => {
    const folded = shown(repoFixture, { showTests: true, showExternal: false, collapsed: new Set(["pkg"]), flow: null });
    expect(lift(nodes, folded, "pkg.conftest:setup")).toBe("pkg");
    expect(lift(nodes, folded, "tests.test_mod:test_load")).toBe("tests.test_mod");
  });
});
