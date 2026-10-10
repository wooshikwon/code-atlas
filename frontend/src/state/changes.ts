// 마지막 커밋 뒤의 변경 내용. 탐색 이력과 무관하므로 화면 상태 저장소와 따로 둔다.
// 레포를 연 뒤 한 번, 창이 포커스를 받을 때, 15초마다 다시 받는다.
import { create } from "zustand";
import { getChanges } from "../api/client";
import type { Change, Changes } from "../api/types";

/** 변경 내용을 다시 받는 간격(ms) */
const INTERVAL = 15_000;

/** 파일 상자와 파일트리 행에 적는 글자 */
export const CHANGE_LETTERS: Record<Change, string> = { modified: "M", added: "A" };

export const CHANGE_NAMES: Record<Change, string> = { modified: "수정됨", added: "추가됨" };

export interface ChangeStore {
  /** 아직 받지 못했으면 null이다. */
  changes: Changes | null;
  /** 변경 내용을 다시 받는다. 응답이 직전과 같으면 상태를 바꾸지 않는다. */
  load(): Promise<void>;
}

export const useChanges = create<ChangeStore>()((set, get) => {
  let loading = false;
  return {
    changes: null,
    load: async () => {
      if (loading) {
        return;
      }
      loading = true;
      try {
        const changes = await getChanges();
        if (JSON.stringify(changes) !== JSON.stringify(get().changes)) {
          set({ changes });
        }
      } catch {
        // 받지 못하면 직전 값을 그대로 둔다.
      } finally {
        loading = false;
      }
    },
  };
});

/** 변경 내용을 받고, 창이 포커스를 받을 때와 15초마다 다시 받는다. 돌려주는 함수가 다시 받기를 멈춘다. */
export function watch(): () => void {
  const load = () => void useChanges.getState().load();
  load();
  window.addEventListener("focus", load);
  const timer = window.setInterval(load, INTERVAL);
  return () => {
    window.removeEventListener("focus", load);
    window.clearInterval(timer);
  };
}

/** 폴더(패키지 노드 id) 자신이나 그 안의 노드 가운데 바뀐 것이 있다. */
export function inside(nodes: Record<string, Change>, folder: string): boolean {
  return Object.keys(nodes).some((id) => id === folder || id.startsWith(`${folder}.`) || id.startsWith(`${folder}:`));
}

/** 노드의 변경 상태. 바뀌지 않았으면 null이다. */
export function useChange(id: string | null): Change | null {
  return useChanges((s) => (id === null ? undefined : s.changes?.nodes[id]) ?? null);
}

/** 접힌 폴더 상자의 변경 상태. 안에 바뀐 노드가 있으면 수정이다. */
export function useFolderChange(id: string): Change | null {
  return useChanges((s) => (s.changes !== null && inside(s.changes.nodes, id) ? "modified" : null));
}

/** 현재 git 브랜치 이름. git 저장소가 아니거나 브랜치 위가 아니면 null이다. */
export function useBranch(): string | null {
  return useChanges((s) => (s.changes?.git === true ? s.changes.branch : null));
}

/** 레포를 열어 분석한 뒤 내용이 바뀐 파일 수. 마지막 커밋과 같아 변경 표시가 없는 파일도 센다. */
export function staleCount(changes: Changes | null): number {
  return changes?.files.filter((f) => f.stale).length ?? 0;
}

export function useStaleCount(): number {
  return useChanges((s) => staleCount(s.changes));
}
