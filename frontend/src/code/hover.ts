// 코드 뷰어의 이름 위에 마우스를 올리면 백엔드가 basedpyright에서 받은 타입과 문서 문자열을 보여 준다.
import * as monaco from "monaco-editor/editor";
import { getHover } from "../api/client";
import { placedOf } from "./monaco";

monaco.languages.registerHoverProvider("python", {
  async provideHover(model, position, token) {
    const at = placedOf(model);
    const line = at?.fileLine(position.lineNumber) ?? null;
    if (at === undefined || line === null) {
      return null;
    }
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    try {
      const hover = await getHover(at.path, line, position.column - 1, controller.signal);
      if (hover.markdown === null) {
        return null;
      }
      const range = hover.range;
      const [from, to] = range === null ? [null, null] : [at.modelLine(range[0]), at.modelLine(range[2])];
      return {
        contents: [{ value: hover.markdown }],
        range: range === null || from === null || to === null ? undefined : new monaco.Range(from, range[1] + 1, to, range[3] + 1),
      };
    } catch {
      // 취소한 요청과 LSP 세션이 없는 서버의 응답은 hover를 비운다.
      return null;
    }
  },
});
