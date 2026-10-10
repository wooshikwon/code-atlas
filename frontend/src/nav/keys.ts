// 키보드 단축키. window의 capture 단계 keydown 하나에서 이력 이동, Esc, 검색 팔레트 열기를 나눠 부른다.

export interface KeyHandlers {
  /** Alt+←, Mac은 Cmd+[도 */
  back(): void;
  /** Alt+→, Mac은 Cmd+]도 */
  forward(): void;
  escape(): void;
  /** Mod+P, Mod+K */
  palette(): void;
}

/** 포커스가 Monaco나 글자 입력 칸에 있는지. 그 안에서는 Alt+←·Alt+→가 낱말 사이를 옮기는 키다. */
function typing(): boolean {
  const element = document.activeElement;
  return (
    element instanceof HTMLElement &&
    (element.closest(".monaco-editor") !== null ||
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement && element.type === "text") ||
      element.isContentEditable)
  );
}

/** 포커스가 파일트리 검색 칸에 있는지. 그 안에서는 Esc가 질의를 비운다. */
function searching(): boolean {
  return document.activeElement?.classList.contains("tree-search-input") === true;
}

/** 단축키를 등록하고 등록을 푸는 함수를 돌려준다. 이력 이동과 팔레트 열기는 브라우저의 기본 동작(이전 페이지, 인쇄)을 막는다. */
export function bind(handlers: KeyHandlers): () => void {
  const onKey = (event: KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    if (mod && (key.toLowerCase() === "p" || key.toLowerCase() === "k")) {
      event.preventDefault();
      handlers.palette();
    } else if (event.altKey && !mod && !event.shiftKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      if (typing()) {
        return;
      }
      event.preventDefault();
      (key === "ArrowLeft" ? handlers.back : handlers.forward)();
    } else if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (key === "[" || key === "]")) {
      event.preventDefault();
      (key === "[" ? handlers.back : handlers.forward)();
    } else if (key === "Escape" && !searching()) {
      handlers.escape();
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
