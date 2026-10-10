import { describe, expect, it } from "vitest";
import { repoFixture } from "./fixture";
import { flow } from "./flow";
import { drawn, ubiquitous, type DrawnEdge } from "./scope";
import { hidden, shown } from "./visible";

const toggles = { showTests: false, showExternal: false };
const off = hidden(repoFixture, toggles);

/** 고른 노드와 접은 폴더에서 그릴 선을 키로 찾는 표를 만든다. */
function draw(selection: string | null, collapsed: string[] = [], hover: string | null = null): Map<string, DrawnEdge> {
  const focus = selection === null ? null : flow(repoFixture, selection, 2, off);
  const visible = shown(repoFixture, { ...toggles, collapsed: new Set(collapsed), flow: focus });
  return new Map(drawn(repoFixture, visible, focus, hover).map((e) => [e.key, e]));
}

describe("ubiquitous", () => {
  const closed = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: null });

  it("상자 수의 3분의 1 이상에서 선이 들어오는 상자와 선을 보내는 상자 수를 낸다", () => {
    expect([...ubiquitous(repoFixture, closed)]).toEqual([["common", 4]]);
  });

  it("파일 상자를 펼쳐도 결과가 같다", () => {
    const focus = flow(repoFixture, "cli:main", 2, off);
    const visible = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: focus });
    expect([...ubiquitous(repoFixture, visible)]).toEqual([["common", 4]]);
  });
});

describe("drawn", () => {
  it("규칙 1: 고른 노드가 없으면 상자 사이의 선을 그리고, 올린 선은 집계 선 하나로 합친다", () => {
    const edges = draw(null);
    expect([...edges.keys()].sort()).toEqual(
      [
        "agg|app.web|app.text",
        "agg|cli|main",
        "agg|main|pkg.mod",
        "agg|pkg.mod|main",
        "main|cli|import",
        "pkg.mod|pkg.util|import",
      ].sort(),
    );
    expect(edges.get("agg|main|pkg.mod")).toMatchObject({
      weight: 4,
      group: "run",
      kinds: { import: 1, call: 3 },
      tone: "muted",
      opacity: 1,
      deferred: false,
    });
    expect(edges.get("pkg.mod|pkg.util|import")?.deferred).toBe(true);
  });

  it("접은 폴더로 올린 선은 폴더에서 잇고 무게를 합친다. 폴더 안의 선과 숨긴 테스트 코드의 선은 넣지 않는다", () => {
    const edges = draw(null, ["pkg"]);
    expect(edges.get("agg|main|pkg")).toMatchObject({ weight: 4, kinds: { import: 1, call: 3 } });
    expect(edges.get("agg|pkg|main")?.weight).toBe(1);
    expect([...edges.keys()].some((key) => key.includes("pkg.mod"))).toBe(false);
  });

  it("테스트 코드를 켜면 접은 폴더 안 테스트 파일의 선을 폴더의 집계 선에 넣는다", () => {
    const visible = shown(repoFixture, { showTests: true, showExternal: false, collapsed: new Set(["pkg"]), flow: null });
    const edges = new Map(drawn(repoFixture, visible, null, null).map((e) => [e.key, e]));
    expect(edges.get("agg|pkg|main")).toMatchObject({ weight: 2, kinds: { call: 2 } });
    expect(edges.get("agg|tests.test_mod|pkg")?.weight).toBe(1);
  });

  it("흐름이 depth보다 앞 단계에서 끝나면 끝 단계로 가는 선을 흐리지 않는다", () => {
    const focus = flow(repoFixture, "app.web:render", 3, off);
    const visible = shown(repoFixture, { ...toggles, collapsed: new Set(), flow: focus });
    const pad = drawn(repoFixture, visible, focus, null).find((e) => e.key === "app.text:wrap|app.text:pad|call");
    expect(pad?.opacity).toBe(1);
  });

  it("규칙 2: 함수를 고르면 흐름에 든 노드 사이의 선과 들어오는 선을 원래 선으로 그린다", () => {
    const edges = draw("app.web:render");
    expect(edges.get("app.web:render|app.text:wrap|call")).toMatchObject({ tone: "outgoing", opacity: 1 });
    expect(edges.get("app.web:index|app.web:render|call")).toMatchObject({ tone: "incoming", opacity: 1 });
    expect(edges.get("app.text:wrap|app.text:pad|call")).toMatchObject({ tone: "muted", opacity: 0.5 });
  });

  it("규칙 2: 접힌 상자 사이의 선은 흐리게 그대로 그리고, 펼친 파일 상자에 닿는 흐름 밖 선은 그리지 않는다", () => {
    const edges = draw("app.web:render");
    expect(edges.get("agg|main|pkg.mod")).toMatchObject({ tone: "muted", opacity: 0.2 });
    expect(edges.has("app.web|app.text|import")).toBe(false);
    expect(edges.has("agg|app.web|app.text")).toBe(false);
  });

  it("규칙 2: 고른 노드가 든 파일 상자 안의 선을 그린다", () => {
    const edges = draw("pkg.mod:parse");
    expect(edges.get("pkg.mod:Store.load|pkg.mod:Row|construct")).toMatchObject({ tone: "muted", opacity: 0.2 });
    expect(edges.get("pkg.mod:Store.save|pkg.mod:parse|call")?.tone).toBe("incoming");
  });

  it("규칙 2: 흐름이 접은 폴더로 들어가면 폴더에서 잇는다", () => {
    const edges = draw("main:run", ["pkg"]);
    expect(edges.get("agg|main:run|pkg")).toMatchObject({ weight: 3, tone: "outgoing", opacity: 1 });
  });

  it("규칙 2: 파일 상자를 고르면 안의 선은 원래 선으로, 경계를 넘는 선은 파일 상자 사이 집계 선으로 그린다", () => {
    const edges = draw("pkg.mod");
    expect(edges.get("pkg.mod:Store.load|pkg.mod:Store.save|call")).toMatchObject({ tone: "muted", opacity: 1 });
    expect(edges.get("agg|main|pkg.mod")).toMatchObject({ weight: 4, tone: "incoming" });
    expect(edges.get("agg|pkg.mod|main")).toMatchObject({ weight: 1, tone: "outgoing" });
    expect(edges.get("pkg.mod|pkg.util|import")).toMatchObject({ tone: "outgoing", deferred: true });
    expect(edges.get("agg|cli|main")).toMatchObject({ tone: "muted", opacity: 0.5 });
    expect(edges.get("agg|app.web|app.text")?.opacity).toBe(0.2);
  });

  it("규칙 2: 마우스를 올린 노드에 닿는 선은 모두 그린다", () => {
    const edges = draw(null, [], "common");
    expect([...edges.keys()].filter((key) => key.includes("common")).sort()).toEqual([
      "agg|cli|common",
      "app.web|common|import",
      "main|common|import",
      "pkg.mod|common|import",
    ]);
  });

  it("규칙 3: 편재 노드로 들어오는 선을 숨기고, 편재 노드와 무관한 노드를 골라도 숨긴다", () => {
    for (const selection of [null, "scratch", "app.text:pad"]) {
      expect([...draw(selection).values()].some((e) => e.target === "common")).toBe(false);
    }
  });

  it("규칙 3: 편재 노드를 고르면 들어오는 선을 다시 그린다", () => {
    const edges = draw("common");
    expect(edges.get("main|common|import")?.tone).toBe("incoming");
    expect(edges.get("agg|cli|common")).toMatchObject({ weight: 2, tone: "incoming" });
    expect(edges.has("app.web|common|import")).toBe(true);
  });

  it("규칙 3: 편재 노드를 쓰는 노드를 고르면 숨긴 선을 모두 다시 그린다", () => {
    const edges = draw("cli");
    expect(edges.get("agg|cli|common")).toMatchObject({ weight: 2, tone: "outgoing", opacity: 1 });
    expect(edges.get("pkg.mod|common|import")).toMatchObject({ tone: "muted", opacity: 0.5 });
    expect(edges.get("app.web|common|import")?.opacity).toBe(0.2);
  });

  it("그린 선의 양 끝은 늘 보이는 노드다", () => {
    for (const [selection, collapsed] of [
      [null, []],
      ["main:run", ["app"]],
      ["pkg.mod", []],
      ["pkg", ["pkg"]],
    ] as const) {
      const focus = selection === null ? null : flow(repoFixture, selection, 3, off);
      const visible = shown(repoFixture, { ...toggles, collapsed: new Set(collapsed), flow: focus });
      for (const e of drawn(repoFixture, visible, focus, null)) {
        expect(visible.nodes.has(e.source) && visible.nodes.has(e.target), e.key).toBe(true);
      }
    }
  });
});
