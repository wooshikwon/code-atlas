// LLM 요약 칸에 그릴 설명을 요지와 표지가 붙은 문단 묶음으로 나누고, 문단 안의 백틱 식별자를 가른다.

/** 설명의 둘째·셋째 부분을 여는 표지 줄 */
export const MARKS = ["하는 일", "앞뒤 흐름"];

export interface Parts {
  /** 표지 줄 앞의 글. 표지 줄이 없는 설명은 전체가 요지다. */
  lead: string;
  sections: { title: string; paragraphs: string[] }[];
}

/** 설명을 요지, "하는 일" 문단, "앞뒤 흐름" 문단으로 나눈다. 문단은 줄마다 하나다. */
export function partsOf(summary: string): Parts {
  const lead: string[] = [];
  const sections: Parts["sections"] = [];
  for (const line of summary.split("\n").map((raw) => raw.trim())) {
    if (line === "") {
      continue;
    }
    if (line === MARKS[sections.length]) {
      sections.push({ title: line, paragraphs: [] });
    } else if (sections.length === 0) {
      lead.push(line);
    } else {
      sections[sections.length - 1].paragraphs.push(line);
    }
  }
  return { lead: lead.join(" "), sections };
}

export interface Span {
  text: string;
  /** 백틱으로 감싼 식별자다. text에 백틱은 없다. */
  code: boolean;
}

/** 글을 백틱으로 감싼 식별자와 그 밖의 글자로 차례로 나눈다. 짝이 없는 백틱은 글자로 둔다. */
export function spansOf(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (const found of text.matchAll(/`([^`]+)`/g)) {
    if (found.index > from) {
      spans.push({ text: text.slice(from, found.index), code: false });
    }
    spans.push({ text: found[1], code: true });
    from = found.index + found[0].length;
  }
  if (from < text.length) {
    spans.push({ text: text.slice(from), code: false });
  }
  return spans;
}
