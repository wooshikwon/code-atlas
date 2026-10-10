// 색 값은 이 파일 한 곳에만 둔다. 값은 그래프 규칙 문서 "시각 규칙: 색"의 표와 같다.

export type Theme = "light" | "dark";

export interface Colors {
  /** 화면 바탕 */
  surface: string;
  /** 본문 잉크: 이름표, 선택 고리 */
  ink: string;
  /** muted 잉크: 노드 테두리, 선, 보조 글자 */
  muted: string;
  /** 이름표 옆 줄 수 숫자 */
  loc: string;
  /** 초점 상태에서 선택한 노드가 쓰는 쪽으로 나가는 선 */
  outgoing: string;
  /** 초점 상태에서 선택한 노드를 쓰는 쪽에서 들어오는 선 */
  incoming: string;
}

const PALETTE: Record<Theme, Colors> = {
  light: { surface: "#fcfcfb", ink: "#0b0b0b", muted: "#898781", loc: "#1d8169", outgoing: "#2a78d6", incoming: "#eb6834" },
  dark: { surface: "#1a1a19", ink: "#ffffff", muted: "#898781", loc: "#3fb79a", outgoing: "#3987e5", incoming: "#d95926" },
};

export function colors(theme: Theme): Colors {
  return PALETTE[theme];
}

export function preferredTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 색을 CSS 변수로 내보낸다. styles.css는 이 변수만 쓴다. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(colors(theme))) {
    root.style.setProperty(`--${name}`, value);
  }
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}
