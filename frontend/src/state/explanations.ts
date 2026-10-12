// 코드 뷰어에서 고른 줄 범위마다의 코드 분석(LLM의 설명이나 질문의 답)과 그 요청. 요청은 코드 뷰어가 아니라 이 저장소가 보내므로
// 다른 노드를 골라 코드 뷰어가 바뀌어도 끝까지 간다. 만든 분석은 서버가 파일과 줄 범위, 질문에 묶어 저장해 두고 파일마다 한 번에 다시 읽는다.
import { create } from "zustand";
import { deleteExplanation, getExplanations, makeExplanation } from "../api/client";
import type { MarkedCode, OldSpan, Usage } from "../api/types";

/** stale은 분석을 만든 뒤 그 줄 범위의 코드가 바뀌었다는 뜻이다. usage는 이 화면에서 만든 분석의 호출이 쓴 토큰 수다. */
export type NoteState =
  | { phase: "making" }
  | { phase: "done"; text: string; stale: boolean; usage: Usage | null }
  | { phase: "failed"; error: string; refresh: boolean };

/**
 * 파일의 줄 범위 하나와 그 설명. start와 end는 1부터 세는 파일 줄 번호다. 두 시점을 엮은 문서에서 고른, 삭제된 줄이 든 범위는 old에
 * 기준 시점의 시작 줄과 끝 줄을 담고, start와 end는 대상 시점의 줄(그 범위에 대상 시점의 줄이 없으면 0)이다.
 */
export interface Note {
  start: number;
  end: number;
  old?: [number, number];
  /** 그 범위를 두고 적은 질문. 질문 없이 범위를 설명하게 했으면 빈 글이다. 같은 범위에 질문이 다르면 다른 분석이다. */
  question: string;
  state: NoteState;
}

/** 견준 두 시점의 이름 */
export interface Between {
  base: string;
  target: string;
}

export interface ExplanationStore {
  /**
   * 레포 루트 기준 파일 경로 → 그 파일의 분석. 범위의 시작 줄 순서이고 같은 범위의 분석은 만든 순서다. 서버에서 읽은 적이 없는 파일은
   * 없다. 두 시점의 비교에 묶은 분석은 `scopeKey`의 열쇠에 따로 담는다.
   */
  files: Record<string, Note[]>;
  /**
   * 파일에 저장해 둔 분석을 읽는다. 이미 읽은 파일은 다시 읽지 않는다. between을 넘기면 그 비교에 묶은 분석을 읽고, codeOf가 낸 지금의
   * 표시 붙은 본문이 분석을 만든 때와 다르면 stale로 담는다. codeOf가 null을 내면 그 범위가 지금의 엮은 문서에 없다.
   */
  load(path: string, between?: Between, codeOf?: (note: { start: number; end: number; old: [number, number] }) => string | null): void;
  /**
   * 줄 범위의 분석을 만든다. question이 빈 글이면 범위를 설명하게 하고, 아니면 그 질문의 답을 만든다. refresh면 캐시에 있어도 다시
   * 만든다. 만드는 중인 분석에는 요청을 다시 보내지 않는다. 엮은 문서에서 고른 범위에 바뀐 줄이 있으면 marked에 표시 붙은 본문을 넘긴다.
   */
  make(path: string, start: number, end: number, refresh: boolean, question: string, marked?: MarkedCode): void;
  /** 줄 범위의 분석 하나를 지운다. */
  remove(path: string, start: number, end: number, question: string, old?: OldSpan): void;
  /** 읽어 둔 분석을 버려 다음에 파일을 열 때 다시 읽게 한다. */
  forget(): void;
}

export function noteKey(note: { start: number; end: number; old?: [number, number]; question: string }): string {
  return `${note.start}-${note.end}${note.old === undefined ? "" : `:${note.old[0]}-${note.old[1]}`}|${note.question}`;
}

/** 두 시점의 비교에 묶은 분석을 담는 `files`의 열쇠 */
export function scopeKey(path: string, between: Between): string {
  return `${between.base}..${between.target}:${path}`;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 서버의 `digest_of`와 같은 값: UTF-8 글의 SHA-256을 16진수로 적는다. */
async function digestOf(code: string): Promise<string> {
  const hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 넘길 값이 있을 때만 인자로 붙인다. */
const given = <T>(value: T | undefined): [] | [T] => (value === undefined ? [] : [value]);

export const useExplanations = create<ExplanationStore>()((set, get) => {
  const loading = new Set<string>();

  /** key의 분석 목록에서 그 분석을 state로 바꾼다. 없던 분석은 같은 범위의 분석 뒤에 더하고, state가 null이면 뺀다. */
  const put = (key: string, at: Omit<Note, "state">, state: NoteState | null) =>
    set((store) => {
      const before = store.files[key] ?? [];
      const order = (note: Omit<Note, "state">) => note.old?.[0] ?? note.start;
      const known = before.some((note) => noteKey(note) === noteKey(at));
      const notes =
        state === null
          ? before.filter((note) => noteKey(note) !== noteKey(at))
          : known
            ? before.map((note) => (noteKey(note) === noteKey(at) ? { ...at, state } : note))
            : [...before, { ...at, state }].sort((a, b) => order(a) - order(b) || a.end - b.end);
      return { files: { ...store.files, [key]: notes } };
    });

  const find = (key: string, at: Omit<Note, "state">) => get().files[key]?.find((note) => noteKey(note) === noteKey(at));

  /** 분석을 담는 `files`의 열쇠와 그 범위·질문 */
  const placed = (path: string, start: number, end: number, question: string, old?: OldSpan | null): [string, Omit<Note, "state">] =>
    old == null ? [path, { start, end, question }] : [scopeKey(path, old), { start, end, old: [old.start, old.end], question }];

  return {
    files: {},
    load: (path, between, codeOf) => {
      const key = between === undefined ? path : scopeKey(path, between);
      if (loading.has(key)) {
        return;
      }
      loading.add(key);
      getExplanations(path, ...given(between)).then(
        async ({ explanations, compared }) => {
          const found: [Omit<Note, "state">, NoteState][] =
            between === undefined
              ? explanations.map(({ start, end, question, text, stale }) => [{ start, end, question }, { phase: "done", text, stale, usage: null }])
              : await Promise.all(
                  (compared ?? []).map(async ({ start, end, old_start, old_end, question, text, digest }): Promise<[Omit<Note, "state">, NoteState]> => {
                    const at = { start, end, old: [old_start, old_end] as [number, number], question };
                    const code = codeOf?.(at) ?? null;
                    return [at, { phase: "done", text, stale: code === null || (await digestOf(code)) !== digest, usage: null }];
                  }),
                );
          // 읽는 동안 만들기 시작했거나 끝난 범위는 화면의 상태를 그대로 둔다.
          for (const [at, state] of found) {
            if (find(key, at) === undefined) {
              put(key, at, state);
            }
          }
          set((store) => (key in store.files ? store : { files: { ...store.files, [key]: [] } }));
        },
        () => loading.delete(key),
      );
    },
    make: (path, start, end, refresh, question, marked) => {
      const [key, at] = placed(path, start, end, question, marked?.old);
      if (find(key, at)?.state.phase === "making") {
        return;
      }
      put(key, at, { phase: "making" });
      makeExplanation(path, start, end, refresh, question, ...given(marked)).then(
        (made) => put(key, at, { phase: "done", text: made.text, stale: made.stale, usage: made.usage ?? null }),
        (error: unknown) => put(key, at, { phase: "failed", error: message(error), refresh }),
      );
    },
    remove: (path, start, end, question, old) => {
      const [key, at] = placed(path, start, end, question, old);
      put(key, at, null);
      deleteExplanation(path, start, end, question, ...given(old)).catch(() => {
        // 저장한 적이 없는 분석(만들다 실패한 범위)은 서버에 지울 것이 없다.
      });
    },
    forget: () => {
      loading.clear();
      set({ files: {} });
    },
  };
});
