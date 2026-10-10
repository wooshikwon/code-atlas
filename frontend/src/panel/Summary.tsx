// LLM 요약 칸. 요약을 만들기 전에는 표지와 안내 문구만 그린다.
import type { NodeKind } from "../api/types";
import { KIND_NAMES } from "../graph/view";

/** 받침이 있는 글자 뒤에는 "이", 없는 글자 뒤에는 "가"를 붙인다. */
function subject(word: string): string {
  const last = word.charCodeAt(word.length - 1) - 0xac00;
  return `${word}${last >= 0 && last % 28 !== 0 ? "이" : "가"}`;
}

export function Summary({ kind }: { kind: NodeKind }) {
  return (
    <div className="info-panel-summary">
      <span className="info-panel-label">LLM 요약</span>
      <span className="info-panel-hint">
        3단계에서 LLM이 이 {subject(KIND_NAMES[kind])} 하는 일을 한두 문장으로 적는다
      </span>
    </div>
  );
}
