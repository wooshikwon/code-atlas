import { describe, expect, it } from "vitest";
import { repoFixture, routeFixture } from "./fixture";
import { flow } from "./flow";
import { lit, route } from "./route";
import { hidden, lift, nodeIndex, shown, unresolvedWithin } from "./visible";

const nodes = nodeIndex(repoFixture);
const toggles = { showTests: false, showExternal: false };
const off = hidden(repoFixture, toggles);
const closed = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: null, lit: null });

describe("shown", () => {
  it("흐름이 없으면 폴더와 파일 상자만 남기고 파일 상자를 펼치지 않는다", () => {
    expect([...closed.nodes].sort()).toEqual(
      ["app", "app.__init__", "app.text", "app.web", "cli", "common", "main", "pkg", "pkg.mod", "pkg.util", "scratch"].sort(),
    );
    expect(closed.open.size).toBe(0);
  });

  it("테스트 코드와 외부 노드는 토글을 켰을 때만 남긴다", () => {
    const all = shown(repoFixture, { showTests: true, showExternal: true, collapsed: new Set(), flow: null, lit: null });
    for (const id of ["tests.test_mod", "pkg.conftest", "ext:json"]) {
      expect(closed.nodes.has(id)).toBe(false);
      expect(all.nodes.has(id)).toBe(true);
    }
    expect(all.nodes.has("tests.test_mod:test_load")).toBe(false);
  });

  it("접은 폴더는 폴더 노드만 남긴다", () => {
    const folded = shown(repoFixture, { ...toggles, collapsed: new Set(["pkg"]), flow: null, lit: null });
    expect(folded.nodes.has("pkg")).toBe(true);
    expect(folded.nodes.has("pkg.mod")).toBe(false);
    expect(folded.nodes.has("app.web")).toBe(true);
  });

  it("파일 상자를 고르면 그 파일 상자만 펼쳐 안의 노드를 모두 남긴다", () => {
    const result = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: flow(repoFixture, "pkg.mod", 2, off), lit: null });
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
    const result = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: flow(repoFixture, "main:run", 1, off), lit: null });
    expect([...result.open].sort()).toEqual(["cli", "main", "pkg.mod"]);
    expect([...result.nodes].filter((id) => id.includes(":")).sort()).toEqual([
      "cli:main",
      "main:helper",
      "main:run",
      "pkg.mod:Store",
      "pkg.mod:Store.load",
    ]);
  });

  it("폴더의 __init__.py에 든 정의를 고르면 __init__.py 파일 상자만 펼친다", () => {
    const result = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: flow(repoFixture, "app:version", 2, off), lit: null });
    expect([...result.nodes].filter((id) => id.includes(":"))).toEqual(["app:version"]);
    expect([...result.open]).toEqual(["app.__init__"]);
  });

  it("접힌 폴더를 고르면 파일 상자를 펼치지 않는다", () => {
    const result = shown(repoFixture, { ...toggles, collapsed: new Set(["pkg"]), flow: flow(repoFixture, "pkg", 2, off), lit: null });
    expect([...result.nodes].some((id) => id.startsWith("pkg."))).toBe(false);
    expect(result.open.size).toBe(0);
  });

  it("접은 폴더 안에서는 흐름에 든 노드도 남기지 않는다", () => {
    const result = shown(repoFixture, {
      ...toggles,
      collapsed: new Set(["pkg"]),
      flow: flow(repoFixture, "main:run", 1, off),
      lit: null,
    });
    expect(result.nodes.has("pkg.mod:Store.load")).toBe(false);
    expect([...result.open].sort()).toEqual(["cli", "main"]);
  });
});

describe("unresolvedWithin", () => {
  const graph = {
    ...repoFixture,
    nodes: repoFixture.nodes.map((n) => ({
      ...n,
      unresolved: { "pkg.mod": 1, "pkg.mod:Store.load": 2, "pkg.mod:parse": 3, "pkg.conftest:setup": 4, "main:run": 5 }[n.id] ?? 0,
    })),
  };

  it("노드와 안에 든 노드의 미확인 호출 수를 파일 상자와 폴더까지 합친다", () => {
    const result = unresolvedWithin(graph, hidden(graph, toggles));
    expect(Object.fromEntries(result)).toEqual({
      pkg: 6,
      "pkg.mod": 6,
      "pkg.mod:Store": 2,
      "pkg.mod:Store.load": 2,
      "pkg.mod:parse": 3,
      main: 5,
      "main:run": 5,
    });
  });

  it("토글로 숨긴 테스트 코드는 켰을 때만 센다", () => {
    const result = unresolvedWithin(graph, hidden(graph, { showTests: true, showExternal: false }));
    expect([result.get("pkg"), result.get("pkg.conftest")]).toEqual([10, 4]);
  });
});

describe("lift", () => {
  it("보이는 노드는 그대로, 보이지 않는 노드는 보이는 가장 가까운 조상으로 올린다", () => {
    expect(lift(nodes, closed, "pkg.mod")).toBe("pkg.mod");
    expect(lift(nodes, closed, "pkg.mod:Store.load")).toBe("pkg.mod");
    const folded = shown(repoFixture, { ...toggles, collapsed: new Set(["pkg"]), flow: null, lit: null });
    expect(lift(nodes, folded, "pkg.mod:Store.load")).toBe("pkg");
  });

  it("숨긴 외부 노드와 테스트 코드는 올리지 않는다", () => {
    expect(closed.hidden).toEqual(off);
    expect(lift(nodes, closed, "ext:json")).toBeNull();
    expect(lift(nodes, closed, "tests.test_mod:test_load")).toBeNull();
    expect(lift(nodes, closed, "pkg.conftest:setup")).toBeNull();
  });

  it("테스트 코드를 켜면 접은 폴더 안의 테스트 코드를 그 폴더로 올린다", () => {
    const folded = shown(repoFixture, { showTests: true, showExternal: false, collapsed: new Set(["pkg"]), flow: null, lit: null });
    expect(lift(nodes, folded, "pkg.conftest:setup")).toBe("pkg");
    expect(lift(nodes, folded, "tests.test_mod:test_load")).toBe("tests.test_mod");
  });
});

describe("shown: 강조하는 경로", () => {
  const hiddenNodes = hidden(routeFixture, toggles);
  const pathOf = (from: string, to: string) => lit(route(routeFixture, from, to, hiddenNodes), 0)!;
  const walk = pathOf("flow.walk:begin", "flow.walk:finish");
  const built = pathOf("flow.build:make", "flow.sink:tune");

  it("경로 위 노드만 남기고 그 노드가 든 파일 상자만 펼친다", () => {
    const result = shown(routeFixture, { ...toggles, collapsed: new Set(), flow: null, lit: walk });
    expect([...result.nodes].filter((id) => id.includes(":")).sort()).toEqual(["flow.walk:begin", "flow.walk:finish", "flow.walk:left"]);
    expect([...result.open]).toEqual(["flow.walk"]);
    expect(result.nodes.has("flow.build")).toBe(true);
    expect(result.nodes.has("ring.a")).toBe(true);
  });

  it("경로 위 메서드를 품은 클래스 노드를 남긴다", () => {
    const result = shown(routeFixture, { ...toggles, collapsed: new Set(), flow: null, lit: built });
    expect([...result.nodes].filter((id) => id.includes(":")).sort()).toEqual([
      "flow.build:Engine",
      "flow.build:Engine.__init__",
      "flow.build:make",
      "flow.sink:tune",
    ]);
    expect([...result.open].sort()).toEqual(["flow.build", "flow.sink"]);
  });

  it("경로 위 노드를 품은 접은 폴더는 펼친 것으로 다루고 다른 접은 폴더와 받은 집합은 그대로 둔다", () => {
    const collapsed = new Set(["flow", "ring"]);
    const result = shown(routeFixture, { ...toggles, collapsed, flow: null, lit: walk });
    expect(result.nodes.has("flow.walk:left")).toBe(true);
    expect(result.nodes.has("flow.build")).toBe(true);
    expect(result.open.has("flow.build")).toBe(false);
    expect(result.nodes.has("ring")).toBe(true);
    expect(result.nodes.has("ring.a")).toBe(false);
    expect([...collapsed]).toEqual(["flow", "ring"]);
  });

  it("경로가 있으면 흐름을 보지 않는다", () => {
    const picked = flow(routeFixture, "flow.build:Base.run", 2, hiddenNodes);
    const result = shown(routeFixture, { ...toggles, collapsed: new Set(), flow: picked, lit: walk });
    expect(result).toEqual(shown(routeFixture, { ...toggles, collapsed: new Set(), flow: null, lit: walk }));
  });
});
