import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useState } from "react";
import { getDefinition, getFile } from "../api/client";
import type { FileText } from "../api/types";
import { useAtlas } from "../state/store";
import { keepModel, monacoTheme } from "./monaco";
import { RangeNotes } from "./RangeNotes";

type CodeEditor = Parameters<OnMount>[0];

interface CodeViewProps {
  path: string;
  /** 문법 색으로 그릴 1부터 세는 시작 줄과 끝 줄. 범위 밖의 줄은 흐리게 그린다. null이면 파일 전체다. */
  range: [number, number] | null;
  /** 바탕을 칠하고 화면 가운데로 옮길 줄 번호 */
  highlight?: number;
}

interface Note {
  text: string;
  x: number;
  y: number;
}

const NOTE_MS = 2000;
const OPTIONS = {
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  glyphMargin: true,
  scrollBeyondLastLine: false,
  fontSize: 13,
  renderLineHighlight: "none" as const,
  automaticLayout: true,
  fixedOverflowWidgets: true,
};

export function CodeView({ path, range, highlight }: CodeViewProps) {
  const theme = useAtlas((s) => s.theme);
  const select = useAtlas((s) => s.select);
  const [file, setFile] = useState<FileText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  /** 정의가 레포 밖에 있을 때 누른 곳 옆에 잠시 띄우는 말풍선 */
  const [note, setNote] = useState<Note | null>(null);

  const [start, end] = range ?? [null, null];
  const code = file?.path === path ? file.text : undefined;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // 파일이 바뀌면 코드 뷰어를 새로 만들므로 앞 파일의 코드 뷰어를 쓰지 않는다.
    setEditor(null);
    getFile(path)
      .then((got) => !cancelled && setFile(got))
      .catch((caught: unknown) => !cancelled && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (code !== undefined) {
      keepModel(path);
    }
  }, [path, code]);

  // 범위 밖의 줄을 흐리게 그리고 범위의 줄 번호 옆에 세로 줄을 긋는다. 범위의 첫 줄을 코드 뷰어 맨 위로 옮긴다.
  useEffect(() => {
    if (editor === null || code === undefined) {
      return;
    }
    if (start === null || end === null) {
      editor.setScrollTop(0);
      return;
    }
    const last = editor.getModel()?.getLineCount() ?? end;
    const lines = (from: number, to: number) => ({ startLineNumber: from, startColumn: 1, endLineNumber: to, endColumn: 1 });
    const decorations = editor.createDecorationsCollection([
      ...(start > 1 ? [{ range: lines(1, start - 1), options: { isWholeLine: true, inlineClassName: "code-dim" } }] : []),
      ...(end < last ? [{ range: lines(end + 1, last), options: { isWholeLine: true, inlineClassName: "code-dim" } }] : []),
      { range: lines(start, end), options: { isWholeLine: true, linesDecorationsClassName: "code-scope" } },
    ]);
    editor.setScrollTop(editor.getTopForLineNumber(start));
    return () => decorations.clear();
  }, [editor, code, start, end]);

  // 줄의 바탕을 칠하고 화면 가운데로 옮긴다.
  useEffect(() => {
    if (editor === null || code === undefined || highlight === undefined) {
      return;
    }
    const decorations = editor.createDecorationsCollection([
      {
        range: { startLineNumber: highlight, startColumn: 1, endLineNumber: highlight, endColumn: 1 },
        options: { isWholeLine: true, className: "code-range" },
      },
    ]);
    editor.revealLineInCenter(highlight);
    return () => decorations.clear();
  }, [editor, code, highlight]);

  // Mod+클릭한 이름의 정의가 레포 안에 있으면 그 노드를 고르고, 레포 밖에 있으면 외부 모듈 이름을 띄운다.
  useEffect(() => {
    if (editor === null) {
      return;
    }
    const listener = editor.onMouseDown((event) => {
      const position = event.target.position;
      const mouse = event.event;
      if (!mouse.leftButton || !(mouse.metaKey || mouse.ctrlKey) || position === null) {
        return;
      }
      const body = editor.getContainerDomNode().getBoundingClientRect();
      const at = { x: mouse.browserEvent.clientX - body.left, y: mouse.browserEvent.clientY - body.top };
      const asked = useAtlas.getState().selection;
      getDefinition(path, position.lineNumber, position.column - 1)
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
  }, [editor, path, select]);

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
        if (word == null || position === null) {
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
        getDefinition(path, line, word.startColumn - 1)
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
  }, [editor, path]);

  useEffect(() => {
    if (note === null) {
      return;
    }
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  return (
    <div className="code">
      {error !== null && <div className="code-error">{error}</div>}
      {code !== undefined && (
        <Editor
          path={path}
          defaultLanguage="python"
          value={code}
          theme={monacoTheme(theme)}
          onMount={(mounted) => setEditor(mounted)}
          options={OPTIONS}
        />
      )}
      {editor !== null && code !== undefined && <RangeNotes key={`${path}:${start}-${end}`} editor={editor} path={path} />}
      {note !== null && (
        <div className="code-note" style={{ left: note.x, top: note.y }}>
          {note.text}
        </div>
      )}
    </div>
  );
}
