// LLM 요약 칸. 고른 노드의 설명을 캐시에서 읽어 요지, 하는 일, 앞뒤 흐름 세 부분으로 보이고, 캐시에 없으면 "요약 생성" 버튼을 눌렀을 때 만든다.
// 이 화면에서 만든 요약은 머리 줄의 오른쪽 끝에 그 호출이 쓴 토큰 수를 적는다.
// 구역 머리를 눌러 접으면 요약의 요지만 한 줄로 보인다. 필터 창의 "자동 요약"이 켜져 있으면 노드를 고른 채 잠시 머문 뒤에 만든다. 요약 상태와 요청은 `state/summaries.ts`가 가지므로
// 노드를 떠나도 만들고 있던 요약은 끝까지 만든다.
import { useEffect } from "react";
import { useAtlas } from "../state/store";
import { useSummaries, type SummaryState } from "../state/summaries";
import { cacheTip, usageText } from "../state/usage";
import { Blocks, useInline } from "./inline";
import { partsOf } from "./parts";
import { SectionHead } from "./Section";

/** "자동 요약"이 켜져 있을 때 캐시에 없는 요약은 노드를 고른 채 이만큼 머문 뒤에 만든다. */
const DELAY = 600;

const READING: SummaryState = { phase: "reading" };

function Explained({ summary, stale }: { summary: string; stale: boolean }) {
  const inline = useInline();
  const { lead, sections } = partsOf(summary);

  return (
    <div className={stale ? "summary-text stale-text" : "summary-text"}>
      <p className="summary-lead">{inline(lead)}</p>
      {sections.map((section) => (
        <section key={section.title} className="summary-part">
          <h4 className="summary-title">{section.title}</h4>
          <Blocks blocks={section.blocks} />
        </section>
      ))}
    </div>
  );
}

/** 접힌 요약 칸이 구역 이름 옆에 적는 한 줄. 요약이 있으면 요지에서 백틱과 `**`를 뺀 글이고, 없으면 요약의 상태다. */
function briefOf(state: SummaryState): string {
  switch (state.phase) {
    case "done":
      return partsOf(state.summary).lead.replace(/`|\*\*/g, "");
    case "making":
      return "요약을 만드는 중";
    case "empty":
      return "만든 요약이 없다";
    case "failed":
      return state.error;
    case "unavailable":
      return state.reason;
    default:
      return "";
  }
}

interface SummaryProps {
  node: string;
  /** 사용자가 경계선을 끌어 정한 높이를 정보 패널 높이로 나눈 값. null이면 내용만큼 쓴다. */
  split: number | null;
}

export function Summary({ node, split }: SummaryProps) {
  const auto = useAtlas((s) => s.autoSummary);
  const unread = useSummaries((s) => s.states[node] === undefined);
  const state = useSummaries((s) => s.states[node]) ?? READING;
  const read = useSummaries((s) => s.read);
  const make = useSummaries((s) => s.make);
  const open = useAtlas((s) => s.summaryOpen);
  const toggle = useAtlas((s) => s.toggleSummary);

  // 읽지 않은 노드면 읽는다. 취소한 요청의 노드는 읽지 않은 노드로 돌아가므로 고른 채로도 다시 읽는다.
  useEffect(() => read(node), [node, read, unread]);

  /** "자동 요약"이 켜져 있으면 요약이 없는 노드와 요약을 만든 뒤 바뀐 노드의 요약을 만든다. */
  const waiting = auto && (state.phase === "empty" || (state.phase === "done" && state.stale && state.available));
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = window.setTimeout(() => make(node, false), DELAY);
    return () => window.clearTimeout(timer);
  }, [waiting, node, make]);

  if (!open) {
    return (
      <div className="info-panel-summary" data-folded="">
        <SectionHead name="LLM 요약" open={false} toggle={toggle} brief={briefOf(state)} />
      </div>
    );
  }
  return (
    <div className="info-panel-summary" data-sized={split === null ? undefined : ""} style={split === null ? undefined : { height: `${split * 100}%`, maxHeight: "none" }}>
      <div className="summary-head">
        <SectionHead name="LLM 요약" open toggle={toggle} brief="" />
        {state.phase === "done" && state.usage !== null && (
          <span className="summary-usage" data-tip={cacheTip(state.usage)}>
            {usageText(state.usage)}
          </span>
        )}
        {state.phase === "done" && state.available && (
          <button className="summary-action" onClick={() => make(node, true)}>
            다시 생성
          </button>
        )}
      </div>
      {state.phase === "reading" && <span className="info-panel-hint">&nbsp;</span>}
      {state.phase === "empty" && (
        <button className="summary-action summary-make" onClick={() => make(node, false)}>
          요약 생성
        </button>
      )}
      {state.phase === "making" && <span className="info-panel-hint">요약을 만드는 중</span>}
      {state.phase === "done" && state.stale && <p className="stale-note">코드나 앞뒤 흐름이 바뀌기 전에 만든 요약</p>}
      {state.phase === "done" && <Explained summary={state.summary} stale={state.stale} />}
      {state.phase === "failed" && (
        <>
          <span className="info-panel-hint">{state.error}</span>
          <button className="summary-action" onClick={() => make(node, state.refresh)}>
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
