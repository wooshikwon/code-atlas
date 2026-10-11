// LLM 요약 칸에 그릴 설명을 요지와 표지가 붙은 문단 묶음으로 나누고, 문단 안의 백틱 식별자와 정의 표기를 가른다.
// 정의 표기는 레포 안의 함수·메서드·클래스를 `파일 경로::정의 이름`으로 적은 글자다(`arbiter.py::arbiter_sync`).
import type { AtlasNode } from "../api/types";
import { titleOf } from "../graph/layout";
import { unitOf } from "../graph/visible";

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
  /** 백틱으로 감싼 식별자이거나 정의 표기다. text에 백틱은 없다. */
  code: boolean;
  /** 정의 표기다. text가 `refs`의 키와 같은 글자다. */
  ref: boolean;
}

/** 정의 표기. 파일 경로는 `.py`로 끝나고 정의 이름은 점으로 이은 식별자다. */
const REF = /[\w./-]+\.py::[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g;

/** 백틱 밖의 글에서 정의 표기를 가른다. */
function plain(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (const found of text.matchAll(REF)) {
    if (found.index > from) {
      spans.push({ text: text.slice(from, found.index), code: false, ref: false });
    }
    spans.push({ text: found[0], code: true, ref: true });
    from = found.index + found[0].length;
  }
  if (from < text.length) {
    spans.push({ text: text.slice(from), code: false, ref: false });
  }
  return spans;
}

/**
 * 글을 백틱으로 감싼 식별자, 정의 표기, 그 밖의 글자로 차례로 나눈다. 정의 표기는 백틱으로 감쌌든 아니든 가른다.
 * 짝이 없는 백틱은 글자로 둔다.
 */
export function spansOf(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (const found of text.matchAll(/`([^`]+)`/g)) {
    spans.push(...plain(text.slice(from, found.index)));
    spans.push({ text: found[1], code: true, ref: found[1].match(REF)?.[0] === found[1] });
    from = found.index + found[0].length;
  }
  spans.push(...plain(text.slice(from)));
  return spans;
}

const DEFINITIONS = new Set<AtlasNode["kind"]>(["function", "method", "class", "dataclass"]);

/**
 * 정의 표기 → 노드 id. 파일 경로는 그 정의가 든 파일 상자의 이름표(소스 루트 기준 경로)이고 정의 이름은 노드 id의 `:` 뒤다.
 * 파일 상자 안에 들지 않은 정의는 담지 않는다.
 */
export function refsOf(nodes: Map<string, AtlasNode>): Map<string, string> {
  const refs = new Map<string, string>();
  for (const node of nodes.values()) {
    const file = nodes.get(unitOf(nodes, node.id));
    if (DEFINITIONS.has(node.kind) && file?.kind === "module" && node.id.includes(":")) {
      refs.set(`${titleOf(file)}::${node.id.slice(node.id.indexOf(":") + 1)}`, node.id);
    }
  }
  return refs;
}
