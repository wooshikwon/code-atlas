// LLM 요약 칸과 코드 범위 설명 창에 그릴 설명을 나눈다. 요약은 요지와 표지가 붙은 구역으로, 구역의 글은 문단·목록·코드 블록으로,
// 문단 안의 글은 백틱 식별자·정의 표기·굵은 글씨로 가른다.
// 정의 표기는 레포 안의 함수·메서드·클래스·변수를 `파일 경로::정의 이름`으로 적은 글자다(`arbiter.py::arbiter_sync`).
import type { AtlasNode } from "../api/types";
import { titleOf } from "../graph/layout";
import { unitOf } from "../graph/visible";

/** 설명의 둘째·셋째 부분을 여는 표지 줄 */
export const MARKS = ["하는 일", "앞뒤 흐름"];

/** 문단, 목록, 코드 울타리로 감싼 코드 블록 */
export type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string };

export interface Parts {
  /** 표지 줄 앞의 글. 표지 줄이 없는 설명은 전체가 요지다. */
  lead: string;
  sections: { title: string; blocks: Block[] }[];
}

const FENCE = /^\s*```/;
const ITEM = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/;

/**
 * 글을 문단, 목록, 코드 블록으로 나눈다. 문단은 줄마다 하나다. `-`·`*`나 번호로 시작하는 줄이 이어지면 목록 하나로 묶고,
 * 코드 울타리 사이의 줄은 들여쓰기를 둔 채 코드 블록 하나로 묶는다. 닫지 않은 울타리는 글의 끝까지를 코드 블록으로 본다.
 */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let fenced: string[] | null = null;
  for (const raw of text.split("\n")) {
    if (FENCE.test(raw)) {
      if (fenced !== null) {
        blocks.push({ kind: "code", text: fenced.join("\n") });
      }
      fenced = fenced === null ? [] : null;
      continue;
    }
    if (fenced !== null) {
      fenced.push(raw);
      continue;
    }
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    const item = ITEM.exec(line);
    if (item === null) {
      blocks.push({ kind: "paragraph", text: line });
      continue;
    }
    const ordered = item[1] !== undefined;
    const last = blocks.at(-1);
    if (last?.kind === "list" && last.ordered === ordered) {
      last.items.push(item[2]);
    } else {
      blocks.push({ kind: "list", ordered, items: [item[2]] });
    }
  }
  if (fenced !== null) {
    blocks.push({ kind: "code", text: fenced.join("\n") });
  }
  return blocks;
}

/** 설명을 요지, "하는 일" 구역, "앞뒤 흐름" 구역으로 나눈다. 코드 블록 안의 표지 글자는 표지 줄로 보지 않는다. */
export function partsOf(summary: string): Parts {
  const lead: string[] = [];
  const sections: { title: string; lines: string[] }[] = [];
  let fenced = false;
  for (const raw of summary.split("\n")) {
    const line = raw.trim();
    fenced = FENCE.test(raw) ? !fenced : fenced;
    if (!fenced && line === MARKS[sections.length]) {
      sections.push({ title: line, lines: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].lines.push(raw);
    } else if (line !== "") {
      lead.push(line);
    }
  }
  return { lead: lead.join(" "), sections: sections.map(({ title, lines }) => ({ title, blocks: blocksOf(lines.join("\n")) })) };
}

export interface Span {
  text: string;
  /** 백틱으로 감싼 식별자이거나 정의 표기다. text에 백틱은 없다. */
  code: boolean;
  /** 정의 표기다. text가 `refs`의 키와 같은 글자다. */
  ref: boolean;
  /** `**`로 감싼 굵은 글씨 안의 조각이다. text에 `**`는 없다. */
  bold: boolean;
}

/** 정의 표기. 파일 경로는 `.py`로 끝나고 정의 이름은 점으로 이은 식별자다. */
const REF = /[\w./-]+\.py::[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g;

/** 백틱 밖의 글에서 정의 표기를 가른다. */
function plain(text: string, bold: boolean): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (const found of text.matchAll(REF)) {
    if (found.index > from) {
      spans.push({ text: text.slice(from, found.index), code: false, ref: false, bold });
    }
    spans.push({ text: found[0], code: true, ref: true, bold });
    from = found.index + found[0].length;
  }
  if (from < text.length) {
    spans.push({ text: text.slice(from), code: false, ref: false, bold });
  }
  return spans;
}

/** 글을 백틱으로 감싼 식별자, 정의 표기, 그 밖의 글자로 차례로 나눈다. */
function coded(text: string, bold: boolean): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (const found of text.matchAll(/`([^`]+)`/g)) {
    spans.push(...plain(text.slice(from, found.index), bold));
    spans.push({ text: found[1], code: true, ref: found[1].match(REF)?.[0] === found[1], bold });
    from = found.index + found[0].length;
  }
  spans.push(...plain(text.slice(from), bold));
  return spans;
}

/**
 * 글을 백틱으로 감싼 식별자, 정의 표기, 굵은 글씨, 그 밖의 글자로 차례로 나눈다. 정의 표기는 백틱으로 감쌌든 아니든 가른다.
 * 짝이 없는 백틱과 `**`는 글자로 둔다. 백틱 안의 `**`는 굵은 글씨로 보지 않는다.
 */
export function spansOf(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (const found of text.matchAll(/`[^`]+`|\*\*((?:[^*`]|`[^`]+`)+)\*\*/g)) {
    if (found[1] === undefined) {
      continue;
    }
    spans.push(...coded(text.slice(from, found.index), false));
    spans.push(...coded(found[1], true));
    from = found.index + found[0].length;
  }
  spans.push(...coded(text.slice(from), false));
  return spans;
}

const DEFINITIONS = new Set<AtlasNode["kind"]>(["function", "method", "class", "dataclass", "variable"]);

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
