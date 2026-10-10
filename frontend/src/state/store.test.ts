import { beforeEach, describe, expect, it, vi } from "vitest";
import { repoFixture } from "../graph/fixture";
import { back, jump, push, type History, type Place } from "./history";
import { parseUi, useAtlas } from "./store";

const [a, b, c] = repoFixture.nodes.filter((n) => n.kind === "function" || n.kind === "method").map((n) => n.id);
const folder = repoFixture.nodes.find((n) => n.kind === "package")!.id;

const store = () => useAtlas.getState();
const selected = () => store().history.entries.map((place) => place.selection);
const node = (id: string) => ({ type: "node", id });

beforeEach(() => {
  useAtlas.setState({ ...useAtlas.getInitialState(), graph: repoFixture }, true);
});

describe("select", () => {
  it("같은 노드를 다시 고르면 선택이 풀린다", () => {
    store().select(a);
    expect(store().selection).toEqual(node(a));
    store().select(a);
    expect(store().selection).toBeNull();
    expect(selected()).toEqual([null, node(a), null]);
  });

  it("그래프에 없는 id는 고르지 않는다", () => {
    store().select(a);
    store().select("없는:노드");
    expect(store().selection).toEqual(node(a));
    expect(store().history.entries).toHaveLength(2);
  });

  it("선을 고른 뒤 노드를 고르면 선택이 그 노드로 바뀐다", () => {
    store().selectEdge("agg|x|y");
    expect(store().selection).toEqual({ type: "edge", key: "agg|x|y" });
    store().select(a);
    expect(store().selection).toEqual(node(a));
  });
});

describe("show", () => {
  it("함수 시점 뷰에서 구조 뷰로 돌아가 그 노드를 고르고 이력에 한 단계를 넣는다", () => {
    store().enterFunction(a);
    store().expandFunction(b);
    store().show(c);
    expect(store().view).toEqual({ kind: "structure" });
    expect(store().selection).toEqual(node(c));
    expect(store().history).toMatchObject({ index: 3, entries: { length: 4 } });
    store().back();
    expect(store().view).toEqual({ kind: "function", center: a, expanded: [b] });
    expect(store().selection).toEqual(node(a));
  });

  it("구조 뷰에서 이미 고른 노드면 선택을 유지하고 이력에 넣지 않는다", () => {
    store().select(a);
    store().show(a);
    expect(store().selection).toEqual(node(a));
    expect(store().history.entries).toHaveLength(2);
  });

  it("접은 폴더 안의 노드면 그 노드의 조상 폴더를 펼치고, 그래프에 없는 id는 넘긴다", () => {
    store().toggleFolder(folder);
    store().show("pkg.mod:Store.save");
    expect(store().collapsed).toEqual(new Set());
    expect(store().history.entries).toHaveLength(3);
    store().show("없는:노드");
    expect(store().selection).toEqual(node("pkg.mod:Store.save"));
    expect(store().history.entries).toHaveLength(3);
  });
});

describe("접은 폴더와 선택", () => {
  it("접은 폴더 안의 노드를 고르면 그 노드의 조상 폴더를 펼치고 이력에 한 단계만 넣는다", () => {
    store().toggleFolder(folder);
    store().toggleFolder("app");
    store().select("pkg.mod:Store.save");
    expect(store().selection).toEqual(node("pkg.mod:Store.save"));
    expect(store().collapsed).toEqual(new Set(["app"]));
    expect(store().history.entries).toHaveLength(4);
    store().back();
    expect(store().selection).toBeNull();
    expect(store().collapsed).toEqual(new Set([folder, "app"]));
  });

  it("접은 폴더 자신을 고르면 접힌 채로 둔다", () => {
    store().toggleFolder(folder);
    store().select(folder);
    expect(store().collapsed).toEqual(new Set([folder]));
  });

  it("고른 노드가 든 폴더를 접으면 선택을 풀고 이력에 한 단계만 넣는다", () => {
    store().select("pkg.mod:Store.save");
    store().toggleFolder(folder);
    expect(store().selection).toBeNull();
    expect(store().collapsed).toEqual(new Set([folder]));
    expect(store().history.entries).toHaveLength(3);
    store().back();
    expect(store().selection).toEqual(node("pkg.mod:Store.save"));
    expect(store().collapsed).toEqual(new Set());
  });

  it("다른 폴더를 접거나 고른 폴더 자신을 접으면 선택을 유지한다", () => {
    store().select("main:run");
    store().toggleFolder(folder);
    expect(store().selection).toEqual(node("main:run"));
    store().select(folder);
    store().toggleFolder(folder);
    store().toggleFolder(folder);
    expect(store().selection).toEqual(node(folder));
  });
});

describe("이력", () => {
  it("고르기·폴더 접기·함수 시점 뷰가 한 단계씩 들어간다", () => {
    store().select(a);
    store().toggleFolder(folder);
    store().enterFunction(b);
    store().expandFunction(c);
    expect(store().history.index).toBe(4);
    expect(store().history.entries[4]).toEqual({
      view: { kind: "function", center: b, expanded: [c] },
      selection: node(b),
      collapsed: [folder],
    });
  });

  it("같은 Place를 거듭 넣지 않는다", () => {
    store().select(null);
    store().selectEdge("agg|x|y");
    store().selectEdge("agg|x|y");
    store().enterFunction(a);
    store().enterFunction(a);
    store().expandFunction(b);
    store().expandFunction(b);
    expect(store().history.entries).toHaveLength(4);
  });

  it("back과 forward는 그 단계의 뷰·선택·접은 폴더를 되돌리고 새 단계를 넣지 않는다", () => {
    store().select(a);
    store().toggleFolder(folder);
    store().enterFunction(b);
    store().back();
    expect(store().view).toEqual({ kind: "structure" });
    expect(store().selection).toEqual(node(a));
    expect(store().collapsed).toEqual(new Set([folder]));
    store().back();
    expect(store().collapsed).toEqual(new Set());
    store().forward();
    store().forward();
    expect(store().view).toEqual({ kind: "function", center: b, expanded: [] });
    expect(store().history).toMatchObject({ index: 3, entries: { length: 4 } });
  });

  it("처음 단계에서 back, 마지막 단계에서 forward는 아무것도 바꾸지 않는다", () => {
    store().select(a);
    const before = store();
    store().forward();
    expect(store()).toBe(before);
    store().back();
    store().back();
    expect(store().history.index).toBe(0);
    expect(store().selection).toBeNull();
  });

  it("back 뒤 select는 앞쪽 단계를 버린다", () => {
    store().select(a);
    store().select(b);
    store().back();
    store().select(c);
    expect(selected()).toEqual([null, node(a), node(c)]);
    expect(store().history.index).toBe(2);
  });

  it("jump는 그 번호의 단계로 옮기고 이력에 없는 번호는 넘긴다", () => {
    store().select(a);
    store().select(b);
    store().jump(1);
    expect(store().selection).toEqual(node(a));
    store().jump(7);
    expect(store().history.index).toBe(1);
  });

  it("push는 index 뒤를 버리고 100단계까지 둔다", () => {
    const place = (id: string): Place => ({ view: { kind: "structure" }, selection: { type: "node", id }, collapsed: [] });
    let history: History = { entries: [place("0")], index: 0 };
    for (let i = 1; i <= 3; i++) {
      history = push(history, place(String(i)));
    }
    history = push(back(back(history)), place("x"));
    expect(history.entries.map((p) => p.selection)).toEqual([node("0"), node("1"), node("x")]);
    for (let i = 0; i < 120; i++) {
      history = push(history, place(`n${i}`));
    }
    expect(history.entries).toHaveLength(100);
    expect(history.index).toBe(99);
    expect(history.entries[99].selection).toEqual(node("n119"));
    expect(jump(history, 100)).toBe(history);
  });
});

describe("화면 설정", () => {
  it("흐름 단계·화면 색·패널·범례를 code-atlas:ui:v1에 쓴다", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { setItem: (key: string, value: string) => saved.set(key, value) });
    vi.stubGlobal("document", { documentElement: { style: { setProperty: () => undefined }, dataset: {} } });
    store().setDepth(3);
    store().setTheme("dark");
    store().setPanel({ x: 10, y: 20, width: 300, height: 200 });
    store().toggleLegend();
    vi.unstubAllGlobals();
    expect(store().history.entries).toHaveLength(1);
    expect(parseUi(saved.get("code-atlas:ui:v1")!, "light")).toEqual({
      panel: { x: 10, y: 20, width: 300, height: 200 },
      legendOpen: true,
      theme: "dark",
      depth: 3,
    });
  });

  it("형태가 맞지 않는 값은 기본값으로 둔다", () => {
    const defaults = { panel: null, legendOpen: false, theme: "dark", depth: 2 };
    expect(parseUi(null, "dark")).toEqual(defaults);
    expect(parseUi("{", "dark")).toEqual(defaults);
    expect(parseUi(JSON.stringify({ panel: { x: 1, y: 2 }, legendOpen: "yes", theme: "blue", depth: 4 }), "dark")).toEqual(
      defaults,
    );
  });
});
