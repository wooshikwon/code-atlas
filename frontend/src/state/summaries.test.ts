import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MadeSummary, SummaryStatus } from "../api/types";

/** 시험이 끝내는 요청 하나 */
interface Pending<T> {
  node: string;
  refresh?: boolean;
  resolve(value: T): void;
  reject(error: Error): void;
}

const reads: Pending<SummaryStatus>[] = [];
const makes: Pending<MadeSummary>[] = [];

vi.mock("../api/client", () => ({
  getSummary: (node: string) => new Promise<SummaryStatus>((resolve, reject) => reads.push({ node, resolve, reject })),
  makeSummary: (node: string, refresh: boolean) =>
    new Promise<MadeSummary>((resolve, reject) => makes.push({ node, refresh, resolve, reject })),
}));

const { makingKey, makingOf, useSummaries } = await import("./summaries");

const store = () => useSummaries.getState();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  reads.length = 0;
  makes.length = 0;
  useSummaries.setState({ states: {} });
});

describe("read", () => {
  it("캐시에 요약이 있으면 done, 없으면 empty, CLI를 부를 수 없으면 unavailable이다", async () => {
    for (const node of ["a", "b", "c"]) {
      store().read(node);
    }
    expect(store().states.a).toEqual({ phase: "reading" });
    reads[0].resolve({ summary: "요지", stale: true, available: true, reason: null });
    reads[1].resolve({ summary: null, stale: false, available: true, reason: null });
    reads[2].resolve({ summary: null, stale: false, available: false, reason: "Claude Code CLI를 찾지 못했다" });
    await settle();
    expect(store().states).toEqual({
      a: { phase: "done", summary: "요지", available: true, stale: true },
      b: { phase: "empty" },
      c: { phase: "unavailable", reason: "Claude Code CLI를 찾지 못했다" },
    });
  });

  it("읽는 중이거나 만드는 중이거나 결과가 있는 노드는 다시 읽지 않고, 요약이 없는 노드는 다시 읽는다", async () => {
    store().read("a");
    store().read("a");
    expect(reads).toHaveLength(1);
    reads[0].resolve({ summary: null, stale: false, available: true, reason: null });
    await settle();
    store().read("a");
    expect(reads).toHaveLength(2);
    store().make("a", false);
    store().read("a");
    makes[0].reject(new Error("Claude Code CLI가 120초 안에 응답하지 않았다"));
    await settle();
    store().read("a");
    expect(reads).toHaveLength(2);
    expect(store().states.a).toEqual({ phase: "failed", error: "Claude Code CLI가 120초 안에 응답하지 않았다", refresh: false });
  });
});

describe("make", () => {
  it("만드는 중인 노드에는 요청을 다시 보내지 않고, 끝나면 요약을 담는다", async () => {
    store().make("a", false);
    store().make("a", true);
    expect(makes.map((m) => [m.node, m.refresh])).toEqual([["a", false]]);
    expect(store().states.a).toEqual({ phase: "making" });
    makes[0].resolve({ summary: "요지" });
    await settle();
    expect(store().states.a).toEqual({ phase: "done", summary: "요지", available: true, stale: false });
    store().make("a", true);
    expect(makes).toHaveLength(2);
  });

  it("만드는 동안 늦게 온 읽기 응답은 만드는 중 상태를 덮지 않는다", async () => {
    store().read("a");
    store().make("a", false);
    reads[0].resolve({ summary: null, stale: false, available: true, reason: null });
    await settle();
    expect(store().states.a).toEqual({ phase: "making" });
  });
});

describe("makingKey", () => {
  it("만드는 중인 노드 id만 정렬해 잇고 makingOf가 다시 나눈다", () => {
    expect(makingOf(makingKey(store()))).toEqual([]);
    store().make("b", false);
    store().make("a", false);
    store().read("c");
    expect(makingOf(makingKey(store()))).toEqual(["a", "b"]);
  });
});
