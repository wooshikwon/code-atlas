// 색 값은 이 파일 한 곳에만 둔다. 값은 그래프 규칙 문서 "시각 규칙: 색"의 표와 같다.

export type Theme = "light" | "dark";

export interface Colors {
  /** 화면 바탕 */
  surface: string;
  /** 본문 잉크: 이름표, 선택 고리, 초점 상태에서 고른 노드에 닿는 선과 흐름에 든 노드 사이의 선 */
  ink: string;
  /** muted 잉크: 노드 테두리, 선, 보조 글자 */
  muted: string;
  /** 이름표 옆 줄 수 숫자 */
  loc: string;
}

const PALETTE: Record<Theme, Colors> = {
  light: { surface: "#fcfcfb", ink: "#0b0b0b", muted: "#898781", loc: "#1d8169" },
  dark: { surface: "#1a1a19", ink: "#ffffff", muted: "#898781", loc: "#3fb79a" },
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
