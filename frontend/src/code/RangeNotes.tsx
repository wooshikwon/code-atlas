// 코드 뷰어에서 고른 줄 범위의 LLM 설명. 범위를 끌어 고르면 고른 끝에 "요약 생성" 버튼을 띄우고, 누르면 그 범위 아래에
// 뜨는 창에 설명을 만든다. 설명이 있는 범위는 시작 줄 왼쪽에 말풍선 표지를 달고, 표지를 누르면 창을 다시 연다.
// 두 시점을 엮은 문서에서는 고른 줄을 두 시점의 줄 범위로 되돌려 요청한다. 삭제된 줄이 든 범위의 설명은 그 비교에 묶이고, 들지 않은 범위의
// 설명은 대상 시점의 파일과 줄 범위에 묶인다.
import type { OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor";
import { useEffect, useReducer, useRef, useState } from "react";
import { Blocks } from "../panel/inline";
import { blocksOf } from "../panel/parts";
import type { MarkedCode } from "../api/types";
import { holds, marked, rowsOf, spanOf, type Woven } from "../graph/weave";
import { noteKey, scopeKey, useExplanations, type Between, type Note } from "../state/explanations";

type CodeEditor = Parameters<OnMount>[0];

interface RangeNotesProps {
  editor: CodeEditor;
  /** 설명을 묶는 파일의 경로. 대상 시점의 경로이고, 대상 시점에 없는 파일은 기준 시점의 경로다. */
  path: string;
  /** 코드 뷰어가 두 시점을 엮은 문서를 보이면 그 문서와 두 시점 */
  woven: Woven | null;
  between: Between | null;
}

/** 끌어 고른 코드 뷰어의 줄 범위와 버튼을 띄울 코드 뷰어 안의 좌표 */
interface Picked {
  start: number;
  end: number;
  x: number;
  y: number;
}

/** 설명 하나와 그 범위가 코드 뷰어에서 차지하는 줄. 엮은 문서가 아니면 from과 to가 설명의 줄 범위와 같다. */
interface Shown {
  note: Note;
  key: string;
  from: number;
  to: number;
}

const NONE: Note[] = [];
/** 창과 코드 뷰어 가장자리 사이에 남기는 폭 */
const MARGIN = 6;

/** 지금 고른 범위. 고른 글자가 없으면 null이다. 줄 머리에서 끝난 선택은 그 앞줄까지로 센다. */
function pickedOf(editor: CodeEditor): Picked | null {
  const selection = editor.getSelection();
  if (selection === null || selection.isEmpty()) {
    return null;
  }
  const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
  const at = editor.getScrolledVisiblePosition(selection.getEndPosition());
  if (at === null) {
    return null;
  }
  return { start: selection.startLineNumber, end, x: at.left, y: at.top + at.height };
}

/** 설명의 창과 표지에 적는 범위. 삭제된 줄이 든 범위는 두 시점의 줄을 함께 적는다. */
function titleOf({ start, end, old }: Note): string {
  if (old === undefined) {
    return `${start}~${end}줄 설명`;
  }
  return `기준 ${old[0]}~${old[1]}줄${start > 0 ? ` · 대상 ${start}~${end}줄` : ""} 설명`;
}

function Window({ shown, top, make, remove, close }: { shown: Shown; top: number; make: (refresh: boolean) => void; remove: () => void; close: () => void }) {
  const { state } = shown.note;
  return (
    <div className="code-note-window" style={{ top }} data-range={shown.key}>
      <div className="code-note-head">
        <span className="info-panel-label">{titleOf(shown.note)}</span>
        {state.phase === "done" && (
          <button className="summary-action" onClick={() => make(true)}>
            다시 생성
          </button>
        )}
        {state.phase !== "making" && (
          <button className="summary-action" onClick={remove}>
            지우기
          </button>
        )}
        <button className="summary-action code-note-fold" onClick={close} data-tip="접기" aria-label="접기">
          –
        </button>
      </div>
      <div className="code-note-body">
        {state.phase === "making" && <span className="info-panel-hint">설명을 만드는 중</span>}
        {state.phase === "done" && (
          <>
            {state.stale && <p className="stale-note">코드가 바뀌기 전에 만든 설명</p>}
            <div className={state.stale ? "summary-text stale-text" : "summary-text"}>
              <Blocks blocks={blocksOf(state.text)} />
            </div>
          </>
        )}
        {state.phase === "failed" && (
          <>
            <span className="info-panel-hint">{state.error}</span>
            <button className="summary-action" onClick={() => make(state.refresh)}>
              다시 시도
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** 코드 뷰어의 본문이나 문법 색으로 그리는 범위가 바뀌면 `key`로 새로 그린다. */
export function RangeNotes({ editor, path, woven, between }: RangeNotesProps) {
  /** 대상 시점의 파일과 줄 범위에 묶은 설명. 대상 시점에 없는 파일에는 없다. */
  const plain = useExplanations((s) => s.files[path]) ?? NONE;
  /** 켜져 있는 비교에 묶은, 삭제된 줄이 든 범위의 설명 */
  const compared = useExplanations((s) => (between === null ? undefined : s.files[scopeKey(path, between)])) ?? NONE;
  const load = useExplanations((s) => s.load);
  const make = useExplanations((s) => s.make);
  const remove = useExplanations((s) => s.remove);
  const [picked, setPicked] = useState<Picked | null>(null);
  /** 창을 연 범위의 `Shown.key` */
  const [open, setOpen] = useState<string | null>(null);
  /** 코드 뷰어를 스크롤하거나 크기를 바꾸면 창의 위치를 다시 잰다. */
  const [, moved] = useReducer((n: number) => n + 1, 0);
  const frame = useRef<HTMLDivElement | null>(null);

  /** 설명의 범위가 엮은 문서에서 차지하는 줄. 그 범위가 엮은 문서에 없으면 null이다. */
  const rows = (note: { start: number; end: number; old?: [number, number] }): [number, number] | null => {
    if (woven === null) {
      return [note.start, note.end];
    }
    const sides = [note.old === undefined ? null : rowsOf(woven, "base", note.old), note.start > 0 ? rowsOf(woven, "target", [note.start, note.end]) : null];
    const found = sides.filter((side) => side !== null);
    const expected = (note.old === undefined ? 0 : 1) + (note.start > 0 ? 1 : 0);
    return found.length < expected ? null : [Math.min(...found.map(([from]) => from)), Math.max(...found.map(([, to]) => to))];
  };

  /** 엮은 문서의 from~to줄에 바뀐 줄이 있으면 요청에 싣는 표시 붙은 본문. 삭제된 줄이 들었으면 기준 시점의 줄을 함께 담는다. */
  const markedOf = (from: number, to: number): MarkedCode | undefined => {
    if (woven === null || between === null || !(holds(woven, from, to, "deleted") || holds(woven, from, to, "added"))) {
      return undefined;
    }
    const { base } = spanOf(woven, from, to);
    const old = holds(woven, from, to, "deleted") && base !== null ? { ...between, start: base[0], end: base[1] } : null;
    return { code: marked(woven, from, to), old };
  };

  useEffect(() => {
    if (woven === null || woven.rows.some((row) => row.target !== null)) {
      load(path);
    }
    if (woven !== null && between !== null) {
      load(path, between, (note) => {
        const at = rows(note);
        return at === null ? null : marked(woven, at[0], at[1]);
      });
    }
  }, [path, woven, between, load]);

  const last = editor.getModel()?.getLineCount() ?? 0;
  const shown = [...plain, ...compared].flatMap((note): Shown[] => {
    const at = rows(note);
    return at === null || at[1] > last ? [] : [{ note, key: noteKey(note), from: at[0], to: at[1] }];
  });
  const opened = shown.find((each) => each.key === open);
  const glyphs = shown.map(({ note, key, from, to }) => `${key}@${from}-${to}:${note.state.phase}:${note.state.phase === "done" && note.state.stale}`).join(" ");

  // 끌어 고르는 동안에는 버튼을 띄우지 않고 마우스를 뗀 뒤에 띄운다. 키보드로 고르면 바로 띄운다.
  useEffect(() => {
    let dragging = false;
    const listeners = [
      editor.onMouseDown(() => {
        dragging = true;
        setPicked(null);
      }),
      editor.onMouseUp(() => {
        dragging = false;
        setPicked(pickedOf(editor));
      }),
      editor.onDidChangeCursorSelection(() => !dragging && setPicked(pickedOf(editor))),
      editor.onDidScrollChange(() => {
        setPicked(null);
        moved();
      }),
      editor.onDidLayoutChange(moved),
    ];
    return () => listeners.forEach((listener) => listener.dispose());
  }, [editor]);

  // 설명이 있는 범위의 시작 줄 왼쪽에 말풍선 표지를 달고, 창을 연 범위의 줄을 칠한다.
  useEffect(() => {
    const decorations = editor.createDecorationsCollection(
      shown.flatMap(({ note, key, from, to }) => {
        const classes = ["code-note-glyph", note.state.phase === "making" ? "code-note-making" : "", note.state.phase === "done" && note.state.stale ? "code-note-stale" : ""];
        const mark = {
          range: new monaco.Range(from, 1, from, 1),
          options: { glyphMarginClassName: classes.filter((name) => name !== "").join(" "), glyphMarginHoverMessage: { value: titleOf(note) } },
        };
        const lines = { range: new monaco.Range(from, 1, to, 1), options: { isWholeLine: true, className: "code-range" } };
        return key === open ? [mark, lines] : [mark];
      }),
    );
    return () => decorations.clear();
    // shown은 glyphs가 같으면 같은 표지를 내므로 glyphs가 바뀔 때만 다시 단다.
  }, [editor, glyphs, open]);

  /** 표지를 누른 줄에서 시작하는 범위를 찾으려고 지금 그린 설명을 담아 둔다. */
  const drawn = useRef(shown);
  drawn.current = shown;

  // 표지를 누르면 그 줄에서 시작하는 범위의 창을 열고, 열려 있으면 접는다.
  useEffect(() => {
    const listener = editor.onMouseDown((event) => {
      const line = event.target.position?.lineNumber;
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || line === undefined) {
        return;
      }
      const found = drawn.current.find((each) => each.from === line);
      if (found !== undefined) {
        setOpen((now) => (now === found.key ? null : found.key));
      }
    });
    return () => listener.dispose();
  }, [editor]);

  /** 코드 뷰어의 from~to줄의 설명을 만든다. 엮은 문서의 줄은 두 시점의 줄 범위로 되돌린다. 돌려주는 값은 그 설명의 `Shown.key`다. */
  const explain = (from: number, to: number, refresh: boolean): string => {
    const code = markedOf(from, to);
    const target = woven === null ? ([from, to] as const) : (spanOf(woven, from, to).target ?? ([0, 0] as const));
    // 그대로인 줄과 추가된 줄만 든 범위는 대상 시점에 줄이 있고, 대상 시점에 줄이 없는 범위는 삭제된 줄만 든 범위다.
    make(path, target[0], target[1], refresh, ...(code === undefined ? [] : [code]));
    return noteKey({ start: target[0], end: target[1], old: code?.old == null ? undefined : [code.old.start, code.old.end] });
  };

  const erase = ({ note }: Shown) => {
    const { start, end, old } = note;
    remove(path, start, end, ...(old === undefined || between === null ? [] : [{ ...between, start: old[0], end: old[1] }]));
  };

  const pick = () => {
    if (picked === null) {
      return;
    }
    setOpen(explain(picked.start, picked.end, false));
    setPicked(null);
  };

  /** 창을 범위의 끝 줄 아래에 두고, 코드 뷰어 밖으로 나가면 안으로 들인다. */
  const top = (to: number): number => {
    const below = editor.getTopForLineNumber(to + 1) - editor.getScrollTop();
    const room = editor.getLayoutInfo().height - (frame.current?.firstElementChild?.getBoundingClientRect().height ?? 0) - MARGIN;
    return Math.max(MARGIN, Math.min(below, room));
  };

  return (
    <div className="code-notes" ref={frame}>
      {opened !== undefined && (
        <Window
          shown={opened}
          top={top(opened.to)}
          make={(refresh) => explain(opened.from, opened.to, refresh)}
          remove={() => erase(opened)}
          close={() => setOpen(null)}
        />
      )}
      {picked !== null && (
        <button className="summary-action code-explain" style={{ left: picked.x, top: picked.y }} onMouseDown={(event) => event.preventDefault()} onClick={pick}>
          요약 생성
        </button>
      )}
    </div>
  );
}
