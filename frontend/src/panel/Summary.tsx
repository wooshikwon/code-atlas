// LLM 요약 칸. 고른 노드의 요약을 캐시에서 읽어 보이고, 캐시에 없으면 "요약 생성" 버튼을 눌렀을 때 만든다.
// 상단 줄의 "자동 요약"이 켜져 있으면 노드를 고른 채 잠시 머문 뒤에 만든다.
import { useEffect, useState } from "react";
import { getSummary, makeSummary } from "../api/client";
import { useAtlas } from "../state/store";

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

/** 노드가 바뀌면 `key`로 새로 그린다. */
export function Summary({ node }: { node: string }) {
  const auto = useAtlas((s) => s.autoSummary);
  const [state, setState] = useState<State>({ phase: "reading" });
  /** 지금 요청. 버튼을 누를 때마다 count를 올려 다시 보낸다. */
  const [asked, setAsked] = useState<{ count: number; mode: Mode }>({ count: 0, mode: "read" });

  useEffect(() => {
    let cancelled = false;
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
      makeSummary(node, mode === "refresh").then(
        (made) => !cancelled && setState({ phase: "done", summary: made.summary, available: true }),
        fail,
      );
    }
    return () => {
      cancelled = true;
    };
  }, [node, asked]);

  const ask = (mode: Mode) => setAsked((prev) => ({ count: prev.count + 1, mode }));

  const waiting = state.phase === "empty" && auto;
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = window.setTimeout(() => ask("make"), DELAY);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  return (
    <div className="info-panel-summary">
      <span className="info-panel-label">LLM 요약</span>
      <div className="summary-body">
        {state.phase === "reading" && <span className="info-panel-hint">&nbsp;</span>}
        {state.phase === "empty" && (
          <button className="summary-action summary-make" onClick={() => ask("make")}>
            요약 생성
          </button>
        )}
        {state.phase === "making" && <span className="info-panel-hint">요약을 만드는 중</span>}
        {state.phase === "done" && (
          <>
            <span className="summary-text">{state.summary}</span>
            {state.available && (
              <button className="summary-action" onClick={() => ask("refresh")}>
                다시 생성
              </button>
            )}
          </>
        )}
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
    </div>
  );
}
