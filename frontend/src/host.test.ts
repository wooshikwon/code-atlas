import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./host";

const shell = vi.hoisted(() => ({
  loaded: [] as string[],
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
  invoke: vi.fn(),
  open: vi.fn(),
  dropped: null as ((event: { payload: { type: string; paths?: string[] } }) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => {
  shell.loaded.push("core");
  return { invoke: shell.invoke };
});
vi.mock("@tauri-apps/api/event", () => {
  shell.loaded.push("event");
  return {
    listen: async (name: string, listener: (event: { payload: unknown }) => void) => {
      shell.listeners.set(name, listener);
      return shell.unlisten;
    },
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (listener: typeof shell.dropped) => {
      shell.dropped = listener;
      return shell.unlisten;
    },
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: shell.open }));

/** 모듈을 새로 읽어 `host`를 다시 만든다. */
const load = async () => (await import("./host")).host;
/** 기다리던 약속이 모두 풀리게 한다. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const emit = (name: string, payload: unknown) => shell.listeners.get(name)!({ payload });

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  shell.loaded.length = 0;
  shell.listeners.clear();
  shell.dropped = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("브라우저", () => {
  it("API 주소의 앞부분이 비어 있고 Tauri의 코드를 불러오지 않는다", async () => {
    const host = await load();
    expect(host.app).toBe(false);
    expect(await host.base()).toBe("");
    const states: Backend[] = [];
    host.onBackend((state) => states.push(state))();
    host.onDrop(() => {})();
    host.onMenu(() => {})();
    await settle();
    expect(states).toEqual([{ phase: "ready", url: "" }]);
    expect(shell.loaded).toEqual([]);
  });
});

describe("앱", () => {
  beforeEach(() => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
  });

  it("백엔드가 뜰 때까지 주소를 기다리고, 다시 뜬 백엔드의 주소로 바꾼다", async () => {
    shell.invoke.mockResolvedValue({ phase: "starting" });
    const host = await load();
    expect(host.app).toBe(true);
    const states: Backend[] = [];
    const stop = host.onBackend((state) => states.push(state));
    let base: string | null = null;
    void host.base().then((url) => (base = url));
    await settle();
    expect(shell.invoke).toHaveBeenCalledWith("backend_state");
    expect(base).toBeNull();

    emit("backend", { phase: "ready", url: "http://127.0.0.1:53124" });
    await settle();
    expect(base).toBe("http://127.0.0.1:53124");

    emit("backend", { phase: "stopped", code: 1, detail: "Traceback" });
    emit("backend", { phase: "ready", url: "http://127.0.0.1:53200" });
    expect(await host.base()).toBe("http://127.0.0.1:53200");
    expect(states.map((state) => state.phase)).toEqual(["starting", "starting", "ready", "stopped", "ready"]);

    stop();
    emit("backend", { phase: "starting" });
    expect(states).toHaveLength(5);
  });

  it("이미 뜬 백엔드의 주소를 바로 준다", async () => {
    shell.invoke.mockResolvedValue({ phase: "ready", url: "http://127.0.0.1:53124" });
    const host = await load();
    expect(await host.base()).toBe("http://127.0.0.1:53124");
  });

  it("대화상자에서 고른 폴더와 파일의 경로를 주고, 고르지 않으면 null이다", async () => {
    shell.invoke.mockResolvedValue({ phase: "starting" });
    const host = await load();
    shell.open.mockResolvedValueOnce("/repos/shop").mockResolvedValueOnce(null);
    expect(await host.pickFolder()).toBe("/repos/shop");
    expect(shell.open).toHaveBeenLastCalledWith({ directory: true });
    expect(await host.pickFile()).toBeNull();
    expect(shell.open).toHaveBeenLastCalledWith({});
  });

  it("끌어다 놓은 경로와 앱 메뉴의 항목을 받고, 멈추면 받기를 그만둔다", async () => {
    shell.invoke.mockResolvedValue({ phase: "starting" });
    const host = await load();
    const dropped: string[][] = [];
    const picked: string[] = [];
    const stops = [host.onDrop((paths) => dropped.push(paths)), host.onMenu((item) => picked.push(item))];
    await settle();
    shell.dropped!({ payload: { type: "over" } });
    shell.dropped!({ payload: { type: "drop", paths: ["/repos/shop"] } });
    emit("menu", "open");
    expect(dropped).toEqual([["/repos/shop"]]);
    expect(picked).toEqual(["open"]);

    stops.forEach((stop) => stop());
    await settle();
    expect(shell.unlisten).toHaveBeenCalledTimes(2);
  });

  it("백엔드를 다시 띄우는 명령과 로그인 명령을 앱 껍데기에 보낸다", async () => {
    shell.invoke.mockResolvedValue({ phase: "starting" });
    const host = await load();
    await host.restartBackend();
    await host.claudeLogin("/Users/me/.local/bin/claude");
    expect(shell.invoke).toHaveBeenCalledWith("restart_backend");
    expect(shell.invoke).toHaveBeenCalledWith("claude_login", { path: "/Users/me/.local/bin/claude" });
  });
});
