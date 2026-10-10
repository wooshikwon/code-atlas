// 코드 뷰어의 이름 위에 마우스를 올리면 백엔드가 basedpyright에서 받은 타입과 문서 문자열을 보여 준다.
import * as monaco from "monaco-editor/editor";
import { getHover } from "../api/client";

/** 코드 뷰어 모델의 주소. 노드의 줄 범위만 담은 모델이므로 파일 경로 뒤에 `#L{시작}-{끝}`을 붙인다. */
export function modelPath(path: string, range: [number, number]): string {
  return `${path}#L${range[0]}-${range[1]}`;
}

/** 모델이 담은 파일 경로와 모델 첫 줄의 파일 줄 번호 */
function located(model: monaco.editor.ITextModel): { path: string; start: number } | null {
  const match = /^L(\d+)-\d+$/.exec(model.uri.fragment);
  return match === null ? null : { path: model.uri.path.replace(/^\//, ""), start: Number(match[1]) };
}

monaco.languages.registerHoverProvider("python", {
  async provideHover(model, position, token) {
    const at = located(model);
    if (at === null) {
      return null;
    }
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    try {
      const hover = await getHover(at.path, position.lineNumber + at.start - 1, position.column - 1, controller.signal);
      if (hover.markdown === null) {
        return null;
      }
      const range = hover.range;
      return {
        contents: [{ value: hover.markdown }],
        range:
          range === null
            ? undefined
            : new monaco.Range(range[0] - at.start + 1, range[1] + 1, range[2] - at.start + 1, range[3] + 1),
      };
    } catch {
      // 취소한 요청과 LSP 세션이 없는 서버의 응답은 hover를 비운다.
      return null;
    }
  },
});
