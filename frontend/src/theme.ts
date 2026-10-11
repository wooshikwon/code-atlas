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
  /** 변경 표시: 마지막 커밋 뒤에 수정했다 */
  changed: string;
  /** 변경 표시: 마지막 커밋에 없다 */
  added: string;
  /** 순환 덮개의 순환 선 */
  critical: string;
}

const PALETTE: Record<Theme, Colors> = {
  light: { surface: "#fcfcfb", ink: "#0b0b0b", muted: "#898781", loc: "#1d8169", changed: "#eb6834", added: "#2a78d6", critical: "#d03b3b" },
  dark: { surface: "#1a1a19", ink: "#ffffff", muted: "#898781", loc: "#3fb79a", changed: "#d95926", added: "#3987e5", critical: "#d03b3b" },
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
