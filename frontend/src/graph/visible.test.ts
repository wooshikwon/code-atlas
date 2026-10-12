import { describe, expect, it } from "vitest";
import { node as made, repoFixture, routeFixture, variableFixture } from "./fixture";
import { flow } from "./flow";
import { lit, route } from "./route";
import { drawnOut, folderLines, hidden, insideCounts, inward, lift, nodeIndex, outward, packedIn, shown, unresolvedWithin, writtenBy } from "./visible";

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

  it("파일 상자를 고르고 전부 펼치면 그 파일 상자만 펼쳐 안의 노드를 모두 남긴다", () => {
    const result = shown(repoFixture, { ...toggles, collapsed: new Set(), unpacked: new Set(["pkg.mod"]), flow: flow(repoFixture, "pkg.mod", 2, off), lit: null });
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

describe("outward, insideCounts", () => {
  it("파일 상자마다 파일 밖과 선을 주고받는 바로 아래 자식을 낸다. 클래스는 메서드의 선으로도 밖과 이어지고 폴더는 판정하지 않는다", () => {
    const linked = outward(repoFixture, off);
    expect([...linked.get("pkg.mod")!]).toEqual(["pkg.mod:Store"]);
    expect([...linked.get("main")!].sort()).toEqual(["main:helper", "main:run"]);
    expect(linked.has("pkg")).toBe(false);
    expect(linked.has("app")).toBe(false);
    expect(linked.has("scratch")).toBe(false);
  });

  it("토글로 숨긴 노드와의 선은 세지 않고, 토글을 켜면 그 선으로 이어진 자식이 는다", () => {
    const all = hidden(repoFixture, { showTests: true, showExternal: true });
    const more = (box: string) => [...(outward(repoFixture, all).get(box) ?? [])].filter((id) => !(outward(repoFixture, off).get(box)?.has(id) ?? false));
    expect(repoFixture.edges.some((e) => off.has(e.source) || off.has(e.target))).toBe(true);
    expect([...outward(repoFixture, all).keys()].flatMap(more).length).toBeGreaterThan(0);
  });

  it("inward는 밖과 이어진 자식도 진입점도 아닌 자식을 내고, 밖과 이어진 자식이 없거나 안쪽 자식이 하나뿐인 파일 상자는 내지 않는다", () => {
    const inner = inward(repoFixture, off);
    expect([...inner.get("pkg.mod")!].sort()).toEqual(["pkg.mod:Row", "pkg.mod:parse"]);
    expect(inner.has("main")).toBe(false);
    expect(inner.has("scratch")).toBe(false);
    expect(outward(repoFixture, off).get("app.text")).toEqual(new Set(["app.text:wrap"]));
    expect(inner.has("app.text")).toBe(false);
    const all = hidden(routeFixture, { showTests: true, showExternal: false });
    expect(inward(routeFixture, hidden(routeFixture, toggles)).has("flow.walk")).toBe(false);
    expect([...inward(routeFixture, all).get("flow.walk")!].sort()).toEqual(["flow.walk:finish", "flow.walk:left", "flow.walk:mid", "flow.walk:right"]);
  });

  it("packedIn은 안쪽 자식과 그 안에 든 노드에 파일 상자를 내고, 밖과 이어진 자식과 파일 상자에는 null을 낸다", () => {
    expect(packedIn(repoFixture, off, "pkg.mod:parse")).toBe("pkg.mod");
    expect(packedIn(repoFixture, off, "pkg.mod:Store.save")).toBeNull();
    expect(packedIn(repoFixture, off, "pkg.mod")).toBeNull();
    expect(packedIn(repoFixture, off, "app.text:pad")).toBeNull();
    const nested: typeof repoFixture = {
      nodes: [...repoFixture.nodes, made("pkg.mod:Cache", "class", "pkg.mod"), made("pkg.mod:Cache.get", "method", "pkg.mod:Cache")],
      edges: repoFixture.edges,
    };
    expect(packedIn(nested, off, "pkg.mod:Cache.get")).toBe("pkg.mod");
  });

  it("접힌 상자의 배지는 파일 상자면 바로 아래 정의 수, 폴더면 안에 든 파일 수다", () => {
    const counts = insideCounts(repoFixture, off);
    expect(counts.get("pkg.mod")).toBe(3);
    expect(counts.get("main")).toBe(2);
    expect(counts.get("pkg")).toBe(2);
    expect(counts.get("app")).toBe(3);
    expect(insideCounts(repoFixture, hidden(repoFixture, { showTests: true, showExternal: false })).get("pkg")).toBe(3);
  });

  it("폴더의 줄 수는 하위 폴더까지 안에 든 파일의 줄 수 합이고 토글로 숨긴 파일은 세지 않는다", () => {
    const lines = folderLines(repoFixture, off);
    expect(lines.get("pkg")).toBe(60 + 5);
    expect(lines.get("app")).toBe(3 + 30 + 20);
    expect(lines.has("pkg.mod")).toBe(false);
    expect(folderLines(repoFixture, hidden(repoFixture, { showTests: true, showExternal: false })).get("pkg")).toBe(60 + 5 + 9);
    const nested = {
      nodes: [
        made("a", "package", null),
        made("a.x", "module", "a", { loc: 7 }),
        made("a.x:f", "function", "a.x", { loc: 4 }),
        made("a.b", "package", "a"),
        made("a.b.y", "module", "a.b", { loc: 11 }),
        made("a.b.test_y", "module", "a.b", { loc: 100, test: true }),
        made("a.c", "package", "a", { test: true }),
        made("a.c.test_z", "module", "a.c", { loc: 50, test: true }),
      ],
      edges: [],
    };
    const shownOnly = folderLines(nested, hidden(nested, { showTests: false, showExternal: false }));
    expect([shownOnly.get("a"), shownOnly.get("a.b"), shownOnly.get("a.c")]).toEqual([18, 11, 0]);
    const all = folderLines(nested, new Set());
    expect([all.get("a"), all.get("a.b"), all.get("a.c")]).toEqual([168, 111, 50]);
  });
});

describe("shown: 세 단계 펼침", () => {
  const at = (selection: string | null, more: Partial<Parameters<typeof shown>[1]> = {}) =>
    shown(repoFixture, { ...toggles, collapsed: new Set(), flow: selection === null ? null : flow(repoFixture, selection, 1, off), lit: null, ...more });
  const inside = (result: ReturnType<typeof shown>, box: string) => [...result.nodes].filter((id) => id.startsWith(`${box}:`)).sort();

  it("펼침 단계의 파일 상자는 밖과 이어진 자식만 그리고 나머지를 손잡이에 담는다", () => {
    const result = at("pkg.mod");
    expect(inside(result, "pkg.mod")).toEqual(["pkg.mod:Store", "pkg.mod:Store.load", "pkg.mod:Store.save"]);
    expect(result.packs.get("pkg.mod")).toEqual({ ids: ["pkg.mod:Row", "pkg.mod:parse"], definitions: 2, variables: 0, open: false, unused: 0 });
    expect(lift(nodes, result, "pkg.mod:parse")).toBe("pkg.mod");
  });

  it("전부 펼침 단계는 나머지 자식도 그리고 손잡이는 같은 자식을 열린 채로 담는다", () => {
    const result = at("pkg.mod", { unpacked: new Set(["pkg.mod"]) });
    expect(inside(result, "pkg.mod")).toEqual(["pkg.mod:Row", "pkg.mod:Store", "pkg.mod:Store.load", "pkg.mod:Store.save", "pkg.mod:parse"]);
    expect(result.packs.get("pkg.mod")).toEqual({ ids: ["pkg.mod:Row", "pkg.mod:parse"], definitions: 2, variables: 0, open: true, unused: 0 });
  });

  it("고른 노드가 그 파일에 없으면 unpacked에 있어도 접힘이고 손잡이가 없다", () => {
    const result = at(null, { unpacked: new Set(["pkg.mod"]) });
    expect(inside(result, "pkg.mod")).toEqual([]);
    expect(result.packs.size).toBe(0);
  });

  it("손잡이에 든 함수를 고르면 꺼내 그리고, 손잡이에 하나만 남으면 그 자식도 그린다", () => {
    const result = at("pkg.mod:parse");
    expect(inside(result, "pkg.mod")).toEqual(["pkg.mod:Row", "pkg.mod:Store", "pkg.mod:Store.load", "pkg.mod:Store.save", "pkg.mod:parse"]);
    expect(result.packs.has("pkg.mod")).toBe(false);
  });

  it("다른 파일의 접힌 상자에는 흐름에 든 노드만 그리고 손잡이를 달지 않는다", () => {
    const result = at("main:run");
    expect(inside(result, "pkg.mod")).toEqual(["pkg.mod:Store", "pkg.mod:Store.load"]);
    expect(result.packs.has("pkg.mod")).toBe(false);
    expect(inside(result, "main")).toEqual(["main:helper", "main:run"]);
  });

  it("선택을 풀면 선택 전과 같은 노드를 그린다", () => {
    expect([...at(null).nodes].sort()).toEqual([...closed.nodes].sort());
  });

  it("밖과 이어진 자식이 하나도 없는 파일 상자는 손잡이만 남으므로 모든 자식을 그린다", () => {
    const none = hidden(routeFixture, toggles);
    expect(outward(routeFixture, none).has("flow.walk")).toBe(false);
    const result = shown(routeFixture, { ...toggles, collapsed: new Set(), flow: flow(routeFixture, "flow.walk", 1, none), lit: null });
    const inside = routeFixture.nodes.filter((n) => n.parent === "flow.walk").map((n) => n.id);
    expect(inside.length).toBeGreaterThan(2);
    expect(inside.every((id) => result.nodes.has(id))).toBe(true);
    expect(result.packs.has("flow.walk")).toBe(false);
  });

  it("폴더는 접힘과 펼침 두 단계다. 펼치면 밖과 선이 없는 파일까지 모두 그리고 손잡이를 달지 않으며 unpacked를 보지 않는다", () => {
    const none = hidden(routeFixture, toggles);
    for (const unpacked of [new Set<string>(), new Set(["flow"])]) {
      const result = shown(routeFixture, { ...toggles, collapsed: new Set(), unpacked, flow: flow(routeFixture, "flow.walk:begin", 1, none), lit: null });
      expect(["flow.walk", "flow.build", "flow.sink"].every((id) => result.nodes.has(id))).toBe(true);
      expect(result.packs.has("flow")).toBe(false);
    }
    const folded = shown(routeFixture, { ...toggles, collapsed: new Set(["flow"]), flow: null, lit: null });
    expect(folded.nodes.has("flow")).toBe(true);
    expect(folded.nodes.has("flow.walk")).toBe(false);
  });

  it("분석 표시가 표시하는 노드는 펼침 단계에서 그리고, 미사용 후보 수는 손잡이에 든 자식에서 센다", () => {
    const candidates = new Set(["pkg.mod:parse", "pkg.mod:Row"]);
    const off = at("pkg.mod", { candidates });
    expect(off.packs.get("pkg.mod")).toEqual({ ids: ["pkg.mod:Row", "pkg.mod:parse"], definitions: 2, variables: 0, open: false, unused: 2 });
    const on = at("pkg.mod", { candidates, marked: candidates });
    expect(inside(on, "pkg.mod")).toContain("pkg.mod:parse");
    expect(on.packs.has("pkg.mod")).toBe(false);
  });

  it("진입점은 펼침 단계에서 그린다", () => {
    expect(nodes.get("app.web:index")!.entry).toBe(true);
    expect(at("app.web").nodes.has("app.web:index")).toBe(true);
  });

  it("경로 고정 중에는 파일 상자가 모두 접힘이어서 경로 위 노드만 그리고, 폴더의 단계는 그대로다", () => {
    const none = hidden(routeFixture, toggles);
    const path = lit(route(routeFixture, "flow.walk:begin", "flow.walk:finish", none), 0)!;
    const result = shown(routeFixture, { ...toggles, collapsed: new Set(), unpacked: new Set(["flow.walk"]), flow: null, lit: path });
    expect([...result.nodes].filter((id) => id.includes(":")).sort()).toEqual(["flow.walk:begin", "flow.walk:finish", "flow.walk:left"]);
    expect(result.packs.has("flow.walk")).toBe(false);
  });

  it("drawnOut은 고른 노드와 흐름의 노드, 경로 위 노드와 그 조상을 낸다", () => {
    const out = drawnOut(repoFixture, flow(repoFixture, "main:run", 1, off), null);
    expect(["main:run", "main", "pkg.mod:Store.load", "pkg.mod:Store", "pkg.mod", "pkg", "cli:main"].every((id) => out.has(id))).toBe(true);
    expect(out.has("pkg.mod:parse")).toBe(false);
    expect([...drawnOut(repoFixture, flow(repoFixture, "pkg.mod", 1, off), null)].some((id) => id.startsWith("pkg.mod:"))).toBe(false);
    expect(drawnOut(repoFixture, null, null).size).toBe(0);
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
    expect(result.nodes.has("flow.walk")).toBe(true);
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
    expect(result.nodes.has("flow.walk")).toBe(true);
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

describe("변수 노드", () => {
  const variables = nodeIndex(variableFixture);
  const [none, external, tests] = [
    hidden(variableFixture, { showTests: false, showExternal: false }),
    hidden(variableFixture, { showTests: false, showExternal: true }),
    hidden(variableFixture, { showTests: true, showExternal: false }),
  ];
  const at = (selection: string, opts: { showTests: boolean; showExternal: boolean }, unpacked: string[] = []) =>
    shown(variableFixture, { ...opts, collapsed: new Set(), flow: flow(variableFixture, selection, 1, hidden(variableFixture, opts)), lit: null, unpacked: new Set(unpacked) });

  it("외부 값 변수는 외부 노드 토글이 꺼지면 숨기고, 테스트 코드의 변수는 테스트 코드 토글을 따른다", () => {
    expect([...none].sort()).toEqual(["conf:logger", "tests.test_conf", "tests.test_conf:SAMPLE", "tests.test_conf:test_clamp"]);
    expect(external.has("conf:logger")).toBe(false);
    expect(tests.has("conf:logger")).toBe(true);
    expect(tests.has("tests.test_conf:SAMPLE")).toBe(false);
  });

  it("다른 파일이 읽는 변수와 값이 다른 파일의 정의로 선을 보내는 변수는 밖과 이어진 자식이다", () => {
    const linked = outward(variableFixture, none);
    expect([...linked.get("conf")!].sort()).toEqual(["conf:PRESETS", "conf:Preset", "conf:clamp"]);
    expect([...linked.get("app")!].sort()).toEqual(["app:STARTERS", "app:run"]);
  });

  it("파일 안에서만 쓰는 변수는 안쪽 자식이고 토글로 숨긴 외부 값 변수는 들지 않는다", () => {
    expect([...inward(variableFixture, none).get("conf")!].sort()).toEqual(["conf:DEFAULT", "conf:LIMIT", "conf:_cache", "conf:remember"]);
    expect(inward(variableFixture, external).get("conf")!.has("conf:logger")).toBe(true);
    expect(inward(variableFixture, none).has("app")).toBe(false);
    expect(packedIn(variableFixture, none, "conf:LIMIT")).toBe("conf");
    expect(packedIn(variableFixture, none, "conf:PRESETS")).toBeNull();
    expect(packedIn(variableFixture, none, "conf:logger")).toBeNull();
    expect(packedIn(variableFixture, external, "conf:logger")).toBe("conf");
  });

  it("접힌 파일 상자의 배지는 변수까지 세고 숨긴 변수는 세지 않는다", () => {
    expect(insideCounts(variableFixture, none).get("conf")).toBe(7);
    expect(insideCounts(variableFixture, external).get("conf")).toBe(8);
    expect(insideCounts(variableFixture, none).get("app")).toBe(2);
    expect(insideCounts(variableFixture, none).has("tests.test_conf")).toBe(false);
    expect(insideCounts(variableFixture, tests).get("tests.test_conf")).toBe(2);
  });

  it("손잡이는 안쪽 자식 가운데 함수·클래스의 수와 변수의 수를 따로 담고 숨긴 변수를 세지 않는다", () => {
    const off = { showTests: false, showExternal: false };
    const result = at("conf", off);
    expect(result.packs.get("conf")).toEqual({
      ids: ["conf:remember", "conf:LIMIT", "conf:DEFAULT", "conf:_cache"],
      definitions: 1,
      variables: 3,
      open: false,
      unused: 0,
    });
    expect(["conf:PRESETS", "conf:Preset", "conf:clamp"].every((id) => result.nodes.has(id))).toBe(true);
    expect(result.nodes.has("conf:LIMIT")).toBe(false);
    expect(lift(variables, result, "conf:LIMIT")).toBe("conf");
    expect(lift(variables, result, "conf:logger")).toBeNull();
    expect(at("conf", { showTests: false, showExternal: true }).packs.get("conf")).toMatchObject({ definitions: 1, variables: 4 });
  });

  it("전부 펼침 단계는 안쪽 자식인 변수를 그리고 숨긴 외부 값 변수는 그리지 않는다", () => {
    const full = at("conf", { showTests: false, showExternal: false }, ["conf"]);
    expect(["conf:LIMIT", "conf:DEFAULT", "conf:_cache", "conf:remember"].every((id) => full.nodes.has(id))).toBe(true);
    expect(full.nodes.has("conf:logger")).toBe(false);
    expect(at("conf", { showTests: false, showExternal: true }, ["conf"]).nodes.has("conf:logger")).toBe(true);
  });

  it("바꿈 선이 나가는 함수마다 도착 변수의 이름을 한 번씩 담고 모듈에서 나가는 바꿈 선은 담지 않는다", () => {
    expect([...writtenBy(variableFixture)]).toEqual([["conf:remember", ["_cache"]]]);
    const more = {
      ...variableFixture,
      edges: [
        ...variableFixture.edges,
        { ...variableFixture.edges.find((e) => e.kind === "write")!, target: "conf:LIMIT" },
        { ...variableFixture.edges.find((e) => e.kind === "write")!, source: "app" },
        { ...variableFixture.edges.find((e) => e.kind === "write")! },
      ],
    };
    expect([...writtenBy(more)]).toEqual([["conf:remember", ["_cache", "LIMIT"]]]);
    expect(writtenBy(repoFixture).size).toBe(0);
  });

  it("변수를 고르면 그 변수를 읽는 함수를 꺼내 그린다", () => {
    const result = at("conf:PRESETS", { showTests: false, showExternal: false });
    expect(result.nodes.has("app:run")).toBe(true);
    expect(result.nodes.has("conf:Preset")).toBe(true);
  });
});
