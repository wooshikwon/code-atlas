import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import type { AtlasEdge, Graph } from "../api/types";
import { callEdges, callElk, callLabel, callSize, callTitle, callview, fileLabel } from "./calls";
import { repoFixture } from "./fixture";
import { fromElk, LEAF_HEIGHT } from "./layout";
import { edgeKey } from "./scope";
import { hidden, nodeIndex } from "./visible";

const off = hidden(repoFixture, { showTests: false, showExternal: false });
const nodes = nodeIndex(repoFixture);
const measure = (text: string) => text.length * 7;
const load = "pkg.mod:Store.load";
const save = "pkg.mod:Store.save";

function link(source: string, target: string, kind: AtlasEdge["kind"], group: AtlasEdge["group"], line = 1): AtlasEdge {
  return { group, kind, source, target, sites: [{ path: "x.py", line, col: 0 }], deferred: false };
}

function withEdges(...edges: AtlasEdge[]): Graph {
  return { nodes: repoFixture.nodes, edges: [...repoFixture.edges, ...edges] };
}

describe("callview", () => {
  it("가운데 함수를 호출하는 함수와 그 함수가 호출하는 함수·생성하는 클래스를 고른다", () => {
    const calls = callview(repoFixture, load, [], off);
    expect(calls.nodes).toEqual(["main:run", load, save, "pkg.mod:Row"]);
    expect([...calls.side]).toEqual([
      [load, "center"],
      ["main:run", "caller"],
      [save, "callee"],
      ["pkg.mod:Row", "callee"],
    ]);
    expect(calls.edges.map(edgeKey)).toEqual([
      `main:run|${load}|call`,
      `${load}|${save}|call`,
      `${load}|pkg.mod:Row|construct`,
    ]);
  });

  it("숨긴 노드에 닿는 선을 빼고, 테스트 코드를 켜면 테스트 함수가 호출하는 쪽에 든다", () => {
    expect(callview(repoFixture, load, [], off).side.has("tests.test_mod:test_load")).toBe(false);
    const calls = callview(repoFixture, load, [], new Set());
    expect(calls.side.get("tests.test_mod:test_load")).toBe("caller");
    expect(calls.nodes.slice(0, 2)).toEqual(["main:run", "tests.test_mod:test_load"]);
  });

  it("expanded에 든 호출되는 쪽 노드는 그 노드가 호출하는 함수를 한 단계 더 편다", () => {
    const calls = callview(repoFixture, load, [save], off);
    expect(calls.nodes).toEqual(["main:run", load, save, "pkg.mod:Row", "main:helper", "pkg.mod:parse"]);
    expect(calls.side.get("main:helper")).toBe("callee");
    expect(calls.edges.map(edgeKey)).toContain(`${save}|pkg.mod:parse|call`);
    expect(calls.edges.map(edgeKey)).not.toContain("main:run|main:helper|call");
  });

  it("expanded에 든 호출하는 쪽 노드는 그 노드를 호출하는 함수를 한 단계 더 편다", () => {
    const calls = callview(repoFixture, load, ["main:run"], off);
    expect(calls.nodes).toEqual(["main:run", "cli:main", load, save, "pkg.mod:Row"]);
    expect(calls.side.get("cli:main")).toBe("caller");
    expect(calls.edges.map(edgeKey)).toContain("cli:main|main:run|call");
    expect(calls.side.has("main:helper")).toBe(false);
  });

  it("그려 둔 노드가 아닌 id와 가운데 함수는 expanded에 들어도 펴지 않는다", () => {
    const plain = callview(repoFixture, load, [], off);
    expect(callview(repoFixture, load, ["app.text:wrap", load], off)).toEqual(plain);
  });

  it("같은 방향으로 더 펼 선이 남은 양옆 노드를 more에 담는다", () => {
    expect([...callview(repoFixture, load, [], off).more].sort()).toEqual(["main:run", save]);
    expect([...callview(repoFixture, load, [save], off).more]).toEqual(["main:run"]);
    expect([...callview(repoFixture, "app.web:render", ["app.text:wrap"], off).more]).toEqual([]);
  });

  it("사용 선과 계승 선은 담지 않는다", () => {
    const graph = withEdges(
      link(load, "common:log", "pass", "use"),
      link("cli:main", load, "type", "use"),
      link("pkg.mod:Row", "pkg.mod:Store", "inherit", "derive"),
    );
    const calls = callview(graph, load, [], off);
    expect(calls.nodes).toEqual(["main:run", load, save, "pkg.mod:Row"]);
    expect(calls.edges.every((edge) => edge.group === "run")).toBe(true);
    expect(callview(repoFixture, "pkg.mod", [], off)).toMatchObject({ nodes: ["pkg.mod"], edges: [] });
  });

  it("가운데 함수를 호출하면서 호출도 받는 노드는 호출하는 쪽에 한 번만 든다", () => {
    const calls = callview(withEdges(link(load, "main:run", "call", "run")), load, [], off);
    expect(calls.nodes.filter((id) => id === "main:run")).toHaveLength(1);
    expect(calls.side.get("main:run")).toBe("caller");
    expect(calls.edges.map(edgeKey)).toContain(`${load}|main:run|call`);
  });

  it("호출되는 쪽을 호출 지점의 줄 순서로 놓는다", () => {
    const graph = withEdges(link("common:log", "app.text:pad", "call", "run", 9), link("common:log", "app.text:wrap", "call", "run", 4));
    expect(callview(graph, "common:log", [], off).nodes).toEqual(["cli:main", "common:log", "app.text:wrap", "app.text:pad"]);
  });
});

describe("이름표와 크기", () => {
  it("메서드는 클래스 이름을 앞에 붙이고 함수와 클래스는 구조 뷰와 같은 이름표다", () => {
    expect(callLabel(nodes, nodes.get(load)!)).toBe("Store.load()");
    expect(callTitle(nodes, nodes.get(load)!)).toBe("Store.load()");
    expect(callLabel(nodes, nodes.get("main:run")!)).toBe("run()");
    expect(callLabel(nodes, nodes.get("pkg.mod:Row")!)).toBe("Row");
  });

  it("파일 경로는 그 노드가 든 파일 상자의 이름표다", () => {
    expect(fileLabel(nodes, nodes.get(load)!)).toBe("pkg/mod.py");
    expect(fileLabel(nodes, nodes.get("main:run")!)).toBe("main.py");
    expect(fileLabel(nodes, nodes.get("ext:json")!)).toBeNull();
  });

  it("높이는 이름표 줄에 파일 경로 줄 14px를 더한 값이고, 더 펼 선이 남은 노드는 + 버튼 16px와 간격 4px만큼 넓다", () => {
    const calls = callview(repoFixture, load, [], off);
    const opened = callview(repoFixture, load, [save], off);
    const before = callSize(calls, nodes, nodes.get(save)!, measure);
    const after = callSize(opened, nodes, nodes.get(save)!, measure);
    expect(before.height).toBe(LEAF_HEIGHT + 14);
    expect(before.width - after.width).toBe(20);
  });
});

describe("배치", () => {
  const elk = new ELK();

  it("호출하는 쪽을 가운데 함수 왼쪽에, 호출되는 쪽을 오른쪽에 놓고 선마다 경로를 낸다", async () => {
    const calls = callview(repoFixture, load, [save, "main:run"], off);
    const done = await elk.layout(callElk(calls, (id) => callSize(calls, nodes, nodes.get(id)!, measure)));
    const layout = fromElk(done);
    const x = (id: string) => layout.boxes.get(id)!.x;
    expect(x("cli:main")).toBeLessThan(x("main:run"));
    expect(x("main:run")).toBeLessThan(x(load));
    expect(x(load)).toBeLessThan(x(save));
    expect(x(save)).toBeLessThan(x("pkg.mod:parse"));
    expect(x("pkg.mod:Row")).toBe(x(save));

    const views = callEdges(calls, load, layout);
    expect(views).toHaveLength(calls.edges.length);
    const tone = (key: string) => views.find((view) => view.key === key)!.tone;
    expect(tone(`main:run|${load}|call`)).toBe("strong");
    expect(tone(`${load}|${save}|call`)).toBe("strong");
    expect(tone(`${save}|pkg.mod:parse|call`)).toBe("muted");
    expect(views.every((view) => view.weight === null && view.opacity === 1)).toBe(true);
  });
});
