import { describe, expect, it } from "vitest";
import type { Graph } from "../api/types";
import { edge, node, routeFixture, variableFixture } from "./fixture";
import { PATH_LIMIT, endpoints, lit, route, steps, type Path } from "./route";
import { hidden } from "./visible";

const off = hidden(routeFixture, { showTests: false, showExternal: false });
const all = hidden(routeFixture, { showTests: true, showExternal: false });
const none = new Set<string>();

/** 파일 m 안의 함수 사이에 호출 선을 둔 그래프. 이름 앞에 `m:`을 붙인다. */
function calls(pairs: [string, string][]): Graph {
  const names = [...new Set(pairs.flat())];
  return {
    nodes: [node("m", "module", null), ...names.map((name) => node(`m:${name}`, "function", "m"))],
    edges: pairs.map(([source, target]) => edge(`m:${source}`, `m:${target}`, "call")),
  };
}

/** 같은 노드를 두 번 지나지 않는 경로 전체를 깊이 우선 탐색으로 모은다. */
function everyPath(graph: Graph, from: string, to: string): Path[] {
  const result: Path[] = [];
  const walk = (path: Path) => {
    const at = path[path.length - 1];
    if (at === to) {
      result.push(path);
      return;
    }
    for (const e of graph.edges) {
      if (e.source === at && !path.includes(e.target)) {
        walk([...path, e.target]);
      }
    }
  };
  walk([from]);
  return result;
}

describe("steps", () => {
  it("실행 선마다 걸음을 내고 도착 노드 id순으로 둔다", () => {
    expect(steps(routeFixture, off).get("flow.walk:begin")).toEqual([
      { source: "flow.walk:begin", target: "flow.walk:left", kind: "call" },
      { source: "flow.walk:begin", target: "flow.walk:mid", kind: "call" },
      { source: "flow.walk:begin", target: "flow.walk:right", kind: "call" },
    ]);
    expect(steps(routeFixture, off).get("flow.build:make")).toEqual([
      { source: "flow.build:make", target: "flow.build:Engine", kind: "construct" },
    ]);
  });

  it("클래스에서 생성자 메서드로, 부모 메서드에서 자식 메서드로 이음을 낸다", () => {
    const out = steps(routeFixture, off);
    expect(out.get("flow.build:Engine")).toEqual([
      { source: "flow.build:Engine", target: "flow.build:Engine.__init__", kind: "init" },
    ]);
    expect(out.get("flow.build:Base.step")).toEqual([
      { source: "flow.build:Base.step", target: "flow.build:Child.step", kind: "overridden" },
    ]);
    expect(out.has("flow.build:Base")).toBe(false);
  });

  it("사용 선과 상속 선은 걸음이 아니다", () => {
    const out = steps(routeFixture, all);
    expect(out.has("flow.build")).toBe(false);
    expect(out.has("flow.build:Child")).toBe(false);
    expect(out.has("ring.a")).toBe(false);
  });

  it("같은 두 노드 사이에 걸음이 여럿이면 call, construct, init, overridden 순서로 앞선 하나만 남긴다", () => {
    const graph: Graph = {
      nodes: [
        node("m", "module", null),
        node("m:Box", "class", "m"),
        node("m:Box.__init__", "method", "m:Box"),
        node("m:Box.__new__", "method", "m:Box"),
        node("m:Box.__post_init__", "method", "m:Box"),
        node("m:Box.size", "method", "m:Box"),
        node("m:Kid", "class", "m"),
        node("m:Kid.size", "method", "m:Kid"),
      ],
      edges: [
        edge("m:Kid.size", "m:Box.size", "override"),
        edge("m:Box.size", "m:Kid.size", "call"),
        edge("m:Box", "m:Box.__init__", "construct"),
        edge("m:Box", "m:Box.__new__", "call"),
        edge("m:Box", "m:Box.__new__", "construct"),
      ],
    };
    const out = steps(graph, none);
    expect(out.get("m:Box.size")!.map((s) => s.kind)).toEqual(["call"]);
    expect(out.get("m:Box")!.map((s) => [s.target, s.kind])).toEqual([
      ["m:Box.__init__", "construct"],
      ["m:Box.__new__", "call"],
      ["m:Box.__post_init__", "init"],
    ]);
  });

  it("숨긴 노드로 가거나 숨긴 노드에서 나오는 걸음을 내지 않는다", () => {
    expect(steps(routeFixture, off).has("flow.walk:probe")).toBe(false);
    expect(steps(routeFixture, off).has("tests.fakes:relay")).toBe(false);
    expect(steps(routeFixture, all).get("flow.walk:probe")!.map((s) => s.target)).toEqual(["tests.fakes:relay"]);
    expect(steps(routeFixture, all).get("tests.fakes:relay")!.map((s) => s.target)).toEqual(["flow.walk:lone"]);
  });
});

describe("endpoints", () => {
  it("함수는 그 노드 하나, 클래스와 파일은 안에 든 노드 전체다", () => {
    expect([...endpoints(routeFixture, "flow.sink:tune", off)]).toEqual(["flow.sink:tune"]);
    expect([...endpoints(routeFixture, "flow.build:Base", off)].sort()).toEqual([
      "flow.build:Base",
      "flow.build:Base.run",
      "flow.build:Base.step",
    ]);
    expect(endpoints(routeFixture, "flow.build", off).size).toBe(9);
  });

  it("숨긴 노드는 넣지 않고, 숨긴 노드나 없는 노드를 주면 빈 집합이다", () => {
    expect(endpoints(routeFixture, "tests.fakes", off).size).toBe(0);
    expect([...endpoints(routeFixture, "tests.fakes", all)].sort()).toEqual(["tests.fakes", "tests.fakes:relay"]);
    expect(endpoints(routeFixture, "nowhere", off).size).toBe(0);
  });
});

describe("route", () => {
  it("경로를 길이순으로, 길이가 같으면 노드 id순으로 낸다", () => {
    const result = route(routeFixture, "flow.walk:begin", "flow.walk:finish", off);
    expect(result.paths).toEqual([
      ["flow.walk:begin", "flow.walk:left", "flow.walk:finish"],
      ["flow.walk:begin", "flow.walk:right", "flow.walk:finish"],
      ["flow.walk:begin", "flow.walk:mid", "flow.walk:left", "flow.walk:finish"],
    ]);
    expect(result.more).toBe(false);
    expect(result.from).toBe("flow.walk:begin");
    expect(result.to).toBe("flow.walk:finish");
  });

  it("같은 입력에 같은 순서를 낸다", () => {
    const shuffled: Graph = { nodes: [...routeFixture.nodes].reverse(), edges: [...routeFixture.edges].reverse() };
    const first = route(routeFixture, "flow.walk:begin", "flow.walk:finish", off);
    expect(route(routeFixture, "flow.walk:begin", "flow.walk:finish", off)).toEqual(first);
    expect(route(shuffled, "flow.walk:begin", "flow.walk:finish", off).paths).toEqual(first.paths);
  });

  it("경로마다 같은 노드가 한 번만 나오고, 전체 경로를 길이와 id순으로 늘어놓은 앞의 다섯 개와 같다", () => {
    const pairs: [string, string][] = [];
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        if (i !== j && (i * 5 + j * 3) % 4 !== 0) {
          pairs.push([`n${i}`, `n${j}`]);
        }
      }
    }
    const graph = calls(pairs);
    const result = route(graph, "m:n0", "m:n7", none);
    const expected = everyPath(graph, "m:n0", "m:n7").sort(
      (a, b) => a.length - b.length || (a.join(" ") < b.join(" ") ? -1 : 1),
    );
    expect(expected.length).toBeGreaterThan(PATH_LIMIT);
    expect(result.paths).toEqual(expected.slice(0, PATH_LIMIT));
    expect(result.more).toBe(true);
    for (const path of result.paths) {
      expect(new Set(path).size).toBe(path.length);
    }
  });

  it("여섯째 경로가 있을 때만 more가 참이다", () => {
    const fan = (count: number) =>
      calls(Array.from({ length: count }, (_, i): [string, string][] => [["a", `v${i}`], [`v${i}`, "z"]]).flat());
    const five = route(fan(5), "m:a", "m:z", none);
    expect(five.paths.length).toBe(5);
    expect(five.more).toBe(false);
    const six = route(fan(6), "m:a", "m:z", none);
    expect(six.paths.map((path) => path[1])).toEqual(["m:v0", "m:v1", "m:v2", "m:v3", "m:v4"]);
    expect(six.more).toBe(true);
  });

  it("파일을 끝점으로 주면 그 파일의 어느 함수에서든 출발하고 어느 함수에든 닿으면 끝난다", () => {
    const result = route(routeFixture, "flow.build", "flow.sink", off);
    expect(result.paths).toEqual([
      ["flow.build:Child.step", "flow.sink:emit"],
      ["flow.build:Engine.__init__", "flow.sink:tune"],
    ]);
    expect(route(routeFixture, "flow.build:Base", "flow.sink:emit", off).paths).toEqual([
      ["flow.build:Base.step", "flow.build:Child.step", "flow.sink:emit"],
    ]);
  });

  it("클래스를 도착 끝점으로 주면 클래스 노드에 닿을 때 끝나고 안으로 더 들어가지 않는다", () => {
    expect(route(routeFixture, "flow.build:make", "flow.build:Engine", off).paths).toEqual([
      ["flow.build:make", "flow.build:Engine"],
    ]);
  });

  it("생성자 안의 호출로 넘어가는 경로는 init 걸음을 지난다", () => {
    const result = route(routeFixture, "flow.build:make", "flow.sink:tune", off);
    expect(result.paths).toEqual([
      ["flow.build:make", "flow.build:Engine", "flow.build:Engine.__init__", "flow.sink:tune"],
    ]);
    expect([...lit(result, 0)!.kinds]).toEqual([
      ["flow.build:make|flow.build:Engine", "construct"],
      ["flow.build:Engine|flow.build:Engine.__init__", "init"],
      ["flow.build:Engine.__init__|flow.sink:tune", "call"],
    ]);
  });

  it("부모 메서드에서 자식 메서드로 넘어가는 경로는 overridden 걸음을 지난다", () => {
    const result = route(routeFixture, "flow.build:Base.run", "flow.sink:emit", off);
    expect(result.paths).toEqual([
      ["flow.build:Base.run", "flow.build:Base.step", "flow.build:Child.step", "flow.sink:emit"],
    ]);
    expect([...lit(result, 0)!.kinds.values()]).toEqual(["call", "overridden", "call"]);
  });

  it("테스트 코드를 숨기면 테스트 코드를 거치는 경로가 빠진다", () => {
    expect(route(routeFixture, "flow.walk:probe", "flow.walk:lone", all).paths).toEqual([
      ["flow.walk:probe", "tests.fakes:relay", "flow.walk:lone"],
    ]);
    const result = route(routeFixture, "flow.walk:probe", "flow.walk:lone", off);
    expect(result.paths).toEqual([]);
    expect(result.reverse).toBe(false);
    expect(result.reach).toBe(1);
  });

  it("경로가 없으면 반대 방향에 경로가 있는지와 출발에서 닿는 함수 수, 그 안의 미확인 호출 수를 낸다", () => {
    const back = route(routeFixture, "flow.walk:finish", "flow.walk:begin", off);
    expect(back.paths).toEqual([]);
    expect(back.more).toBe(false);
    expect(back.reverse).toBe(true);
    expect(back.reach).toBe(1);
    expect(back.unresolved).toBe(3);
    expect(lit(back, 0)).toBeNull();

    const apart = route(routeFixture, "flow.build:Base.run", "flow.walk:finish", off);
    expect(apart.paths).toEqual([]);
    expect(apart.reverse).toBe(false);
    expect(apart.reach).toBe(4);
    expect(apart.unresolved).toBe(1);
  });

  it("경로가 있을 때도 닿는 함수 수와 미확인 호출 수를 세고 reverse는 거짓이다", () => {
    const result = route(routeFixture, "flow.walk:begin", "flow.walk:finish", off);
    expect(result.reach).toBe(5);
    expect(result.unresolved).toBe(4);
    expect(result.reverse).toBe(false);
  });

  it("출발과 도착이 같거나 한쪽이 다른 쪽을 품으면 경로가 없고 reverse도 거짓이다", () => {
    for (const [from, to] of [
      ["flow.walk:begin", "flow.walk:begin"],
      ["flow.walk", "flow.walk:finish"],
      ["flow.walk:begin", "flow.walk"],
    ]) {
      const result = route(routeFixture, from, to, off);
      expect(result.paths).toEqual([]);
      expect(result.reverse).toBe(false);
    }
  });
});

describe("lit", () => {
  it("고른 번호의 경로와 그 위의 노드, 걸음 종류만 담는다", () => {
    const result = route(routeFixture, "flow.walk:begin", "flow.walk:finish", off);
    const third = lit(result, 2)!;
    expect(third.path).toBe(result.paths[2]);
    expect([...third.nodes]).toEqual(["flow.walk:begin", "flow.walk:mid", "flow.walk:left", "flow.walk:finish"]);
    expect([...third.kinds.keys()]).toEqual([
      "flow.walk:begin|flow.walk:mid",
      "flow.walk:mid|flow.walk:left",
      "flow.walk:left|flow.walk:finish",
    ]);
    expect(lit(result, 1)!.kinds.has("flow.walk:begin|flow.walk:mid")).toBe(false);
  });

  it("그 번호의 경로가 없으면 null이다", () => {
    const result = route(routeFixture, "flow.walk:begin", "flow.walk:finish", off);
    expect(lit(result, 3)).toBeNull();
    expect(lit(result, -1)).toBeNull();
  });
});

describe("변수 노드와 경로", () => {
  const shownAll = hidden(variableFixture, { showTests: false, showExternal: true });
  const found = steps(variableFixture, shownAll);

  it("읽음·바꿈 선은 걸음이 아니다", () => {
    const pairs = [...found.values()].flat().map((step) => `${step.source}|${step.target}`);
    for (const e of variableFixture.edges.filter((each) => each.kind === "read" || each.kind === "write")) {
      expect(pairs).not.toContain(`${e.source}|${e.target}`);
    }
    expect(found.has("conf:remember")).toBe(false);
  });

  it("변수에서 나가는 생성 선은 걸음이고, 파일을 출발로 고르면 그 안의 변수에서 시작하는 경로가 나온다", () => {
    expect(found.get("conf:PRESETS")).toEqual([{ source: "conf:PRESETS", target: "conf:Preset", kind: "construct" }]);
    expect(route(variableFixture, "app", "conf:Preset", shownAll)?.paths).toEqual([["app:STARTERS", "conf:Preset"]]);
  });
});
