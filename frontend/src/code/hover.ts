// 코드 뷰어의 이름 위에 마우스를 올리면 백엔드가 basedpyright에서 받은 타입과 문서 문자열을 보여 준다.
import * as monaco from "monaco-editor/editor";
import { getHover } from "../api/client";

monaco.languages.registerHoverProvider("python", {
  async provideHover(model, position, token) {
    // 코드 뷰어는 레포 루트 기준 파일 경로를 모델의 주소로 쓴다.
    const path = model.uri.path.replace(/^\//, "");
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    try {
      const hover = await getHover(path, position.lineNumber, position.column - 1, controller.signal);
      if (hover.markdown === null) {
        return null;
      }
      const range = hover.range;
      return {
        contents: [{ value: hover.markdown }],
        range: range === null ? undefined : new monaco.Range(range[0], range[1] + 1, range[2], range[3] + 1),
      };
    } catch {
      // 취소한 요청과 LSP 세션이 없는 서버의 응답은 hover를 비운다.
      return null;
    }
  },
});
