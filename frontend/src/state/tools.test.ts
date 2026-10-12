import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, deleteTool, getAbout, getTools, postClaudeAsk, postToolsCheck, putTool } from "../api/client";
import type { Attempt, Code, Found, Tools } from "../api/types";
import { aboutLine, answerLine, claudeLine, claudeState, gitLine, saidOf, saved, shellLine, sourceName, useTools } from "./tools";

vi.mock("../api/client", async (original) => ({
  ApiError: (await original<typeof import("../api/client")>()).ApiError,
  getTools: vi.fn(),
  postToolsCheck: vi.fn(),
  putTool: vi.fn(),
  deleteTool: vi.fn(),
  postClaudeAsk: vi.fn(),
  getAbout: vi.fn(),
}));

const tried = (source: string, path: string | null, code: Code, detail: string): Attempt => ({ source, path, ok: code === "ok", detail, code });

const found = (tool: string, extra: Partial<Found> = {}): Found => ({
  tool,
  path: `/usr/local/bin/${tool}`,
  version: "1.0.0",
  source: "env",
  attempts: [tried("env", `/usr/local/bin/${tool}`, "ok", "1.0.0")],
  note: null,
  auth: null,
  prefix: null,
  venv: null,
  code: "ok",
  ...extra,
});

const none = (tool: string, code: Code, attempts: Attempt[]): Found => found(tool, { path: null, version: null, source: null, attempts, code });
/** 경우와 문장을 함께 낸다. */
const told = (claude: Found) => {
  const state = claudeState(claude.code, claude);
  return [state, claudeLine(state, saidOf(claude))] as const;
};

const tools = (extra: Partial<Tools> = {}): Tools => ({ shell: null, claude: found("claude", { auth: "claude.ai" }), git: found("git"), python: null, ...extra });

const store = () => useTools.getState();
/** 기다리던 약속이 모두 풀리게 한다. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  useTools.setState({ shown: false, tools: null, about: null, busy: false, error: null, refused: {}, answer: null });
  vi.mocked(getTools).mockResolvedValue(tools());
  vi.mocked(getAbout).mockRejectedValue(new ApiError("HTTP 404 Not Found", 404));
});

describe("claudeState", () => {
  it("code가 ok면 쓸 수 있다", () => {
    expect(told(found("claude"))).toEqual([{ kind: "ready" }, null]);
  });

  it("not_found면 찾지 못한 것이다", () => {
    const absent = none("claude", "not_found", [tried("known", "/home/me/.local/bin/claude", "missing", "없는 파일"), tried("known", "/opt/homebrew/bin/claude", "missing", "없는 파일")]);
    expect(told(none("claude", "not_found", []))).toEqual([{ kind: "missing" }, "Claude Code CLI를 찾지 못했다"]);
    expect(told(absent)).toEqual([{ kind: "missing" }, "Claude Code CLI를 찾지 못했다"]);
  });

  it.each(["failed", "timeout", "spawn_failed", "not_executable", "unreadable", "not_file"] as const)("%s면 같은 code를 가진 첫 기록의 경로와 글을 적는다", (code) => {
    const broken = none("claude", code, [
      tried("known", "/home/me/.local/bin/claude", "missing", "없는 파일"),
      tried("known", "/opt/homebrew/bin/claude", code, "서버가 적은 글"),
      tried("known", "/usr/local/bin/claude", code, "둘째 기록"),
    ]);
    expect(told(broken)).toEqual([{ kind: "broken", path: "/opt/homebrew/bin/claude", detail: "서버가 적은 글" }, "Claude Code CLI를 실행하지 못했다: /opt/homebrew/bin/claude (서버가 적은 글)"]);
  });

  it("not_logged_in이면 로그인에 쓸 경로를 함께 내고 글이 달라도 같은 경우다", () => {
    const out = found("claude", { code: "not_logged_in", note: "서버가 바꾼 글" });
    expect(told(out)).toEqual([{ kind: "logged-out", path: "/usr/local/bin/claude" }, "Claude Code에 로그인돼 있지 않다"]);
  });

  it("not_answering이면 다시 확인하라고 적는다", () => {
    const silent = found("claude", { code: "not_answering", note: "Claude Code CLI가 응답하지 않는다" });
    expect(told(silent)).toEqual([{ kind: "silent" }, "Claude Code CLI가 로그인 여부를 묻는 명령에 답하지 않았다. 잠시 뒤 다시 확인한다"]);
  });

  it.each([
    ["disabled", "환경 변수 CODE_ATLAS_NO_CLAUDE가 켜져 있어 Claude Code를 실행하지 않는다. 변수를 지우고 Atlas를 다시 띄운다"],
    ["shell_pending", "로그인 셸의 환경을 읽는 중이라 Claude Code를 아직 확인하지 않았다. 잠시 뒤 다시 확인한다"],
    ["home_mismatch", "환경의 HOME이 이 계정의 홈 폴더가 아니라 Claude Code를 실행하지 않는다. 로그인한 계정의 환경에서 Atlas를 다시 띄운다"],
    ["user_mismatch", "환경의 USER가 이 계정의 이름이 아니라 Claude Code를 실행하지 않는다. 로그인한 계정의 환경에서 Atlas를 다시 띄운다"],
    ["no_keychain_command", "환경의 PATH에 security가 없어 Claude Code를 실행하지 않는다. PATH에 /usr/bin을 넣고 Atlas를 다시 띄운다"],
  ] as const)("%s면 실행하지 않은 까닭과 고치는 방법을 적고 서버가 적은 글을 함께 낸다", (code, line) => {
    const unchecked = none("claude", code, [tried("env", null, code, "확인하지 못함: 서버가 적은 글")]);
    expect(told(unchecked)).toEqual([{ kind: "unchecked", line, detail: "확인하지 못함: 서버가 적은 글" }, line]);
  });

  it("목록에 없는 값이면 서버가 적은 글만 그대로 적는다", () => {
    const later = { ...none("claude", "ok", [tried("env", "/x/claude", "ok", "")]), code: "later_added" as Code };
    later.attempts = [{ ...tried("env", "/x/claude", "failed", "나중에 생긴 까닭"), code: "later_added" as Code }];
    expect(told(later)).toEqual([{ kind: "other" }, "나중에 생긴 까닭"]);
    expect(told(found("claude", { code: "later_added" as Code, note: "쓰지 못하는 새 까닭" }))).toEqual([{ kind: "other" }, "쓰지 못하는 새 까닭"]);
  });

  it("요약 칸은 요약 응답의 code로 경우를 가르고 경로와 글은 환경 점검의 값에서 읽는다", () => {
    const claude = none("claude", "failed", [tried("known", "/opt/homebrew/bin/claude", "failed", "종료 코드 127")]);
    expect(claudeState("failed", claude)).toEqual({ kind: "broken", path: "/opt/homebrew/bin/claude", detail: "종료 코드 127" });
    expect(claudeState("timeout", claude)).toEqual({ kind: "other" });
    expect(claudeState("not_logged_in", claude)).toEqual({ kind: "other" });
    expect(claudeState("style_guide_unreadable", found("claude"))).toEqual({ kind: "other" });
  });
});

describe("문구", () => {
  it("git을 찾았으면 적을 문장이 없다", () => {
    expect(gitLine(found("git"))).toBeNull();
  });

  it("git을 찾지 못했으면 꺼지는 기능을 적는다", () => {
    expect(gitLine(none("git", "not_found", [tried("known", "/opt/homebrew/bin/git", "missing", "없는 파일")]))).toBe("git을 찾지 못했다. 변경 표시와 시점 비교를 끈다");
  });

  it("Xcode Command Line Tools가 없어 실행하지 않았으면 설치 명령을 적는다", () => {
    const stub = none("git", "no_clt", [tried("known", "/opt/homebrew/bin/git", "missing", "없는 파일"), tried("known", "/usr/bin/git", "no_clt", "서버가 적은 글")]);
    expect(gitLine(stub)).toBe("Xcode Command Line Tools가 없다. 터미널에서 xcode-select --install을 실행한 뒤 다시 확인한다");
  });

  it("있는 git이 확인 명령을 통과하지 못했으면 그 경로와 글을 적는다", () => {
    const broken = none("git", "failed", [tried("saved", "/pick/git", "failed", "종료 코드 1")]);
    expect(gitLine(broken)).toBe("git을 실행하지 못했다: /pick/git (종료 코드 1). 변경 표시와 시점 비교를 끈다");
  });

  it("git의 code가 목록에 없는 값이면 서버가 적은 글만 그대로 적는다", () => {
    const later = none("git", "later_added" as Code, [{ ...tried("env", "/x/git", "failed", "나중에 생긴 까닭"), code: "later_added" as Code }]);
    expect(gitLine(later)).toBe("나중에 생긴 까닭");
  });

  it("로그인 셸은 읽었으면 걸린 초를, 읽지 못했으면 서버가 적은 까닭을, 읽지 않는 실행이면 그 사실을 적는다", () => {
    expect(shellLine({ shell: "/bin/zsh", ok: true, detail: "", seconds: 1.43 })).toBe("환경을 1.43초에 읽었다");
    const slow = "로그인 셸(zsh)이 10초 안에 환경을 알려 주지 않았다. 앱이 받은 환경과 알려진 설치 위치에서 도구를 찾는다";
    expect(shellLine({ shell: "/bin/zsh", ok: false, detail: slow, seconds: 10.02 })).toBe(slow);
    expect(shellLine(null)).toBe("터미널에서 띄웠으므로 그 터미널의 환경에서 도구를 찾는다");
  });

  it("응답 확인은 걸린 초나 답하지 않은 까닭을 적는다", () => {
    expect(answerLine({ ok: true, seconds: 3.2, detail: "" })).toBe("claude -p가 3.2초에 답했다");
    expect(answerLine({ ok: false, seconds: 0.4, detail: "종료 코드 1: Not logged in" })).toBe("claude -p가 답하지 않았다: 종료 코드 1: Not logged in");
  });

  it("앱의 판은 빌드한 앱에서만 커밋 해시와 빌드한 날을 적는다", () => {
    expect(aboutLine({ commit: "54fe2cf0a1b2c3d4", built: "2026-10-12", python: "3.13.16", basedpyright: "1.40.2" })).toBe(
      "Atlas 54fe2cf · 2026-10-12 빌드 · Atlas가 쓰는 Python 3.13.16 · basedpyright 1.40.2",
    );
    expect(aboutLine({ commit: null, built: null, python: "3.13.12", basedpyright: "1.40.2" })).toBe("Atlas가 쓰는 Python 3.13.12 · basedpyright 1.40.2");
  });

  it("출처의 이름을 적고 모르는 출처는 받은 글을 그대로 적는다", () => {
    expect(["saved", "env", "known", "other"].map(sourceName)).toEqual(["저장한 경로", "환경", "알려진 위치", "other"]);
  });

  it("저장한 경로는 통과했든 아니든 시도 기록에 남아 있으면 있는 것이다", () => {
    expect(saved(found("git"))).toBe(false);
    expect(saved(found("git", { source: "saved", attempts: [tried("saved", "/pick/git", "ok", "2.50.1")] }))).toBe(true);
    expect(saved(found("git", { attempts: [tried("saved", "/pick/git", "missing", "없는 파일"), tried("env", "/usr/bin/git", "ok", "2.50.1")] }))).toBe(true);
  });
});

describe("useTools", () => {
  it("화면을 띄우면 찾아 둔 결과와 앱의 판을 받는다", async () => {
    vi.mocked(getAbout).mockResolvedValue({ commit: null, built: null, python: "3.13.12", basedpyright: "1.40.2" });
    store().show();
    expect(store()).toMatchObject({ shown: true, busy: true });
    await settle();
    expect(store()).toMatchObject({ busy: false, error: null, tools: tools(), about: { python: "3.13.12" } });
    expect(postToolsCheck).not.toHaveBeenCalled();
    store().hide();
    expect(store().shown).toBe(false);
  });

  it("결과를 받지 못하면 까닭을 적고 앞의 결과를 둔다", async () => {
    await store().load();
    vi.mocked(getTools).mockRejectedValue(new ApiError("HTTP 500 Internal Server Error", 500));
    await store().load();
    expect(store()).toMatchObject({ busy: false, error: "HTTP 500 Internal Server Error", tools: tools() });
  });

  it("다시 확인은 다시 찾은 결과로 바꾸고 응답 확인의 결과와 저장하지 못한 까닭을 지운다", async () => {
    await store().load();
    useTools.setState({ answer: { ok: true, seconds: 1, detail: "" }, refused: { git: "실행하지 못했다" } });
    const again = tools({ claude: none("claude", "not_found", []) });
    vi.mocked(postToolsCheck).mockResolvedValue(again);
    await store().check();
    expect(store()).toMatchObject({ tools: again, answer: null, refused: {} });
  });

  it("늦게 온 결과는 버린다", async () => {
    let late!: (value: Tools) => void;
    vi.mocked(getTools).mockReturnValueOnce(new Promise((resolve) => (late = resolve)));
    const first = store().load();
    const again = tools({ git: none("git", "not_found", []) });
    vi.mocked(postToolsCheck).mockResolvedValue(again);
    await store().check();
    late(tools());
    await first;
    expect(store().tools).toEqual(again);
  });

  it("직접 고른 경로가 확인을 통과하면 그 도구의 결과만 바꾼다", async () => {
    await store().load();
    const picked = found("git", { path: "/pick/git", source: "saved", attempts: [tried("saved", "/pick/git", "ok", "2.50.1")] });
    vi.mocked(putTool).mockResolvedValue(picked);
    await store().keep("git", "/pick/git");
    expect(putTool).toHaveBeenCalledWith("git", "/pick/git");
    expect(store()).toMatchObject({ tools: tools({ git: picked }), busy: false });
    expect(store().refused.git).toBeUndefined();
  });

  it("직접 고른 경로가 확인을 통과하지 못하면 까닭을 적고 결과를 그대로 둔다", async () => {
    await store().load();
    vi.mocked(putTool).mockRejectedValue(new ApiError("실행하지 못했다: /pick/notes.txt (실행 권한 없음)", 400));
    await store().keep("claude", "/pick/notes.txt");
    expect(store()).toMatchObject({ tools: tools(), busy: false, refused: { claude: "실행하지 못했다: /pick/notes.txt (실행 권한 없음)" } });
  });

  it("저장한 경로를 지우면 다시 찾은 결과로 바꾼다", async () => {
    await store().load();
    useTools.setState({ refused: { claude: "실행하지 못했다" } });
    const again = found("claude", { source: "known" });
    vi.mocked(deleteTool).mockResolvedValue(again);
    await store().forget("claude");
    expect(deleteTool).toHaveBeenCalledWith("claude");
    expect(store().tools?.claude).toEqual(again);
    expect(store().refused.claude).toBeUndefined();
  });

  it("응답 확인은 기다리는 동안 asking이고 받은 결과를 둔다", async () => {
    let answer!: (value: { ok: boolean; seconds: number; detail: string }) => void;
    vi.mocked(postClaudeAsk).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const asking = store().ask();
    expect(store().answer).toBe("asking");
    answer({ ok: true, seconds: 2.5, detail: "" });
    await asking;
    expect(store().answer).toEqual({ ok: true, seconds: 2.5, detail: "" });
  });

  it("응답 확인의 요청이 실패하면 답하지 않은 것으로 적는다", async () => {
    vi.mocked(postClaudeAsk).mockRejectedValue(new ApiError("HTTP 502 Bad Gateway", 502));
    await store().ask();
    expect(store().answer).toEqual({ ok: false, seconds: 0, detail: "HTTP 502 Bad Gateway" });
  });
});
