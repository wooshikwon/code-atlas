import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGraph, getRepo, getStatus, getTree, getUnused } from "../api/client";
import type { Status } from "../api/types";
import { reread } from "./opening";
import { comparingText, phaseText, progressOf, running, staleLines, useStatus } from "./status";

const atlas = vi.hoisted(() => ({ repo: null as object | null, load: vi.fn(), refresh: vi.fn() }));
const overlay = vi.hoisted(() => ({ load: vi.fn(), mark: vi.fn() }));
const changes = vi.hoisted(() => ({ load: vi.fn() }));
const compare = vi.hoisted(() => ({
  state: { running: false, result: null as { target: string; revision: number } | null, renew: vi.fn() },
  listeners: new Set<(now: { running: boolean }, before: { running: boolean }) => void>(),
}));

vi.mock("../api/client", () => ({ getStatus: vi.fn(), getRepo: vi.fn(), getGraph: vi.fn(), getTree: vi.fn(), getUnused: vi.fn(), forgetFiles: vi.fn() }));
vi.mock("./changes", () => ({ useChanges: { getState: () => changes } }));
vi.mock("./compare", () => ({
  useCompare: {
    getState: () => compare.state,
    subscribe: (listener: (now: { running: boolean }, before: { running: boolean }) => void) => {
      compare.listeners.add(listener);
      return () => compare.listeners.delete(listener);
    },
  },
}));
vi.mock("./opening", () => ({ reread: vi.fn() }));
vi.mock("./explanations", () => ({ useExplanations: { getState: () => ({ forget: vi.fn(), list: vi.fn() }) } }));
vi.mock("./overlay", () => ({ useOverlay: { getState: () => overlay } }));
vi.mock("./store", () => ({ useAtlas: { getState: () => atlas } }));
vi.mock("./summaries", () => ({ useSummaries: { getState: () => ({ forget: vi.fn(), list: vi.fn() }) } }));

const received = vi.mocked(getStatus);

const status = (extra: Partial<Status> = {}): Status => ({
  phase: "ready",
  done: 0,
  total: 0,
  revision: 1,
  draft: false,
  lsp: "ready",
  error: null,
  stale: { count: 0, paths: [] },
  compare: null,
  session: 1,
  ...extra,
});

const resolving = status({ phase: "resolve", done: 12_000, total: 19_292, revision: 0, lsp: "starting" });

const store = () => useStatus.getState();

beforeEach(() => {
  useStatus.setState({ status: null, shown: 0, session: null });
  vi.clearAllMocks();
  atlas.repo = null;
  atlas.load.mockImplementation(async () => {
    atlas.repo = {};
  });
  changes.load.mockResolvedValue(undefined);
  compare.state.running = false;
  compare.state.result = null;
  compare.state.renew.mockResolvedValue(undefined);
  compare.listeners.clear();
  vi.mocked(getRepo).mockResolvedValue({ name: "repo" } as never);
  vi.mocked(getGraph).mockResolvedValue({ nodes: [], edges: [] } as never);
  vi.mocked(getTree).mockResolvedValue({ entries: [] } as never);
  vi.mocked(getUnused).mockResolvedValue({ candidates: [], definitions: 0 } as never);
});

describe("load", () => {
  it("판 번호가 0인 동안 분석 결과를 받지 않고, 1이 되면 한 번만 받는다", async () => {
    received.mockResolvedValue(resolving);
    await store().load();
    expect(store().status).toEqual(resolving);
    expect(atlas.load).not.toHaveBeenCalled();

    received.mockResolvedValue(status());
    await store().load();
    await store().load();
    expect(atlas.load).toHaveBeenCalledTimes(1);
    expect(overlay.load).toHaveBeenCalledTimes(1);
    expect(atlas.refresh).not.toHaveBeenCalled();
    expect(store().shown).toBe(1);
  });

  it("판 번호가 그린 판과 달라지면 분석 결과와 미사용 후보를 다시 받아 보던 화면에 담는다", async () => {
    received.mockResolvedValue(status({ draft: true }));
    await store().load();
    received.mockResolvedValue(status({ phase: "resolve", done: 1, total: 4, draft: true }));
    await store().load();
    expect(atlas.refresh).not.toHaveBeenCalled();

    received.mockResolvedValue(status({ revision: 2 }));
    await store().load();
    await store().load();
    expect(atlas.load).toHaveBeenCalledTimes(1);
    expect(atlas.refresh).toHaveBeenCalledTimes(1);
    expect(atlas.refresh).toHaveBeenCalledWith({ name: "repo" }, { nodes: [], edges: [] }, { entries: [] });
    expect(overlay.load).toHaveBeenCalledTimes(1);
    expect(overlay.mark).toHaveBeenCalledWith({ candidates: [], definitions: 0 });
    expect(changes.load).toHaveBeenCalledTimes(1);
    expect(store().shown).toBe(2);
  });

  it("session이 처음 받은 값과 달라지면 그리지 않고 페이지를 다시 읽는다", async () => {
    received.mockResolvedValue(status({ session: 3 }));
    await store().load();
    await store().load();
    expect(store().session).toBe(3);
    expect(reread).not.toHaveBeenCalled();

    const other = status({ session: 4, revision: 2 });
    received.mockResolvedValue(other);
    await store().load();
    expect(reread).toHaveBeenCalledTimes(1);
    expect(store().status).not.toEqual(other);
    expect(atlas.refresh).not.toHaveBeenCalled();
    expect(store().shown).toBe(1);
  });

  it("연 레포가 없으면 분석 결과를 받지 않는다", async () => {
    const idle = status({ phase: "idle", revision: 0, lsp: "starting" });
    received.mockResolvedValue(idle);
    await store().load();
    expect(store().status).toEqual(idle);
    expect(atlas.load).not.toHaveBeenCalled();
    expect(running(idle)).toBe(false);
  });

  it("상태를 받지 못하면 직전 값을 그대로 두고 다음에 다시 받는다", async () => {
    received.mockResolvedValue(resolving);
    await store().load();
    received.mockRejectedValue(new Error("연결 끊김"));
    await store().load();
    expect(store().status).toEqual(resolving);

    received.mockResolvedValue(status());
    await store().load();
    expect(store().status?.phase).toBe("ready");
    expect(atlas.load).toHaveBeenCalledTimes(1);
  });

  it("분석 결과를 받지 못하면 그린 판 번호를 바꾸지 않고 다음에 다시 받는다", async () => {
    received.mockResolvedValue(status());
    atlas.load.mockImplementationOnce(async () => undefined);
    await store().load();
    expect(store().shown).toBe(0);
    expect(overlay.load).not.toHaveBeenCalled();

    await store().load();
    expect(atlas.load).toHaveBeenCalledTimes(2);
    expect(store().shown).toBe(1);

    received.mockResolvedValue(status({ revision: 2 }));
    vi.mocked(getGraph).mockRejectedValueOnce(new Error("연결 끊김"));
    await store().load();
    expect(store().shown).toBe(1);
    await store().load();
    expect(atlas.refresh).toHaveBeenCalledTimes(1);
    expect(store().shown).toBe(2);
  });

  it("응답이 직전과 같으면 상태를 바꾸지 않는다", async () => {
    received.mockImplementation(async () => status());
    await store().load();
    const heard = vi.fn();
    const stop = useStatus.subscribe(heard);
    await store().load();
    expect(heard).not.toHaveBeenCalled();
    stop();
  });

  it("받는 중에 다시 부르면 앞의 일이 끝난 뒤에 한 번 더 받는다", async () => {
    received.mockResolvedValueOnce(resolving).mockResolvedValueOnce(status());
    await Promise.all([store().load(), store().load()]);
    expect(received).toHaveBeenCalledTimes(2);
    expect(store().shown).toBe(1);
  });
});

describe("시점 비교가 켜져 있는 동안의 load", () => {
  beforeEach(async () => {
    received.mockResolvedValue(status());
    await store().load();
    vi.mocked(getGraph).mockClear();
  });

  it("대상이 작업 중인 상태면 판 번호가 달라질 때 그래프를 받지 않고 비교를 다시 받는다", async () => {
    compare.state.result = { target: "worktree", revision: 1 };
    received.mockResolvedValue(status({ revision: 2 }));
    await store().load();
    expect(compare.state.renew).toHaveBeenCalledTimes(1);
    expect(getGraph).not.toHaveBeenCalled();
    expect(atlas.refresh).not.toHaveBeenCalled();
    expect(changes.load).toHaveBeenCalledTimes(1);
    expect(store().shown).toBe(2);
  });

  it("비교가 이미 그 판으로 만든 것이면 다시 받지 않는다", async () => {
    compare.state.result = { target: "worktree", revision: 2 };
    received.mockResolvedValue(status({ revision: 2 }));
    await store().load();
    expect(compare.state.renew).not.toHaveBeenCalled();
    expect(getGraph).not.toHaveBeenCalled();
    expect(store().shown).toBe(2);
  });

  it("비교를 다시 받지 못하면 그린 판 번호를 바꾸지 않고 다음에 다시 받는다", async () => {
    compare.state.result = { target: "worktree", revision: 1 };
    compare.state.renew.mockRejectedValueOnce(new Error("분석 중"));
    received.mockResolvedValue(status({ revision: 2 }));
    await store().load();
    expect(store().shown).toBe(1);
    await store().load();
    expect(compare.state.renew).toHaveBeenCalledTimes(2);
    expect(store().shown).toBe(2);
  });

  it("대상이 커밋이면 아무것도 받지 않고, 비교를 끈 뒤에 그 판을 받아 그린다", async () => {
    compare.state.result = { target: "b".repeat(40), revision: 0 };
    received.mockResolvedValue(status({ revision: 2 }));
    await store().load();
    expect(compare.state.renew).not.toHaveBeenCalled();
    expect(getGraph).not.toHaveBeenCalled();
    expect(changes.load).not.toHaveBeenCalled();
    expect(store().shown).toBe(1);

    compare.state.result = null;
    await store().load();
    expect(atlas.refresh).toHaveBeenCalledTimes(1);
    expect(store().shown).toBe(2);
  });
});

describe("watch", () => {
  const page = Object.assign(new EventTarget(), { hidden: false });

  beforeEach(() => {
    vi.useFakeTimers();
    page.hidden = false;
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("document", page);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("분석하는 동안 0.5초마다, 끝난 뒤에는 2초마다 받고 멈추면 더 받지 않는다", async () => {
    received.mockResolvedValue(resolving);
    const stop = store().watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(received).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toHaveBeenCalledTimes(2);

    received.mockResolvedValue(status());
    await vi.advanceTimersByTimeAsync(500);
    expect(received).toHaveBeenCalledTimes(3);
    expect(atlas.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(received).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toHaveBeenCalledTimes(4);

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(received).toHaveBeenCalledTimes(4);
  });

  it("비교할 시점의 분석이 시작되면 바로 받고 끝날 때까지 0.5초마다 받는다", async () => {
    received.mockResolvedValue(status());
    const stop = store().watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveBeenCalledTimes(1);

    compare.state.running = true;
    compare.listeners.forEach((listener) => listener({ running: true }, { running: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(received).toHaveBeenCalledTimes(4);

    compare.state.running = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(received).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(received).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(500);
    expect(received).toHaveBeenCalledTimes(6);
    stop();
    expect(compare.listeners.size).toBe(0);
  });

  it("상태를 받지 못하면 0.5초 뒤에 다시 받는다", async () => {
    received.mockRejectedValue(new Error("연결 끊김"));
    const stop = store().watch();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(received).toHaveBeenCalledTimes(2);
    stop();
  });

  it("창이 보이지 않으면 멈추고 다시 보이면 바로 받는다", async () => {
    received.mockResolvedValue(status());
    const stop = store().watch();
    await vi.advanceTimersByTimeAsync(0);
    page.hidden = true;
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(received).toHaveBeenCalledTimes(1);

    page.hidden = false;
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(received).toHaveBeenCalledTimes(3);
    stop();
  });
});

describe("진행 표시의 글", () => {
  it("수를 세는 단계는 이름 뒤에 진행 수를 적고, 세지 않는 단계는 이름만 적는다", () => {
    expect(phaseText(resolving)).toBe("호출 대상 확인 12,000 / 19,292");
    expect(phaseText(status({ phase: "extract", done: 3, total: 33 }))).toBe("구조 추출 3 / 33");
    expect(phaseText(status({ phase: "collect" }))).toBe("파일 수집");
    expect(phaseText(status({ phase: "build" }))).toBe("그래프 조립");
    expect(progressOf(resolving)).toBeCloseTo(12_000 / 19_292);
    expect(progressOf(status({ phase: "build" }))).toBeNull();
  });

  it("ready와 failed가 아닌 단계가 분석하는 중이다", () => {
    expect(running(null)).toBe(false);
    expect(running(resolving)).toBe(true);
    expect(running(status())).toBe(false);
    expect(running(status({ phase: "failed", revision: 0, error: "가상환경 없음" }))).toBe(false);
  });
});

describe("comparingText", () => {
  it("비교할 시점을 분석하는 진행 수를 적고, 수를 세지 않는 동안에는 글만 적는다", () => {
    expect(comparingText(status({ compare: { phase: "resolve", done: 120, total: 3_333 } }))).toBe("분석 중 120 / 3,333");
    expect(comparingText(status({ compare: { phase: "collect", done: 0, total: 0 } }))).toBe("분석 중");
    expect(comparingText(status())).toBe("분석 중");
    expect(comparingText(null)).toBe("분석 중");
  });
});

describe("staleLines", () => {
  it("바뀐 파일의 경로를 한 줄씩 적고 서버가 싣지 않은 나머지를 수로 적는다", () => {
    expect(staleLines({ count: 0, paths: [] })).toEqual([]);
    expect(staleLines({ count: 2, paths: ["src/a.py", "src/b.py"] })).toEqual(["분석 뒤 바뀐 파일 2개", "  src/a.py", "  src/b.py"]);
    expect(staleLines({ count: 7, paths: ["a.py", "b.py", "c.py", "d.py", "e.py"] }).slice(-2)).toEqual(["  e.py", "  외 2개"]);
  });
});
