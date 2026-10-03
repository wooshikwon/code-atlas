// Monaco를 CDN에서 받지 않고 번들에 넣는다. 언어 기능 가운데 Python 문법 색과 찾기만 싣는다.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/features/find/register";
import { colors, type Theme } from "../theme";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

export function monacoTheme(theme: Theme): string {
  return `atlas-${theme}`;
}

for (const theme of ["light", "dark"] as const) {
  const c = colors(theme);
  monaco.editor.defineTheme(monacoTheme(theme), {
    base: theme === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [],
    colors: { "editor.background": c.surface, "editorLineNumber.foreground": c.muted },
  });
}
