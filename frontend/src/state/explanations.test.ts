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

const { noteKey, useExplanations } = await import("./explanations");

const store = () => useExplanations.getState();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const done = (start: number, end: number, text: string, stale = false) => ({ start, end, state: { phase: "done", text, stale } });

// 읽은 파일은 저장소가 기억하므로 load 시험은 시험마다 다른 파일을 쓴다.
beforeEach(() => {
  lists.length = 0;
  makes.length = 0;
  deletes.length = 0;
  useExplanations.setState({ files: {} });
});

describe("load", () => {
  it("파일마다 한 번만 읽어 저장해 둔 설명을 시작 줄 순서로 담는다", async () => {
    store().load("a.py");
    store().load("a.py");
    expect(lists.map((l) => l.args)).toEqual([["a.py"]]);
    lists[0].resolve({
      explanations: [
        { start: 9, end: 12, text: "뒤", stale: true },
        { start: 2, end: 4, text: "앞", stale: false },
      ],
    });
    await settle();
    expect(store().files["a.py"]).toEqual([done(2, 4, "앞"), done(9, 12, "뒤", true)]);
  });

  it("읽는 동안 만들기 시작한 범위는 읽은 값으로 덮지 않고, 읽기에 실패한 파일은 다시 읽는다", async () => {
    store().load("c.py");
    store().make("c.py", 2, 4, true);
    lists[0].resolve({ explanations: [{ start: 2, end: 4, text: "옛 설명", stale: true }] });
    await settle();
    expect(store().files["c.py"]).toEqual([{ start: 2, end: 4, state: { phase: "making" } }]);

    store().load("d.py");
    lists[1].reject(new Error("HTTP 500"));
    await settle();
    store().load("d.py");
    expect(lists).toHaveLength(3);
  });
});

describe("make, remove", () => {
  it("만드는 중인 범위에는 요청을 다시 보내지 않고, 끝나면 설명을 담는다", async () => {
    store().make("a.py", 2, 4, false);
    store().make("a.py", 2, 4, false);
    store().make("a.py", 1, 1, false);
    expect(makes.map((m) => m.args)).toEqual([
      ["a.py", 2, 4, false],
      ["a.py", 1, 1, false],
    ]);
    expect(store().files["a.py"].map(noteKey)).toEqual(["1-1", "2-4"]);
    makes[0].resolve({ start: 2, end: 4, text: "설명", stale: false });
    makes[1].reject(new Error("Claude Code CLI가 120초 안에 응답하지 않았다"));
    await settle();
    expect(store().files["a.py"]).toEqual([
      { start: 1, end: 1, state: { phase: "failed", error: "Claude Code CLI가 120초 안에 응답하지 않았다", refresh: false } },
      done(2, 4, "설명"),
    ]);
  });

  it("지우면 목록에서 빼고 서버에도 지우게 한다", async () => {
    store().make("a.py", 2, 4, false);
    makes[0].resolve({ start: 2, end: 4, text: "설명", stale: false });
    await settle();
    store().remove("a.py", 2, 4);
    expect(store().files["a.py"]).toEqual([]);
    expect(deletes).toEqual([["a.py", 2, 4]]);
  });
});
