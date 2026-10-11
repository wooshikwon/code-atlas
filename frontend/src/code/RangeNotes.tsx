// 코드 뷰어에서 고른 줄 범위의 LLM 설명. 범위를 끌어 고르면 고른 끝에 "요약 생성" 버튼을 띄우고, 누르면 그 범위 아래에
// 뜨는 창에 설명을 만든다. 설명이 있는 범위는 시작 줄 왼쪽에 말풍선 표지를 달고, 표지를 누르면 창을 다시 연다.
import type { OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor";
import { useEffect, useReducer, useRef, useState } from "react";
import { Blocks } from "../panel/inline";
import { blocksOf } from "../panel/parts";
import { noteKey, useExplanations, type Note } from "../state/explanations";

type CodeEditor = Parameters<OnMount>[0];

interface RangeNotesProps {
  editor: CodeEditor;
  path: string;
}

/** 끌어 고른 줄 범위와 버튼을 띄울 코드 뷰어 안의 좌표 */
interface Picked {
  start: number;
  end: number;
  x: number;
  y: number;
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

function Window({ note, path, top, close }: { note: Note; path: string; top: number; close: () => void }) {
  const make = useExplanations((s) => s.make);
  const remove = useExplanations((s) => s.remove);
  const { start, end, state } = note;
  return (
    <div className="code-note-window" style={{ top }} data-range={noteKey(note)}>
      <div className="code-note-head">
        <span className="info-panel-label">
          {start}~{end}줄 설명
        </span>
        {state.phase === "done" && (
          <button className="summary-action" onClick={() => make(path, start, end, true)}>
            다시 생성
          </button>
        )}
        {state.phase !== "making" && (
          <button className="summary-action" onClick={() => remove(path, start, end)}>
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
            <button className="summary-action" onClick={() => make(path, start, end, state.refresh)}>
              다시 시도
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** 코드 뷰어의 파일이나 문법 색으로 그리는 범위가 바뀌면 `key`로 새로 그린다. */
export function RangeNotes({ editor, path }: RangeNotesProps) {
  const notes = useExplanations((s) => s.files[path]) ?? NONE;
  const load = useExplanations((s) => s.load);
  const make = useExplanations((s) => s.make);
  const [picked, setPicked] = useState<Picked | null>(null);
  /** 창을 연 범위의 `noteKey` */
  const [open, setOpen] = useState<string | null>(null);
  /** 코드 뷰어를 스크롤하거나 크기를 바꾸면 창의 위치를 다시 잰다. */
  const [, moved] = useReducer((n: number) => n + 1, 0);
  const frame = useRef<HTMLDivElement | null>(null);

  useEffect(() => load(path), [path, load]);

  const last = editor.getModel()?.getLineCount() ?? 0;
  const shown = notes.filter((note) => note.end <= last);
  const opened = shown.find((note) => noteKey(note) === open);
  const glyphs = shown.map((note) => `${noteKey(note)}:${note.state.phase}:${note.state.phase === "done" && note.state.stale}`).join(" ");

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
      shown.flatMap((note) => {
        const classes = ["code-note-glyph", note.state.phase === "making" ? "code-note-making" : "", note.state.phase === "done" && note.state.stale ? "code-note-stale" : ""];
        const mark = {
          range: new monaco.Range(note.start, 1, note.start, 1),
          options: { glyphMarginClassName: classes.filter((name) => name !== "").join(" "), glyphMarginHoverMessage: { value: `${note.start}~${note.end}줄 설명` } },
        };
        const lines = { range: new monaco.Range(note.start, 1, note.end, 1), options: { isWholeLine: true, className: "code-range" } };
        return noteKey(note) === open ? [mark, lines] : [mark];
      }),
    );
    return () => decorations.clear();
    // shown은 glyphs가 같으면 같은 표지를 내므로 glyphs가 바뀔 때만 다시 단다.
  }, [editor, glyphs, open]);

  // 표지를 누르면 그 줄에서 시작하는 범위의 창을 열고, 열려 있으면 접는다.
  useEffect(() => {
    const listener = editor.onMouseDown((event) => {
      const line = event.target.position?.lineNumber;
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || line === undefined) {
        return;
      }
      const found = useExplanations.getState().files[path]?.find((note) => note.start === line);
      if (found !== undefined) {
        setOpen((now) => (now === noteKey(found) ? null : noteKey(found)));
      }
    });
    return () => listener.dispose();
  }, [editor, path]);

  const explain = () => {
    if (picked === null) {
      return;
    }
    make(path, picked.start, picked.end, false);
    setOpen(noteKey(picked));
    setPicked(null);
  };

  /** 창을 범위의 끝 줄 아래에 두고, 코드 뷰어 밖으로 나가면 안으로 들인다. */
  const top = (note: Note): number => {
    const below = editor.getTopForLineNumber(note.end + 1) - editor.getScrollTop();
    const room = editor.getLayoutInfo().height - (frame.current?.firstElementChild?.getBoundingClientRect().height ?? 0) - MARGIN;
    return Math.max(MARGIN, Math.min(below, room));
  };

  return (
    <div className="code-notes" ref={frame}>
      {opened !== undefined && <Window note={opened} path={path} top={top(opened)} close={() => setOpen(null)} />}
      {picked !== null && (
        <button className="summary-action code-explain" style={{ left: picked.x, top: picked.y }} onMouseDown={(event) => event.preventDefault()} onClick={explain}>
          요약 생성
        </button>
      )}
    </div>
  );
}
