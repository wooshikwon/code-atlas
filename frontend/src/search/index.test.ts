import { describe, expect, it } from "vitest";
import type { AtlasNode, Graph } from "../api/types";
import type { History } from "../state/history";
import { build, find, recent } from "./index";

function node(id: string, kind: AtlasNode["kind"], parent: string | null, path: string | null, test = false): AtlasNode {
  const name = id.includes(":") ? id.split(":")[1].split(".").at(-1)! : id.split(".").at(-1)!;
  return { id, kind, name, parent, path, test } as AtlasNode;
}

const graph: Graph = {
  nodes: [
    node("arbiter", "module", null, "src/arbiter.py"),
    node("arbiter:_rebuild_note_sections", "function", "arbiter", "src/arbiter.py"),
    node("arbiter:Arbiter", "class", "arbiter", "src/arbiter.py"),
    node("arbiter:Arbiter.run", "method", "arbiter:Arbiter", "src/arbiter.py"),
    node("parser", "package", null, "src/parser/__init__.py"),
    node("parser.reminders", "module", "parser", "src/parser/reminders.py"),
    node("parser.reminders:Item", "dataclass", "parser.reminders", "src/parser/reminders.py"),
    node("docs", "package", null, "docs"),
    node("tests.test_reminders", "module", null, "tests/test_reminders.py", true),
    node("tests.test_reminders:test_rns", "function", "tests.test_reminders", "tests/test_reminders.py", true),
    node("ext:json", "external", null, null),
  ],
  edges: [],
};

const entries = build(graph, false);
const ids = (query: string, limit?: number) => find(entries, query, limit).map((hit) => hit.entry.id);

describe("build", () => {
  it("파일·클래스·데이터 클래스·함수·메서드를 담고 폴더와 그 __init__.py, 외부 노드는 뺀다", () => {
    expect(entries).toEqual([
      { id: "arbiter", name: "arbiter.py", path: "src/arbiter.py", kind: "file" },
      { id: "arbiter:_rebuild_note_sections", name: "_rebuild_note_sections", path: "src/arbiter.py", kind: "function" },
      { id: "arbiter:Arbiter", name: "Arbiter", path: "src/arbiter.py", kind: "class" },
      { id: "arbiter:Arbiter.run", name: "Arbiter.run", path: "src/arbiter.py", kind: "method" },
      { id: "parser.reminders", name: "reminders.py", path: "src/parser/reminders.py", kind: "file" },
      { id: "parser.reminders:Item", name: "Item", path: "src/parser/reminders.py", kind: "dataclass" },
    ]);
  });

  it("테스트 코드 토글이 꺼지면 테스트 노드가 빠지고 켜지면 들어간다", () => {
    expect(entries.some((entry) => entry.id.startsWith("tests."))).toBe(false);
    const withTests = build(graph, true).map((entry) => entry.id);
    expect(withTests).toContain("tests.test_reminders");
    expect(withTests).toContain("tests.test_reminders:test_rns");
  });
});

describe("find", () => {
  it("rns 질의는 _rebuild_note_sections를 reminders.py보다 앞에 낸다", () => {
    const found = ids("rns");
    expect(found[0]).toBe("arbiter:_rebuild_note_sections");
    expect(found.indexOf("parser.reminders")).toBeGreaterThan(0);
  });

  it("일치한 글자의 위치를 돌려준다", () => {
    const hit = find(entries, "rns")[0];
    expect(hit.field).toBe("name");
    expect([...hit.positions].sort((a, b) => a - b)).toEqual([1, 9, 14]);
  });

  it("name에서 찾은 결과 뒤에 path에서 찾은 결과를 잇는다", () => {
    const hits = find(entries, "parser");
    expect(hits.map((hit) => [hit.entry.id, hit.field])).toEqual([
      ["parser.reminders", "path"],
      ["parser.reminders:Item", "path"],
    ]);
    expect(find(entries, "rem").map((hit) => [hit.entry.id, hit.field])).toEqual([
      ["parser.reminders", "name"],
      ["parser.reminders:Item", "path"],
    ]);
  });

  it("limit까지만 낸다", () => {
    expect(ids("a", 2)).toHaveLength(2);
    expect(ids("src", 3)).toHaveLength(3);
  });

  it("질의가 비면 최근에 고른 노드를 최근 것부터 낸다", () => {
    const history: History = {
      entries: [
        { view: { kind: "structure" }, selection: null, via: null, collapsed: [], unpacked: [] },
        { view: { kind: "structure" }, selection: { type: "node", id: "arbiter" }, via: null, collapsed: [], unpacked: [] },
        { view: { kind: "structure" }, selection: { type: "node", id: "parser.reminders:Item" }, via: null, collapsed: [], unpacked: [] },
        { view: { kind: "structure" }, selection: { type: "edge", key: "agg|a|b", focus: null }, via: null, collapsed: [], unpacked: [] },
        { view: { kind: "structure" }, selection: { type: "node", id: "arbiter" }, via: null, collapsed: [], unpacked: [] },
        { view: { kind: "structure" }, selection: { type: "node", id: "tests.test_reminders" }, via: null, collapsed: [], unpacked: [] },
      ],
      index: 5,
    };
    expect(recent(history)).toEqual(["tests.test_reminders", "arbiter", "parser.reminders:Item"]);
    const hits = find(entries, " ", 50, recent(history));
    expect(hits.map((hit) => hit.entry.id)).toEqual(["arbiter", "parser.reminders:Item"]);
    expect(hits[0].field).toBeNull();
    expect(find(entries, "")).toEqual([]);
  });
});
