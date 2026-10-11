// 코드 뷰어에서 고른 줄 범위마다의 LLM 설명과 설명 요청. 요청은 코드 뷰어가 아니라 이 저장소가 보내므로
// 다른 노드를 골라 코드 뷰어가 바뀌어도 끝까지 간다. 만든 설명은 서버가 저장해 두고 파일마다 다시 읽는다.
import { create } from "zustand";
import { deleteExplanation, getExplanations, makeExplanation } from "../api/client";

/** stale은 설명을 만든 뒤 그 줄 범위의 코드가 바뀌었다는 뜻이다. */
export type NoteState =
  | { phase: "making" }
  | { phase: "done"; text: string; stale: boolean }
  | { phase: "failed"; error: string; refresh: boolean };

/** 파일의 줄 범위 하나와 그 설명. start와 end는 1부터 세는 파일 줄 번호다. */
export interface Note {
  start: number;
  end: number;
  state: NoteState;
}

export interface ExplanationStore {
  /** 레포 루트 기준 파일 경로 → 그 파일의 설명. 시작 줄 순서다. 서버에서 읽은 적이 없는 파일은 없다. */
  files: Record<string, Note[]>;
  /** 파일에 저장해 둔 설명을 읽는다. 이미 읽은 파일은 다시 읽지 않는다. */
  load(path: string): void;
  /** 줄 범위의 설명을 만든다. refresh면 캐시에 있어도 다시 만든다. 만드는 중인 범위에는 요청을 다시 보내지 않는다. */
  make(path: string, start: number, end: number, refresh: boolean): void;
  /** 줄 범위의 설명을 지운다. */
  remove(path: string, start: number, end: number): void;
}

export function noteKey(note: { start: number; end: number }): string {
  return `${note.start}-${note.end}`;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const useExplanations = create<ExplanationStore>()((set, get) => {
  const loading = new Set<string>();

  /** 파일의 설명 목록에서 그 줄 범위의 설명을 state로 바꾼다. state가 null이면 뺀다. */
  const put = (path: string, start: number, end: number, state: NoteState | null) =>
    set((store) => {
      const rest = (store.files[path] ?? []).filter((note) => note.start !== start || note.end !== end);
      const notes = state === null ? rest : [...rest, { start, end, state }].sort((a, b) => a.start - b.start || a.end - b.end);
      return { files: { ...store.files, [path]: notes } };
    });

  const find = (path: string, start: number, end: number) =>
    get().files[path]?.find((note) => note.start === start && note.end === end);

  return {
    files: {},
    load: (path) => {
      if (loading.has(path)) {
        return;
      }
      loading.add(path);
      getExplanations(path).then(
        ({ explanations }) => {
          // 읽는 동안 만들기 시작했거나 끝난 범위는 화면의 상태를 그대로 둔다.
          for (const { start, end, text, stale } of explanations) {
            if (find(path, start, end) === undefined) {
              put(path, start, end, { phase: "done", text, stale });
            }
          }
          set((store) => (path in store.files ? store : { files: { ...store.files, [path]: [] } }));
        },
        () => loading.delete(path),
      );
    },
    make: (path, start, end, refresh) => {
      if (find(path, start, end)?.state.phase === "making") {
        return;
      }
      put(path, start, end, { phase: "making" });
      makeExplanation(path, start, end, refresh).then(
        (made) => put(path, start, end, { phase: "done", text: made.text, stale: made.stale }),
        (error: unknown) => put(path, start, end, { phase: "failed", error: message(error), refresh }),
      );
    },
    remove: (path, start, end) => {
      put(path, start, end, null);
      deleteExplanation(path, start, end).catch(() => {
        // 저장한 적이 없는 설명(만들다 실패한 범위)은 서버에 지울 것이 없다.
      });
    },
  };
});
