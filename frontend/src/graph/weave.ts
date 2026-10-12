// 두 시점의 파일 본문을 한 문서로 엮는다. 바뀌지 않은 줄은 한 번 적고, 바뀐 곳마다 삭제된 줄을 먼저, 추가된 줄을 이어 적는다.
// 코드 뷰어가 엮은 문서를 편집기 하나에 넣고, 엮은 문서의 줄과 두 시점의 줄 번호를 이 파일의 함수로 오간다.

export type RowKind = "same" | "deleted" | "added";

/** 엮은 문서의 줄 하나. base와 target은 1부터 세는 그 시점의 줄 번호이고, 그 시점에 없는 줄이면 null이다. */
export interface Row {
  kind: RowKind;
  base: number | null;
  target: number | null;
}

/** 엮은 문서. lines[i]와 rows[i]가 엮은 문서의 i+1번 줄이다. */
export interface Woven {
  lines: string[];
  rows: Row[];
}

export type Side = "base" | "target";

/** `git diff -U0`의 토막 하나: 기준 쪽 시작 줄과 줄 수, 대상 쪽 시작 줄과 줄 수 */
export type Hunk = [number, number, number, number];

/** 엮은 문서의 줄 범위가 두 시점에서 차지하는 줄 범위. 그 시점의 줄이 하나도 없으면 null이다. */
export interface Span {
  base: [number, number] | null;
  target: [number, number] | null;
}

/** 본문의 줄. 파일 끝의 줄바꿈 뒤는 줄로 세지 않는다. 그 시점에 파일이 없으면 줄이 없다. */
function linesOf(text: string | null): string[] {
  if (text === null || text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/**
 * 기준 시점의 본문 base와 대상 시점의 본문 target을 그 파일의 줄 토막 hunks(비교 응답의 `files[].hunks`)로 엮는다. 토막 밖의 줄은
 * 두 시점에서 짝인 그대로인 줄이고, 토막마다 기준 쪽 줄을 삭제된 줄로, 대상 쪽 줄을 추가된 줄로 적는다. 삭제된 줄과 추가된 줄의 수가
 * 그 파일의 줄 수(`added`, `deleted`)와 같다. 파일이 그 시점에 없으면 null을 넘긴다.
 */
export function weave(base: string | null, target: string | null, hunks: Hunk[]): Woven {
  const a = linesOf(base);
  const b = linesOf(target);
  const lines: string[] = [];
  const rows: Row[] = [];
  let x = 0;
  let y = 0;
  const same = (until: number) => {
    for (; x < until && x < a.length && y < b.length; x += 1, y += 1) {
      lines.push(b[y]);
      rows.push({ kind: "same", base: x + 1, target: y + 1 });
    }
  };
  for (const [oldStart, oldCount, , newCount] of hunks) {
    /** 줄이 없는 쪽의 시작 줄은 토막이 끼어드는 곳의 앞줄이다. */
    same(oldCount === 0 ? oldStart : oldStart - 1);
    for (const end = Math.min(x + oldCount, a.length); x < end; x += 1) {
      lines.push(a[x]);
      rows.push({ kind: "deleted", base: x + 1, target: null });
    }
    for (const end = Math.min(y + newCount, b.length); y < end; y += 1) {
      lines.push(b[y]);
      rows.push({ kind: "added", base: null, target: y + 1 });
    }
  }
  same(a.length);
  return { lines, rows };
}

/** 한 시점의 줄 line이 엮은 문서에서 놓인 줄. 그 시점의 본문에 없는 줄이면 null이다. */
export function rowOf(woven: Woven, side: Side, line: number): number | null {
  const at = woven.rows.findIndex((row) => row[side] === line);
  return at === -1 ? null : at + 1;
}

/**
 * 한 시점의 줄 범위 range가 엮은 문서에서 차지하는 줄 범위. 그 시점의 첫 줄이 놓인 줄부터 끝 줄이 놓인 줄까지이고, 사이에 든 다른 시점의
 * 줄을 품는다. 범위가 그 시점의 본문을 벗어나면 null이다.
 */
export function rowsOf(woven: Woven, side: Side, range: [number, number]): [number, number] | null {
  const from = rowOf(woven, side, range[0]);
  const to = rowOf(woven, side, range[1]);
  return from === null || to === null || to < from ? null : [from, to];
}

/**
 * 대상 시점의 정의가 엮은 문서에서 차지하는 줄 범위 rows를 그 정의에서 삭제된 줄까지 넓힌다. 첫 줄이 추가된 줄이면 바로 앞에 붙은 삭제된
 * 줄까지, 끝 줄 바로 뒤에 삭제된 줄이 붙어 있으면 그 줄까지다.
 */
export function widened(woven: Woven, rows: [number, number]): [number, number] {
  let [from, to] = rows;
  while (woven.rows[rows[0] - 1].kind === "added" && woven.rows[from - 2]?.kind === "deleted") {
    from -= 1;
  }
  while (woven.rows[to]?.kind === "deleted") {
    to += 1;
  }
  return [from, to];
}

/** 엮은 문서의 from~to줄이 두 시점에서 차지하는 줄 범위 */
export function spanOf(woven: Woven, from: number, to: number): Span {
  const span: Span = { base: null, target: null };
  for (const row of woven.rows.slice(from - 1, to)) {
    for (const side of ["base", "target"] as const) {
      const line = row[side];
      if (line !== null) {
        span[side] = [span[side]?.[0] ?? line, line];
      }
    }
  }
  return span;
}

/** 엮은 문서의 from~to줄에 kind인 줄이 있다 */
export function holds(woven: Woven, from: number, to: number, kind: RowKind): boolean {
  return woven.rows.slice(from - 1, to).some((row) => row.kind === kind);
}

const MARKS: Record<RowKind, string> = { same: " ", deleted: "-", added: "+" };

/**
 * 엮은 문서의 from~to줄을 줄 머리에 `-`(삭제된 줄)·`+`(추가된 줄)·빈칸(그대로인 줄)을 붙여 잇는다. 범위에 바뀐 줄이 없으면 표시 없이
 * 잇는다. texts는 줄마다 적을 글이고 없으면 줄 전체를 적는다.
 */
export function marked(woven: Woven, from: number, to: number, texts: string[] = woven.lines.slice(from - 1, to)): string {
  const rows = woven.rows.slice(from - 1, to);
  const plain = rows.every((row) => row.kind === "same");
  return texts.map((text, i) => (plain ? text : MARKS[rows[i].kind] + text)).join("\n");
}

/**
 * 줄 번호 칸에 번호 하나를 적는 함수와 그 글자 수. 그대로인 줄과 추가된 줄은 대상 시점의 번호를, 삭제된 줄은 기준 시점의 번호를 적는다.
 * 글자 수는 두 시점의 가장 큰 줄 번호의 자릿수다.
 */
export function gutter(woven: Woven): { chars: number; label(line: number): string } {
  const number = (row: Row | undefined) => row?.target ?? row?.base ?? null;
  return {
    chars: String(woven.rows.reduce((most, row) => Math.max(most, number(row) ?? 0), 0)).length,
    label: (line) => String(number(woven.rows[line - 1]) ?? ""),
  };
}
