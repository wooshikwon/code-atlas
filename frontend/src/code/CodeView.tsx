import Editor, { type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { getDefinition, getFile } from "../api/client";
import { WORKTREE, type Comparison } from "../api/types";
import { gutter, marked, rowOf, rowsOf, weave, widened, type Hunk, type RowKind, type Woven } from "../graph/weave";
import { useCompare } from "../state/compare";
import type { Between } from "../state/explanations";
import { useAtlas } from "../state/store";
import { keepModel, monacoTheme, place } from "./monaco";
import { RangeNotes } from "./RangeNotes";

type CodeEditor = Parameters<OnMount>[0];

interface CodeViewProps {
  path: string;
  /** 문법 색으로 그릴 1부터 세는 시작 줄과 끝 줄. 범위 밖의 줄은 흐리게 그린다. null이면 파일 전체다. */
  range: [number, number] | null;
  /** 바탕을 칠할 줄 번호 */
  highlight?: number;
  /** path와 range, highlight가 시점 비교의 기준 시점의 값이다. 대상 시점에 없는 정의와 삭제된 관계의 코드 줄이 해당한다. */
  base?: boolean;
}

/** 코드 뷰어에 넣는 본문. 시점 비교에서 바뀐 줄이 있는 파일은 두 시점의 본문을 엮은 문서(woven)이고 text가 그 문서의 글이다. */
interface Shown {
  key: string;
  text: string;
  woven: Woven | null;
}

/**
 * 코드 뷰어가 보일 본문의 출처. key는 모델의 주소이고 본문마다 다르다. file은 그 파일이 대상 시점에서 가진 경로(삭제된 파일은 기준 시점의
 * 경로)이고, live는 대상 시점이 작업 중인 상태여서 언어 서버에 물을 수 있는지다. between은 두 시점의 본문을 엮어 보일 때 기준 시점과
 * 대상 시점에서 읽을 경로와 그 파일의 줄 토막이고, 그 시점에 파일이 없으면 경로가 null이다.
 */
interface Source {
  key: string;
  file: string;
  live: boolean;
  compared: Between | null;
  between: { old: string | null; fresh: string | null; hunks: Hunk[] } | null;
}

function sourceOf(compared: Comparison | null, path: string, base: boolean): Source {
  if (compared === null) {
    return { key: path, file: path, live: true, compared: null, between: null };
  }
  const named = compared.files.find((file) => file.path === path);
  const found = base ? (compared.files.find((file) => (file.old ?? file.path) === path) ?? named) : named;
  const file = found?.path ?? path;
  const live = compared.target === WORKTREE;
  const shared = { file, live, compared: { base: compared.base, target: compared.target } };
  if (found === undefined || (found.added === 0 && found.deleted === 0 && found.status !== "added" && found.status !== "deleted")) {
    return { ...shared, key: live ? file : `${compared.target}/${file}`, between: null };
  }
  const between = { old: found.status === "added" ? null : (found.old ?? found.path), fresh: found.status === "deleted" ? null : found.path, hunks: found.hunks };
  return { ...shared, key: `${compared.base}..${compared.target}/${file}`, between };
}

async function load({ key, file, live, compared, between }: Source): Promise<Shown> {
  const target = live ? undefined : compared?.target;
  if (compared === null || between === null) {
    return { key, text: (await getFile(file, target)).text, woven: null };
  }
  const [old, fresh] = await Promise.all([
    between.old === null ? null : getFile(between.old, compared.base),
    between.fresh === null ? null : getFile(between.fresh, target),
  ]);
  const woven = weave(old?.text ?? null, fresh?.text ?? null, between.hunks);
  return { key, text: woven.lines.join("\n"), woven };
}

interface Note {
  text: string;
  x: number;
  y: number;
}

const NOTE_MS = 2000;
/** 사용자가 코드 뷰어를 스크롤하는 키 */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

/**
 * 줄 from~to의 세로 가운데를 코드 뷰어의 세로 가운데에 둔다. from 줄이 뷰어 맨 위보다 위로 올라가지 않게 하고,
 * 스크롤 위치는 Monaco가 문서의 범위 안으로 자른다. 그래서 뷰어보다 긴 범위는 첫 줄부터 보이고, 파일 맨 위의 범위는 1번 줄부터 보인다.
 */
function center(editor: CodeEditor, from: number, to: number): void {
  const height = editor.getLayoutInfo().height;
  const first = editor.getTopForLineNumber(from);
  const middle = (first + editor.getBottomForLineNumber(to) - height) / 2;
  // 지금 문서의 끝을 넘는 위치를 청하면 Monaco가 그 값을 기억했다가 그리는 도중에 문서 높이가 늘 때(가로 스크롤 막대가 생길 때) 스크롤을
  // 옮기고, 그때 줄 번호가 한 줄씩 밀려 그려진다. 넘지 않는 위치만 청하고, 문서 높이가 바뀌면 그리기를 마친 뒤에 다시 가운데에 둔다.
  editor.setScrollTop(Math.min(first, middle, editor.getScrollHeight() - height));
}

/** 엮은 문서에서 삭제된 줄과 추가된 줄의 바탕과 줄 번호 칸 옆의 `−`·`+` */
const CHANGED: Partial<Record<RowKind, string>> = { deleted: "code-deleted", added: "code-added" };

const OPTIONS = {
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  // 줄 번호 왼쪽에 칸을 두지 않는다. 번호 오른쪽의 표시 칸에 시점 비교의 `−`·`+`(앞 10px)와 코드 분석의 표지(그 뒤 14px)를 그린다.
  glyphMargin: false,
  lineDecorationsWidth: 24,
  scrollBeyondLastLine: false,
  // 첫 줄 위의 여백과 코드 사이에 스크롤 그림자가 줄을 긋지 않게 한다.
  scrollbar: { useShadows: false },
  fontSize: 13,
  renderLineHighlight: "none" as const,
  automaticLayout: true,
  fixedOverflowWidgets: true,
};

export function CodeView({ path, range, highlight, base = false }: CodeViewProps) {
  const theme = useAtlas((s) => s.theme);
  const select = useAtlas((s) => s.select);
  const picked = useAtlas((s) => s.picked);
  const compared = useCompare((s) => s.result);
  const source = useMemo(() => sourceOf(compared, path, base), [compared, path, base]);
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  /** 코드 뷰어 위에 비우는 높이. 코드 한 줄의 높이다. */
  const [top, setTop] = useState(0);
  /** 정의가 레포 밖에 있을 때 누른 곳 옆에 잠시 띄우는 말풍선 */
  const [note, setNote] = useState<Note | null>(null);

  const { key, file, live } = source;
  const code = shown?.key === key ? shown.text : undefined;
  const woven = shown?.key === key ? shown.woven : null;
  /** path와 range, highlight의 줄 번호가 속한 시점 */
  const side = base ? "base" : "target";
  /** 문법 색으로 그릴 코드 뷰어의 줄 범위. 엮은 문서에서는 정의의 줄 범위가 놓인 줄이고, 대상 시점의 정의는 그 정의에서 삭제된 줄을 품는다. */
  const [start, end] = useMemo((): [number, number] | [null, null] => {
    if (woven === null || range === null) {
      return range ?? [null, null];
    }
    const rows = rowsOf(woven, side, range);
    return rows === null ? [null, null] : side === "target" ? widened(woven, rows) : rows;
  }, [woven, side, range]);
  const lit = highlight === undefined ? undefined : woven === null ? highlight : (rowOf(woven, side, highlight) ?? undefined);
  /** 모델의 줄이 작업 중인 상태의 파일에서 몇째 줄인지. 언어 서버에 물을 수 없는 줄이면 null이다. */
  const fileLine = useMemo(() => (line: number) => (!live ? null : woven === null ? line : (woven.rows[line - 1]?.target ?? null)), [live, woven]);
  // 줄 번호 칸의 폭은 가장 큰 줄 번호의 자릿수다. 엮은 문서는 두 시점의 가장 큰 줄 번호를, 그 밖에는 파일의 줄 수를 쓴다.
  const options = useMemo(() => {
    if (woven === null) {
      return code === undefined ? OPTIONS : { ...OPTIONS, lineNumbersMinChars: String(code.split("\n").length).length };
    }
    const { chars, label } = gutter(woven);
    return { ...OPTIONS, lineNumbers: label, lineNumbersMinChars: chars };
  }, [code, woven]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    load(source)
      .then((got) => !cancelled && setShown(got))
      .catch((caught: unknown) => !cancelled && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      cancelled = true;
    };
  }, [source]);

  // 본문이 바뀌면 코드 뷰어를 새로 만들므로 앞 본문의 코드 뷰어를 쓰지 않는다.
  useEffect(() => setEditor(null), [key]);

  useEffect(() => {
    if (code !== undefined) {
      keepModel(key);
      place(key, { path: file, fileLine, modelLine: (line) => (woven === null ? line : rowOf(woven, "target", line)) });
    }
  }, [key, code, file, fileLine, woven]);

  // 엮은 문서의 삭제된 줄과 추가된 줄에 바탕을 칠하고 줄 번호 칸 옆에 `−`·`+`를 적는다.
  useEffect(() => {
    if (editor === null || woven === null) {
      return;
    }
    const decorations = editor.createDecorationsCollection(
      woven.rows.flatMap((row, i) => {
        const name = CHANGED[row.kind];
        const options = { isWholeLine: true, className: name, marginClassName: name, linesDecorationsClassName: `code-sign ${name}-sign` };
        return name === undefined ? [] : [{ range: new monaco.Range(i + 1, 1, i + 1, 1), options }];
      }),
    );
    return () => decorations.clear();
  }, [editor, woven]);

  // 엮은 문서에서 고른 범위에 바뀐 줄이 있으면 줄 머리에 `-`·`+`·빈칸 표시를 붙여 복사한다. 줄 머리에서 끝난 선택은 그 앞줄까지로 센다.
  useEffect(() => {
    if (editor === null || woven === null) {
      return;
    }
    const dom = editor.getContainerDomNode();
    const onCopy = (event: ClipboardEvent) => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (selection === null || selection.isEmpty() || model === null || event.clipboardData === null) {
        return;
      }
      const from = selection.startLineNumber;
      const open = selection.endColumn === 1 && selection.endLineNumber > from;
      const to = open ? selection.endLineNumber - 1 : selection.endLineNumber;
      if (woven.rows.slice(from - 1, to).every((row) => row.kind === "same")) {
        return;
      }
      const texts = Array.from({ length: to - from + 1 }, (_, i) => {
        const line = from + i;
        const ends = line === to && !open ? selection.endColumn : model.getLineMaxColumn(line);
        return model.getValueInRange(new monaco.Range(line, line === from ? selection.startColumn : 1, line, ends));
      });
      event.clipboardData.setData("text/plain", marked(woven, from, to, texts) + (open ? "\n" : ""));
      event.preventDefault();
      event.stopPropagation();
    };
    dom.addEventListener("copy", onCopy, true);
    return () => dom.removeEventListener("copy", onCopy, true);
  }, [editor, woven]);

  // 범위 밖의 줄을 흐리게 그린다.
  useEffect(() => {
    if (editor === null || code === undefined || start === null || end === null) {
      return;
    }
    const last = editor.getModel()?.getLineCount() ?? end;
    const lines = (from: number, to: number) => ({ startLineNumber: from, startColumn: 1, endLineNumber: to, endColumn: 1 });
    const decorations = editor.createDecorationsCollection([
      ...(start > 1 ? [{ range: lines(1, start - 1), options: { isWholeLine: true, inlineClassName: "code-dim" } }] : []),
      ...(end < last ? [{ range: lines(end + 1, last), options: { isWholeLine: true, inlineClassName: "code-dim" } }] : []),
    ]);
    return () => decorations.clear();
  }, [editor, code, start, end]);

  // 줄의 바탕을 칠한다.
  useEffect(() => {
    if (editor === null || code === undefined || lit === undefined) {
      return;
    }
    const decorations = editor.createDecorationsCollection([
      {
        range: { startLineNumber: lit, startColumn: 1, endLineNumber: lit, endColumn: 1 },
        options: { isWholeLine: true, className: "code-range" },
      },
    ]);
    return () => decorations.clear();
  }, [editor, code, lit]);

  // 바탕을 칠한 줄이 있으면 그 줄을, 없으면 범위를 코드 뷰어의 가운데에 둔다. 파일 전체를 보일 때는 1번 줄부터 보인다.
  // 뷰어의 높이가 바뀌면 다시 가운데에 두고, 사용자가 스크롤한 뒤에는 옮기지 않는다. 노드를 고를 때마다(`picked`) 처음부터 다시 한다.
  const [from, to] = lit !== undefined ? [lit, lit] : [start, end];
  useEffect(() => {
    if (editor === null || code === undefined) {
      return;
    }
    if (from === null || to === null) {
      editor.setScrollTop(0);
      return;
    }
    center(editor, from, to);
    const dom = editor.getContainerDomNode();
    let scrolled = false;
    /** 마우스 버튼을 누른 채인지. 스크롤 막대를 끌거나 글자를 끌어 고르며 옮긴 스크롤을 사용자의 스크롤로 센다. */
    let pressed = false;
    /** 문서 높이가 바뀐 뒤 다시 가운데에 두려고 잡아 둔 프레임 */
    let again = 0;
    const onWheel = () => (scrolled = true);
    const onKey = (event: KeyboardEvent) => (scrolled ||= SCROLL_KEYS.has(event.key));
    const onDown = () => (pressed = true);
    const onUp = () => (pressed = false);
    dom.addEventListener("wheel", onWheel, { capture: true, passive: true });
    dom.addEventListener("keydown", onKey, true);
    dom.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    const listeners = [
      editor.onDidScrollChange((event) => (scrolled ||= pressed && event.scrollTopChanged)),
      editor.onDidLayoutChange(() => !scrolled && center(editor, from, to)),
      editor.onDidContentSizeChange((event) => {
        if (event.contentHeightChanged) {
          cancelAnimationFrame(again);
          again = requestAnimationFrame(() => !scrolled && center(editor, from, to));
        }
      }),
    ];
    return () => {
      cancelAnimationFrame(again);
      listeners.forEach((listener) => listener.dispose());
      dom.removeEventListener("wheel", onWheel, true);
      dom.removeEventListener("keydown", onKey, true);
      dom.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
    };
  }, [editor, code, from, to, picked]);

  // Mod+클릭한 이름의 정의가 레포 안에 있으면 그 노드를 고르고, 레포 밖에 있으면 외부 모듈 이름을 띄운다.
  useEffect(() => {
    if (editor === null) {
      return;
    }
    const listener = editor.onMouseDown((event) => {
      const position = event.target.position;
      const mouse = event.event;
      const line = position === null ? null : fileLine(position.lineNumber);
      if (!mouse.leftButton || !(mouse.metaKey || mouse.ctrlKey) || position === null || line === null) {
        return;
      }
      const body = editor.getContainerDomNode().getBoundingClientRect();
      const at = { x: mouse.browserEvent.clientX - body.left, y: mouse.browserEvent.clientY - body.top };
      const asked = useAtlas.getState().selection;
      getDefinition(file, line, position.column - 1)
        .then(({ targets }) => {
          const target = targets.at(0);
          const selection = useAtlas.getState().selection;
          // 응답을 기다리는 동안 선택이 바뀌었으면 그 선택을 덮지 않는다.
          if (target === undefined || selection !== asked) {
            return;
          }
          if (target.node !== null) {
            if (selection?.type !== "node" || selection.id !== target.node) {
              // 포커스가 코드 뷰어에 남으면 이력 단축키가 듣지 않으므로 포커스를 뺀다.
              const focused = document.activeElement;
              if (focused instanceof HTMLElement && editor.getContainerDomNode().contains(focused)) {
                focused.blur();
              }
              select(target.node);
            }
          } else if (target.external !== null) {
            setNote({ text: `외부 모듈 ${target.external.replace(/^ext:/, "")}`, ...at });
          }
        })
        .catch(() => {
          // LSP 세션이 없는 서버에서는 정의 이동이 아무 일도 하지 않는다.
        });
    });
    return () => listener.dispose();
  }, [editor, file, fileLine, select]);

  // Mod를 누른 채 이름 위에 마우스를 올리면 정의가 레포 안의 노드인 이름에 밑줄을 긋는다.
  useEffect(() => {
    if (editor === null) {
      return;
    }
    const links = editor.createDecorationsCollection();
    /** 정의를 물어 둔 이름의 줄과 시작 열 */
    let asked = "";
    const clear = () => {
      asked = "";
      links.clear();
    };
    const listeners = [
      editor.onMouseMove((event) => {
        const position = event.target.position;
        const mod = event.event.metaKey || event.event.ctrlKey;
        const word = mod && position !== null ? editor.getModel()?.getWordAtPosition(position) : null;
        const asking = position === null ? null : fileLine(position.lineNumber);
        if (word == null || position === null || asking === null) {
          clear();
          return;
        }
        const line = position.lineNumber;
        const key = `${line}:${word.startColumn}`;
        if (key === asked) {
          return;
        }
        clear();
        asked = key;
        getDefinition(file, asking, word.startColumn - 1)
          .then(({ targets }) => {
            if (asked === key && targets.at(0)?.node != null) {
              links.set([
                {
                  range: { startLineNumber: line, startColumn: word.startColumn, endLineNumber: line, endColumn: word.endColumn },
                  options: { inlineClassName: "code-link" },
                },
              ]);
            }
          })
          .catch(() => {
            // LSP 세션이 없는 서버에서는 밑줄을 긋지 않는다.
          });
      }),
    ];
    // 밑줄은 Mod를 뗄 때 지운다. 포커스가 코드 뷰어 밖에 있어도 지우도록 window에서 듣는다.
    const onKeyUp = (event: KeyboardEvent) => !(event.metaKey || event.ctrlKey) && clear();
    window.addEventListener("keyup", onKeyUp);
    return () => {
      listeners.forEach((listener) => listener.dispose());
      window.removeEventListener("keyup", onKeyUp);
      links.clear();
    };
  }, [editor, file, fileLine]);

  useEffect(() => {
    if (note === null) {
      return;
    }
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  return (
    <div className="code" style={{ "--code-top": `${top}px` } as CSSProperties}>
      {error !== null && <div className="code-error">{error}</div>}
      {code !== undefined && (
        <Editor
          path={key}
          defaultLanguage="python"
          value={code}
          theme={monacoTheme(theme)}
          onMount={(mounted) => {
            setTop(mounted.getOption(monaco.editor.EditorOption.lineHeight));
            setEditor(mounted);
          }}
          options={options}
        />
      )}
      {editor !== null && code !== undefined && (
        <RangeNotes key={`${key}:${start}-${end}:${picked}`} editor={editor} path={file} woven={woven} between={woven === null ? null : source.compared} />
      )}
      {note !== null && (
        <div className="code-note" style={{ left: note.x, top: note.y }}>
          {note.text}
        </div>
      )}
    </div>
  );
}
