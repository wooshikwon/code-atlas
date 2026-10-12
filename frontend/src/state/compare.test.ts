import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetFiles, getGraph, getHistory, getRepo, getStat, getSummaries, getTree, getUnused, postCompare } from "../api/client";
import { WORKTREE, type Commit, type Comparison, type History, type Stat } from "../api/types";
import { compareFixture, repoFixture } from "../graph/fixture";
import { firstPicks, parseSize, useCompare } from "./compare";
import { useOverlay } from "./overlay";
import { useAtlas, type AtlasStore } from "./store";

vi.mock("../api/client", () => ({
  forgetFiles: vi.fn(),
  getSummaries: vi.fn(),
  getGraph: vi.fn(),
  getHistory: vi.fn(),
  getRepo: vi.fn(),
  getStat: vi.fn(),
  getTree: vi.fn(),
  getUnused: vi.fn(),
  postCompare: vi.fn(),
}));

const commit = (hash: string, ...parents: string[]): Commit => ({ hash, parents, time: 0, subject: hash, refs: [] });
const history = (extra: Partial<History> = {}): History => ({
  git: true,
  head: "c",
  branch: "work",
  default: "a",
  dirty: false,
  commits: [commit("c", "b"), commit("b", "a"), commit("a")],
  more: false,
  ...extra,
});
const stat = (base: string, target: string, extra: Partial<Stat> = {}): Stat => ({ base, target, fork: null, files: 6, added: 13, deleted: 21, ...extra });

const repo = { name: "repo", root: "/repo", source_root: "", python: null, stats: {} } as unknown as NonNullable<AtlasStore["repo"]>;
const tree = { entries: [] };
const store = () => useCompare.getState();
const atlas = () => useAtlas.getState();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 끝낼 때를 시험이 정하는 응답 */
function held<T>() {
  let release!: (value: T) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

beforeEach(() => {
  useCompare.setState(useCompare.getInitialState(), true);
  useOverlay.setState(useOverlay.getInitialState(), true);
  useAtlas.setState({ ...useAtlas.getInitialState(), repo, graph: repoFixture, tree }, true);
  vi.resetAllMocks();
  vi.mocked(getHistory).mockResolvedValue(history());
  vi.mocked(getStat).mockImplementation(async (a, b) => stat(a, b));
  vi.mocked(postCompare).mockResolvedValue(compareFixture);
  vi.mocked(getRepo).mockResolvedValue(repo);
  vi.mocked(getGraph).mockResolvedValue(repoFixture);
  vi.mocked(getTree).mockResolvedValue(tree);
  vi.mocked(getUnused).mockResolvedValue({ definitions: 12, candidates: [] });
  vi.mocked(getSummaries).mockResolvedValue({ summaries: [] });
});

afterEach(async () => {
  await store().clear();
  vi.unstubAllGlobals();
});

describe("firstPicks", () => {
  it("커밋하지 않은 변경이 있으면 지금 커밋과 작업 중인 상태를 고른다", () => {
    expect(firstPicks(history({ dirty: true }))).toEqual(["c", WORKTREE]);
  });

  it("변경이 없으면 기본 브랜치의 커밋과 지금 커밋을 고른다", () => {
    expect(firstPicks(history())).toEqual(["a", "c"]);
  });

  it("두 값이 같거나 기본 브랜치가 없으면 지금 커밋과 그 첫째 부모를 고른다", () => {
    expect(firstPicks(history({ default: "c" }))).toEqual(["b", "c"]);
    expect(firstPicks(history({ default: null }))).toEqual(["b", "c"]);
    expect(firstPicks(history({ default: "m", head: "m", commits: [commit("m", "c", "f"), commit("f"), commit("c")] }))).toEqual(["c", "m"]);
  });

  it("부모가 없으면 지금 커밋 하나만 고르고, 커밋이 없으면 고르지 않는다", () => {
    expect(firstPicks(history({ default: "a", head: "a", commits: [commit("a")] }))).toEqual(["a"]);
    expect(firstPicks(history({ git: false, head: null, default: null, commits: [] }))).toEqual([]);
  });
});

describe("toggle", () => {
  it("처음 펴면 커밋 그래프의 첫 묶음을 받아 줄을 골라 두고 두 줄의 줄 수를 받는다", async () => {
    store().toggle();
    expect(store().open).toBe(true);
    await settle();
    expect(getHistory).toHaveBeenCalledWith(0, 200);
    expect(store().history).toEqual(history());
    expect(store().picks).toEqual(["a", "c"]);
    expect(store().stat).toEqual(stat("a", "c"));
  });

  it("다시 펴면 커밋 그래프를 다시 받고 고른 줄은 그대로 둔다", async () => {
    store().toggle();
    await settle();
    store().pick("b");
    store().toggle();
    expect(store().open).toBe(false);
    vi.mocked(getHistory).mockResolvedValue(history({ head: "d", commits: [commit("d", "c"), ...history().commits] }));
    store().toggle();
    await settle();
    expect(store().history?.commits).toHaveLength(4);
    expect(store().picks).toEqual(["c", "b"]);
  });

  it("커밋이 하나뿐이면 한 줄만 고르고 줄 수를 받지 않는다", async () => {
    vi.mocked(getHistory).mockResolvedValue(history({ default: "a", head: "a", commits: [commit("a")] }));
    store().toggle();
    await settle();
    expect(store().picks).toEqual(["a"]);
    expect(getStat).not.toHaveBeenCalled();
    expect(store().stat).toBeNull();
  });

  it("받지 못하면 까닭을 적고 다음에 펼 때 줄을 골라 둔다", async () => {
    vi.mocked(getHistory).mockRejectedValueOnce(new Error("연결 끊김"));
    store().toggle();
    await settle();
    expect([store().error, store().history, store().picks]).toEqual(["연결 끊김", null, []]);
    store().toggle();
    store().toggle();
    await settle();
    expect(store().picks).toEqual(["a", "c"]);
  });
});

describe("extend", () => {
  it("받은 줄 수부터 다음 묶음을 받아 잇는다", async () => {
    vi.mocked(getHistory).mockResolvedValue(history({ more: true }));
    store().toggle();
    await settle();
    vi.mocked(getHistory).mockResolvedValue(history({ commits: [commit("a"), commit("z")], more: false }));
    await Promise.all([store().extend(), store().extend()]);
    expect(getHistory).toHaveBeenLastCalledWith(3, 200);
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(store().history?.commits.map((c) => c.hash)).toEqual(["c", "b", "a", "z"]);
    expect(store().history?.more).toBe(false);
    await store().extend();
    expect(getHistory).toHaveBeenCalledTimes(2);
  });
});

describe("pick", () => {
  beforeEach(async () => {
    store().toggle();
    await settle();
    vi.mocked(getStat).mockClear();
  });

  it("고른 줄을 다시 누르면 풀리고 줄 수가 없어진다", () => {
    store().pick("c");
    expect(store().picks).toEqual(["a"]);
    expect(store().stat).toBeNull();
    expect(getStat).not.toHaveBeenCalled();
  });

  it("두 줄을 고른 채 셋째 줄을 누르면 먼저 고른 줄이 빠진다", async () => {
    store().pick("b");
    expect(store().picks).toEqual(["c", "b"]);
    expect(store().stat).toBeNull();
    await settle();
    expect(store().stat).toEqual(stat("c", "b"));
    store().pick(WORKTREE);
    expect(store().picks).toEqual(["b", WORKTREE]);
  });

  it("한 줄을 고른 채 다른 줄을 누르면 두 줄이 되고 줄 수를 받는다", async () => {
    store().pick("a");
    store().pick("b");
    expect(store().picks).toEqual(["c", "b"]);
    await settle();
    expect(getStat).toHaveBeenCalledTimes(1);
    expect(getStat).toHaveBeenCalledWith("c", "b");
  });

  it("늦게 도착한 앞의 줄 수를 담지 않는다", async () => {
    const slow = held<Stat>();
    vi.mocked(getStat).mockReturnValueOnce(slow.promise);
    store().pick("b");
    store().pick(WORKTREE);
    await settle();
    slow.release(stat("c", "b", { files: 99 }));
    await settle();
    expect(store().stat).toEqual(stat("b", WORKTREE));
  });
});

describe("confirm과 clear", () => {
  const pin = async () => {
    store().toggle();
    await settle();
  };

  it("두 줄을 고르지 않았으면 아무것도 받지 않는다", async () => {
    await store().confirm();
    expect(postCompare).not.toHaveBeenCalled();
    expect(store().running).toBe(false);
  });

  it("창을 닫고 분석하는 동안 그래프를 그대로 두고, 받으면 그래프와 파일트리를 바꾸고 분석 표시를 compare로 켠다", async () => {
    await pin();
    vi.mocked(getStat).mockResolvedValue(stat("f", "c", { fork: "f" }));
    store().pick("a");
    store().pick("x");
    await settle();
    const answer = held<Comparison>();
    vi.mocked(postCompare).mockReturnValue(answer.promise);
    useOverlay.getState().set("cycles");
    const done = store().confirm();
    expect([store().open, store().running]).toEqual([false, true]);
    expect(atlas().graph).toBe(repoFixture);
    answer.release(compareFixture);
    await done;
    expect(postCompare).toHaveBeenCalledWith("f", "c");
    expect(store().running).toBe(false);
    expect(store().result).toBe(compareFixture);
    expect(store().shown).toEqual({ base: compareFixture.base, target: compareFixture.target, fork: "f", files: 6, added: 13, deleted: 21 });
    expect(store().chosen).toBe("x");
    expect([atlas().graph, atlas().tree]).toEqual([compareFixture.graph, compareFixture.tree]);
    expect(useOverlay.getState().kind).toBe("compare");
    expect(useOverlay.getState().unused).toEqual(new Set(["scratch:todo"]));
  });

  it("켰다 끄면 그래프와 파일트리, 선택과 접은 폴더가 켜기 전과 같다", async () => {
    atlas().toggleFolder("app");
    atlas().select("main:run");
    const before = atlas();
    await pin();
    await store().confirm();
    expect(atlas().selection).toBe(before.selection);
    await store().clear();
    expect(getGraph).toHaveBeenCalledTimes(1);
    expect([store().result, store().shown, store().chosen]).toEqual([null, null, null]);
    expect([atlas().graph, atlas().tree]).toEqual([before.graph, before.tree]);
    expect([atlas().selection, atlas().collapsed, atlas().history]).toEqual([before.selection, before.collapsed, before.history]);
    expect(useOverlay.getState().kind).toBeNull();
    expect(useOverlay.getState().unused).toEqual(new Set());
  });

  it("삭제된 노드를 고른 채 끄면 선택이 풀린다", async () => {
    await pin();
    await store().confirm();
    atlas().select("pkg.mod:drop");
    expect(atlas().selection).toEqual({ type: "node", id: "pkg.mod:drop" });
    await store().clear();
    expect(atlas().selection).toBeNull();
  });

  it("비교가 켜져 있는 동안 삭제된 선과 노드를 지나는 경로를 찾지 않고, 끈 뒤에도 출발과 도착이 남는다", async () => {
    await pin();
    await store().confirm();
    atlas().setEnd("from", "cli:main");
    atlas().setEnd("to", "main:helper");
    expect(atlas().finder.route?.paths).toEqual([
      ["cli:main", "main:run", "main:helper"],
      ["cli:main", "main:run", "pkg.mod:Store.load", "pkg.mod:Store.save", "main:helper"],
    ]);
    await store().clear();
    expect([atlas().finder.from, atlas().finder.to]).toEqual(["cli:main", "main:helper"]);
  });

  it("경로의 끝이 삭제된 노드인 비교를 받으면 그 칸을 비운다", async () => {
    useAtlas.setState({ graph: compareFixture.graph });
    atlas().setEnd("from", "pkg.mod:Store.save");
    atlas().setEnd("to", "pkg.mod:drop");
    expect(atlas().finder.route?.paths).toHaveLength(1);
    await pin();
    await store().confirm();
    expect([atlas().finder.from, atlas().finder.to, atlas().finder.route]).toEqual(["pkg.mod:Store.save", null, null]);
  });

  it("다른 분석 표시를 켜면 비교가 꺼진다", async () => {
    await pin();
    await store().confirm();
    useOverlay.getState().set("unused");
    await settle();
    expect(store().result).toBeNull();
    expect(atlas().graph).toBe(repoFixture);
    expect(useOverlay.getState().kind).toBe("unused");
  });

  it("분석하지 못하면 까닭을 적고 그래프와 분석 표시를 그대로 둔다", async () => {
    await pin();
    vi.mocked(postCompare).mockRejectedValue(new Error("꺼내지 못했다"));
    await store().confirm();
    expect([store().running, store().error, store().result]).toEqual([false, "꺼내지 못했다", null]);
    expect(atlas().graph).toBe(repoFixture);
    expect(useOverlay.getState().kind).toBeNull();
  });

  it("분석하는 중에 다른 두 줄로 다시 확인하면 뒤의 결과만 그린다", async () => {
    await pin();
    const first = held<Comparison>();
    vi.mocked(postCompare).mockReturnValueOnce(first.promise);
    const early = store().confirm();
    const later = { ...compareFixture, base: "c".repeat(40) };
    vi.mocked(postCompare).mockResolvedValue(later);
    await store().confirm();
    expect(store().result).toBe(later);
    first.fail(new Error("취소됨"));
    await early;
    expect([store().result, store().error, store().running]).toEqual([later, null, false]);
  });

  it("비교를 켜고 끌 때마다 받아 둔 파일 본문을 버리고 요지 목록을 다시 받는다", async () => {
    await pin();
    await store().confirm();
    expect([vi.mocked(forgetFiles).mock.calls.length, vi.mocked(getSummaries).mock.calls.length]).toEqual([1, 1]);
    await store().clear();
    expect([vi.mocked(forgetFiles).mock.calls.length, vi.mocked(getSummaries).mock.calls.length]).toEqual([2, 2]);
  });

  it("분석하는 중에 끄면 도착한 결과를 그리지 않고 서버가 기억한 시점을 작업 중인 상태로 되돌린다", async () => {
    await pin();
    const answer = held<Comparison>();
    vi.mocked(postCompare).mockReturnValue(answer.promise);
    const done = store().confirm();
    await store().clear();
    expect(store().running).toBe(false);
    answer.release(compareFixture);
    await done;
    expect(store().result).toBeNull();
    expect(atlas().graph).toBe(repoFixture);
    expect(getGraph).toHaveBeenCalledTimes(1);
  });

  it("끌 때 그래프를 받지 못하면 비교를 그대로 두고 까닭을 적는다", async () => {
    await pin();
    await store().confirm();
    vi.mocked(getGraph).mockRejectedValueOnce(new Error("연결 끊김"));
    await store().clear();
    expect([store().result, store().error]).toEqual([compareFixture, "연결 끊김"]);
    expect(atlas().graph).toBe(compareFixture.graph);
  });
});

describe("renew", () => {
  it("켜져 있는 비교를 같은 두 시점으로 다시 받아 그리고 줄 수를 다시 센다", async () => {
    store().toggle();
    await settle();
    vi.mocked(getStat).mockResolvedValue(stat("f", WORKTREE, { fork: "f" }));
    store().pick("a");
    store().pick(WORKTREE);
    await settle();
    const on = { ...compareFixture, target: WORKTREE, revision: 3 };
    vi.mocked(postCompare).mockResolvedValue(on);
    await store().confirm();
    const next = { ...on, revision: 4, files: on.files.slice(0, 1) };
    vi.mocked(postCompare).mockResolvedValue(next);
    await store().renew();
    expect(postCompare).toHaveBeenLastCalledWith(on.base, WORKTREE);
    expect(store().result).toBe(next);
    expect(store().shown).toEqual({ base: on.base, target: WORKTREE, fork: "f", files: 1, added: 7, deleted: 0 });
  });

  it("받지 못하면 던지고 비교를 그대로 둔다", async () => {
    store().toggle();
    await settle();
    await store().confirm();
    vi.mocked(postCompare).mockRejectedValue(new Error("분석 중"));
    await expect(store().renew()).rejects.toThrow("분석 중");
    expect(store().result).toBe(compareFixture);
  });
});

describe("창의 크기", () => {
  it("바꾼 크기를 담고 localStorage에 쓴다", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { setItem: (key: string, value: string) => saved.set(key, value) });
    expect(store().size).toBeNull();
    store().resize({ width: 520, height: 360 });
    expect(store().size).toEqual({ width: 520, height: 360 });
    expect(parseSize([...saved.values()][0])).toEqual({ width: 520, height: 360 });
  });

  it("형태가 맞지 않는 값은 읽지 않는다", () => {
    expect(parseSize(null)).toBeNull();
    expect(parseSize("{")).toBeNull();
    expect(parseSize('{"width":0,"height":300}')).toBeNull();
    expect(parseSize('{"width":"520","height":300}')).toBeNull();
  });
});
