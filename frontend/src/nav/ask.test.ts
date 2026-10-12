import { describe, expect, it } from "vitest";
import { repoFixture as graph } from "../graph/fixture";
import { hidden } from "../graph/visible";
import type { SummaryState } from "../state/summaries";
import { asksOf } from "./ask";

const done: SummaryState = { phase: "done", summary: "요지", available: true, stale: false, usage: null };
const empty = { states: {}, leads: {} };
const off = hidden(graph, { showTests: false, showExternal: false });
/** `pkg` 아래에 하위 폴더 `pkg.sub`과 그 안의 파일, 함수를 더한 그래프 */
const nested = {
  ...graph,
  nodes: [
    ...graph.nodes,
    { ...graph.nodes.find((n) => n.id === "pkg")!, id: "pkg.sub", name: "sub", parent: "pkg", path: "pkg/sub" },
    { ...graph.nodes.find((n) => n.id === "pkg.mod")!, id: "pkg.sub.deep", name: "deep", parent: "pkg.sub", path: "pkg/sub/deep.py" },
    { ...graph.nodes.find((n) => n.id === "main:run")!, id: "pkg.sub.deep:run", parent: "pkg.sub.deep", path: "pkg/sub/deep.py" },
  ],
};
/** 파일 id 안에 든 클래스·함수·메서드 */
const inside = (file: string) => graph.nodes.filter((n) => n.id.startsWith(`${file}:`) && n.kind !== "external").map((n) => n.id);

describe("asksOf", () => {
  it("요약이 없으면 요청, 있으면 다시 만들기, 만드는 중이면 누를 수 없는 항목이다", () => {
    const [id] = inside("main");
    expect(asksOf(graph, empty, off, id)).toEqual([{ key: "one", label: "LLM 요약 요청", disabled: false, nodes: [id], refresh: false }]);
    const again = [{ key: "one", label: "요약 다시 만들기", disabled: false, nodes: [id], refresh: true }];
    expect(asksOf(graph, { states: { [id]: done }, leads: {} }, off, id)).toEqual(again);
    expect(asksOf(graph, { states: {}, leads: { [id]: "요지" } }, off, id)).toEqual(again);
    expect(asksOf(graph, { states: { [id]: { phase: "making" } }, leads: { [id]: "요지" } }, off, id)).toEqual([
      { key: "one", label: "요약 만드는 중", disabled: true, nodes: [], refresh: false },
    ]);
    expect(asksOf(graph, { states: { [id]: { phase: "failed", error: "실패", refresh: false } }, leads: {} }, off, id)[0].label).toBe("LLM 요약 요청");
  });

  it("파일은 그 파일과 안에 든 정의 가운데 요약이 없고 만드는 중도 아닌 것을 모두 요청하는 항목이 더해진다", () => {
    const all = inside("pkg.mod");
    expect(all.length).toBeGreaterThan(2);
    const label = (count: number) => `이 파일과 안에 든 정의 모두 요약 (${count}개)`;
    const sorted = (ids: string[]) => [...ids].sort();
    const whole = asksOf(graph, empty, off, "pkg.mod");
    expect(whole.map((ask) => ask.key)).toEqual(["one", "all"]);
    expect(whole[0]).toEqual({ key: "one", label: "LLM 요약 요청", disabled: false, nodes: ["pkg.mod"], refresh: false });
    expect({ ...whole[1], nodes: sorted(whole[1].nodes) }).toEqual({ key: "all", label: label(all.length + 1), disabled: false, nodes: sorted(["pkg.mod", ...all]), refresh: false });

    const defs = asksOf(graph, { states: { "pkg.mod": done }, leads: {} }, off, "pkg.mod");
    expect(defs[0].label).toBe("요약 다시 만들기");
    expect(defs[1]).toEqual({ key: "all", label: label(all.length), disabled: false, nodes: all, refresh: false });

    const file = asksOf(graph, { states: {}, leads: Object.fromEntries(all.map((id) => [id, "요지"])) }, off, "pkg.mod")[1];
    expect(file).toEqual({ key: "all", label: label(1), disabled: false, nodes: ["pkg.mod"], refresh: false });

    const [kept, busy, ...rest] = all;
    const some = asksOf(graph, { states: { "pkg.mod": { phase: "making" }, [busy]: { phase: "making" } }, leads: { [kept]: "요지" } }, off, "pkg.mod");
    expect(some[0].label).toBe("요약 만드는 중");
    expect(some[1]).toEqual({ key: "all", label: label(rest.length), disabled: false, nodes: rest, refresh: false });

    const none = asksOf(graph, { states: { "pkg.mod": done }, leads: Object.fromEntries(all.map((id) => [id, "요지"])) }, off, "pkg.mod")[1];
    expect(none).toEqual({ key: "all", label: label(0), disabled: true, nodes: [], refresh: false });
  });

  it("폴더는 그 아래의 파일 가운데 요약이 없고 만드는 중도 아닌 것을 모두 요청하는 항목 하나만 있다", () => {
    const label = (count: number) => `안에 든 파일 모두 요약 (${count}개)`;
    const files = ["pkg.mod", "pkg.util", "pkg.sub.deep"];
    expect(asksOf(nested, empty, off, "pkg")).toEqual([{ key: "all", label: label(3), disabled: false, nodes: files, refresh: false }]);
    expect(asksOf(nested, empty, off, "pkg.sub")).toEqual([{ key: "all", label: label(1), disabled: false, nodes: ["pkg.sub.deep"], refresh: false }]);

    const defs = Object.fromEntries(nested.nodes.filter((n) => n.id.includes(":")).map((n) => [n.id, "요지"]));
    expect(asksOf(nested, { states: {}, leads: defs }, off, "pkg")[0].nodes).toEqual(files);

    expect(asksOf(nested, { states: { "pkg.mod": done }, leads: {} }, off, "pkg")[0]).toMatchObject({ label: label(2), nodes: ["pkg.util", "pkg.sub.deep"] });
    expect(asksOf(nested, { states: {}, leads: { "pkg.sub.deep": "요지" } }, off, "pkg")[0]).toMatchObject({ label: label(2), nodes: ["pkg.mod", "pkg.util"] });
    expect(asksOf(nested, { states: { "pkg.mod": { phase: "making" } }, leads: {} }, off, "pkg")[0]).toMatchObject({ label: label(2), nodes: ["pkg.util", "pkg.sub.deep"] });
    expect(asksOf(nested, { states: { "pkg.mod": done, "pkg.sub.deep": { phase: "making" } }, leads: { "pkg.util": "요지" } }, off, "pkg")).toEqual([
      { key: "all", label: label(0), disabled: true, nodes: [], refresh: false },
    ]);
  });

  it("토글로 숨긴 파일은 폴더의 대상에 들지 않고, 토글을 켜면 든다", () => {
    expect(nested.nodes.find((n) => n.id === "pkg.conftest")?.test).toBe(true);
    expect(asksOf(nested, empty, off, "pkg")[0].nodes).not.toContain("pkg.conftest");
    const shown = hidden(nested, { showTests: true, showExternal: false });
    expect(asksOf(nested, empty, shown, "pkg")[0]).toMatchObject({ label: "안에 든 파일 모두 요약 (4개)", nodes: ["pkg.mod", "pkg.util", "pkg.conftest", "pkg.sub.deep"] });
  });

  it("외부 노드와 그래프에 없는 id는 항목이 없다", () => {
    const external = graph.nodes.filter((n) => n.kind === "external").map((n) => n.id);
    for (const id of [...external, "없는 노드"]) {
      expect(asksOf(graph, empty, off, id)).toEqual([]);
    }
    expect(external.length).toBeGreaterThan(0);
  });
});
