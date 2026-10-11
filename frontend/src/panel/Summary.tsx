// LLM 요약 칸. 고른 노드의 설명을 캐시에서 읽어 요지, 하는 일, 앞뒤 흐름 세 부분으로 보이고, 캐시에 없으면 "요약 생성" 버튼을 눌렀을 때 만든다.
// 상단 줄의 "자동 요약"이 켜져 있으면 노드를 고른 채 잠시 머문 뒤에 만든다. 노드를 떠나거나 "자동 요약"을 끄면
// 만들고 있던 요청을 끊는다.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getSummary, makeSummary } from "../api/client";
import { nodeIndex } from "../graph/visible";
import { useAtlas } from "../state/store";
import { partsOf, refsOf, spansOf } from "./parts";

/** "자동 요약"이 켜져 있을 때 캐시에 없는 요약은 노드를 고른 채 이만큼 머문 뒤에 만든다. */
const DELAY = 600;

/** 요청 한 번이 하는 일. read는 캐시만 읽고, make는 캐시에 없으면 만들고, refresh는 캐시에 있어도 다시 만든다. */
type Mode = "read" | "make" | "refresh";

type State =
  | { phase: "reading" }
  | { phase: "empty" }
  | { phase: "making" }
  | { phase: "done"; summary: string; available: boolean }
  | { phase: "failed"; error: string; mode: Mode }
  | { phase: "unavailable"; reason: string };

function Explained({ summary }: { summary: string }) {
  const graph = useAtlas((s) => s.graph);
  const show = useAtlas((s) => s.show);
  const refs = useMemo(() => (graph === null ? new Map<string, string>() : refsOf(nodeIndex(graph))), [graph]);
  const { lead, sections } = partsOf(summary);

  /** 백틱으로 감싼 식별자와 정의 표기를 등폭 글꼴로 그린다. 그래프의 노드와 대응하는 정의 표기는 누르면 그 노드를 고른다. */
  const inline = (text: string): ReactNode[] =>
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

  return (
    <div className="summary-text">
      <p className="summary-lead">{inline(lead)}</p>
      {sections.map((section) => (
        <section key={section.title} className="summary-part">
          <h4 className="info-panel-label">{section.title}</h4>
          {section.paragraphs.map((paragraph, i) => (
            <p key={i}>{inline(paragraph)}</p>
          ))}
        </section>
      ))}
    </div>
  );
}

/** 노드가 바뀌면 `key`로 새로 그린다. */
export function Summary({ node }: { node: string }) {
  const auto = useAtlas((s) => s.autoSummary);
  const [state, setState] = useState<State>({ phase: "reading" });
  /** 지금 요청. 버튼을 누를 때마다 count를 올려 다시 보낸다. auto는 "자동 요약"이 보낸 요청이다. */
  const [asked, setAsked] = useState<{ count: number; mode: Mode; auto: boolean }>({ count: 0, mode: "read", auto: false });

  useEffect(() => {
    let cancelled = false;
    const making = new AbortController();
    const { mode } = asked;
    const fail = (error: unknown) =>
      !cancelled && setState({ phase: "failed", error: error instanceof Error ? error.message : String(error), mode });
    if (mode === "read") {
      getSummary(node).then((cached) => {
        if (cancelled) {
          return;
        }
        if (cached.summary !== null) {
          setState({ phase: "done", summary: cached.summary, available: cached.available });
        } else if (!cached.available) {
          setState({ phase: "unavailable", reason: cached.reason ?? "Claude Code CLI를 부르지 못한다" });
        } else {
          setState({ phase: "empty" });
        }
      }, fail);
    } else {
      setState({ phase: "making" });
      makeSummary(node, mode === "refresh", making.signal).then(
        (made) => !cancelled && setState({ phase: "done", summary: made.summary, available: true }),
        fail,
      );
    }
    return () => {
      cancelled = true;
      making.abort();
    };
  }, [node, asked]);

  const ask = (mode: Mode, auto = false) => setAsked((prev) => ({ count: prev.count + 1, mode, auto }));

  const waiting = state.phase === "empty" && auto;
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = window.setTimeout(() => ask("make", true), DELAY);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  // "자동 요약"을 끄면 그 토글이 보낸 요청을 끊고 캐시를 다시 읽는다.
  const dropped = !auto && asked.auto && state.phase === "making";
  useEffect(() => {
    if (dropped) {
      ask("read");
    }
  }, [dropped]);

  return (
    <div className="info-panel-summary">
      <div className="summary-head">
        <span className="info-panel-label">LLM 요약</span>
        {state.phase === "done" && state.available && (
          <button className="summary-action" onClick={() => ask("refresh")}>
            다시 생성
          </button>
        )}
      </div>
      {state.phase === "reading" && <span className="info-panel-hint">&nbsp;</span>}
      {state.phase === "empty" && (
        <button className="summary-action summary-make" onClick={() => ask("make")}>
          요약 생성
        </button>
      )}
      {state.phase === "making" && <span className="info-panel-hint">요약을 만드는 중</span>}
      {state.phase === "done" && <Explained summary={state.summary} />}
      {state.phase === "failed" && (
        <>
          <span className="info-panel-hint">{state.error}</span>
          <button className="summary-action" onClick={() => ask(state.mode)}>
            다시 시도
          </button>
        </>
      )}
      {state.phase === "unavailable" && (
        <span className="info-panel-hint">
          {state.reason}. Claude Code를 설치하고 터미널에서 <code>claude auth login</code>으로 로그인하면 요약을 만든다
        </span>
      )}
    </div>
  );
}
