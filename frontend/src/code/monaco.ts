// Monaco를 CDN에서 받지 않고 번들에 넣는다. 언어 기능 가운데 문법 색, 찾기, hover만 싣는다. 언어는 모델 주소의 파일 이름으로 정한다.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/register.all";
import { jsonDefaults } from "monaco-editor/languages/features/json/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/hover/register";
import { colors, type Theme } from "../theme";
import "./hover";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
// JSON은 문법 색만 켠다. 나머지 기능은 JSON 워커를 쓴다.
jsonDefaults.setModeConfiguration({ tokens: true });
// TOML은 문법 정의가 없으므로 구획과 `키 = 값`을 같은 꼴로 적는 INI의 문법 색을 쓴다.
monaco.languages.register({ id: "ini", extensions: [".toml"] });
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

/** 코드 뷰어의 모델이 작업 중인 상태의 어느 파일을 보이는지. hover와 정의 이동이 언어 서버에 묻는 위치를 이 값으로 정한다. */
export interface Placed {
  /** 레포 루트 기준 파일 경로 */
  path: string;
  /** 모델의 줄이 그 파일의 몇째 줄인지. 작업 중인 상태에 없는 줄이면 null이다. */
  fileLine(line: number): number | null;
  /** 파일의 줄이 모델의 몇째 줄인지 */
  modelLine(line: number): number | null;
}

const placed = new Map<string, Placed>();

/** 주소가 key인 모델이 보이는 파일을 적어 둔다. */
export function place(key: string, at: Placed): void {
  placed.set(monaco.Uri.parse(key).toString(), at);
}

export function placedOf(model: monaco.editor.ITextModel): Placed | undefined {
  return placed.get(model.uri.toString());
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
    const uri = monaco.Uri.parse(recent.shift()!);
    placed.delete(uri.toString());
    monaco.editor.getModel(uri)?.dispose();
  }
}
