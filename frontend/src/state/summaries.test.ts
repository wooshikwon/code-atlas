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

const { makingKey, makingOf, MAX_REQUESTS, useSummaries } = await import("./summaries");

const store = () => useSummaries.getState();
const IDLE = { total: 0, ended: 0, failed: 0, held: false, cancelled: false, usage: null };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  reads.length = 0;
  makes.length = 0;
  lists.length = 0;
  useSummaries.setState({ states: {}, leads: {}, waiting: [], sent: 0, batch: IDLE });
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
      a: { phase: "done", summary: "요지", available: true, stale: true, usage: null },
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
    makes[0].resolve({ summary: "요지", usage: null });
    await settle();
    expect(store().states.a).toEqual({ phase: "done", summary: "요지", available: true, stale: false, usage: null });
    store().make("a", true);
    expect(makes).toHaveLength(2);
  });

  it("요청이 여럿이면 서버로 MAX_REQUESTS개만 보내고, 하나가 끝나거나 실패할 때마다 기다리던 요청을 차례로 보낸다", async () => {
    const nodes = ["a", "b", "c", "d"];
    for (const node of nodes) {
      store().make(node, node === "d");
    }
    expect(MAX_REQUESTS).toBe(2);
    expect(makes.map((m) => m.node)).toEqual(["a", "b"]);
    expect(nodes.map((node) => store().states[node].phase)).toEqual(["making", "making", "making", "making"]);
    store().make("c", false);
    expect(store().waiting.map((w) => w.node)).toEqual(["c", "d"]);
    makes[1].resolve({ summary: "b의 요지", usage: null });
    await settle();
    expect(makes.map((m) => [m.node, m.refresh])).toEqual([["a", false], ["b", false], ["c", false]]);
    makes[0].reject(new Error("실패"));
    await settle();
    expect(makes.map((m) => [m.node, m.refresh]).at(-1)).toEqual(["d", true]);
    expect(nodes.map((node) => store().states[node].phase)).toEqual(["failed", "done", "making", "making"]);
    makes[2].resolve({ summary: "c의 요지", usage: null });
    makes[3].resolve({ summary: "d의 요지", usage: null });
    await settle();
    expect(store().sent).toBe(0);
    expect(store().leads).toEqual({ b: "b의 요지", c: "c의 요지", d: "d의 요지" });
  });

  it("만드는 동안 늦게 온 읽기 응답은 만드는 중 상태를 덮지 않는다", async () => {
    store().read("a");
    store().make("a", false);
    reads[0].resolve({ summary: null, stale: false, available: true, reason: null });
    await settle();
    expect(store().states.a).toEqual({ phase: "making" });
  });
});

describe("batch", () => {
  it("묶음이 시작된 뒤 요청한 수와 끝난 수, 만들지 못한 수를 세고, 요청이 모두 끝나면 0으로 돌아간다", async () => {
    for (const node of ["a", "b", "c", "d"]) {
      store().make(node, false);
    }
    expect(store().batch).toEqual({ total: 4, ended: 0, failed: 0, held: true, cancelled: false, usage: null });
    makes[0].resolve({ summary: "a의 요지", usage: null });
    makes[1].reject(new Error("실패"));
    await settle();
    expect(store().batch).toEqual({ total: 4, ended: 2, failed: 1, held: true, cancelled: false, usage: null });
    store().make("e", false);
    expect(store().batch).toEqual({ total: 5, ended: 2, failed: 1, held: true, cancelled: false, usage: null });
    for (const index of [2, 3]) {
      makes[index].resolve({ summary: "요지", usage: null });
    }
    await settle();
    expect(store().batch).toEqual({ total: 5, ended: 4, failed: 1, held: true, cancelled: false, usage: null });
    makes[4].resolve({ summary: "요지", usage: null });
    await settle();
    expect(store().batch).toEqual(IDLE);
  });

  it("끝난 요청의 사용량을 더하고, 사용량이 없는 응답과 실패는 더하지 않으며, 취소해도 합을 그대로 두고 묶음이 끝나면 버린다", async () => {
    for (const node of ["a", "b", "c", "d", "e"]) {
      store().make(node, false);
    }
    makes[0].resolve({ summary: "a의 요지", usage: null });
    await settle();
    expect(store().batch.usage).toBeNull();
    makes[1].resolve({ summary: "b의 요지", usage: { input: 2, cache_write: 1487, cache_read: 16411, output: 527 } });
    makes[2].reject(new Error("실패"));
    await settle();
    expect(store().batch.usage).toEqual({ input: 2, cache_write: 1487, cache_read: 16411, output: 527 });
    expect(store().states.b).toEqual({ phase: "done", summary: "b의 요지", available: true, stale: false, usage: { input: 2, cache_write: 1487, cache_read: 16411, output: 527 } });
    store().cancel();
    expect(store().batch).toEqual({ total: 2, ended: 0, failed: 0, held: true, cancelled: true, usage: { input: 2, cache_write: 1487, cache_read: 16411, output: 527 } });
    makes[3].resolve({ summary: "d의 요지", usage: { input: 3, cache_write: 2990, cache_read: 16411, output: 1100 } });
    await settle();
    expect(store().batch.usage).toEqual({ input: 5, cache_write: 4477, cache_read: 32822, output: 1627 });
    makes[4].resolve({ summary: "e의 요지", usage: null });
    await settle();
    expect(store().batch).toEqual(IDLE);
  });

  it("차례를 기다린 요청이 없는 묶음은 held가 거짓이다", async () => {
    store().make("a", false);
    store().make("b", false);
    expect(store().batch).toEqual({ total: 2, ended: 0, failed: 0, held: false, cancelled: false, usage: null });
    makes[0].resolve({ summary: "요지", usage: null });
    await settle();
    store().make("c", false);
    expect(store().batch).toEqual({ total: 3, ended: 1, failed: 0, held: false, cancelled: false, usage: null });
    store().make("d", false);
    expect(store().batch.held).toBe(true);
  });
});

describe("cancel", () => {
  it("차례를 기다리는 요청만 빼고, 뺀 노드의 요약 상태는 요청하기 전으로 돌아가며, 보낸 요청은 끝까지 간다", async () => {
    const kept = { phase: "done" as const, summary: "옛 요지", available: true, stale: true, usage: null };
    useSummaries.setState({ states: { c: kept, e: { phase: "empty" } }, leads: { c: "옛 요지" } });
    store().read("f");
    for (const node of ["a", "b", "c", "d", "e", "f"]) {
      store().make(node, node === "c");
    }
    expect(makes.map((m) => m.node)).toEqual(["a", "b"]);
    expect(makingOf(makingKey(store()))).toEqual(["a", "b", "c", "d", "e", "f"]);
    store().cancel();
    expect(store().waiting).toEqual([]);
    expect(store().states).toEqual({ a: { phase: "making" }, b: { phase: "making" }, c: kept, e: { phase: "empty" } });
    expect(store().leads).toEqual({ c: "옛 요지" });
    expect(store().batch).toEqual({ total: 2, ended: 0, failed: 0, held: true, cancelled: true, usage: null });
    makes[0].resolve({ summary: "a의 요지", usage: null });
    await settle();
    expect(store().batch).toEqual({ total: 2, ended: 1, failed: 0, held: true, cancelled: true, usage: null });
    makes[1].reject(new Error("실패"));
    await settle();
    expect(makes).toHaveLength(2);
    expect(store().states.a).toMatchObject({ phase: "done" });
    expect(store().states.b).toMatchObject({ phase: "failed" });
    expect(store().sent).toBe(0);
    expect(store().batch).toEqual(IDLE);
  });

  it("취소한 노드는 다시 요청하면 대기열에 들어가고, 읽어 둔 요약을 버린 뒤에 취소하면 읽지 않은 노드로 돌아간다", async () => {
    useSummaries.setState({ states: { c: { phase: "empty" } } });
    for (const node of ["a", "b", "c"]) {
      store().make(node, false);
    }
    store().forget();
    store().cancel();
    expect(store().states).toEqual({ a: { phase: "making" }, b: { phase: "making" } });
    store().make("c", false);
    expect(store().waiting.map((w) => w.node)).toEqual(["c"]);
    expect(store().batch).toEqual({ total: 3, ended: 0, failed: 0, held: true, cancelled: true, usage: null });
  });
});

describe("leads", () => {
  it("받은 목록으로 요지를 바꾸고, 요약을 읽거나 만들면 그 노드의 요지를 바꾼다", async () => {
    store().list();
    lists[0].resolve({ summaries: [{ node: "a", lead: "옛 요지" }, { node: "b", lead: "b의 요지" }] });
    await settle();
    expect(store().leads).toEqual({ a: "옛 요지", b: "b의 요지" });
    store().make("a", true);
    makes[0].resolve({ summary: "새 요지\n\n하는 일\n문단\n\n앞뒤 흐름\n문단", usage: null });
    store().read("c");
    reads[0].resolve({ summary: "c의 요지\n\n하는 일\n문단", stale: true, available: true, reason: null });
    await settle();
    expect(store().leads).toEqual({ a: "새 요지", b: "b의 요지", c: "c의 요지" });
  });

  it("목록을 받는 동안 만든 요약의 요지는 늦게 온 목록이 덮지 않고, 목록에 없는 노드의 요지는 지운다", async () => {
    useSummaries.setState({ leads: { a: "옛 요지", gone: "지워진 노드의 요지" } });
    store().list();
    store().make("a", true);
    makes[0].resolve({ summary: "새 요지", usage: null });
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
