// 인터프리터를 고르는 화면. 레포의 Python 인터프리터를 찾지 못했을 때와 연 레포의 인터프리터를 바꿀 때 까닭과 시도한 경로,
// 이 기기에서 찾은 인터프리터를 보이고 하나를 고르게 한다. 목록에 없는 인터프리터는 앱이 파일 선택 대화상자로, 브라우저가
// 경로 입력 칸으로 받는다. 고른 경로는 서버가 실행해 확인하고 그 레포의 인터프리터로 기억한다.
import { useState } from "react";
import type { Attempt, Found } from "../api/types";
import { host } from "../host";
import { nameOf, useOpening, type Step } from "../state/opening";
import { sourceName } from "../state/tools";

/**
 * 맨 위에 적는 문장. 지금 쓰는 인터프리터가 있으면 그 경로를, 저장해 둔 인터프리터가 실행되지 않았으면 그 경로와 까닭을,
 * 그 밖에는 찾지 못했다는 문장을 적는다.
 */
function headline(path: string, found: Found): string {
  if (found.path !== null) {
    return `${nameOf(path)}의 Python 인터프리터를 고른다. 지금은 ${found.path}`;
  }
  const saved = found.attempts.find((attempt) => attempt.source === "saved" && !attempt.ok);
  return saved === undefined
    ? `${nameOf(path)}의 Python 인터프리터를 찾지 못했다. 이 레포의 패키지가 설치된 인터프리터를 고른다`
    : `저장해 둔 인터프리터를 실행하지 못했다: ${saved.path} (${saved.detail})`;
}

/** 시도 기록 한 줄. 출처, 경로, 결과 세 칸이다. 결과는 통과했으면 판 번호이고 아니면 통과하지 못한 까닭이다. */
export function AttemptRow({ attempt }: { attempt: Attempt }) {
  const result = attempt.ok ? `통과 · ${attempt.detail}` : attempt.detail;
  return (
    <li className="ask-attempt" data-ok={attempt.ok ? "" : undefined}>
      <span className="ask-attempt-source">{sourceName(attempt.source)}</span>
      <span className="ask-attempt-path" data-full={attempt.path ?? undefined}>
        <bdi>{attempt.path ?? "경로 없음"}</bdi>
      </span>
      <span className="ask-attempt-detail" data-full={result}>
        {result}
      </span>
    </li>
  );
}

export function Interpreters({ step }: { step: Extract<Step, { kind: "ask-python" }> }) {
  const choose = useOpening((s) => s.choose);
  const cancel = useOpening((s) => s.cancel);
  const [typed, setTyped] = useState("");
  const pick = (python: string) => void choose(step.path, { asIs: true, python });

  return (
    <>
      <h2 className="ask-title" id="ask-title">
        {headline(step.path, step.found)}
      </h2>
      {step.error !== undefined && (
        <p className="ask-error" role="alert">
          {step.error}
        </p>
      )}
      {step.found.attempts.length > 0 && (
        <>
          <h3 className="ask-label">시도한 경로</h3>
          <ul className="ask-attempts">
            {step.found.attempts.map((attempt, index) => (
              <AttemptRow key={index} attempt={attempt} />
            ))}
          </ul>
        </>
      )}
      <h3 className="ask-label">이 기기에서 찾은 인터프리터</h3>
      {step.seeking === true ? (
        <p className="ask-note" role="status">
          찾는 중
        </p>
      ) : step.candidates.length === 0 ? (
        <p className="ask-note">찾은 인터프리터가 없다</p>
      ) : (
        <ul className="ask-options">
          {step.candidates.map((found) => (
            <li key={found.path}>
              <button className="ask-option" data-python={found.path} onClick={() => pick(found.path!)}>
                <span className="ask-option-name">Python {found.version}</span>
                <span className="ask-option-path" data-full={found.path ?? undefined}>
                  <bdi>{found.path}</bdi>
                </span>
                {found.venv === true && <span className="ask-option-aside">가상환경</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ask-buttons">
        {host.app ? (
          <button
            className="toolbar-button"
            onClick={() =>
              void host.pickFile().then((path) => {
                if (path !== null) {
                  pick(path);
                }
              })
            }
          >
            파일 고르기…
          </button>
        ) : (
          <form
            className="open-path"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed.trim() !== "") {
                pick(typed.trim());
              }
            }}
          >
            <input
              className="open-input"
              type="text"
              value={typed}
              placeholder="인터프리터의 경로"
              aria-label="인터프리터의 경로"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
            <button className="toolbar-button" type="submit" disabled={typed.trim() === ""}>
              이 경로로 열기
            </button>
          </form>
        )}
        <button className="toolbar-button" onClick={cancel}>
          취소
        </button>
      </div>
    </>
  );
}
