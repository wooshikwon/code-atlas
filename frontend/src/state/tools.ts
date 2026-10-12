// 환경 점검의 값. 로그인 셸의 환경, `claude`, `git`, 연 레포의 인터프리터를 서버가 찾은 결과를 받아 두고, 다시 찾기·직접 고른 경로의
// 저장과 지우기·`응답 확인`을 서버에 청한다. 후보의 순서와 확인 방법은 서버가 정하고, 여기서는 받은 결과를 화면에 적을 문구로 옮긴다.
import { create } from "zustand";
import { deleteTool, getAbout, getTools, postClaudeAsk, postToolsCheck, putTool } from "../api/client";
import type { About, Answer, Found, Pickable, ShellEnv, Tools } from "../api/types";

/** 서버(`tools.py`)가 시도 기록과 `note`에 적는 까닭 가운데 화면이 경우를 가르는 데 쓰는 것 */
const ABSENT = "없는 파일";
const NOT_LOGGED_IN = "Claude Code에 로그인돼 있지 않다";
const NO_CLT = "Xcode Command Line Tools가 없다";

export const INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
export const LOGIN = "claude auth login";

const SOURCES: Record<string, string> = { saved: "저장한 경로", env: "환경", known: "알려진 위치" };

/** 후보의 출처를 화면에 적는 이름 */
export function sourceName(source: string): string {
  return SOURCES[source] ?? source;
}

/**
 * `claude`를 쓸 수 있는지와 쓰지 못하는 경우. missing은 있는 후보가 없고, broken은 있는 후보가 확인 명령을 통과하지 못했고,
 * logged-out은 로그인돼 있지 않고, blocked는 그 밖의 까닭(로그인 여부를 묻는 명령이 답하지 않음)이다.
 */
export type ClaudeState =
  | { kind: "ready" }
  | { kind: "missing" }
  | { kind: "broken"; path: string; detail: string }
  | { kind: "logged-out"; path: string }
  | { kind: "blocked"; note: string };

export function claudeState(found: Found): ClaudeState {
  if (found.path === null) {
    const tried = found.attempts.find((attempt) => !attempt.ok && attempt.path !== null && attempt.detail !== ABSENT);
    return tried === undefined ? { kind: "missing" } : { kind: "broken", path: tried.path!, detail: tried.detail };
  }
  if (found.note === null) {
    return { kind: "ready" };
  }
  return found.note === NOT_LOGGED_IN ? { kind: "logged-out", path: found.path } : { kind: "blocked", note: found.note };
}

/** `claude`를 쓰지 못하는 까닭을 적는 문장. 쓸 수 있으면 null이다. */
export function claudeLine(state: ClaudeState): string | null {
  switch (state.kind) {
    case "ready":
      return null;
    case "missing":
      return "Claude Code CLI를 찾지 못했다";
    case "broken":
      return `Claude Code CLI를 실행하지 못했다: ${state.path} (${state.detail})`;
    case "logged-out":
      return NOT_LOGGED_IN;
    case "blocked":
      return state.note;
  }
}

/** `git`을 쓰지 못할 때 적는 문장. 찾았으면 null이다. */
export function gitLine(found: Found): string | null {
  if (found.path !== null) {
    return null;
  }
  return found.attempts.some((attempt) => attempt.detail === NO_CLT)
    ? `${NO_CLT}. 터미널에서 xcode-select --install을 실행한 뒤 다시 확인한다`
    : "git을 찾지 못했다. 변경 표시와 시점 비교를 끈다";
}

/** 로그인 셸의 환경을 읽은 결과를 적는 문장. shell이 null이면 터미널에서 띄운 실행이다. */
export function shellLine(shell: ShellEnv | null): string {
  if (shell === null) {
    return "터미널에서 띄웠으므로 그 터미널의 환경에서 도구를 찾는다";
  }
  return shell.ok ? `환경을 ${shell.seconds}초에 읽었다` : shell.detail;
}

/** `응답 확인`의 결과를 적는 문장 */
export function answerLine(answer: Answer): string {
  return answer.ok ? `claude -p가 ${answer.seconds}초에 답했다` : `claude -p가 답하지 않았다: ${answer.detail}`;
}

/** 앱의 판을 적는 줄. 빌드 명령으로 만든 앱이면 커밋 해시의 앞 7자와 빌드한 날이 앞에 온다. */
export function aboutLine(about: About): string {
  return [
    about.commit === null ? null : `Atlas ${about.commit.slice(0, 7)}`,
    about.built === null ? null : `${about.built} 빌드`,
    `Atlas가 쓰는 Python ${about.python}`,
    `basedpyright ${about.basedpyright}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** 직접 골라 저장한 경로가 있는지. 저장한 경로는 통과했든 아니든 시도 기록의 맨 앞에 남는다. */
export function saved(found: Found): boolean {
  return found.attempts.some((attempt) => attempt.source === "saved");
}

export interface ToolsStore {
  /** 환경 점검 화면이 떠 있다 */
  shown: boolean;
  /** 서버가 찾은 결과. 아직 받지 않았으면 null이다. */
  tools: Tools | null;
  /** 앱의 판. 받지 못했으면 null이다. */
  about: About | null;
  /** 결과를 받는 중이거나 다시 찾는 중이다 */
  busy: boolean;
  /** 결과를 받지 못한 까닭 */
  error: string | null;
  /** 직접 고른 경로를 저장하지 못한 까닭. 도구마다 마지막으로 고른 경로의 것이다. */
  refused: Partial<Record<Pickable, string>>;
  /** `응답 확인`의 결과. 기다리는 중이면 asking이다. */
  answer: Answer | "asking" | null;
  /** 환경 점검 화면을 띄우고 결과를 받는다. */
  show(): void;
  hide(): void;
  /** 서버가 찾아 둔 결과를 받는다. */
  load(): Promise<void>;
  /** 찾아 둔 값을 버리고 다시 찾게 한다. */
  check(): Promise<void>;
  /** 직접 고른 실행 파일을 그 도구의 경로로 저장한다. 서버가 실행해 확인하지 못하면 저장하지 않고 까닭을 refused에 적는다. */
  keep(tool: Pickable, path: string): Promise<void>;
  /** 저장한 경로를 지우고 그 도구를 다시 찾게 한다. */
  forget(tool: Pickable): Promise<void>;
  /** `claude -p`에 요청 하나를 보내 답하는지 본다. */
  ask(): Promise<void>;
}

const reason = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

export const useTools = create<ToolsStore>()((set, get) => {
  /** 결과를 청한 횟수. 기다리는 동안 다른 요청을 보냈으면 늦게 온 결과를 버린다. */
  let turn = 0;

  /** 네 결과를 통째로 받는 요청 */
  const receive = async (request: () => Promise<Tools>): Promise<void> => {
    turn += 1;
    const mine = turn;
    set({ busy: true, error: null });
    try {
      const tools = await request();
      if (mine === turn) {
        set({ tools, busy: false });
      }
    } catch (caught) {
      if (mine === turn) {
        set({ busy: false, error: reason(caught) });
      }
    }
  };

  /** 도구 하나의 결과를 받는 요청. 받은 결과로 그 도구의 값만 바꾼다. */
  const replace = async (tool: Pickable, request: () => Promise<Found>): Promise<void> => {
    turn += 1;
    const mine = turn;
    set({ busy: true, refused: { ...get().refused, [tool]: undefined }, answer: null });
    try {
      const found = await request();
      const tools = get().tools;
      if (mine === turn) {
        set({ tools: tools === null ? null : { ...tools, [tool]: found }, busy: false });
      }
    } catch (caught) {
      if (mine === turn) {
        set({ busy: false, refused: { ...get().refused, [tool]: reason(caught) } });
      }
    }
  };

  return {
    shown: false,
    tools: null,
    about: null,
    busy: false,
    error: null,
    refused: {},
    answer: null,
    show: () => {
      set({ shown: true, refused: {}, answer: null });
      void get().load();
      if (get().about === null) {
        getAbout().then(
          (about) => set({ about }),
          () => undefined,
        );
      }
    },
    hide: () => set({ shown: false }),
    load: () => receive(getTools),
    check: () => {
      set({ refused: {}, answer: null });
      return receive(postToolsCheck);
    },
    keep: (tool, path) => replace(tool, () => putTool(tool, path)),
    forget: (tool) => replace(tool, () => deleteTool(tool)),
    ask: async () => {
      set({ answer: "asking" });
      try {
        set({ answer: await postClaudeAsk() });
      } catch (caught) {
        set({ answer: { ok: false, seconds: 0, detail: reason(caught) } });
      }
    },
  };
});
