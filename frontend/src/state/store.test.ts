import { beforeEach, describe, expect, it, vi } from "vitest";
import { node as made, repoFixture, routeFixture } from "../graph/fixture";
import { back, jump, push, remap, type History, type Place } from "./history";
import { useOverlay } from "./overlay";
import { barred, chosenOf, litOf, parseUi, pinned, placeIn, startFolds, undoable, useAtlas, type AtlasStore } from "./store";

const [a, b, c] = repoFixture.nodes.filter((n) => n.kind === "function" || n.kind === "method").map((n) => n.id);
const folder = repoFixture.nodes.find((n) => n.kind === "package")!.id;

const store = () => useAtlas.getState();
const selected = () => store().history.entries.map((place) => place.selection);
const node = (id: string) => ({ type: "node", id });

beforeEach(() => {
  useAtlas.setState({ ...useAtlas.getInitialState(), graph: repoFixture }, true);
});

describe("select", () => {
  it("고른 파일 상자를 다시 고르면 선택이 풀린다", () => {
    store().select("main");
    expect(store().selection).toEqual(node("main"));
    store().select("main");
    expect(store().selection).toBeNull();
    expect(selected()).toEqual([null, node("main"), null]);
  });

  it("고른 함수·메서드·클래스를 다시 고르면 선택과 이력, 전부 펼친 상자가 그대로다", () => {
    for (const id of [a, "pkg.mod:Store.save", "pkg.mod:Store", "pkg.mod:Row"]) {
      store().select(id);
      const before = store();
      store().select(id);
      expect(store().selection).toEqual(node(id));
      expect(store().history).toBe(before.history);
      expect(store().unpacked).toBe(before.unpacked);
    }
  });

  it("함수 시점 뷰에서 고른 가운데 함수를 다시 골라도 뷰와 선택이 그대로다", () => {
    store().enterFunction(a);
    const before = store();
    store().select(a);
    expect(store().view).toBe(before.view);
    expect(store().selection).toEqual(node(a));
    expect(store().history).toBe(before.history);
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

describe("togglePack", () => {
  it("상자를 전부 펼침에 넣고 빼며 선택은 그대로 두고, 이력에 한 단계씩 넣어 뒤로·앞으로로 되돌아간다", () => {
    store().select("pkg.mod");
    const at = store().history.index;
    store().togglePack("pkg.mod");
    expect(store().unpacked).toEqual(new Set(["pkg.mod"]));
    expect(store().selection).toEqual(node("pkg.mod"));
    expect(store().history.index).toBe(at + 1);
    expect(store().history.entries[at + 1].unpacked).toEqual(["pkg.mod"]);
    store().togglePack("pkg.mod");
    expect(store().unpacked).toEqual(new Set());
    expect(store().history.index).toBe(at + 2);
    store().back();
    expect(store().unpacked).toEqual(new Set(["pkg.mod"]));
    store().back();
    expect(store().unpacked).toEqual(new Set());
    store().forward();
    expect(store().unpacked).toEqual(new Set(["pkg.mod"]));
  });

  it("선택을 풀어도 전부 펼침은 남는다", () => {
    store().select("pkg.mod");
    store().togglePack("pkg.mod");
    store().select(null);
    expect(store().unpacked).toEqual(new Set(["pkg.mod"]));
  });
});

describe("안쪽 자식 선택과 전부 펼침", () => {
  const parse = "pkg.mod:parse";
  const save = "pkg.mod:Store.save";

  it("안쪽 자식을 고르면 그 파일 상자를 같은 이력 단계에서 전부 펼침에 넣고, 밖과 이어진 자식과 파일 상자를 고르면 넣지 않는다", () => {
    store().select(save);
    store().select("pkg.mod");
    expect(store().unpacked).toEqual(new Set());
    const at = store().history.index;
    store().select(parse);
    expect(store().unpacked).toEqual(new Set(["pkg.mod"]));
    expect(store().history.index).toBe(at + 1);
    expect(store().history.entries[at + 1]).toMatchObject({ selection: node(parse), unpacked: ["pkg.mod"] });
  });

  it("show, follow, enterFunction, 더블클릭으로 골라도 전부 펼침에 넣는다", () => {
    const picks: ((state: AtlasStore) => void)[] = [
      (state) => state.show(parse),
      (state) => state.follow([`run|${save}|${parse}`], parse),
      (state) => state.enterFunction(parse),
      (state) => state.open(parse, state.history),
    ];
    for (const pick of picks) {
      useAtlas.setState({ ...useAtlas.getInitialState(), graph: repoFixture }, true);
      pick(store());
      expect(store().selection).toEqual(node(parse));
      expect(store().unpacked).toEqual(new Set(["pkg.mod"]));
    }
  });

  it("안쪽 자식을 고른 뒤 다른 노드를 고르거나 선택을 풀어도 전부 펼침은 남고, 뒤로·앞으로가 단계마다의 집합을 되돌린다", () => {
    store().select(save);
    store().select(parse);
    store().select(save);
    expect(store().unpacked).toEqual(new Set(["pkg.mod"]));
    store().back();
    store().back();
    expect(store().selection).toEqual(node(save));
    expect(store().unpacked).toEqual(new Set());
    store().forward();
    expect(store().selection).toEqual(node(parse));
    expect(store().unpacked).toEqual(new Set(["pkg.mod"]));
  });

  it("안쪽 자식을 고른 채 접는 손잡이를 누르면 그 파일 상자를 고르고, 밖과 이어진 자식을 고른 채면 선택을 그대로 둔다", () => {
    store().select(parse);
    const at = store().history.index;
    store().togglePack("pkg.mod");
    expect(store().unpacked).toEqual(new Set());
    expect(store().selection).toEqual(node("pkg.mod"));
    expect(store().history.index).toBe(at + 1);
    store().back();
    expect(store().selection).toEqual(node(parse));
    expect(store().unpacked).toEqual(new Set(["pkg.mod"]));

    store().select(save);
    store().togglePack("pkg.mod");
    expect(store().unpacked).toEqual(new Set());
    expect(store().selection).toEqual(node(save));
  });

  it("선을 골라 초점만 안쪽 자식에 남은 채 접는 손잡이를 눌러도 그 파일 상자를 고른다", () => {
    store().select(parse);
    store().selectEdge(`run|${save}|${parse}`);
    store().togglePack("pkg.mod");
    expect(store().selection).toEqual(node("pkg.mod"));
    expect(store().unpacked).toEqual(new Set());
  });

  it("토글을 바꿔 고른 노드가 안쪽 자식이 되면 전부 펼침에 넣고, 뒤로 가서 되돌린 단계도 지금 토글로 맞춘다", () => {
    useAtlas.setState({ ...useAtlas.getInitialState(), graph: routeFixture }, true);
    store().select("flow.walk:mid");
    store().select("flow.walk:left");
    expect(store().unpacked).toEqual(new Set());
    store().toggleTests();
    expect(store().unpacked).toEqual(new Set(["flow.walk"]));
    store().back();
    expect(store().selection).toEqual(node("flow.walk:mid"));
    expect(store().unpacked).toEqual(new Set(["flow.walk"]));
    store().toggleTests();
    expect(store().unpacked).toEqual(new Set(["flow.walk"]));
  });

  it("경로 고정 중에는 경로 위의 안쪽 자식에 focus를 두어도 전부 펼침을 바꾸지 않는다", () => {
    useAtlas.setState({ ...useAtlas.getInitialState(), graph: routeFixture, showTests: true }, true);
    store().setEnd("from", "flow.walk:begin");
    store().setEnd("to", "flow.walk:finish");
    expect(pinned(store().finder)).toBe(true);
    store().select("flow.walk:finish");
    expect(store().finder.focus).toBe("flow.walk:finish");
    expect(store().unpacked).toEqual(new Set());
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

describe("follow", () => {
  const line = `${b}|${a}|call`;

  it("도착 노드를 고르고 누른 선을 이력의 단계에 담는다. 이미 고른 노드여도 선택을 풀지 않는다", () => {
    store().follow([line], a);
    expect(store().selection).toEqual(node(a));
    expect(store().via).toEqual([line]);
    store().follow([line], a);
    expect(store().selection).toEqual(node(a));
    expect(store().history.entries).toHaveLength(2);
    expect(store().history.entries[1].via).toEqual([line]);
  });

  it("도착 노드가 접힌 폴더면 펼치고 다른 노드의 선택을 풀어 이력에 한 단계만 넣는다", () => {
    store().toggleFolder(folder);
    store().select(a);
    store().follow([`agg|main|${folder}`], folder);
    expect(store().selection).toBeNull();
    expect(store().via).toEqual([`agg|main|${folder}`]);
    expect(store().collapsed).toEqual(new Set());
    expect(store().history.entries).toHaveLength(4);
    store().back();
    expect(store().selection).toEqual(node(a));
    expect(store().via).toBeNull();
    expect(store().collapsed).toEqual(new Set([folder]));
    store().forward();
    expect(store().via).toEqual([`agg|main|${folder}`]);
  });

  it("선택을 바꾸는 액션은 지나온 선을 지우고, 선택을 그대로 두는 액션은 지나온 선을 그대로 둔다", () => {
    store().follow([line], a);
    store().togglePack("pkg.mod");
    expect(store().via).toEqual([line]);
    store().select(c);
    expect(store().via).toBeNull();
    store().follow([line], a);
    store().selectEdge("agg|x|y");
    expect(store().via).toBeNull();
    store().toggleFolder(folder);
    store().follow([`agg|main|${folder}`], folder);
    store().select(null);
    expect(store().via).toBeNull();
    expect(store().history.entries.at(-1)).toMatchObject({ selection: null, via: null });
  });

  it("선의 출발 노드로 가도 누른 선을 그대로 담는다", () => {
    store().follow([line], b);
    expect(store().selection).toEqual(node(b));
    expect(store().via).toEqual([line]);
  });

  it("그래프에 없는 노드로는 가지 않는다", () => {
    store().follow([line], "없는:노드");
    expect(store().via).toBeNull();
    expect(store().history.entries).toHaveLength(1);
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

  it("null이면 함수 시점 뷰에서 구조 뷰로 돌아가 선택을 풀고, 구조 뷰에서는 선택만 푼다", () => {
    store().enterFunction(a);
    store().show(null);
    expect(store().view).toEqual({ kind: "structure" });
    expect(store().selection).toBeNull();
    expect(store().history).toMatchObject({ index: 2, entries: { length: 3 } });
    store().back();
    expect(store().view).toEqual({ kind: "function", center: a, expanded: [] });
    store().forward();
    store().select(b);
    store().show(null);
    expect(store().selection).toBeNull();
    expect(selected()).toEqual([null, node(a), null, node(b), null]);
  });
});

describe("leaveFunction", () => {
  it("가운데 함수를 고른 구조 뷰로 돌아가고 뒤로·앞으로가 두 뷰를 오간다", () => {
    store().enterFunction(a);
    store().leaveFunction();
    expect(store().view).toEqual({ kind: "structure" });
    expect(store().selection).toEqual(node(a));
    expect(store().history).toMatchObject({ index: 2, entries: { length: 3 } });
    store().back();
    expect(store().view).toEqual({ kind: "function", center: a, expanded: [] });
    expect(store().selection).toEqual(node(a));
    store().forward();
    expect(store().view).toEqual({ kind: "structure" });
    expect(store().selection).toEqual(node(a));
  });

  it("함수 시점 뷰에서 다른 함수를 골랐으면 그 함수를 고른 구조 뷰로 돌아간다", () => {
    store().enterFunction(a);
    store().select(b);
    store().leaveFunction();
    expect(store().view).toEqual({ kind: "structure" });
    expect(store().selection).toEqual(node(b));
  });

  it("선택을 푼 함수 시점 뷰에서는 가운데 함수를 고르고, 접은 폴더 안의 함수면 그 폴더를 펼친다", () => {
    store().enterFunction("pkg.mod:Store.save");
    store().select(null);
    useAtlas.setState({ collapsed: new Set([folder]) });
    store().leaveFunction();
    expect(store().selection).toEqual(node("pkg.mod:Store.save"));
    expect(store().collapsed).toEqual(new Set());
  });

  it("구조 뷰에서는 선택과 이력을 바꾸지 않는다", () => {
    store().select(a);
    const before = store();
    store().leaveFunction();
    expect(store().selection).toEqual(node(a));
    expect(store().history).toBe(before.history);
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
    expect(store().history).toBe(from);
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
      unpacked: [],
      via: null,
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
    const place = (id: string): Place => ({ view: { kind: "structure" }, selection: { type: "node", id }, via: null, collapsed: [], unpacked: [] });
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

describe("느린 배치의 취소", () => {
  /** 화면에 그린 배치가 지금 이력의 것이라고 적는다. */
  const drawn = () => useAtlas.setState({ arranged: store().history, arranging: false });
  const slow = () => useAtlas.setState({ arranging: true });

  it("배치가 길어지는 동안 취소하면 뷰·선택·접은 폴더·이력이 화면에 그린 배치의 것으로 돌아간다", () => {
    store().select(a);
    drawn();
    const before = store();
    store().toggleFolder(folder);
    store().select(b);
    slow();
    expect(undoable(store())).toBe(true);
    expect(store().cancelArranging()).toBe(true);
    const now = store();
    expect([now.history, now.selection, now.collapsed, now.view]).toEqual([before.history, before.selection, before.collapsed, before.view]);
    expect(now.history).toBe(before.history);
    expect(undoable(now)).toBe(false);
  });

  it("뒤로 가기는 되돌릴 느린 배치가 있으면 그 배치만 취소한다", () => {
    store().select(a);
    drawn();
    const before = store().history;
    store().back();
    slow();
    store().back();
    expect(store().history).toBe(before);
    expect(store().selection).toEqual(node(a));
    useAtlas.setState({ arranging: false });
    store().back();
    expect(store().history.index).toBe(0);
  });

  it("배치가 길어지지 않았거나 그린 배치 뒤에 이력이 바뀌지 않았으면 취소하지 않는다", () => {
    store().select(a);
    expect(undoable({ ...store(), arranging: true })).toBe(false);
    drawn();
    store().select(b);
    expect(store().cancelArranging()).toBe(false);
    expect(store().selection).toEqual(node(b));
    drawn();
    store().toggleTests();
    slow();
    expect(store().cancelArranging()).toBe(false);
    expect(store().selection).toEqual(node(b));
  });

  it("경로 고정 중에는 취소하지 않는다", () => {
    useAtlas.setState({ graph: routeFixture });
    drawn();
    store().select("flow.walk:probe");
    store().setEnd("from", "flow.walk:begin");
    store().setEnd("to", "flow.walk:finish");
    slow();
    expect(pinned(store().finder)).toBe(true);
    expect(store().cancelArranging()).toBe(false);
    expect(store().selection).toEqual(node("flow.walk:probe"));
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
    ["follow", (state) => state.follow(["agg|x|flow"], "flow")],
    ["togglePack", (state) => state.togglePack("flow")],
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
    expect(Object.keys(JSON.parse(saved.get("code-atlas:ui:v2")!) as object)).not.toContain("finder");
    expect(saved.size).toBe(1);
  });
});

describe("화면 설정", () => {
  it("흐름 단계·화면 색·패널·패널 구역의 접힘·범례·미니맵·자동 요약을 code-atlas:ui:v2에 쓴다", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { setItem: (key: string, value: string) => saved.set(key, value) });
    vi.stubGlobal("document", { documentElement: { style: { setProperty: () => undefined }, dataset: {} } });
    store().setDepth(3);
    store().setTheme("dark");
    store().setPanel({ x: 10, y: 20, width: 300, height: 200 });
    store().setSplit(0.4);
    store().toggleFacts();
    store().toggleLegend();
    store().toggleMinimap();
    store().toggleAutoSummary();
    vi.unstubAllGlobals();
    expect(store().history.entries).toHaveLength(1);
    expect(parseUi(saved.get("code-atlas:ui:v2")!, "light")).toEqual({
      panel: { x: 10, y: 20, width: 300, height: 200 },
      split: 0.4,
      factsOpen: false,
      summaryOpen: true,
      legendOpen: true,
      minimapOpen: false,
      theme: "dark",
      depth: 3,
      autoSummary: true,
    });
  });

  it("형태가 맞지 않는 값은 기본값으로 둔다", () => {
    const defaults = { panel: null, split: null, factsOpen: true, summaryOpen: true, legendOpen: false, minimapOpen: true, theme: "dark", depth: 2, autoSummary: false };
    expect(parseUi(null, "dark")).toEqual(defaults);
    expect(parseUi("{", "dark")).toEqual(defaults);
    expect(parseUi(JSON.stringify({ panel: { x: 1, y: 2 }, split: 1.5, legendOpen: "yes", minimapOpen: 0, theme: "blue", depth: 4, autoSummary: 1 }), "dark")).toEqual(
      defaults,
    );
  });
});

/** 노드 ids와 그 노드에 닿는 선을 뺀 그래프 */
const without = (...ids: string[]) => ({
  nodes: repoFixture.nodes.filter((n) => !ids.includes(n.id)),
  edges: repoFixture.edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target)),
});

describe("placeIn", () => {
  const place = (extra: Partial<Place>): Place => ({ view: { kind: "structure" }, selection: null, via: null, collapsed: [], unpacked: [], ...extra });

  it("그래프에 있는 노드만 가리키는 단계는 뷰와 선택을 받은 객체 그대로 돌려준다", () => {
    const before = place({ view: { kind: "function", center: a, expanded: [b] }, selection: { type: "node", id: a }, via: [`${b}|${a}|call`], collapsed: ["pkg"], unpacked: ["main"] });
    const after = placeIn(before, repoFixture, repoFixture);
    expect(after).toEqual(before);
    expect([after.view, after.selection]).toEqual([before.view, before.selection]);
    expect(after.view).toBe(before.view);
    expect(after.selection).toBe(before.selection);
  });

  it("없어진 노드를 접은 폴더와 전부 펼친 상자, 펼친 이웃에서 빼고 앞의 그래프에 없던 폴더를 접어 둔다", () => {
    const before = place({ view: { kind: "function", center: a, expanded: [b, c] }, collapsed: ["app", "pkg"], unpacked: ["main", "pkg.mod"] });
    const graph = { nodes: [...without("pkg", "pkg.mod", c).nodes, made("new", "package", null)], edges: [] };
    expect(placeIn(before, graph, repoFixture)).toEqual(place({ view: { kind: "function", center: a, expanded: [b] }, collapsed: ["app", "new"], unpacked: ["main"] }));
  });

  it("고른 노드가 없어지면 선택과 지나온 선을 풀고, 가운데 함수가 없어지면 구조 뷰로 돌아간다", () => {
    const before = place({ view: { kind: "function", center: a, expanded: [] }, selection: { type: "node", id: a }, via: [`${b}|${a}|call`] });
    expect(placeIn(before, without(a), repoFixture)).toEqual(place({}));
    const other = place({ view: { kind: "function", center: a, expanded: [] }, selection: { type: "node", id: b } });
    expect(placeIn(other, without(a), repoFixture)).toEqual(place({ selection: { type: "node", id: b } }));
  });

  it("고른 선의 끝 노드가 없어지면 초점을 둔 노드를 고르고, 끝 노드가 없어진 지나온 선을 지운다", () => {
    const before = place({ selection: { type: "edge", key: `${b}|${c}|call`, focus: b }, via: [`${b}|${c}|call`, `agg|main|pkg`] });
    expect(placeIn(before, without(c), repoFixture)).toEqual(place({ selection: { type: "node", id: b } }));
    const kept = place({ selection: { type: "node", id: b }, via: [`${b}|${c}|call`, `agg|main|pkg`] });
    expect(placeIn(kept, without(c), repoFixture)).toEqual(place({ selection: { type: "node", id: b }, via: [`agg|main|pkg`] }));
  });
});

describe("remap", () => {
  it("바꾼 뒤에 앞 단계와 같아진 단계를 빼고 지금 단계의 번호를 맞춘다", () => {
    const at = (id: string | null): Place => ({ view: { kind: "structure" }, selection: id === null ? null : { type: "node", id }, via: null, collapsed: [], unpacked: [] });
    const history = { entries: [at(null), at(a), at(b), at(a), at(c)], index: 3 };
    const dropped = remap(history, (place) => placeIn(place, without(b), repoFixture));
    expect(dropped.entries.map((place) => place.selection)).toEqual([null, node(a), null, node(a), node(c)]);
    expect(dropped.index).toBe(3);
    const merged = remap(history, (place) => placeIn(place, without(a), repoFixture));
    expect(merged.entries.map((place) => place.selection)).toEqual([null, node(b), null, node(c)]);
    expect(merged.index).toBe(2);
  });
});

describe("refresh", () => {
  const repo = { name: "repo", root: "/repo", source_root: "", python: null, stats: {} } as unknown as NonNullable<AtlasStore["repo"]>;
  const tree = { entries: [] };

  it("보기 설정, 선택과 뷰, 탐색 이력, 접은 폴더, 전부 펼친 상자, 전체 맞춤 상태를 그대로 둔다", () => {
    vi.stubGlobal("localStorage", { setItem: () => undefined });
    store().setDepth(3);
    store().toggleAutoSummary();
    store().toggleTests();
    store().toggleExternal();
    store().toggleFolder("app");
    store().togglePack("pkg.mod");
    store().select(a);
    store().enterFunction(b);
    useOverlay.getState().set("unused");
    useAtlas.setState({ fitted: true, paletteOpen: true });
    const before = store();
    const graph = { ...repoFixture };
    store().refresh(repo, graph, tree);
    vi.unstubAllGlobals();
    const now = store();
    expect([now.depth, now.autoSummary, now.showTests, now.showExternal, now.fitted, now.paletteOpen]).toEqual([3, true, true, true, true, true]);
    expect([now.view, now.selection, now.via]).toEqual([before.view, before.selection, before.via]);
    expect(now.selection).toBe(before.selection);
    expect([now.collapsed, now.unpacked]).toEqual([new Set(["app"]), new Set(["pkg.mod"])]);
    expect(now.history).toEqual(before.history);
    expect(useOverlay.getState().kind).toBe("unused");
    expect([now.repo, now.graph, now.tree, now.epoch, now.arranged]).toEqual([repo, graph, tree, 1, null]);
  });

  it("고른 노드가 없어지면 선택만 풀고 접은 폴더와 이력의 나머지 단계는 그대로 둔다", () => {
    store().toggleFolder("app");
    store().select(b);
    store().select(a);
    store().refresh(repo, without(a), tree);
    const now = store();
    expect(now.selection).toBeNull();
    expect(now.collapsed).toEqual(new Set(["app"]));
    expect(selected()).toEqual([null, null, node(b), null]);
    expect(now.history.index).toBe(3);
    store().back();
    expect(store().selection).toEqual(node(b));
  });

  it("함수 시점 뷰의 가운데 함수가 없어지면 구조 뷰로 돌아간다", () => {
    store().select(b);
    store().enterFunction(a);
    store().refresh(repo, without(a), tree);
    expect([store().view, store().selection]).toEqual([{ kind: "structure" }, null]);
    store().refresh(repo, repoFixture, tree);
    store().enterFunction(b);
    store().refresh(repo, without(a), tree);
    expect([store().view, store().selection]).toEqual([{ kind: "function", center: b, expanded: [] }, node(b)]);
  });

  it("경로 고정은 출발과 도착이 남아 있으면 경로를 다시 찾아 유지하고, 없어지면 푼다", () => {
    const [from, mid, to] = ["flow.walk:begin", "flow.walk:left", "flow.walk:finish"];
    useAtlas.setState({ graph: routeFixture });
    store().setEnd("from", from);
    store().setEnd("to", to);
    store().pickPath(1);
    store().select("flow.walk:right");
    const { aimed } = store().finder;
    store().refresh(repo, { ...routeFixture }, tree);
    expect(store().finder).toMatchObject({ from, to, pick: 1, focus: "flow.walk:right", aimed });
    expect(pinned(store().finder)).toBe(true);
    store().refresh(repo, { nodes: routeFixture.nodes.filter((n) => n.id !== "flow.walk:right"), edges: routeFixture.edges.filter((e) => e.source !== "flow.walk:right" && e.target !== "flow.walk:right") }, tree);
    expect(store().finder).toMatchObject({ from, to, focus: from });
    expect(litOf(store().finder)?.path).toContain(mid);
    store().refresh(repo, { nodes: routeFixture.nodes.filter((n) => n.id !== to), edges: routeFixture.edges.filter((e) => e.source !== to && e.target !== to) }, tree);
    expect(store().finder).toMatchObject({ from, to: null, route: null, focus: null });
    expect(pinned(store().finder)).toBe(false);
  });
});

describe("resetView", () => {
  it("구조 뷰로 돌아가 선택과 지나온 선을 풀고 폴더를 처음 화면처럼 접어 이력에 한 단계를 넣는다", () => {
    store().toggleTests();
    store().togglePack("pkg.mod");
    store().follow([`${b}|${c}|call`], c);
    store().enterFunction(a);
    const before = store().history;
    store().resetView();
    const now = store();
    expect([now.view, now.selection, now.via]).toEqual([{ kind: "structure" }, null, null]);
    expect([now.collapsed, now.unpacked]).toEqual([startFolds(repoFixture, true), new Set()]);
    expect([now.showTests, now.homed]).toEqual([true, 1]);
    expect(now.history).toMatchObject({ index: before.index + 1, entries: { length: before.entries.length + 1 } });
  });

  it("뒤로 가면 초기화하기 전의 화면으로 돌아간다", () => {
    store().toggleFolder("app");
    store().select(c);
    const before = store();
    store().resetView();
    store().back();
    const now = store();
    expect([now.view, now.selection, now.collapsed, now.unpacked]).toEqual([before.view, before.selection, before.collapsed, before.unpacked]);
    store().forward();
    expect([store().selection, store().collapsed]).toEqual([null, startFolds(repoFixture, false)]);
  });

  it("이미 처음 화면이면 이력에 넣지 않고 화면을 다시 맞추게만 한다", () => {
    const collapsed = startFolds(repoFixture, false);
    useAtlas.setState({ collapsed, history: { entries: [{ view: { kind: "structure" }, selection: null, via: null, collapsed: [...collapsed].sort(), unpacked: [] }], index: 0 } });
    store().resetView();
    expect([store().history.entries.length, store().homed]).toEqual([1, 1]);
  });

  it("경로 고정 중에는 막힌다", () => {
    useAtlas.setState({ graph: routeFixture });
    store().select("flow.walk:probe");
    store().setEnd("from", "flow.walk:begin");
    store().setEnd("to", "flow.walk:finish");
    store().resetView();
    expect([store().selection, store().homed, store().finder.blocked]).toEqual([node("flow.walk:probe"), 0, 1]);
  });
});
