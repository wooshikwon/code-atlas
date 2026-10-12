// 코드 뷰어에서 고른 줄 범위의 코드 분석. 범위를 끌어 고르면 고른 끝에 "코드 분석" 버튼을 띄우고, 누르면 그 자리에 질문 입력 창을 띄운다.
// 질문을 보내면 그 범위 아래에 뜨는 창에 질문과 LLM의 답을 적고, 질문을 비운 채 보내면 그 범위의 설명을 적는다. 분석은 파일과 줄 범위에
// 묶이므로 그 파일을 여는 모든 화면에서 범위의 시작 줄 왼쪽에 말풍선 표지가 달리고, 표지를 누르면 그 범위의 분석을 만든 순서로 쌓은 창을 연다.
// 두 시점을 엮은 문서에서는 고른 줄을 두 시점의 줄 범위로 되돌려 요청한다. 삭제된 줄이 든 범위의 분석은 그 비교에 묶이고, 들지 않은 범위의
// 분석은 대상 시점의 파일과 줄 범위에 묶인다.
import type { OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor";
import { useCallback, useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { Blocks } from "../panel/inline";
import { blocksOf } from "../panel/parts";
import type { MarkedCode } from "../api/types";
import { holds, marked, rowsOf, spanOf, type Woven } from "../graph/weave";
import { noteKey, scopeKey, useExplanations, type Between, type Note } from "../state/explanations";
import { cacheTip, usageText } from "../state/usage";

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

/** 분석 하나와 그 범위가 코드 뷰어에서 차지하는 줄. 엮은 문서가 아니면 from과 to가 분석의 줄 범위와 같다. */
interface Shown {
  note: Note;
  key: string;
  from: number;
  to: number;
}

/** 코드 뷰어의 같은 줄 범위에 묶인 분석을 한 창에 쌓는 열쇠 */
const groupKey = (at: { from: number; to: number }) => `${at.from}-${at.to}`;

const NONE: Note[] = [];
/** 창과 코드 뷰어 가장자리 사이에 남기는 폭 */
const MARGIN = 6;
/** 질문 입력 창의 폭 */
const ASK_WIDTH = 320;

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

/** 분석의 창과 표지에 적는 범위. 삭제된 줄이 든 범위는 두 시점의 줄을 함께 적는다. */
function titleOf({ start, end, old }: Note): string {
  if (old === undefined) {
    return `${start}~${end}줄 코드 분석`;
  }
  return `기준 ${old[0]}~${old[1]}줄${start > 0 ? ` · 대상 ${start}~${end}줄` : ""} 코드 분석`;
}

/** 창에 쌓는 분석 하나. 질문이 있으면 답 위에 적고, 이 화면에서 만든 분석은 끝에 그 호출의 토큰 수를 적는다. */
function Item({ note, make, remove }: { note: Note; make: (refresh: boolean) => void; remove: () => void }) {
  const { question, state } = note;
  return (
    <div className="code-note-item">
      <div className="code-note-asked">
        <span className="code-note-question">{question}</span>
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
      </div>
      {state.phase === "making" && <span className="info-panel-hint">코드를 분석하는 중</span>}
      {state.phase === "done" && (
        <>
          {state.stale && <p className="stale-note">코드가 바뀌기 전에 만든 분석</p>}
          <div className={state.stale ? "summary-text stale-text" : "summary-text"}>
            <Blocks blocks={blocksOf(state.text)} />
          </div>
          {state.usage !== null && (
            <span className="summary-usage code-note-usage" data-tip={cacheTip(state.usage)}>
              {usageText(state.usage)}
            </span>
          )}
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
  );
}

/** 질문 입력 창. `Enter`로 보내고 `Shift+Enter`로 줄을 바꾸며, `Esc`와 창 밖을 누르면 닫는다. 한글을 조합하는 중의 `Enter`는 보내지 않는다. */
function Ask({ left, top, width, send, close }: { left: number; top: number; width: number; send: (question: string) => void; close: () => void }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target) !== true) {
        close();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [close]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(text.trim());
    }
  };

  return (
    <form
      ref={box}
      className="code-ask"
      style={{ left, top, width }}
      onSubmit={(event) => {
        event.preventDefault();
        send(text.trim());
      }}
    >
      <textarea
        className="code-ask-input"
        rows={2}
        autoFocus
        value={text}
        placeholder="질문을 적는다. 비우면 이 코드를 설명한다"
        aria-label="코드 분석 질문"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button className="summary-action code-ask-send" type="submit">
        보내기
      </button>
    </form>
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
  /** 질문 입력 창을 띄운 범위. 버튼을 누른 때의 범위와 좌표다. */
  const [asking, setAsking] = useState<Picked | null>(null);
  /** 창을 연 범위의 `groupKey` */
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
  /** 창에 쌓는 분석: 창을 연 줄 범위에 묶인 분석을 만든 순서로 */
  const opened = shown.filter((each) => groupKey(each) === open);
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

  // 분석이 있는 범위의 시작 줄 왼쪽에 말풍선 표지를 달고, 창을 연 범위와 질문 입력 창을 띄운 범위의 줄을 칠한다.
  // 같은 줄에서 시작하는 분석이 여럿이면 표지는 하나이고, 만드는 중인 분석이 있으면 깜박이며 모두 낡았을 때만 흐리다.
  useEffect(() => {
    const starts = new Map<number, Shown[]>();
    for (const each of shown) {
      starts.set(each.from, [...(starts.get(each.from) ?? []), each]);
    }
    const marks = [...starts].map(([from, list]) => {
      const making = list.some(({ note }) => note.state.phase === "making");
      const stale = list.every(({ note }) => note.state.phase === "done" && note.state.stale);
      const classes = ["code-note-glyph", making ? "code-note-making" : "", stale ? "code-note-stale" : ""];
      return {
        range: new monaco.Range(from, 1, from, 1),
        options: { glyphMarginClassName: classes.filter((name) => name !== "").join(" "), glyphMarginHoverMessage: { value: titleOf(list[0].note) } },
      };
    });
    const held = [shown.find((each) => groupKey(each) === open), asking === null ? undefined : { from: asking.start, to: asking.end }];
    const lines = held.flatMap((at) =>
      at === undefined ? [] : [{ range: new monaco.Range(at.from, 1, at.to, 1), options: { isWholeLine: true, className: "code-range" } }],
    );
    const decorations = editor.createDecorationsCollection([...marks, ...lines]);
    return () => decorations.clear();
    // shown은 glyphs가 같으면 같은 표지를 내므로 glyphs가 바뀔 때만 다시 단다.
  }, [editor, glyphs, open, asking]);

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
        setOpen((now) => (now === groupKey(found) ? null : groupKey(found)));
      }
    });
    return () => listener.dispose();
  }, [editor]);

  /** 코드 뷰어의 from~to줄의 분석을 만든다. 엮은 문서의 줄은 두 시점의 줄 범위로 되돌린다. question이 빈 글이면 그 범위를 설명하게 한다. */
  const explain = (from: number, to: number, refresh: boolean, question: string) => {
    const code = markedOf(from, to);
    // 그대로인 줄과 추가된 줄만 든 범위는 대상 시점에 줄이 있고, 대상 시점에 줄이 없는 범위는 삭제된 줄만 든 범위다.
    const target = woven === null ? ([from, to] as const) : (spanOf(woven, from, to).target ?? ([0, 0] as const));
    make(path, target[0], target[1], refresh, question, ...(code === undefined ? [] : [code]));
  };

  const erase = ({ start, end, old, question }: Note) =>
    remove(path, start, end, question, ...(old === undefined || between === null ? [] : [{ ...between, start: old[0], end: old[1] }]));

  const send = (question: string) => {
    if (asking === null) {
      return;
    }
    explain(asking.start, asking.end, false, question);
    setOpen(groupKey({ from: asking.start, to: asking.end }));
    setAsking(null);
  };

  /** 질문 입력 창을 닫고, 범위를 고른 채면 버튼을 다시 띄운다. */
  const shut = useCallback(() => {
    setAsking(null);
    setPicked(pickedOf(editor));
  }, [editor]);

  /** 창을 범위의 끝 줄 아래에 두고, 코드 뷰어 밖으로 나가면 안으로 들인다. */
  const top = (to: number): number => {
    const below = editor.getTopForLineNumber(to + 1) - editor.getScrollTop();
    const room = editor.getLayoutInfo().height - (frame.current?.firstElementChild?.getBoundingClientRect().height ?? 0) - MARGIN;
    return Math.max(MARGIN, Math.min(below, room));
  };

  /** 질문 입력 창의 폭. 코드 뷰어가 좁으면 그 안에 들어가게 줄인다. */
  const askWidth = Math.min(ASK_WIDTH, editor.getLayoutInfo().width - 2 * MARGIN);

  return (
    <div className="code-notes" ref={frame}>
      {opened.length > 0 && asking === null && (
        <div className="code-note-window" style={{ top: top(opened[0].to) }} data-range={open}>
          <div className="code-note-head">
            <span className="info-panel-label">{titleOf(opened[0].note)}</span>
            <button className="summary-action code-note-fold" onClick={() => setOpen(null)} data-tip="접기" aria-label="접기">
              –
            </button>
          </div>
          <div className="code-note-body">
            {opened.map(({ note, key, from, to }) => (
              <Item key={key} note={note} make={(refresh) => explain(from, to, refresh, note.question)} remove={() => erase(note)} />
            ))}
          </div>
        </div>
      )}
      {asking !== null && <Ask left={Math.max(MARGIN, Math.min(asking.x, editor.getLayoutInfo().width - askWidth - MARGIN))} top={asking.y} width={askWidth} send={send} close={shut} />}
      {picked !== null && asking === null && (
        <button
          className="summary-action code-explain"
          style={{ left: picked.x, top: picked.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setAsking(picked);
            setPicked(null);
          }}
        >
          코드 분석
        </button>
      )}
    </div>
  );
}
