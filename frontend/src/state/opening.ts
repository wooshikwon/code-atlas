// 레포를 여는 단계. 고른 폴더의 판정을 서버에서 받아 설계 명세 "레포 열기"의 순서대로 열 수 없음을 알리거나, 프로젝트 루트·품은
// 프로젝트·인터프리터를 묻거나, 연다. 무엇이 프로젝트 루트이고 어느 인터프리터가 맞는지는 서버가 정하고 여기서는 받은 값의 순서만 정한다.
// 레포를 열거나 닫으면 페이지를 다시 읽는다. 연 적이 있는 레포의 목록도 여기에 둔다.
import { create } from "zustand";
import { deleteRepo, getInterpreters, getRepos, postClose, postOpen, postProbe } from "../api/client";
import type { Found, Probe, RecentRepo } from "../api/types";
import { host } from "../host";

export type Step =
  | { kind: "idle" }
  | { kind: "probing"; path: string }
  | { kind: "blocked"; path: string; reason: "missing" | "no-python-files" }
  /** 프로젝트 루트를 열지 고른 폴더를 그대로 열지 */
  | { kind: "ask-project"; path: string; project: string }
  /** 프로젝트 여러 개를 품은 폴더 */
  | { kind: "ask-nested"; path: string; nested: string[] }
  /** seeking이면 이 기기의 인터프리터를 찾는 중이라 candidates가 아직 비어 있다. error는 고른 인터프리터로 열지 못한 까닭이다. */
  | { kind: "ask-python"; path: string; found: Found; candidates: Found[]; seeking?: true; error?: string }
  | { kind: "opening"; path: string }
  | { kind: "failed"; path: string; error: string };

/** 묻지 않고 정하는 것. asIs면 프로젝트 루트와 품은 프로젝트를 묻지 않고 고른 폴더를 그대로 열고, python은 인터프리터를 고르는 화면에서 고른 경로다. */
export interface As {
  asIs?: boolean;
  python?: string;
}

export interface OpeningStore {
  step: Step;
  /** 브라우저에서 폴더의 경로를 받는 입력 창이 떠 있다 */
  typing: boolean;
  /** 연 적이 있는 레포. 마지막으로 연 레포가 앞이다. */
  repos: RecentRepo[];
  /** 열 폴더를 받는다. 앱은 폴더 선택 대화상자를 띄워 고른 폴더를 choose에 넘기고, 브라우저는 경로 입력 창을 띄운다. */
  browse(): Promise<void>;
  /** 폴더를 판정하고 다음 단계로 간다. 열 수 있으면 열고 페이지를 다시 읽는다. python을 주면 판정하지 않고 그 인터프리터로 연다. */
  choose(path: string, as?: As): Promise<void>;
  /** 끌어다 놓은 경로 가운데 첫 폴더를 choose에 넘긴다. 폴더가 없으면 첫 경로를 열 수 없다고 알린다. */
  drop(paths: string[]): Promise<void>;
  /** path 레포의 인터프리터를 고르는 화면을 띄운다. found는 그 레포에서 지금 찾은 인터프리터다. */
  pick(path: string, found: Found): Promise<void>;
  /** 묻는 창과 경로 입력 창을 닫는다. 판정을 기다리는 중이면 그 결과를 버린다. */
  cancel(): void;
  /** 연 레포를 닫고 페이지를 다시 읽는다. */
  close(): Promise<void>;
  list(): Promise<void>;
  /** 목록에서 레포를 지운다. 폴더와 캐시는 그대로다. */
  forget(root: string): Promise<void>;
}

/** 경로의 마지막 마디 */
export function nameOf(path: string): string {
  return path.split("/").filter((part) => part !== "").at(-1) ?? path;
}

/**
 * 판정을 받은 폴더의 다음 단계. 폴더가 없거나 `.py` 파일이 없으면 열지 못하고, 조상에 프로젝트 루트가 있으면 어느 쪽을 열지 묻고,
 * 프로젝트를 둘 이상 품었으면 하나를 고르게 하고, 인터프리터를 찾지 못했으면 고르게 하고, 그 밖에는 연다. asIs면 앞의 두 물음을 건너뛴다.
 */
export function next(probe: Probe, as: { asIs?: boolean }): Step {
  const { path } = probe;
  if (!probe.exists || !probe.python_files) {
    return { kind: "blocked", path, reason: probe.exists ? "no-python-files" : "missing" };
  }
  if (probe.project !== null && as.asIs !== true) {
    return { kind: "ask-project", path, project: probe.project };
  }
  if (probe.nested.length >= 2 && as.asIs !== true) {
    return { kind: "ask-nested", path, nested: probe.nested };
  }
  if (probe.python.path === null) {
    return { kind: "ask-python", path, found: probe.python, candidates: [] };
  }
  return { kind: "opening", path };
}

/** 묻는 창이나 경로 입력 창이 떠 있다. Esc가 이 창을 먼저 닫는다. */
export function asking(state: Pick<OpeningStore, "step" | "typing">): boolean {
  return state.typing || (state.step.kind !== "idle" && state.step.kind !== "opening");
}

/** 페이지를 다시 읽는다. 레포마다의 화면 상태를 모두 버리고 화면 설정만 남긴다. */
export function reread(): void {
  location.reload();
}

/** 인터프리터를 고르는 화면에 찾은 목록을 넣는다. */
function sought<S extends Extract<Step, { kind: "ask-python" }>>(step: S, candidates: Found[]): Omit<S, "seeking"> {
  const { seeking: _, ...rest } = step;
  return { ...rest, candidates };
}

const reason = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

export const useOpening = create<OpeningStore>()((set, get) => {
  /** choose와 cancel을 부른 횟수. 기다리는 동안 달라졌으면 그 결과를 버린다. */
  let turn = 0;

  /** 인터프리터 목록을 청한 횟수 */
  let asked = 0;
  /** 받았을 때 인터프리터를 고르는 화면이 떠 있지 않아 넣지 못한 목록. 그 화면으로 돌아갈 때 넣는다. */
  let late: Found[] | null = null;

  /**
   * 인터프리터를 고르는 화면을 띄우고 이 기기의 인터프리터를 받아 목록에 넣는다. 관리자 명령과 후보마다의 확인을 차례로 실행하는
   * 요청이라 몇 초가 걸리므로 화면을 먼저 띄운다. 받지 못하면 빈 목록이다.
   */
  const ask = async (path: string, found: Found): Promise<void> => {
    asked += 1;
    const mine = asked;
    late = null;
    set({ step: { kind: "ask-python", path, found, candidates: [], seeking: true } });
    const candidates = await getInterpreters().then(
      (received) => received.found,
      () => [],
    );
    if (mine !== asked) {
      return;
    }
    const step = get().step;
    if (step.kind === "ask-python") {
      set({ step: sought(step, candidates) });
    } else {
      late = candidates;
    }
  };

  /** 판정을 받은 폴더를 다음 단계로 보낸다. */
  const proceed = async (probe: Probe, as: As, mine: number): Promise<void> => {
    const step = next(probe, as);
    if (step.kind === "ask-python") {
      await ask(step.path, step.found);
      return;
    }
    if (step.kind === "opening") {
      await open(step.path, undefined, mine);
    } else {
      set({ step });
    }
  };

  /** 레포를 열고 페이지를 다시 읽는다. 고른 인터프리터로 열지 못하면 인터프리터를 고르는 화면에 까닭을 적는다. */
  const open = async (path: string, python: string | undefined, mine: number): Promise<void> => {
    const before = get().step;
    set({ step: { kind: "opening", path } });
    try {
      await postOpen(path, python);
      reread();
    } catch (caught) {
      if (mine !== turn) {
        return;
      }
      const error = reason(caught);
      if (before.kind === "ask-python" && python !== undefined) {
        set({ step: { ...(before.seeking === true && late !== null ? sought(before, late) : before), error } });
      } else {
        set({ step: { kind: "failed", path, error } });
      }
    }
  };

  return {
    step: { kind: "idle" },
    typing: false,
    repos: [],
    browse: async () => {
      if (!host.app) {
        set({ typing: true });
        return;
      }
      const path = await host.pickFolder();
      if (path !== null) {
        await get().choose(path);
      }
    },
    choose: async (path, as = {}) => {
      turn += 1;
      const mine = turn;
      if (as.python !== undefined) {
        set({ typing: false });
        await open(path, as.python, mine);
        return;
      }
      set({ typing: false, step: { kind: "probing", path } });
      try {
        const probe = await postProbe(path);
        if (mine === turn) {
          await proceed(probe, as, mine);
        }
      } catch (caught) {
        if (mine === turn) {
          set({ step: { kind: "failed", path, error: reason(caught) } });
        }
      }
    },
    drop: async (paths) => {
      if (paths.length === 0) {
        return;
      }
      turn += 1;
      const mine = turn;
      set({ typing: false, step: { kind: "probing", path: paths[0] } });
      try {
        const probes: Probe[] = [];
        for (const path of paths) {
          const probe = await postProbe(path);
          if (mine !== turn) {
            return;
          }
          probes.push(probe);
          if (probe.exists) {
            break;
          }
        }
        await proceed(probes.find((probe) => probe.exists) ?? probes[0], {}, mine);
      } catch (caught) {
        if (mine === turn) {
          set({ step: { kind: "failed", path: paths[0], error: reason(caught) } });
        }
      }
    },
    pick: async (path, found) => {
      turn += 1;
      set({ typing: false });
      await ask(path, found);
    },
    cancel: () => {
      turn += 1;
      set({ typing: false, step: { kind: "idle" } });
    },
    close: async () => {
      // 닫지 못했으면 다시 읽은 화면이 서버의 지금 상태를 그린다.
      await postClose().catch(() => undefined);
      reread();
    },
    list: async () => {
      try {
        set({ repos: (await getRepos()).repos });
      } catch {
        // 받지 못하면 직전 목록을 그대로 둔다.
      }
    },
    forget: async (root) => {
      await deleteRepo(root).catch(() => undefined);
      await get().list();
    },
  };
});
