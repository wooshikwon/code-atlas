// 환경 점검 화면. 맨 위에 앱의 판을 적고 로그인 셸의 환경, Claude Code, git, 연 레포의 Python 네 행을 그린다. 행마다 상태, 판,
// 찾은 출처, 경로를 적고, 쓰지 못하는 도구는 까닭과 고치는 방법을 적는다. 행 머리를 누르면 시도한 후보의 목록(출처, 경로, 결과)이
// 펴지고, 찾지 못한 도구의 목록은 처음부터 펴져 있다. `직접 고르기`는 앱이 파일 선택 대화상자로, 브라우저가 경로 입력 칸으로 받는다.
// Claude Code를 쓰지 못할 때의 안내(`ClaudeHelp`)는 LLM 요약 칸도 함께 쓴다.
import { useState, type ReactNode } from "react";
import type { Found, Pickable } from "../api/types";
import { host } from "../host";
import { nameOf, useOpening } from "../state/opening";
import { useAtlas } from "../state/store";
import { aboutLine, answerLine, claudeLine, claudeState, gitLine, INSTALL, LOGIN, saidOf, saved, shellLine, sourceName, useTools, type ClaudeState } from "../state/tools";
import { Ask, Title } from "./Asks";
import { AttemptRow } from "./Interpreters";

/** 터미널에 붙여 넣을 명령과 그 명령을 클립보드에 넣는 버튼 */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="tools-command">
      <code>{text}</code>
      <button className="summary-action" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}>
        {copied ? "복사함" : "복사"}
      </button>
    </span>
  );
}

/**
 * Claude Code를 쓰지 못하는 까닭과 고치는 방법. 고치는 방법은 번호를 붙인 단계로 적는다. 찾지 못했으면 설치 명령과 로그인 명령을,
 * 로그인돼 있지 않으면 앱은 터미널을 열어 로그인하게 하는 버튼을, 브라우저는 로그인 명령을 적고 마지막 단계에 `다시 확인`을 적는다. 실행하지 않은 경우는 서버가 적은 글을 까닭 아래에 함께 적는다. said는 서버가 적은 글이고
 * 화면이 모르는 경우에 그대로 적는다.
 */
export function ClaudeHelp({ state, said }: { state: Exclude<ClaudeState, { kind: "ready" }>; said: string }) {
  return (
    <div className="tools-help" data-claude={state.kind}>
      <span className="tools-trouble">{claudeLine(state, said)}</span>
      {state.kind === "unchecked" && state.detail !== "" && <span className="tools-note">{state.detail}</span>}
      {state.kind === "missing" && (
        <ol className="tools-steps">
          <li>
            터미널에서 설치합니다
            <Command text={INSTALL} />
          </li>
          <li>
            설치한 뒤 로그인합니다
            <Command text={LOGIN} />
          </li>
          <li>
            <b>다시 확인</b>을 누릅니다
          </li>
        </ol>
      )}
      {state.kind === "logged-out" && (
        <ol className="tools-steps">
          <li>
            {host.app ? (
              <>
                터미널을 열어 로그인합니다
                <button className="summary-action tools-login" onClick={() => void host.claudeLogin(state.path)}>
                  로그인
                </button>
              </>
            ) : (
              <>
                터미널에서 로그인합니다
                <Command text={LOGIN} />
              </>
            )}
          </li>
          <li>
            <b>다시 확인</b>을 누릅니다
          </li>
        </ol>
      )}
    </div>
  );
}

interface RowProps {
  /** 행의 열쇠. `data-tool`에 적는다. */
  tool: string;
  name: string;
  /** 쓸 수 있으면 참 */
  ok: boolean;
  /** 상태를 적는 낱말 */
  state: string;
  /** 판, 찾은 출처처럼 상태 옆에 적는 값 */
  facts: (string | null)[];
  path: string | null;
  found?: Found;
  /** 직접 고른 경로를 저장하는 함수. 주면 `직접 고르기`를 그린다. */
  keep?: (path: string) => void;
  /** 직접 고른 경로를 저장하지 못한 까닭 */
  refused?: string;
  /** `다시 확인` 앞에 그리는 버튼 */
  before?: ReactNode;
  /** 경로 아래에 적는 까닭과 안내 */
  children?: ReactNode;
}

function Row({ tool, name, ok, state, facts, path, found, keep, refused, before, children }: RowProps) {
  const busy = useTools((s) => s.busy);
  const check = useTools((s) => s.check);
  const forget = useTools((s) => s.forget);
  const attempts = found?.attempts ?? [];
  /** 사용자가 접거나 편 상태. 누른 적이 없으면 쓰지 못하는 도구의 목록만 펴 둔다. */
  const [folded, setFolded] = useState<boolean | null>(null);
  const open = folded === null ? !ok : !folded;
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");

  const pick = () => {
    if (!host.app) {
      setTyping(!typing);
      return;
    }
    void host.pickFile().then((picked) => {
      if (picked !== null) {
        keep?.(picked);
      }
    });
  };

  return (
    <li className="tools-row" data-tool={tool} data-ok={ok ? "" : undefined}>
      <div className="tools-head">
        <button type="button" className="info-section-head" aria-expanded={open && attempts.length > 0} disabled={attempts.length === 0} onClick={() => setFolded(open)}>
          <span className="info-section-caret" aria-hidden />
          <span className="tools-name">{name}</span>
        </button>
        <span className="tools-state">{state}</span>
        <span className="tools-facts">{facts.filter((fact) => fact !== null).join(" · ")}</span>
        {found !== undefined && (
          <span className="tools-actions">
            {before}
            <button className="summary-action" disabled={busy} onClick={() => void check()}>
              다시 확인
            </button>
            {keep !== undefined && (
              <button className="summary-action" disabled={busy} aria-expanded={host.app ? undefined : typing} onClick={pick}>
                직접 고르기
              </button>
            )}
            {keep !== undefined && saved(found) && (
              <button className="summary-action" disabled={busy} onClick={() => void forget(tool as Pickable)}>
                저장한 경로 지우기
              </button>
            )}
          </span>
        )}
      </div>
      {path !== null && (
        <div className="tools-path" data-full={path}>
          <bdi>{path}</bdi>
        </div>
      )}
      {children}
      {typing && (
        <form
          className="open-path"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed.trim() !== "") {
              keep?.(typed.trim());
            }
          }}
        >
          <input
            className="open-input"
            type="text"
            value={typed}
            placeholder={`${name} 실행 파일의 경로`}
            aria-label={`${name} 실행 파일의 경로`}
            spellCheck={false}
            autoFocus
            onChange={(event) => setTyped(event.target.value)}
          />
          <button className="toolbar-button" type="submit" disabled={busy || typed.trim() === ""}>
            이 경로 쓰기
          </button>
        </form>
      )}
      {refused !== undefined && (
        <p className="ask-error" role="alert">
          {refused}
        </p>
      )}
      {open && attempts.length > 0 && (
        <ul className="ask-attempts" aria-label={`${name}에서 시도한 경로`}>
          {attempts.map((attempt, index) => (
            <AttemptRow key={index} attempt={attempt} />
          ))}
        </ul>
      )}
    </li>
  );
}

const CLAUDE_STATES: Record<ClaudeState["kind"], string> = {
  ready: "찾음",
  missing: "찾지 못함",
  broken: "실행하지 못함",
  "logged-out": "로그인돼 있지 않음",
  silent: "응답 없음",
  unchecked: "확인하지 않음",
  other: "쓰지 못함",
};

function ClaudeRow({ found }: { found: Found }) {
  const answer = useTools((s) => s.answer);
  const refused = useTools((s) => s.refused.claude);
  const ask = useTools((s) => s.ask);
  const keep = useTools((s) => s.keep);
  const state = claudeState(found.code, found);
  const login = state.kind === "ready" ? (found.auth === null ? "로그인됨" : `로그인됨(${found.auth})`) : null;
  return (
    <Row
      tool="claude"
      name="Claude Code"
      ok={state.kind === "ready"}
      state={CLAUDE_STATES[state.kind]}
      facts={[found.version, found.source === null ? null : sourceName(found.source), login]}
      path={found.path}
      found={found}
      keep={(path) => void keep("claude", path)}
      refused={refused}
      before={
        state.kind === "ready" && (
          <button className="summary-action" disabled={answer === "asking"} data-tip="claude -p에 한 낱말을 답하게 하는 요청 하나를 보냅니다" onClick={() => void ask()}>
            응답 확인
          </button>
        )
      }
    >
      {state.kind !== "ready" && <ClaudeHelp state={state} said={saidOf(found)} />}
      {answer === "asking" && (
        <p className="ask-note" role="status">
          claude -p의 답을 기다리는 중
        </p>
      )}
      {answer !== null && answer !== "asking" && (
        <p className={answer.ok ? "ask-note" : "ask-error"} data-answer={answer.ok ? "ok" : "failed"}>
          {answerLine(answer)}
        </p>
      )}
    </Row>
  );
}

function GitRow({ found }: { found: Found }) {
  const refused = useTools((s) => s.refused.git);
  const keep = useTools((s) => s.keep);
  const trouble = gitLine(found);
  return (
    <Row
      tool="git"
      name="git"
      ok={trouble === null}
      state={trouble === null ? "찾음" : "찾지 못함"}
      facts={[found.version, found.source === null ? null : sourceName(found.source)]}
      path={found.path}
      found={found}
      keep={(path) => void keep("git", path)}
      refused={refused}
    >
      {trouble !== null && <span className="tools-trouble">{trouble}</span>}
    </Row>
  );
}

/** 연 레포의 인터프리터. 바꾸는 일은 인터프리터를 고르는 화면이 맡는다. */
function PythonRow({ found }: { found: Found | null }) {
  const root = useAtlas((s) => s.repo?.root ?? null);
  const busy = useTools((s) => s.busy);
  if (found === null || root === null) {
    return <Row tool="python" name="레포의 Python" ok state="연 레포 없음" facts={[]} path={null} />;
  }
  return (
    <Row
      tool="python"
      name={`${nameOf(root)}의 Python`}
      ok={found.code === "ok"}
      state={found.code === "ok" ? "찾음" : "찾지 못함"}
      facts={[found.version, found.source === null ? null : sourceName(found.source), found.venv === true ? "가상환경" : null]}
      path={found.path}
      found={found}
      before={
        <button className="summary-action" disabled={busy} onClick={() => void useOpening.getState().pick(root, found)}>
          바꾸기
        </button>
      }
    >
      {found.code !== "ok" && <span className="tools-trouble">{nameOf(root)}의 Python 인터프리터를 찾지 못했습니다. 이 레포의 패키지가 설치된 인터프리터를 골라 주세요</span>}
      {found.prefix !== null && (
        <span className="tools-prefix">
          sys.prefix
          <span className="tools-path" data-full={found.prefix}>
            <bdi>{found.prefix}</bdi>
          </span>
        </span>
      )}
    </Row>
  );
}

export function Tools() {
  const shown = useTools((s) => s.shown);
  const tools = useTools((s) => s.tools);
  const about = useTools((s) => s.about);
  const busy = useTools((s) => s.busy);
  const error = useTools((s) => s.error);
  const hide = useTools((s) => s.hide);

  if (!shown) {
    return null;
  }
  const shell = tools?.shell ?? null;
  return (
    <Ask wide close={hide}>
      <Title>환경 점검</Title>
      {about !== null && <p className="ask-note tools-about">{aboutLine(about)}</p>}
      {error !== null && (
        <p className="ask-error" role="alert">
          환경을 읽지 못했습니다: {error}
        </p>
      )}
      {tools === null
        ? busy && (
            <p className="ask-note" role="status">
              확인하는 중
            </p>
          )
        : (
            <ul className="tools-rows" aria-busy={busy}>
              <Row
                tool="shell"
                name="로그인 셸"
                ok={shell === null || shell.ok}
                state={shell === null ? "읽지 않음" : shell.ok ? "읽음" : "읽지 못함"}
                facts={[shell === null ? null : nameOf(shell.shell)]}
                path={shell?.shell ?? null}
              >
                <span className={shell === null || shell.ok ? "tools-note" : "tools-trouble"}>{shellLine(shell)}</span>
              </Row>
              <ClaudeRow found={tools.claude} />
              <GitRow found={tools.git} />
              <PythonRow found={tools.python} />
            </ul>
          )}
      <div className="ask-buttons">
        {busy && tools !== null && (
          <span className="tools-busy" role="status">
            확인하는 중
          </span>
        )}
        <button className="toolbar-button" data-first onClick={hide}>
          닫기
        </button>
      </div>
    </Ask>
  );
}
