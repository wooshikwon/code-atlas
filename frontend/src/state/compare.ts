// 시점 비교의 상태. 비교 창이 펴져 있는지와 창의 크기, 받은 커밋 그래프, 고른 두 줄과 그 기준·대상·줄 수, 분석 중인지, 켜져 있는 비교를 담는다.
// 비교를 켜면 비교 결과의 그래프와 파일트리로 화면을 바꾸고 보던 화면은 그대로 둔다(`useAtlas`의 `refresh`). 끄면 작업 중인 상태의
// 그래프를 다시 받아 같은 방법으로 되돌린다. 탐색 이력과 무관하므로 화면 상태 저장소와 따로 두고, 창의 크기만 localStorage에 쓴다.
import { create } from "zustand";
import { getGraph, getHistory, getRepo, getStat, getTree, getUnused, postCompare } from "../api/client";
import { WORKTREE, type Comparison, type History, type Stat } from "../api/types";
import { useOverlay } from "./overlay";
import { useAtlas } from "./store";

/** 커밋 그래프를 한 번에 받는 줄 수 */
export const PAGE = 200;

const SIZE_KEY = "code-atlas:compare:v1";

export interface Size {
  width: number;
  height: number;
}

export interface CompareStore {
  /** 비교 창이 펴져 있다 */
  open: boolean;
  /** 크기 조절 손잡이로 바꾼 창의 크기. 바꾼 적이 없으면 null이고 창이 처음 크기를 정한다. */
  size: Size | null;
  /** 받은 커밋 그래프. commits는 받은 묶음을 이어 붙인 것이다. 아직 받지 못했으면 null이다. */
  history: History | null;
  /** 고른 줄의 해시나 `worktree`. 누른 순서로 두 개까지 담는다. */
  picks: string[];
  /** 고른 두 줄의 기준·대상·갈라진 지점과 줄 수. 두 줄을 고르지 않았거나 아직 받지 못했으면 null이다. */
  stat: Stat | null;
  /** 확인을 누른 뒤 분석하는 중. 진행 수는 `useStatus`의 `status.compare`에 있다. */
  running: boolean;
  /** 마지막 요청이 실패한 까닭. 다음 요청을 시작하면 지운다. */
  error: string | null;
  /** 켜져 있는 비교. 비교가 꺼져 있으면 null이다. */
  result: Comparison | null;
  /** 켜져 있는 비교의 두 시점과 줄 수. 줄 수는 result의 files를 더한 값이다. */
  shown: Stat | null;
  /** 창을 펴거나 접는다. 펼 때마다 커밋 그래프의 첫 묶음을 다시 받고, 처음 펼 때 `firstPicks`의 줄을 골라 둔다. */
  toggle(): void;
  /** 커밋 그래프의 다음 묶음을 받아 잇는다. 더 받을 줄이 없거나 받는 중이면 아무것도 하지 않는다. */
  extend(): Promise<void>;
  /** 줄을 고른다. 고른 줄이면 풀고, 두 줄을 고른 채면 먼저 고른 줄을 뺀다. 두 줄이 되면 stat을 받는다. */
  pick(id: string): void;
  resize(size: Size): void;
  /** 창을 닫고 stat의 두 시점을 견준 결과를 받아 그래프와 파일트리를 바꾸고 분석 표시를 compare로 켠다. stat이 없으면 아무것도 하지 않는다. */
  confirm(): Promise<void>;
  /** 켜져 있는 비교를 같은 두 시점으로 다시 받아 그린다. 받지 못하면 던진다. */
  renew(): Promise<void>;
  /** 비교를 끄고 작업 중인 상태의 그래프와 파일트리로 되돌린다. 분석하는 중이면 그 결과를 받지 않는다. */
  clear(): Promise<void>;
}

/** localStorage에 저장한 문자열에서 창의 크기를 읽는다. 형태가 맞지 않으면 null이다. */
export function parseSize(raw: string | null): Size | null {
  try {
    const saved = JSON.parse(raw ?? "null") as Record<string, unknown> | null;
    const sides = [saved?.width, saved?.height];
    return sides.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0) ? { width: sides[0] as number, height: sides[1] as number } : null;
  } catch {
    return null;
  }
}

/**
 * 창을 처음 펼 때 골라 두는 줄. 커밋하지 않은 `.py` 변경이 있으면 지금 커밋과 작업 중인 상태를, 없으면 기본 브랜치의 커밋과 지금 커밋을
 * 고른다. 두 값이 같거나 기본 브랜치가 없으면 지금 커밋과 그 첫째 부모를 고르고, 부모를 모르면 지금 커밋 하나만 고른다.
 */
export function firstPicks(history: History): string[] {
  const { head, dirty, commits } = history;
  if (head === null) {
    return [];
  }
  const [older, newer] = dirty ? [head, WORKTREE] : [history.default, head];
  if (older !== null && older !== newer) {
    return [older, newer];
  }
  const parent = commits.find((c) => c.hash === head)?.parents[0];
  return parent === undefined ? [head] : [parent, head];
}

function reason(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export const useCompare = create<CompareStore>()((set, get) => {
  /** 창을 편 횟수. 접은 뒤에 도착한 커밋 그래프를 버린다. */
  let opened = 0;
  let extending = false;
  /** 비교를 받기 시작한 횟수. 뒤의 요청이나 끄기가 시작된 뒤에 도착한 결과를 버린다. */
  let asked = 0;
  let clearing: Promise<void> | null = null;

  const measure = (picks: string[]) => {
    set({ picks, stat: null, error: null });
    if (picks.length < 2) {
      return;
    }
    const same = () => get().picks === picks;
    getStat(picks[0], picks[1]).then(
      (stat) => same() && set({ stat }),
      (caught: unknown) => same() && set({ error: reason(caught) }),
    );
  };

  /** 받은 비교로 그래프와 파일트리를 바꾼다. fork는 그 비교의 갈라진 지점이다. */
  const draw = (result: Comparison, fork: string | null) => {
    const atlas = useAtlas.getState();
    if (atlas.repo === null) {
      return;
    }
    const lines = (side: "added" | "deleted") => result.files.reduce((sum, file) => sum + file[side], 0);
    const shown = { base: result.base, target: result.target, fork, files: result.files.length, added: lines("added"), deleted: lines("deleted") };
    set({ result, shown });
    atlas.refresh(atlas.repo, result.graph, result.tree);
    useOverlay.getState().mark(result.unused);
    useOverlay.getState().set("compare");
  };

  const restore = async () => {
    try {
      const [repo, graph, tree, unused] = await Promise.all([getRepo(), getGraph(), getTree(), getUnused().catch(() => null)]);
      set({ result: null, shown: null, error: null });
      useAtlas.getState().refresh(repo, graph, tree);
      if (unused !== null) {
        useOverlay.getState().mark(unused);
      }
      if (useOverlay.getState().kind === "compare") {
        useOverlay.getState().set(null);
      }
    } catch (caught) {
      set({ error: reason(caught) });
    }
  };

  return {
    open: false,
    size: typeof localStorage === "undefined" ? null : parseSize(localStorage.getItem(SIZE_KEY)),
    history: null,
    picks: [],
    stat: null,
    running: false,
    error: null,
    result: null,
    shown: null,

    toggle: () => {
      opened += 1;
      if (get().open) {
        set({ open: false });
        return;
      }
      set({ open: true });
      const turn = opened;
      const first = get().history === null;
      getHistory(0, PAGE).then(
        (history) => {
          if (turn !== opened) {
            return;
          }
          set({ history });
          if (first) {
            measure(firstPicks(history));
          }
        },
        (caught: unknown) => turn === opened && set({ error: reason(caught) }),
      );
    },
    extend: async () => {
      const before = get().history;
      if (before === null || !before.more || extending) {
        return;
      }
      extending = true;
      try {
        const next = await getHistory(before.commits.length, PAGE);
        if (get().history === before) {
          const known = new Set(before.commits.map((c) => c.hash));
          set({ history: { ...next, commits: [...before.commits, ...next.commits.filter((c) => !known.has(c.hash))] } });
        }
      } catch (caught) {
        set({ error: reason(caught) });
      } finally {
        extending = false;
      }
    },
    pick: (id) => {
      const { picks } = get();
      measure(picks.includes(id) ? picks.filter((p) => p !== id) : [...picks, id].slice(-2));
    },
    resize: (size) => {
      set({ size });
      localStorage.setItem(SIZE_KEY, JSON.stringify(size));
    },
    confirm: async () => {
      const { stat } = get();
      if (stat === null) {
        return;
      }
      asked += 1;
      const turn = asked;
      set({ open: false, running: true, error: null });
      try {
        const result = await postCompare(stat.base, stat.target);
        if (turn === asked) {
          draw(result, stat.fork);
        }
      } catch (caught) {
        if (turn === asked) {
          set({ error: reason(caught) });
        }
      }
      if (turn === asked) {
        set({ running: false });
      }
    },
    renew: async () => {
      const { result, shown } = get();
      if (result === null) {
        return;
      }
      const next = await postCompare(result.base, result.target);
      if (get().result === result) {
        draw(next, shown?.fork ?? null);
      }
    },
    clear: () => {
      asked += 1;
      set({ running: false });
      if (get().result === null) {
        return Promise.resolve();
      }
      return (clearing ??= restore().finally(() => (clearing = null)));
    },
  };
});
