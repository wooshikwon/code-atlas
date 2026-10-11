import { beforeEach, describe, expect, it, vi } from "vitest";
import { node as made, repoFixture, routeFixture } from "../graph/fixture";
import { back, jump, push, type History, type Place } from "./history";
import { useOverlay } from "./overlay";
import { barred, chosenOf, litOf, parseUi, pinned, startFolds, useAtlas, type AtlasStore } from "./store";

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
    expect(store().selection).toEqual({ type: "edge", key: "agg|x|y", focus: null });
    store().select(a);
    expect(store().selection).toEqual(node(a));
  });
});

describe("selectEdge", () => {
  it("직전에 초점을 둔 노드를 선 선택에 담고, 선을 이어 골라도 그 노드를 유지한다", () => {
    store().select(a);
    store().selectEdge("agg|x|y");
    expect(store().selection).toEqual({ type: "edge", key: "agg|x|y", focus: a });
    store().selectEdge("agg|y|z");
    expect(store().selection).toEqual({ type: "edge", key: "agg|y|z", focus: a });
    store().select(b);
    store().back();
    expect(store().selection).toEqual({ type: "edge", key: "agg|y|z", focus: a });
  });

  it("초점을 둔 노드가 든 폴더를 접으면 선 선택도 푼다", () => {
    store().select("pkg.mod:Store.save");
    store().selectEdge("agg|x|y");
    store().toggleFolder(folder);
    expect(store().selection).toBeNull();
    expect(store().collapsed).toEqual(new Set([folder]));
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

  it("펼친 폴더를 고르면 그 폴더를 접어 고르고 이력에 한 단계만 넣는다", () => {
    store().select("pkg.mod:Store.save");
    store().show(folder);
    expect(store().selection).toEqual(node(folder));
    expect(store().collapsed).toEqual(new Set([folder]));
    expect(store().history.entries).toHaveLength(3);
    store().select("app");
    expect(store().collapsed).toEqual(new Set([folder, "app"]));
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

  it("다른 폴더를 접으면 선택을 유지하고, 고른 폴더를 펼치면 선택을 풀어 이력에 한 단계만 넣는다", () => {
    store().select("main:run");
    store().toggleFolder(folder);
    expect(store().selection).toEqual(node("main:run"));
    store().select(folder);
    const steps = store().history.entries.length;
    store().toggleFolder(folder);
    expect(store().selection).toBeNull();
    expect(store().collapsed).toEqual(new Set());
    expect(store().history.entries).toHaveLength(steps + 1);
  });
});

describe("startFolds", () => {
  const graph = (...nodes: ReturnType<typeof made>[]) => ({ nodes, edges: [] });
  const lib = [made("lib", "package", null), made("lib.a", "module", "lib"), made("lib.sub", "package", "lib"), made("lib.sub.b", "module", "lib.sub")];

  it("최상위에 상자가 둘 이상이면 모든 폴더를 접는다", () => {
    const inner = made("pkg.inner", "package", "pkg");
    expect(startFolds(repoFixture, false)).toEqual(new Set(["pkg", "app"]));
    expect(startFolds({ ...repoFixture, nodes: [...repoFixture.nodes, inner] }, false)).toEqual(new Set(["pkg", "pkg.inner", "app"]));
  });

  it("그 층에 보이는 상자가 폴더 하나뿐이면 그 폴더를 펼치고 한 층 더 내려가 같은 판정을 한다", () => {
    expect(startFolds(graph(...lib), false)).toEqual(new Set(["lib.sub"]));
    const deep = [made("top", "package", null), made("top.core", "package", "top"), made("top.core.a", "module", "top.core"), made("top.core.sub", "package", "top.core")];
    expect(startFolds(graph(...deep), false)).toEqual(new Set(["top.core.sub"]));
    const chain = [made("one", "package", null), made("one.two", "package", "one"), made("one.two.three", "package", "one.two"), made("one.two.three.a", "module", "one.two.three")];
    expect(startFolds(graph(...chain), false)).toEqual(new Set());
  });

  it("테스트 코드 토글이 꺼져 숨는 폴더와 파일은 세지 않는다", () => {
    const tests = [made("tests", "package", null, { test: true }), made("tests.test_a", "module", "tests", { test: true }), made("conftest", "module", null, { test: true })];
    expect(startFolds(graph(...lib, ...tests), false)).toEqual(new Set(["lib.sub", "tests"]));
    expect(startFolds(graph(...lib, ...tests), true)).toEqual(new Set(["lib", "lib.sub", "tests"]));
  });

  it("그 층에 파일 상자가 있으면 폴더를 펼치지 않고, 외부 노드는 상자로 세지 않는다", () => {
    expect(startFolds(graph(...lib, made("setup", "module", null)), false)).toEqual(new Set(["lib", "lib.sub"]));
    expect(startFolds(graph(...lib, made("ext:json", "external", null)), false)).toEqual(new Set(["lib.sub"]));
  });
});

describe("open", () => {
  it("함수를 더블클릭하면 첫 클릭이 넣은 단계 대신 함수 시점 뷰 한 단계를 넣는다", () => {
    const from = store().history;
    store().select(a);
    store().open(a, from);
    expect(store().view).toEqual({ kind: "function", center: a, expanded: [] });
    expect(selected()).toEqual([null, node(a)]);
    store().back();
    expect(store().view).toEqual({ kind: "structure" });
    expect(store().selection).toBeNull();
  });

  it("이미 고른 함수를 더블클릭하고 뒤로 가면 그 함수를 고른 구조 뷰로 돌아간다", () => {
    store().select(a);
    const from = store().history;
    store().select(a);
    expect(store().selection).toBeNull();
    store().open(a, from);
    expect(store().history).toMatchObject({ index: 2, entries: { length: 3 } });
    store().back();
    expect(store().view).toEqual({ kind: "structure" });
    expect(store().selection).toEqual(node(a));
  });

  it("폴더는 열지 않는다", () => {
    store().toggleFolder(folder);
    const from = store().history;
    store().open(folder, from);
    expect(store().collapsed).toEqual(new Set([folder]));
    expect(store().history).toBe(from);
  });

  it("함수 시점 뷰의 가운데 함수를 더블클릭하면 첫 클릭 전으로 되돌려 펼친 단계를 남긴다", () => {
    store().enterFunction(a);
    store().expandFunction(b);
    const from = store().history;
    store().select(a);
    store().open(a, from);
    expect(store().view).toEqual({ kind: "function", center: a, expanded: [b] });
    expect(store().selection).toEqual(node(a));
    expect(store().history).toBe(from);
  });

  it("함수 시점 뷰의 양옆 함수를 더블클릭하면 그 함수가 가운데인 뷰 한 단계를 넣는다", () => {
    store().enterFunction(a);
    const from = store().history;
    store().select(b);
    store().open(b, from);
    expect(store().view).toEqual({ kind: "function", center: b, expanded: [] });
    expect(store().history).toMatchObject({ index: 2, entries: { length: 3 } });
  });

  it("열 것이 없는 노드는 첫 클릭의 선택을 그대로 둔다", () => {
    const from = store().history;
    store().select("pkg.mod:Store");
    store().open("pkg.mod:Store", from);
    expect(store().selection).toEqual(node("pkg.mod:Store"));
    expect(store().history.entries).toHaveLength(2);
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

describe("경로 고정", () => {
  const [begin, left, mid, right, finish] = ["begin", "left", "mid", "right", "finish"].map((name) => `flow.walk:${name}`);
  const [probe, lone] = ["flow.walk:probe", "flow.walk:lone"];
  const paths = [
    [begin, left, finish],
    [begin, right, finish],
    [begin, mid, left, finish],
  ];

  /** 경로 고정 중에 바뀌지 않는 상태 */
  const kept = ({ selection, collapsed, view, history, showTests, showExternal, depth }: AtlasStore) => ({
    selection,
    collapsed,
    view,
    history,
    showTests,
    showExternal,
    depth,
  });

  /** 뒤로·앞으로 갈 단계가 모두 있는 이력을 만든 뒤 begin에서 finish까지의 경로로 고정에 들어간다. */
  const pin = () => {
    store().toggleFolder("ring");
    store().select(probe);
    store().select(lone);
    store().back();
    store().setEnd("from", begin);
    store().setEnd("to", finish);
  };

  beforeEach(() => {
    useAtlas.setState({ graph: routeFixture });
  });

  it("칸 하나만 차면 고정이 아니고, 두 칸이 차면 경로를 찾아 첫 경로를 강조하며 출발 노드를 focus에 둔다", () => {
    store().setEnd("from", begin);
    expect(store().finder).toMatchObject({ from: begin, to: null, route: null, focus: null });
    expect(pinned(store().finder)).toBe(false);
    expect(litOf(store().finder)).toBeNull();
    store().setEnd("to", finish);
    expect(store().finder).toMatchObject({ from: begin, to: finish, pick: 0, focus: begin, blocked: 0 });
    expect(store().finder.route?.paths).toEqual(paths);
    expect(pinned(store().finder)).toBe(true);
    expect(litOf(store().finder)?.path).toEqual(paths[0]);
  });

  it("그래프에 없는 id와 폴더는 칸에 넣지 않는다", () => {
    store().setEnd("from", "없는:노드");
    store().setEnd("to", "flow");
    expect(store().finder).toMatchObject({ from: null, to: null });
    store().setEnd("from", "flow.build");
    store().setEnd("to", "flow.build:Engine");
    expect(store().finder).toMatchObject({ from: "flow.build", to: "flow.build:Engine" });
  });

  it("고정에 들어가도 선택·접은 폴더·뷰·이력이 그대로다", () => {
    store().toggleFolder("ring");
    store().select(probe);
    const before = kept(store());
    store().setEnd("from", begin);
    store().setEnd("to", finish);
    expect(kept(store())).toEqual(before);
    expect(store().history).toBe(before.history);
  });

  it.each<[string, (state: AtlasStore) => void]>([
    ["select", (state) => state.select(probe)],
    ["show", (state) => state.show(probe)],
    ["selectEdge", (state) => state.selectEdge("agg|x|y")],
    ["toggleFolder", (state) => state.toggleFolder("flow")],
    ["enterFunction", (state) => state.enterFunction(begin)],
    ["expandFunction", (state) => state.expandFunction(left)],
    ["open", (state) => state.open(begin, { entries: [state.history.entries[0]], index: 0 })],
    ["back", (state) => state.back()],
    ["forward", (state) => state.forward()],
    ["jump", (state) => state.jump(0)],
    ["toggleTests", (state) => state.toggleTests()],
    ["toggleExternal", (state) => state.toggleExternal()],
    ["setDepth", (state) => state.setDepth(3)],
  ])("고정 중에 %s는 상태를 바꾸지 않고 blocked만 늘리며 접은 창을 편다", (_name, act) => {
    pin();
    const before = store();
    act(before);
    expect(kept(store())).toEqual(kept(before));
    expect(store().history).toBe(before.history);
    expect(store().collapsed).toBe(before.collapsed);
    expect(store().finder).toEqual({ ...before.finder, open: true, blocked: 1 });
    act(store());
    expect(store().finder.blocked).toBe(2);
  });

  it("같은 액션이 고정 밖에서는 상태를 바꾼다", () => {
    store().enterFunction(begin);
    store().expandFunction(left);
    store().show(probe);
    store().selectEdge("agg|x|y");
    store().toggleFolder("flow");
    store().back();
    store().forward();
    store().jump(0);
    store().toggleTests();
    store().toggleExternal();
    expect(store().history).toMatchObject({ index: 0, entries: { length: 6 } });
    expect(store()).toMatchObject({ showTests: true, showExternal: true });
    expect(store().finder.blocked).toBe(0);
  });

  it("경로 위 노드의 select와 show는 focus를 바꾸고 aimed를 늘리며, 다시 골라도 focus가 풀리지 않고 aimed가 는다", () => {
    pin();
    const before = store();
    const aimed = before.finder.aimed;
    store().select(left);
    expect(store().finder).toEqual({ ...before.finder, focus: left, aimed: aimed + 1 });
    store().select(left);
    expect(store().finder).toEqual({ ...before.finder, focus: left, aimed: aimed + 2 });
    store().show(begin);
    expect(store().finder).toEqual({ ...before.finder, focus: begin, aimed: aimed + 3 });
    expect(kept(store())).toEqual(kept(before));
    expect(store().history).toBe(before.history);
  });

  it("강조하지 않은 경로에만 있는 노드는 경로 밖 노드로 막는다", () => {
    pin();
    store().select(right);
    expect(store().finder).toMatchObject({ focus: begin, blocked: 1 });
    store().pickPath(1);
    store().select(right);
    expect(store().finder).toMatchObject({ focus: right, blocked: 1 });
    store().select(left);
    expect(store().finder).toMatchObject({ focus: right, blocked: 2 });
  });

  it("chosenOf는 고정 밖에서 고른 노드를, 고정 중에는 focus를 낸다", () => {
    store().select(probe);
    expect(chosenOf(store())).toBe(probe);
    store().setEnd("from", begin);
    store().setEnd("to", finish);
    expect(chosenOf(store())).toBe(begin);
    store().select(left);
    expect(chosenOf(store())).toBe(left);
    store().clearFinder();
    expect(chosenOf(store())).toBe(probe);
  });

  it("barred는 고정 밖에서 거짓이고, 고정 중에는 blocked를 늘리고 창을 편 뒤 참을 낸다", () => {
    expect(barred()).toBe(false);
    expect(store().finder).toMatchObject({ open: false, blocked: 0 });
    pin();
    expect(barred()).toBe(true);
    expect(store().finder).toMatchObject({ open: true, blocked: 1 });
  });

  it("select(null)은 고정을 풀지 않고 blocked도 늘리지 않는다", () => {
    pin();
    store().select(left);
    const before = store();
    store().select(null);
    expect(store()).toBe(before);
    expect(pinned(store().finder)).toBe(true);
  });

  it("pickPath는 고정을 유지한 채 강조할 경로를 바꾸고 focus를 출발 노드로 돌린다", () => {
    pin();
    store().select(left);
    const before = store();
    store().pickPath(2);
    expect(store().finder).toEqual({ ...before.finder, pick: 2, focus: begin, aimed: before.finder.aimed + 1 });
    expect(litOf(store().finder)?.path).toEqual(paths[2]);
    expect(kept(store())).toEqual(kept(before));
    store().pickPath(3);
    store().pickPath(-1);
    expect(store().finder.pick).toBe(2);
  });

  it("고정 중에 setEnd로 끝점을 바꾸면 고정을 유지한 채 경로를 다시 찾고 첫 경로로 돌아간다", () => {
    pin();
    store().pickPath(2);
    const before = store();
    store().setEnd("from", mid);
    expect(store().finder).toMatchObject({ from: mid, to: finish, pick: 0, focus: mid });
    expect(store().finder.route?.paths).toEqual([[mid, left, finish]]);
    expect(pinned(store().finder)).toBe(true);
    expect(kept(store())).toEqual(kept(before));
    store().setEnd("to", "flow.walk");
    expect(store().finder.route?.paths).toEqual([]);
    expect(store().finder.focus).toBeNull();
  });

  it("새 결과에 경로가 없으면 고정이 풀려 액션이 다시 동작하고, swapEnds로 되돌리면 다시 고정이다", () => {
    pin();
    store().swapEnds();
    expect(store().finder).toMatchObject({ from: finish, to: begin, pick: 0, focus: null });
    expect(store().finder.route).toMatchObject({ paths: [], reverse: true });
    expect(pinned(store().finder)).toBe(false);
    expect(litOf(store().finder)).toBeNull();
    store().select(left);
    expect(store().selection).toEqual(node(left));
    expect(store().finder.blocked).toBe(0);
    store().swapEnds();
    expect(pinned(store().finder)).toBe(true);
    expect(store().finder.focus).toBe(begin);
    store().select(probe);
    expect(store().selection).toEqual(node(left));
    expect(store().finder.blocked).toBe(1);
  });

  it("칸을 비우면 고정이 풀린다", () => {
    pin();
    store().setEnd("to", null);
    expect(store().finder).toMatchObject({ from: begin, to: null, route: null, pick: 0, focus: null });
    expect(pinned(store().finder)).toBe(false);
  });

  it("clearFinder는 출발·도착·경로를 비우고 선택·접은 폴더·뷰·이력·토글을 고정 전 그대로 돌려준다", () => {
    store().toggleFolder("ring");
    store().select(probe);
    const before = store();
    store().toggleFinder();
    store().setEnd("from", begin);
    store().setEnd("to", finish);
    store().select(left);
    store().select(lone);
    store().toggleFolder("flow");
    store().enterFunction(begin);
    store().back();
    store().toggleTests();
    store().select(null);
    store().pickPath(1);
    store().clearFinder();
    expect(store().finder).toEqual({ open: true, from: null, to: null, route: null, pick: 0, focus: null, blocked: 5, aimed: 5 });
    expect(kept(store())).toEqual(kept(before));
    expect(store().history).toBe(before.history);
    expect(store().collapsed).toBe(before.collapsed);
    store().select(lone);
    expect(store().selection).toEqual(node(lone));
  });

  it("toggleFinder는 창만 펴고 접으며, 고정 중에 접어도 고정이 유지된다", () => {
    store().toggleFinder();
    expect(store().finder.open).toBe(true);
    pin();
    const before = store().finder;
    store().toggleFinder();
    expect(store().finder).toEqual({ ...before, open: false });
    expect(pinned(store().finder)).toBe(true);
    expect(litOf(store().finder)?.path).toEqual(paths[0]);
    store().select(left);
    expect(store().finder).toMatchObject({ open: false, focus: left });
  });

  it("함수 시점 뷰에서 경로가 나오면 구조 뷰로 돌아가는 단계를 이력에 넣고, 경로가 없으면 뷰를 그대로 둔다", () => {
    store().enterFunction(finish);
    store().setEnd("from", finish);
    store().setEnd("to", begin);
    expect(store().view).toEqual({ kind: "function", center: finish, expanded: [] });
    expect(store().history.entries).toHaveLength(2);
    store().swapEnds();
    expect(pinned(store().finder)).toBe(true);
    expect(store().view).toEqual({ kind: "structure" });
    expect(store().selection).toEqual(node(finish));
    expect(store().history).toMatchObject({ index: 2, entries: { length: 3 } });
    store().clearFinder();
    store().back();
    expect(store().view).toEqual({ kind: "function", center: finish, expanded: [] });
  });

  it("경로는 토글로 숨긴 노드를 거치지 않고, 두 칸이 찬 채 토글을 바꾸면 경로를 다시 찾는다", () => {
    store().setEnd("from", probe);
    store().setEnd("to", lone);
    expect(store().finder.route?.paths).toEqual([]);
    store().toggleTests();
    expect(store().showTests).toBe(true);
    expect(store().finder.route?.paths).toEqual([[probe, "tests.fakes:relay", lone]]);
    expect(store().finder).toMatchObject({ pick: 0, focus: probe });
    store().toggleTests();
    expect(store().showTests).toBe(true);
    expect(store().finder.blocked).toBe(1);
  });

  it("finder를 localStorage에 쓰지 않는다", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { setItem: (key: string, value: string) => saved.set(key, value) });
    store().toggleFinder();
    store().setEnd("from", begin);
    store().toggleLegend();
    vi.unstubAllGlobals();
    expect(Object.keys(JSON.parse(saved.get("code-atlas:ui:v1")!) as object)).not.toContain("finder");
    expect(saved.size).toBe(1);
  });
});

describe("화면 설정", () => {
  it("흐름 단계·화면 색·패널·범례·미니맵·자동 요약을 code-atlas:ui:v1에 쓴다", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { setItem: (key: string, value: string) => saved.set(key, value) });
    vi.stubGlobal("document", { documentElement: { style: { setProperty: () => undefined }, dataset: {} } });
    store().setDepth(3);
    store().setTheme("dark");
    store().setPanel({ x: 10, y: 20, width: 300, height: 200 });
    store().setSplit(0.4);
    store().toggleLegend();
    store().toggleMinimap();
    store().toggleAutoSummary();
    vi.unstubAllGlobals();
    expect(store().history.entries).toHaveLength(1);
    expect(parseUi(saved.get("code-atlas:ui:v1")!, "light")).toEqual({
      panel: { x: 10, y: 20, width: 300, height: 200 },
      split: 0.4,
      legendOpen: true,
      minimapOpen: false,
      theme: "dark",
      depth: 3,
      autoSummary: true,
    });
  });

  it("형태가 맞지 않는 값은 기본값으로 둔다", () => {
    const defaults = { panel: null, split: null, legendOpen: false, minimapOpen: true, theme: "dark", depth: 2, autoSummary: false };
    expect(parseUi(null, "dark")).toEqual(defaults);
    expect(parseUi("{", "dark")).toEqual(defaults);
    expect(parseUi(JSON.stringify({ panel: { x: 1, y: 2 }, split: 1.5, legendOpen: "yes", minimapOpen: 0, theme: "blue", depth: 4, autoSummary: 1 }), "dark")).toEqual(
      defaults,
    );
  });
});

describe("reopen", () => {
  const repo = { name: "repo", root: "/repo", source_root: "", python: null, stats: {} } as unknown as NonNullable<AtlasStore["repo"]>;
  const tree = { entries: [] };

  it("보기 설정, 선택과 뷰, 탐색 이력, 접은 폴더, 경로 고정을 레포를 처음 연 상태로 되돌린다", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { setItem: (key: string, value: string) => saved.set(key, value) });
    store().setDepth(3);
    store().toggleAutoSummary();
    store().toggleTests();
    store().toggleExternal();
    store().select(a);
    store().enterFunction(b);
    store().toggleFinder();
    useOverlay.getState().set("unused");
    useAtlas.setState({ reloadError: "앞의 실패" });
    store().reopen(repo, repoFixture, tree);
    vi.unstubAllGlobals();
    const now = store();
    expect([now.depth, now.autoSummary, now.showTests, now.showExternal]).toEqual([2, false, false, false]);
    expect([now.view, now.selection]).toEqual([{ kind: "structure" }, null]);
    expect(now.collapsed).toEqual(new Set(["app", "pkg"]));
    expect(now.history).toEqual({ entries: [{ view: { kind: "structure" }, selection: null, collapsed: ["app", "pkg"] }], index: 0 });
    expect([now.finder.open, now.finder.from, now.finder.route]).toEqual([false, null, null]);
    expect([now.repo, now.graph, now.tree, now.epoch]).toEqual([repo, repoFixture, tree, 1]);
    expect(useOverlay.getState().kind).toBe("cycles");
    expect(parseUi(saved.get("code-atlas:ui:v1")!, "light")).toMatchObject({ depth: 2, autoSummary: false });
  });

  it("화면 색, 정보 패널의 사각형과 요약 칸 비율, 미니맵·범례의 접힘은 그대로 둔다", () => {
    vi.stubGlobal("localStorage", { setItem: () => undefined });
    vi.stubGlobal("document", { documentElement: { style: { setProperty: () => undefined }, dataset: {} } });
    store().setTheme("dark");
    store().setPanel({ x: 10, y: 20, width: 300, height: 200 });
    store().setSplit(0.4);
    store().toggleLegend();
    store().toggleMinimap();
    store().reopen(repo, repoFixture, tree);
    vi.unstubAllGlobals();
    const now = store();
    expect([now.theme, now.panel, now.split, now.legendOpen, now.minimapOpen]).toEqual(["dark", { x: 10, y: 20, width: 300, height: 200 }, 0.4, true, false]);
  });

  it("순환 묶음이 없는 그래프를 받으면 덮개를 끈다", () => {
    vi.stubGlobal("localStorage", { setItem: () => undefined });
    useOverlay.getState().set("unused");
    store().reopen(repo, { ...repoFixture, edges: [] }, tree);
    vi.unstubAllGlobals();
    expect(useOverlay.getState().kind).toBeNull();
  });
});
