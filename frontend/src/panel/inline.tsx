// 설명 문단 안의 백틱 식별자와 정의 표기를 그린다. LLM 요약 칸과 코드 범위 설명 창이 함께 쓴다.
import { useMemo, type ReactNode } from "react";
import { nodeIndex } from "../graph/visible";
import { useAtlas } from "../state/store";
import { refsOf, spansOf } from "./parts";

/**
 * 문단을 그릴 조각으로 바꾸는 함수. 백틱으로 감싼 식별자와 정의 표기를 등폭 글꼴로 그리고,
 * 그래프의 노드와 대응하는 정의 표기는 누르면 그 노드를 고른다.
 */
export function useInline(): (text: string) => ReactNode[] {
  const graph = useAtlas((s) => s.graph);
  const show = useAtlas((s) => s.show);
  const refs = useMemo(() => (graph === null ? new Map<string, string>() : refsOf(nodeIndex(graph))), [graph]);
  return (text) =>
    spansOf(text).map((span, i) => {
      const target = span.ref ? refs.get(span.text) : undefined;
      if (target !== undefined) {
        return (
          <button key={i} className="summary-ref" data-node={target} title="그래프에서 고르기" onClick={() => show(target)}>
            <code>{span.text}</code>
          </button>
        );
      }
      return span.code ? <code key={i}>{span.text}</code> : span.text;
    });
}
