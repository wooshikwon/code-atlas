// Monaco를 CDN에서 받지 않고 번들에 넣는다. 언어 기능 가운데 Python 문법 색, 찾기, hover만 싣는다.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/hover/register";
import { colors, type Theme } from "../theme";
import "./hover";

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

const MODELS_KEPT = 20;
const recent: string[] = [];

/** 코드 뷰어가 연 모델의 주소를 기억하고, 최근에 연 20개에 들지 않는 모델을 지운다. */
export function keepModel(path: string): void {
  const at = recent.indexOf(path);
  if (at !== -1) {
    recent.splice(at, 1);
  }
  recent.push(path);
  while (recent.length > MODELS_KEPT) {
    monaco.editor.getModel(monaco.Uri.parse(recent.shift()!))?.dispose();
  }
}
