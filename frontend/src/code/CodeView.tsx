import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { getFile } from "../api/client";
import { useAtlas } from "../state/AtlasProvider";
import { monacoTheme } from "./monaco";

type CodeEditor = Parameters<OnMount>[0];

export function CodeView() {
  const { openFile, theme } = useAtlas();
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  const decorations = useRef<string[]>([]);

  const path = openFile?.path ?? null;
  const text = path === null ? undefined : texts.get(path);

  useEffect(() => {
    if (path === null || texts.has(path)) {
      return;
    }
    let cancelled = false;
    getFile(path)
      .then((file) => !cancelled && setTexts((prev) => new Map(prev).set(file.path, file.text)))
      .catch((caught: unknown) => !cancelled && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      cancelled = true;
    };
  }, [path, texts]);

  // 파일 본문이 모델에 들어간 뒤에 범위를 강조하고 화면 가운데로 옮긴다.
  useEffect(() => {
    if (editor === null || text === undefined || openFile === null) {
      return;
    }
    const range = openFile.range;
    decorations.current = editor.deltaDecorations(
      decorations.current,
      range === null
        ? []
        : [
            {
              range: { startLineNumber: range[0], startColumn: 1, endLineNumber: range[1], endColumn: 1 },
              options: { isWholeLine: true, className: "code-range" },
            },
          ],
    );
    editor.revealLineInCenter(range === null ? 1 : range[0]);
  }, [editor, text, openFile]);

  return (
    <div className="code">
      <div className="code-header">{path ?? "노드나 파일을 고르면 코드를 연다"}</div>
      <div className="code-body">
        {error !== null && <div className="code-error">{error}</div>}
        {path !== null && text !== undefined && (
          <Editor
            path={path}
            defaultLanguage="python"
            value={text}
            theme={monacoTheme(theme)}
            onMount={(mounted) => setEditor(mounted)}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              renderLineHighlight: "none",
              automaticLayout: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
