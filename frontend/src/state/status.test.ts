import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGraph, getRepo, getStatus, getTree, getUnused } from "../api/client";
import type { Status } from "../api/types";
import { phaseText, progressOf, running, staleLines, useStatus } from "./status";

const atlas = vi.hoisted(() => ({ repo: null as object | null, load: vi.fn(), refresh: vi.fn() }));
const overlay = vi.hoisted(() => ({ load: vi.fn(), mark: vi.fn() }));
const changes = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("../api/client", () => ({ getStatus: vi.fn(), getRepo: vi.fn(), getGraph: vi.fn(), getTree: vi.fn(), getUnused: vi.fn(), forgetFiles: vi.fn() }));
vi.mock("./changes", () => ({ useChanges: { getState: () => changes } }));
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
  ...extra,
});

const resolving = status({ phase: "resolve", done: 12_000, total: 19_292, revision: 0, lsp: "starting" });

const store = () => useStatus.getState();

beforeEach(() => {
  useStatus.setState({ status: null, shown: 0 });
  vi.clearAllMocks();
  atlas.repo = null;
  atlas.load.mockImplementation(async () => {
    atlas.repo = {};
  });
  changes.load.mockResolvedValue(undefined);
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

describe("staleLines", () => {
  it("바뀐 파일의 경로를 한 줄씩 적고 서버가 싣지 않은 나머지를 수로 적는다", () => {
    expect(staleLines({ count: 0, paths: [] })).toEqual([]);
    expect(staleLines({ count: 2, paths: ["src/a.py", "src/b.py"] })).toEqual(["분석 뒤 바뀐 파일 2개", "  src/a.py", "  src/b.py"]);
    expect(staleLines({ count: 7, paths: ["a.py", "b.py", "c.py", "d.py", "e.py"] }).slice(-2)).toEqual(["  e.py", "  외 2개"]);
  });
});
