import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Explanation, Explanations } from "../api/types";

interface Pending<T> {
  args: unknown[];
  resolve(value: T): void;
  reject(error: Error): void;
}

const lists: Pending<Explanations>[] = [];
const makes: Pending<Explanation>[] = [];
const deletes: unknown[][] = [];
const pending = <T>(into: Pending<T>[], args: unknown[]) => new Promise<T>((resolve, reject) => into.push({ args, resolve, reject }));

vi.mock("../api/client", () => ({
  getExplanations: (...args: unknown[]) => pending(lists, args),
  makeExplanation: (...args: unknown[]) => pending(makes, args),
  deleteExplanation: (...args: unknown[]) => {
    deletes.push(args);
    return Promise.resolve({ deleted: true });
  },
}));

const { noteKey, scopeKey, useExplanations } = await import("./explanations");

const store = () => useExplanations.getState();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const done = (start: number, end: number, text: string, stale = false, question = "") => ({ start, end, question, state: { phase: "done", text, stale, usage: null } });

// 읽은 파일은 저장소가 기억하므로 load 시험은 시험마다 다른 파일을 쓴다.
beforeEach(() => {
  lists.length = 0;
  makes.length = 0;
  deletes.length = 0;
  useExplanations.setState({ files: {} });
});

describe("load", () => {
  it("파일마다 한 번만 읽어 저장해 둔 분석을 시작 줄 순서로 담고, 같은 범위의 분석은 받은 순서로 둔다", async () => {
    store().load("a.py");
    store().load("a.py");
    expect(lists.map((l) => l.args)).toEqual([["a.py"]]);
    lists[0].resolve({
      explanations: [
        { start: 9, end: 12, question: "", text: "뒤", stale: true },
        { start: 2, end: 4, question: "", text: "앞", stale: false },
        { start: 2, end: 4, question: "왜?", text: "답", stale: false },
      ],
    });
    await settle();
    expect(store().files["a.py"]).toEqual([done(2, 4, "앞"), done(2, 4, "답", false, "왜?"), done(9, 12, "뒤", true)]);
  });

  it("읽는 동안 만들기 시작한 분석은 읽은 값으로 덮지 않고, 읽기에 실패한 파일은 다시 읽는다", async () => {
    store().load("c.py");
    store().make("c.py", 2, 4, true, "");
    lists[0].resolve({ explanations: [{ start: 2, end: 4, question: "", text: "옛 설명", stale: true }] });
    await settle();
    expect(store().files["c.py"]).toEqual([{ start: 2, end: 4, question: "", state: { phase: "making" } }]);

    store().load("d.py");
    lists[1].reject(new Error("HTTP 500"));
    await settle();
    store().load("d.py");
    expect(lists).toHaveLength(3);
  });
});

describe("make, remove", () => {
  it("만드는 중인 분석에는 요청을 다시 보내지 않고, 끝나면 분석과 사용량을 담는다", async () => {
    store().make("a.py", 2, 4, false, "");
    store().make("a.py", 2, 4, false, "");
    store().make("a.py", 1, 1, false, "");
    expect(makes.map((m) => m.args)).toEqual([
      ["a.py", 2, 4, false, ""],
      ["a.py", 1, 1, false, ""],
    ]);
    expect(store().files["a.py"].map(noteKey)).toEqual(["1-1|", "2-4|"]);
    const usage = { input: 10, cache_write: 0, cache_read: 5, output: 3 };
    makes[0].resolve({ start: 2, end: 4, question: "", text: "설명", stale: false, usage });
    makes[1].reject(new Error("Claude Code CLI가 120초 안에 응답하지 않았습니다"));
    await settle();
    expect(store().files["a.py"]).toEqual([
      { start: 1, end: 1, question: "", state: { phase: "failed", error: "Claude Code CLI가 120초 안에 응답하지 않았습니다", refresh: false } },
      { start: 2, end: 4, question: "", state: { phase: "done", text: "설명", stale: false, usage } },
    ]);
  });

  it("같은 범위에 질문이 다르면 다른 분석이고 만든 순서로 쌓인다", async () => {
    store().make("a.py", 2, 4, false, "왜 None을 넘기나?");
    store().make("a.py", 2, 4, false, "");
    store().make("a.py", 2, 4, false, "왜 None을 넘기나?");
    store().make("a.py", 1, 1, false, "뭘 하나?");
    expect(makes.map((m) => m.args)).toEqual([
      ["a.py", 2, 4, false, "왜 None을 넘기나?"],
      ["a.py", 2, 4, false, ""],
      ["a.py", 1, 1, false, "뭘 하나?"],
    ]);
    expect(store().files["a.py"].map((note) => [note.start, note.question])).toEqual([[1, "뭘 하나?"], [2, "왜 None을 넘기나?"], [2, ""]]);
    makes[1].resolve({ start: 2, end: 4, question: "", text: "설명", stale: false });
    await settle();
    // 다시 만들어도 쌓인 순서는 그대로다.
    store().make("a.py", 2, 4, true, "왜 None을 넘기나?");
    expect(store().files["a.py"].map((note) => [note.question, note.state.phase])).toEqual([["뭘 하나?", "making"], ["왜 None을 넘기나?", "making"], ["", "done"]]);
  });

  it("지우면 그 질문의 분석만 목록에서 빼고 서버에도 지우게 한다", async () => {
    store().make("a.py", 2, 4, false, "");
    store().make("a.py", 2, 4, false, "왜?");
    makes[0].resolve({ start: 2, end: 4, question: "", text: "설명", stale: false });
    await settle();
    store().remove("a.py", 2, 4, "왜?");
    expect(store().files["a.py"]).toEqual([done(2, 4, "설명")]);
    expect(deletes).toEqual([["a.py", 2, 4, "왜?"]]);
  });
});

describe("두 시점의 비교에 묶은 분석", () => {
  const between = { base: "a".repeat(40), target: "worktree" };
  const old = { ...between, start: 7, end: 8 };
  const sha256 = async (code: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  it("삭제된 줄이 든 범위는 비교의 열쇠에 담고 표시 붙은 본문과 기준 시점의 줄을 함께 보낸다", async () => {
    const marked = { code: "-a\n+b", old };
    store().make("a.py", 3, 3, false, "왜 바꿨나?", marked);
    store().make("a.py", 3, 4, false, "", { code: "+b\n c", old: null });
    expect(makes.map((m) => m.args)).toEqual([
      ["a.py", 3, 3, false, "왜 바꿨나?", marked],
      ["a.py", 3, 4, false, "", { code: "+b\n c", old: null }],
    ]);
    const key = scopeKey("a.py", between);
    expect(store().files[key]).toEqual([{ start: 3, end: 3, old: [7, 8], question: "왜 바꿨나?", state: { phase: "making" } }]);
    expect(store().files["a.py"].map(noteKey)).toEqual(["3-4|"]);
    expect(noteKey(store().files[key][0])).toBe("3-3:7-8|왜 바꿨나?");

    store().remove("a.py", 3, 3, "왜 바꿨나?", old);
    expect(store().files[key]).toEqual([]);
    expect(deletes).toEqual([["a.py", 3, 3, "왜 바꿨나?", old]]);
  });

  it("비교에 묶은 분석을 따로 읽고, 지금의 표시 붙은 본문이 만든 때와 다르거나 범위가 없으면 stale로 담는다", async () => {
    store().load("e.py", between, (note) => (note.old[0] === 9 ? null : "-a\n+b"));
    expect(lists.map((l) => l.args)).toEqual([["e.py", between]]);
    lists[0].resolve({
      explanations: [],
      compared: [
        { start: 3, end: 3, old_start: 7, old_end: 8, question: "", text: "같은 본문", digest: await sha256("-a\n+b") },
        { start: 0, end: 0, old_start: 5, old_end: 5, question: "왜?", text: "달라진 본문", digest: await sha256("-x") },
        { start: 0, end: 0, old_start: 9, old_end: 9, question: "", text: "없는 범위", digest: await sha256("-a\n+b") },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const kept = (start: number, at: [number, number], question: string, text: string, stale: boolean) => ({ start, end: start, old: at, question, state: { phase: "done", text, stale, usage: null } });
    expect(store().files[scopeKey("e.py", between)]).toEqual([
      kept(0, [5, 5], "왜?", "달라진 본문", true),
      kept(3, [7, 8], "", "같은 본문", false),
      kept(0, [9, 9], "", "없는 범위", true),
    ]);
    expect(store().files["e.py"]).toBeUndefined();
  });
});
