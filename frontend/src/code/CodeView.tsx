import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useMemo, useState } from "react";
import { getDefinition, getFile } from "../api/client";
import type { FileText } from "../api/types";
import { useAtlas } from "../state/store";
import { modelPath } from "./hover";
import { keepModel, monacoTheme } from "./monaco";

type CodeEditor = Parameters<OnMount>[0];

interface CodeViewProps {
  path: string;
  /** 보여 줄 1부터 세는 시작 줄과 끝 줄 */
  range: [number, number];
  /** 강조하고 화면 가운데로 옮길 파일 줄 번호 */
  highlight?: number;
}

interface Note {
  text: string;
  x: number;
  y: number;
}

const NOTE_MS = 2000;

export function CodeView({ path, range, highlight }: CodeViewProps) {
  const theme = useAtlas((s) => s.theme);
  const select = useAtlas((s) => s.select);
  const [file, setFile] = useState<FileText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  /** 정의가 레포 밖에 있을 때 누른 곳 옆에 잠시 띄우는 말풍선 */
  const [note, setNote] = useState<Note | null>(null);

  const [start, end] = range;
  const model = modelPath(path, range);
  const text = file?.path === path ? file.text : undefined;
  const code = useMemo(() => text?.split("\n").slice(start - 1, end).join("\n"), [text, start, end]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getFile(path)
      .then((got) => !cancelled && setFile(got))
      .catch((caught: unknown) => !cancelled && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (code !== undefined) {
      keepModel(model);
    }
  }, [model, code]);

  // 코드가 모델에 들어간 뒤에 줄을 강조하고 화면 가운데로 옮긴다.
  useEffect(() => {
    if (editor === null || code === undefined || highlight === undefined) {
      return;
    }
    const line = highlight - start + 1;
    const decorations = editor.createDecorationsCollection([
      {
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: { isWholeLine: true, className: "code-range" },
      },
    ]);
    editor.revealLineInCenter(line);
    return () => decorations.clear();
  }, [editor, code, model, highlight, start]);

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
      getDefinition(path, position.lineNumber + start - 1, position.column - 1)
        .then(({ targets }) => {
          const target = targets.at(0);
          const selection = useAtlas.getState().selection;
          if (target === undefined) {
            return;
          }
          if (target.node !== null) {
            if (selection?.type !== "node" || selection.id !== target.node) {
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
  }, [editor, path, start, select]);

  useEffect(() => {
    if (note === null) {
      return;
    }
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  const options = useMemo(
    () => ({
      readOnly: true,
      domReadOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      renderLineHighlight: "none" as const,
      automaticLayout: true,
      fixedOverflowWidgets: true,
      lineNumbers: (n: number) => String(n + start - 1),
    }),
    [start],
  );

  return (
    <div className="code">
      {error !== null && <div className="code-error">{error}</div>}
      {code !== undefined && (
        <Editor
          path={model}
          defaultLanguage="python"
          value={code}
          theme={monacoTheme(theme)}
          onMount={(mounted) => setEditor(mounted)}
          options={options}
        />
      )}
      {note !== null && (
        <div className="code-note" style={{ left: note.x, top: note.y }}>
          {note.text}
        </div>
      )}
    </div>
  );
}
