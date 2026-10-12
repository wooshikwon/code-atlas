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

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** Mod만 누른 채인지. Mod는 Mac에서 Cmd, 그 밖에서 Ctrl이다. */
function modOnly(event: KeyboardEvent): boolean {
  const mod = MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && !event.shiftKey && !event.altKey;
}

/**
 * 포커스가 글자 입력 칸에 있는지. 그 안에서는 Alt+←·Alt+→가 낱말 사이를 옮기는 키다. 코드 뷰어는 읽기 전용이므로 Monaco가 본문의
 * 키 입력을 받으려고 둔 요소(`.inputarea`, `.native-edit-context`)는 입력 칸이 아니고, 찾기 창처럼 Monaco 안에 뜬 입력 칸은 입력 칸이다.
 */
function typing(): boolean {
  const element = document.activeElement;
  return (
    element instanceof HTMLElement &&
    !element.matches(".monaco-editor .inputarea, .monaco-editor .native-edit-context") &&
    (element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && element.type === "text") || element.isContentEditable)
  );
}

/**
 * Esc를 직접 쓰는 요소가 있는지. 포커스가 든 파일트리 검색 칸은 질의를 비우고, 포커스가 든 경로 탐색 창의 검색 칸은 입력을 닫고,
 * 포커스가 든 코드 뷰어는 hover 상자를 닫고, 상단 줄의 펼친 필터 창은 창을 닫고, 펼친 메뉴(`MenuList`)는 메뉴를 닫는다.
 */
function escaping(): boolean {
  return (
    document.activeElement?.closest(".tree-search-input, .finder-input, .monaco-editor") != null ||
    document.querySelector('.toolbar [aria-expanded="true"], .menu') !== null
  );
}

/** 단축키를 등록하고 등록을 푸는 함수를 돌려준다. 이력 이동과 팔레트 열기는 브라우저의 기본 동작(이전 페이지, 인쇄)을 막는다. */
export function bind(handlers: KeyHandlers): () => void {
  const onKey = (event: KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    if (modOnly(event) && (key.toLowerCase() === "p" || key.toLowerCase() === "k")) {
      event.preventDefault();
      handlers.palette();
    } else if (event.altKey && !mod && !event.shiftKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      if (typing()) {
        return;
      }
      // 코드 뷰어의 본문에 포커스가 있으면 Monaco가 같은 키로 커서를 낱말만큼 옮기므로 이벤트를 Monaco로 보내지 않는다.
      event.preventDefault();
      event.stopPropagation();
      (key === "ArrowLeft" ? handlers.back : handlers.forward)();
    } else if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (key === "[" || key === "]")) {
      event.preventDefault();
      (key === "[" ? handlers.back : handlers.forward)();
    } else if (key === "Escape" && !escaping()) {
      handlers.escape();
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
