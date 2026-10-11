import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MadeSummary, Summaries, SummaryStatus } from "../api/types";

/** 시험이 끝내는 요청 하나 */
interface Pending<T> {
  node: string;
  refresh?: boolean;
  resolve(value: T): void;
  reject(error: Error): void;
}

const reads: Pending<SummaryStatus>[] = [];
const makes: Pending<MadeSummary>[] = [];

const lists: Pending<Summaries>[] = [];

vi.mock("../api/client", () => ({
  getSummaries: () => new Promise<Summaries>((resolve, reject) => lists.push({ node: "", resolve, reject })),
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
  lists.length = 0;
  useSummaries.setState({ states: {}, leads: {} });
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

describe("leads", () => {
  it("받은 목록으로 요지를 바꾸고, 요약을 읽거나 만들면 그 노드의 요지를 바꾼다", async () => {
    store().list();
    lists[0].resolve({ summaries: [{ node: "a", lead: "옛 요지" }, { node: "b", lead: "b의 요지" }] });
    await settle();
    expect(store().leads).toEqual({ a: "옛 요지", b: "b의 요지" });
    store().make("a", true);
    makes[0].resolve({ summary: "새 요지\n\n하는 일\n문단\n\n앞뒤 흐름\n문단" });
    store().read("c");
    reads[0].resolve({ summary: "c의 요지\n\n하는 일\n문단", stale: true, available: true, reason: null });
    await settle();
    expect(store().leads).toEqual({ a: "새 요지", b: "b의 요지", c: "c의 요지" });
  });

  it("목록을 받는 동안 만든 요약의 요지는 늦게 온 목록이 덮지 않고, 목록에 없는 노드의 요지는 지운다", async () => {
    useSummaries.setState({ leads: { a: "옛 요지", gone: "지워진 노드의 요지" } });
    store().list();
    store().make("a", true);
    makes[0].resolve({ summary: "새 요지" });
    await settle();
    lists[0].resolve({ summaries: [{ node: "a", lead: "옛 요지" }] });
    await settle();
    expect(store().leads).toEqual({ a: "새 요지" });
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
