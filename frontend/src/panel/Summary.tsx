// LLM 요약 칸. 고른 노드의 요약을 캐시에서 읽고, 없으면 만들게 한 뒤 보인다.
import { useEffect, useState } from "react";
import { getSummary, makeSummary } from "../api/client";

/** 캐시에 없는 요약은 노드를 고른 채 이만큼 머문 뒤에 만든다. */
const DELAY = 600;

type State =
  | { phase: "reading" }
  | { phase: "making" }
  | { phase: "done"; summary: string; available: boolean }
  | { phase: "failed"; error: string }
  | { phase: "unavailable"; reason: string };

/** 노드가 바뀌면 `key`로 새로 그린다. */
export function Summary({ node }: { node: string }) {
  const [state, setState] = useState<State>({ phase: "reading" });
  /** 버튼으로 요청한 생성. count가 0이면 캐시부터 읽는다. */
  const [asked, setAsked] = useState({ count: 0, refresh: false });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const fail = (error: unknown) => {
      if (!cancelled) {
        setState({ phase: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    };
    const make = (refresh: boolean) => {
      makeSummary(node, refresh).then((made) => {
        if (!cancelled) {
          setState({ phase: "done", summary: made.summary, available: true });
        }
      }, fail);
    };
    if (asked.count > 0) {
      setState({ phase: "making" });
      make(asked.refresh);
    } else {
      getSummary(node).then((cached) => {
        if (cancelled) {
          return;
        }
        if (cached.summary !== null) {
          setState({ phase: "done", summary: cached.summary, available: cached.available });
        } else if (!cached.available) {
          setState({ phase: "unavailable", reason: cached.reason ?? "Claude Code CLI를 부르지 못한다" });
        } else {
          setState({ phase: "making" });
          timer = window.setTimeout(() => make(false), DELAY);
        }
      }, fail);
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [node, asked]);

  const ask = (refresh: boolean) => setAsked((prev) => ({ count: prev.count + 1, refresh }));

  return (
    <div className="info-panel-summary">
      <span className="info-panel-label">LLM 요약</span>
      {state.phase === "reading" && <span className="info-panel-hint">&nbsp;</span>}
      {state.phase === "making" && <span className="info-panel-hint">요약을 만드는 중</span>}
      {state.phase === "done" && (
        <>
          <span className="summary-text">{state.summary}</span>
          {state.available && (
            <button className="summary-action" onClick={() => ask(true)}>
              다시 생성
            </button>
          )}
        </>
      )}
      {state.phase === "failed" && (
        <>
          <span className="info-panel-hint">{state.error}</span>
          <button className="summary-action" onClick={() => ask(false)}>
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
