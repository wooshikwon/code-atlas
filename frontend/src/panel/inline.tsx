// 설명의 문단·목록·코드 블록과 그 안의 백틱 식별자, 정의 표기, 굵은 글씨를 그린다. LLM 요약 칸과 코드 범위 설명 창이 함께 쓴다.
import { useMemo, type ReactNode } from "react";
import { nodeIndex } from "../graph/visible";
import { useAtlas } from "../state/store";
import { refsOf, spansOf, type Block } from "./parts";

/** 정의 표기의 파일 경로와 `::`는 흐리게, 정의 이름은 본문 잉크로 그린다. */
function refText(text: string): ReactNode {
  const at = text.indexOf("::") + 2;
  return (
    <>
      <span className="ref-path">{text.slice(0, at)}</span>
      {text.slice(at)}
    </>
  );
}

/**
 * 문단을 그릴 조각으로 바꾸는 함수. 백틱으로 감싼 식별자와 정의 표기를 등폭 글꼴의 코드 칩으로 그리고,
 * 그래프의 노드와 대응하는 정의 표기는 누르면 그 노드를 고르는 칩으로 그린다. `**`로 감싼 글은 굵게 그린다.
 */
export function useInline(): (text: string) => ReactNode[] {
  const graph = useAtlas((s) => s.graph);
  const show = useAtlas((s) => s.show);
  const refs = useMemo(() => (graph === null ? new Map<string, string>() : refsOf(nodeIndex(graph))), [graph]);
  return (text) =>
    spansOf(text).map((span, i) => {
      const target = span.ref ? refs.get(span.text) : undefined;
      let piece: ReactNode = span.text;
      if (target !== undefined) {
        piece = (
          <button className="summary-ref" data-node={target} title="그래프에서 고르기" onClick={() => show(target)}>
            <code>{refText(span.text)}</code>
          </button>
        );
      } else if (span.code) {
        piece = <code>{span.ref ? refText(span.text) : span.text}</code>;
      }
      return span.bold ? <strong key={i}>{piece}</strong> : <span key={i}>{piece}</span>;
    });
}

/** 문단은 `<p>`, 목록은 `<ul>`·`<ol>`, 코드 블록은 `<pre>`로 그린다. */
export function Blocks({ blocks }: { blocks: Block[] }) {
  const inline = useInline();
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "paragraph":
            return <p key={i}>{inline(block.text)}</p>;
          case "code":
            return (
              <pre key={i} className="summary-code">
                {block.text}
              </pre>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={i} className="summary-list">
                {block.items.map((item, at) => (
                  <li key={at}>{inline(item)}</li>
                ))}
              </List>
            );
          }
        }
      })}
    </>
  );
}
