// 레포를 여는 동안 띄우는 창. 열지 못하는 폴더와 까닭, 프로젝트의 하위 폴더를 골랐을 때의 물음, 프로젝트 여러 개를 품은 폴더의
// 목록, 인터프리터를 고르는 화면, 브라우저의 경로 입력 창을 화면 가운데에 그린다. 창 밖을 누르거나 Esc를 누르면 닫힌다.
import { useEffect, useRef, type ReactNode } from "react";
import { nameOf, useOpening, type Step } from "../state/opening";
import { Interpreters } from "./Interpreters";
import { PathField } from "./Welcome";

/**
 * 창 하나. 뜰 때 data-first가 붙은 요소(없으면 창)에 포커스를 두고, 닫히면 열기 전에 포커스가 있던 요소로 돌려준다.
 * 창 밖을 누르면 close를 부른다.
 */
export function Ask({ wide, close, children }: { wide?: boolean; close: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement;
    (box.current?.querySelector<HTMLElement>("[data-first], input") ?? box.current)?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div className="ask-backdrop" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={box} className={wide === true ? "ask ask-wide" : "ask"} role="dialog" aria-modal aria-labelledby="ask-title" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <h2 className="ask-title" id="ask-title">
      {children}
    </h2>
  );
}

function Body({ step }: { step: Step }) {
  const choose = useOpening((s) => s.choose);
  const cancel = useOpening((s) => s.cancel);
  switch (step.kind) {
    case "blocked":
      return (
        <>
          <Title>{step.reason === "missing" ? `폴더를 찾지 못했다: ${step.path}` : `파이썬 파일이 없는 폴더는 열지 못한다: ${step.path}`}</Title>
          <div className="ask-buttons">
            <button className="toolbar-button" data-first onClick={cancel}>
              닫기
            </button>
          </div>
        </>
      );
    case "failed":
      return (
        <>
          <Title>{nameOf(step.path)}를 열지 못했다</Title>
          <p className="ask-error">{step.error}</p>
          <div className="ask-buttons">
            <button className="toolbar-button" data-first onClick={cancel}>
              닫기
            </button>
          </div>
        </>
      );
    case "ask-project":
      return (
        <>
          <Title>
            {nameOf(step.path)}는 프로젝트 {nameOf(step.project)}의 하위 폴더다
          </Title>
          <p className="ask-note">하위 폴더만 열면 폴더 밖의 코드를 부르는 지점이 미확인으로 남는다.</p>
          <div className="ask-buttons">
            <button className="toolbar-button" data-first data-full={step.project} onClick={() => void choose(step.project)}>
              {nameOf(step.project)} 열기
            </button>
            <button className="toolbar-button" data-full={step.path} onClick={() => void choose(step.path, { asIs: true })}>
              이 폴더만 열기
            </button>
            <button className="toolbar-button" onClick={cancel}>
              취소
            </button>
          </div>
        </>
      );
    case "ask-nested":
      return (
        <>
          <Title>
            {nameOf(step.path)}는 프로젝트 {step.nested.length}개를 품고 있다. 하나를 고른다
          </Title>
          <ul className="ask-options">
            {step.nested.map((name, index) => (
              <li key={name}>
                <button className="ask-option" data-first={index === 0 ? "" : undefined} onClick={() => void choose(`${step.path}/${name}`)}>
                  <span className="ask-option-name">{name}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="ask-buttons">
            <button className="toolbar-button" onClick={() => void choose(step.path, { asIs: true })}>
              이 폴더 그대로 열기
            </button>
            <button className="toolbar-button" onClick={cancel}>
              취소
            </button>
          </div>
        </>
      );
    case "ask-python":
      return <Interpreters step={step} />;
    default:
      return null;
  }
}

export function Asks() {
  const step = useOpening((s) => s.step);
  const typing = useOpening((s) => s.typing);
  const cancel = useOpening((s) => s.cancel);

  if (typing) {
    return (
      <Ask close={cancel}>
        <Title>열 레포 폴더의 경로를 적는다</Title>
        <PathField autoFocus />
        <div className="ask-buttons">
          <button className="toolbar-button" onClick={cancel}>
            취소
          </button>
        </div>
      </Ask>
    );
  }
  if (step.kind === "idle" || step.kind === "probing" || step.kind === "opening") {
    return null;
  }
  return (
    <Ask key={step.kind} wide={step.kind === "ask-python"} close={cancel}>
      <Body step={step} />
    </Ask>
  );
}
