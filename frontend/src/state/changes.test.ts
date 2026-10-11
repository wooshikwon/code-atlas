import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChanges } from "../api/client";
import type { Changes } from "../api/types";
import { inside, useChanges, watch } from "./changes";

vi.mock("../api/client", () => ({ getChanges: vi.fn() }));

const received = vi.mocked(getChanges);

const changes = (extra: Partial<Changes> = {}): Changes => ({
  git: true,
  branch: "main",
  files: [{ path: "pkg/mod.py", status: "modified", stale: false, test: false }],
  nodes: { "pkg.mod": "modified", "pkg.mod:Store.put": "modified" },
  ...extra,
});

const store = () => useChanges.getState();

beforeEach(() => {
  useChanges.setState({ changes: null });
  received.mockReset();
});

describe("load", () => {
  it("받은 변경 내용을 담는다", async () => {
    received.mockResolvedValue(changes());
    await store().load();
    expect(store().changes).toEqual(changes());
  });

  it("응답이 직전과 같으면 상태를 바꾸지 않는다", async () => {
    received.mockImplementation(async () => changes());
    await store().load();
    const first = store().changes;
    const heard = vi.fn();
    const stop = useChanges.subscribe(heard);
    await store().load();
    expect(store().changes).toBe(first);
    expect(heard).not.toHaveBeenCalled();

    received.mockResolvedValue(changes({ nodes: { "pkg.mod": "modified" } }));
    await store().load();
    expect(store().changes?.nodes).toEqual({ "pkg.mod": "modified" });
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  it("받지 못하면 직전 값을 그대로 둔다", async () => {
    received.mockResolvedValue(changes({ branch: "work" }));
    await store().load();
    received.mockRejectedValue(new Error("연결 끊김"));
    await store().load();
    expect(store().changes?.branch).toBe("work");
  });

  it("받는 중에 다시 부르면 요청을 더 보내지 않는다", async () => {
    received.mockResolvedValue(changes({ branch: "once" }));
    await Promise.all([store().load(), store().load()]);
    expect(received).toHaveBeenCalledTimes(1);
  });
});

describe("watch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", Object.assign(new EventTarget(), { setInterval, clearInterval }));
    received.mockResolvedValue(changes({ branch: "watch" }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("바로 한 번, 창이 포커스를 받을 때, 15초마다 받고 멈추면 더 받지 않는다", async () => {
    const stop = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(received).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toHaveBeenCalledTimes(3);

    stop();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(received).toHaveBeenCalledTimes(3);
  });
});

describe("inside", () => {
  const nodes = changes().nodes;

  it("폴더 안의 파일이나 정의가 바뀌었으면 참이다", () => {
    expect(inside(nodes, "pkg")).toBe(true);
    expect(inside({ pkg: "modified" }, "pkg")).toBe(true);
    expect(inside({ "pkg:setup": "added" }, "pkg")).toBe(true);
  });

  it("이름이 같은 글자로 시작하는 다른 폴더는 거짓이다", () => {
    expect(inside(nodes, "pk")).toBe(false);
    expect(inside(nodes, "pkg.mod.deep")).toBe(false);
    expect(inside({}, "pkg")).toBe(false);
  });
});
