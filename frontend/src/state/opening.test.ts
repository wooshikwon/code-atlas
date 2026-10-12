import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteRepo, getInterpreters, getRepos, postClose, postOpen, postProbe } from "../api/client";
import type { Found, Probe } from "../api/types";
import { asking, nameOf, next, useOpening } from "./opening";

const page = vi.hoisted(() => ({ app: false, pickFolder: vi.fn(), reload: vi.fn() }));

vi.mock("../api/client", () => ({ postProbe: vi.fn(), postOpen: vi.fn(), postClose: vi.fn(), getRepos: vi.fn(), deleteRepo: vi.fn(), getInterpreters: vi.fn() }));
vi.mock("../host", () => ({
  host: {
    get app() {
      return page.app;
    },
    pickFolder: page.pickFolder,
  },
}));

const found = (extra: Partial<Found> = {}): Found => ({
  tool: "python",
  path: "/repos/shop/.venv/bin/python",
  version: "3.13.12",
  source: "env",
  attempts: [],
  note: null,
  auth: null,
  prefix: "/repos/shop/.venv",
  venv: true,
  ...extra,
});

const probe = (extra: Partial<Probe> = {}): Probe => ({
  path: "/repos/shop",
  exists: true,
  python_files: true,
  project: null,
  nested: [],
  git: true,
  python: found(),
  ...extra,
});

const missing = found({ path: null, version: null, source: null, prefix: null, venv: null, attempts: [{ source: "env", path: null, ok: false, detail: "가상환경 폴더가 없다" }] });
const system = found({ path: "/opt/homebrew/bin/python3.13", source: null, prefix: "/opt/homebrew", venv: false });

const store = () => useOpening.getState();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("location", { reload: page.reload });
  page.app = false;
  useOpening.setState({ step: { kind: "idle" }, typing: false, repos: [] });
  vi.mocked(postOpen).mockResolvedValue({ session: 2 });
  vi.mocked(postClose).mockResolvedValue({ session: 2 });
  vi.mocked(deleteRepo).mockResolvedValue({ deleted: true });
  vi.mocked(getInterpreters).mockResolvedValue({ found: [system] });
});

describe("next", () => {
  it("폴더가 없거나 파이썬 파일이 없으면 열지 못한다", () => {
    expect(next(probe({ exists: false, python_files: false }), {})).toEqual({ kind: "blocked", path: "/repos/shop", reason: "missing" });
    expect(next(probe({ python_files: false, project: "/repos" }), {})).toEqual({ kind: "blocked", path: "/repos/shop", reason: "no-python-files" });
  });

  it("조상에 프로젝트 루트가 있으면 어느 쪽을 열지 묻고, 그대로 열기를 골랐으면 묻지 않는다", () => {
    const inner = probe({ path: "/repos/shop/src", project: "/repos/shop" });
    expect(next(inner, {})).toEqual({ kind: "ask-project", path: "/repos/shop/src", project: "/repos/shop" });
    expect(next(inner, { asIs: true })).toEqual({ kind: "opening", path: "/repos/shop/src" });
  });

  it("프로젝트를 둘 이상 품었으면 하나를 고르게 하고, 그대로 열기를 골랐으면 묻지 않는다", () => {
    const many = probe({ path: "/repos", nested: ["shop", "tools"] });
    expect(next(many, {})).toEqual({ kind: "ask-nested", path: "/repos", nested: ["shop", "tools"] });
    expect(next(many, { asIs: true })).toEqual({ kind: "opening", path: "/repos" });
    expect(next(probe({ nested: ["vendored"] }), {})).toEqual({ kind: "opening", path: "/repos/shop" });
  });

  it("인터프리터를 찾지 못했으면 고르게 한다", () => {
    expect(next(probe({ python: missing }), {})).toEqual({ kind: "ask-python", path: "/repos/shop", found: missing, candidates: [] });
  });

  it("git 저장소가 아닌 폴더는 묻지 않고 연다", () => {
    expect(next(probe({ git: false }), {})).toEqual({ kind: "opening", path: "/repos/shop" });
  });

  it("프로젝트 루트의 물음이 품은 프로젝트의 물음보다 앞이다", () => {
    expect(next(probe({ project: "/repos", nested: ["a", "b"], python: missing }), {}).kind).toBe("ask-project");
    expect(next(probe({ nested: ["a", "b"], python: missing }), {}).kind).toBe("ask-nested");
  });
});

describe("choose", () => {
  it("열 수 있는 폴더는 판정이 돌려준 경로로 열고 페이지를 다시 읽는다", async () => {
    vi.mocked(postProbe).mockResolvedValue(probe());
    await store().choose("/repos/SHOP");
    expect(postProbe).toHaveBeenCalledWith("/repos/SHOP");
    expect(postOpen).toHaveBeenCalledWith("/repos/shop", undefined);
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(store().step).toEqual({ kind: "opening", path: "/repos/shop" });
  });

  it("하위 폴더를 고르면 묻고, 프로젝트 루트를 고르면 그 경로를 다시 판정하고, 이 폴더만 열기를 고르면 묻지 않고 연다", async () => {
    const inner = probe({ path: "/repos/shop/src", project: "/repos/shop" });
    vi.mocked(postProbe).mockResolvedValue(inner);
    await store().choose("/repos/shop/src");
    expect(store().step).toEqual({ kind: "ask-project", path: "/repos/shop/src", project: "/repos/shop" });
    expect(postOpen).not.toHaveBeenCalled();

    // `{조상 이름} 열기`
    vi.mocked(postProbe).mockResolvedValue(probe());
    await store().choose("/repos/shop");
    expect(postProbe).toHaveBeenLastCalledWith("/repos/shop");
    expect(postOpen).toHaveBeenLastCalledWith("/repos/shop", undefined);

    // `이 폴더만 열기`
    vi.mocked(postProbe).mockResolvedValue(inner);
    await store().choose("/repos/shop/src", { asIs: true });
    expect(postOpen).toHaveBeenLastCalledWith("/repos/shop/src", undefined);
    expect(page.reload).toHaveBeenCalledTimes(2);
  });

  it("인터프리터를 찾지 못하면 후보를 받아 고르게 하고, 고른 경로로 판정 없이 연다", async () => {
    vi.mocked(postProbe).mockResolvedValue(probe({ python: missing }));
    await store().choose("/repos/shop");
    expect(store().step).toEqual({ kind: "ask-python", path: "/repos/shop", found: missing, candidates: [system] });

    await store().choose("/repos/shop", { asIs: true, python: system.path! });
    expect(postProbe).toHaveBeenCalledTimes(1);
    expect(postOpen).toHaveBeenCalledWith("/repos/shop", system.path);
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("후보를 받지 못해도 인터프리터를 고르는 단계로 간다", async () => {
    vi.mocked(postProbe).mockResolvedValue(probe({ python: missing }));
    vi.mocked(getInterpreters).mockRejectedValue(new Error("HTTP 404 Not Found"));
    await store().choose("/repos/shop");
    expect(store().step).toEqual({ kind: "ask-python", path: "/repos/shop", found: missing, candidates: [] });
  });

  it("고른 인터프리터로 열지 못하면 같은 단계에 까닭을 적는다", async () => {
    vi.mocked(postProbe).mockResolvedValue(probe({ python: missing }));
    await store().choose("/repos/shop");
    vi.mocked(postOpen).mockRejectedValue(new Error("Python 인터프리터가 아니다: /bin/ls (종료 코드 2)"));
    await store().choose("/repos/shop", { asIs: true, python: "/bin/ls" });
    expect(store().step).toEqual({ kind: "ask-python", path: "/repos/shop", found: missing, candidates: [system], error: "Python 인터프리터가 아니다: /bin/ls (종료 코드 2)" });
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("이 기기의 인터프리터를 찾는 동안에도 고르는 화면이 떠 있고, 받으면 목록에 넣는다", async () => {
    vi.mocked(postProbe).mockResolvedValue(probe({ python: missing }));
    let arrive!: (value: { found: Found[] }) => void;
    vi.mocked(getInterpreters).mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    const chosen = store().choose("/repos/shop");
    await vi.waitFor(() => expect(store().step).toEqual({ kind: "ask-python", path: "/repos/shop", found: missing, candidates: [], seeking: true }));
    arrive({ found: [system] });
    await chosen;
    expect(store().step).toEqual({ kind: "ask-python", path: "/repos/shop", found: missing, candidates: [system] });
  });

  it("찾는 동안 고른 인터프리터로 열지 못하면 그 사이에 받은 목록과 까닭을 함께 그린다", async () => {
    vi.mocked(postProbe).mockResolvedValue(probe({ python: missing }));
    let arrive!: (value: { found: Found[] }) => void;
    vi.mocked(getInterpreters).mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    const chosen = store().choose("/repos/shop");
    await vi.waitFor(() => expect(store().step.kind).toBe("ask-python"));
    let refuse!: (error: Error) => void;
    vi.mocked(postOpen).mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    const opened = store().choose("/repos/shop", { asIs: true, python: "/bin/ls" });
    expect(store().step).toEqual({ kind: "opening", path: "/repos/shop" });
    arrive({ found: [system] });
    await chosen;
    refuse(new Error("Python 인터프리터가 아니다: /bin/ls (종료 코드 2)"));
    await opened;
    expect(store().step).toEqual({ kind: "ask-python", path: "/repos/shop", found: missing, candidates: [system], error: "Python 인터프리터가 아니다: /bin/ls (종료 코드 2)" });
  });

  it("찾는 동안 창을 닫으면 늦게 온 목록으로 창을 다시 띄우지 않는다", async () => {
    vi.mocked(postProbe).mockResolvedValue(probe({ python: missing }));
    let arrive!: (value: { found: Found[] }) => void;
    vi.mocked(getInterpreters).mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    const chosen = store().choose("/repos/shop");
    await vi.waitFor(() => expect(store().step.kind).toBe("ask-python"));
    store().cancel();
    arrive({ found: [system] });
    await chosen;
    expect(store().step).toEqual({ kind: "idle" });
  });

  it("pick은 판정 없이 인터프리터를 고르는 화면을 띄우고 지금 찾은 인터프리터를 넘긴다", async () => {
    useOpening.setState({ typing: true });
    await store().pick("/repos/shop", found());
    expect(postProbe).not.toHaveBeenCalled();
    expect(store().typing).toBe(false);
    expect(store().step).toEqual({ kind: "ask-python", path: "/repos/shop", found: found(), candidates: [system] });
    expect(asking(store())).toBe(true);

    await store().choose("/repos/shop", { asIs: true, python: system.path! });
    expect(postOpen).toHaveBeenCalledWith("/repos/shop", system.path);
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("판정이나 열기가 실패하면 까닭을 적는다", async () => {
    vi.mocked(postProbe).mockRejectedValue(new Error("폴더를 읽지 못했다: Permission denied"));
    await store().choose("/private");
    expect(store().step).toEqual({ kind: "failed", path: "/private", error: "폴더를 읽지 못했다: Permission denied" });

    vi.mocked(postProbe).mockResolvedValue(probe());
    vi.mocked(postOpen).mockRejectedValue(new Error("폴더가 없다: /repos/shop"));
    await store().choose("/repos/shop");
    expect(store().step).toEqual({ kind: "failed", path: "/repos/shop", error: "폴더가 없다: /repos/shop" });
  });

  it("판정을 기다리는 동안 닫으면 그 결과를 버린다", async () => {
    let answer: (value: Probe) => void = () => {};
    vi.mocked(postProbe).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const chosen = store().choose("/repos/shop");
    expect(store().step).toEqual({ kind: "probing", path: "/repos/shop" });
    expect(asking(store())).toBe(true);
    store().cancel();
    answer(probe());
    await chosen;
    expect(store().step).toEqual({ kind: "idle" });
    expect(postOpen).not.toHaveBeenCalled();
    expect(asking(store())).toBe(false);
  });
});

describe("browse", () => {
  it("브라우저는 경로 입력 창을 띄우고, 경로를 고르면 창을 닫는다", async () => {
    await store().browse();
    expect(store().typing).toBe(true);
    expect(asking(store())).toBe(true);
    vi.mocked(postProbe).mockResolvedValue(probe({ python_files: false }));
    await store().choose("/repos/shop");
    expect(store().typing).toBe(false);
    expect(store().step.kind).toBe("blocked");
  });

  it("앱은 폴더 선택 대화상자에서 고른 폴더를 판정하고, 고르지 않으면 아무것도 하지 않는다", async () => {
    page.app = true;
    page.pickFolder.mockResolvedValue(null);
    await store().browse();
    expect(store().typing).toBe(false);
    expect(postProbe).not.toHaveBeenCalled();

    page.pickFolder.mockResolvedValue("/repos/shop");
    vi.mocked(postProbe).mockResolvedValue(probe());
    await store().browse();
    expect(postOpen).toHaveBeenCalledWith("/repos/shop", undefined);
  });
});

describe("drop", () => {
  it("끌어다 놓은 경로 가운데 첫 폴더만 쓴다", async () => {
    vi.mocked(postProbe).mockImplementation(async (path) => probe({ path, exists: path !== "/repos/notes.txt", python_files: path !== "/repos/notes.txt" }));
    await store().drop(["/repos/notes.txt", "/repos/shop", "/repos/tools"]);
    expect(vi.mocked(postProbe).mock.calls.map(([path]) => path)).toEqual(["/repos/notes.txt", "/repos/shop"]);
    expect(postOpen).toHaveBeenCalledWith("/repos/shop", undefined);
  });

  it("폴더가 없으면 첫 경로를 열 수 없다고 알린다", async () => {
    vi.mocked(postProbe).mockImplementation(async (path) => probe({ path, exists: false, python_files: false }));
    await store().drop(["/repos/a.txt", "/repos/b.txt"]);
    expect(store().step).toEqual({ kind: "blocked", path: "/repos/a.txt", reason: "missing" });
  });
});

describe("목록과 닫기", () => {
  it("연 적이 있는 레포를 받고, 지우면 다시 받는다", async () => {
    const repo = { root: "/repos/shop", name: "shop", python: null, opened: 1_791_000_000, exists: true };
    vi.mocked(getRepos).mockResolvedValue({ repos: [repo] });
    await store().list();
    expect(store().repos).toEqual([repo]);

    vi.mocked(getRepos).mockResolvedValue({ repos: [] });
    await store().forget("/repos/shop");
    expect(deleteRepo).toHaveBeenCalledWith("/repos/shop");
    expect(store().repos).toEqual([]);
  });

  it("목록을 받지 못하면 직전 목록을 그대로 둔다", async () => {
    const repo = { root: "/repos/shop", name: "shop", python: null, opened: 1_791_000_000, exists: true };
    useOpening.setState({ repos: [repo] });
    vi.mocked(getRepos).mockRejectedValue(new Error("연결 끊김"));
    await store().list();
    expect(store().repos).toEqual([repo]);
  });

  it("레포를 닫으면 페이지를 다시 읽는다", async () => {
    await store().close();
    expect(postClose).toHaveBeenCalledTimes(1);
    expect(page.reload).toHaveBeenCalledTimes(1);
  });
});

describe("nameOf", () => {
  it("경로의 마지막 마디를 낸다", () => {
    expect(nameOf("/repos/shop")).toBe("shop");
    expect(nameOf("/repos/shop/")).toBe("shop");
    expect(nameOf("/")).toBe("/");
  });
});
