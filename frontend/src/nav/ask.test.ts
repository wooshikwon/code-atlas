import { describe, expect, it } from "vitest";
import { repoFixture as graph } from "../graph/fixture";
import type { SummaryState } from "../state/summaries";
import { asksOf } from "./ask";

const done: SummaryState = { phase: "done", summary: "요지", available: true, stale: false };
const empty = { states: {}, leads: {} };
/** 파일 id 안에 든 클래스·함수·메서드 */
const inside = (file: string) => graph.nodes.filter((n) => n.id.startsWith(`${file}:`) && n.kind !== "external").map((n) => n.id);

describe("asksOf", () => {
  it("요약이 없으면 요청, 있으면 다시 만들기, 만드는 중이면 누를 수 없는 항목이다", () => {
    const [id] = inside("main");
    expect(asksOf(graph, empty, id)).toEqual([{ key: "one", label: "LLM 요약 요청", disabled: false, nodes: [id], refresh: false }]);
    const again = [{ key: "one", label: "요약 다시 만들기", disabled: false, nodes: [id], refresh: true }];
    expect(asksOf(graph, { states: { [id]: done }, leads: {} }, id)).toEqual(again);
    expect(asksOf(graph, { states: {}, leads: { [id]: "요지" } }, id)).toEqual(again);
    expect(asksOf(graph, { states: { [id]: { phase: "making" } }, leads: { [id]: "요지" } }, id)).toEqual([
      { key: "one", label: "요약 만드는 중", disabled: true, nodes: [], refresh: false },
    ]);
    expect(asksOf(graph, { states: { [id]: { phase: "failed", error: "실패", refresh: false } }, leads: {} }, id)[0].label).toBe("LLM 요약 요청");
  });

  it("파일은 안에 든 정의 가운데 요약이 없고 만드는 중도 아닌 것을 모두 요청하는 항목이 더해지고, 파일 자신은 넣지 않는다", () => {
    const all = inside("pkg.mod");
    expect(all.length).toBeGreaterThan(2);
    const asks = asksOf(graph, { states: { "pkg.mod": done }, leads: {} }, "pkg.mod");
    expect(asks.map((ask) => ask.key)).toEqual(["one", "all"]);
    expect(asks[0].label).toBe("요약 다시 만들기");
    expect(asks[1]).toEqual({ key: "all", label: `안에 든 정의 ${all.length}개 모두 요약`, disabled: false, nodes: all, refresh: false });

    const [kept, busy, ...rest] = all;
    const some = asksOf(graph, { states: { [busy]: { phase: "making" } }, leads: { [kept]: "요지" } }, "pkg.mod")[1];
    expect(some).toEqual({ key: "all", label: `안에 든 정의 ${rest.length}개 모두 요약`, disabled: false, nodes: rest, refresh: false });

    const none = asksOf(graph, { states: {}, leads: Object.fromEntries(all.map((id) => [id, "요지"])) }, "pkg.mod")[1];
    expect(none).toEqual({ key: "all", label: "안에 든 정의 0개 모두 요약", disabled: true, nodes: [], refresh: false });
  });

  it("폴더와 외부 노드, 그래프에 없는 id는 항목이 없다", () => {
    const kinds = (kind: string) => graph.nodes.filter((n) => n.kind === kind).map((n) => n.id);
    for (const id of [...kinds("package"), ...kinds("external"), "없는 노드"]) {
      expect(asksOf(graph, empty, id)).toEqual([]);
    }
    expect(kinds("package").length).toBeGreaterThan(0);
  });
});
