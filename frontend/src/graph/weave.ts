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

/** 엮은 문서의 줄 범위가 두 시점에서 차지하는 줄 범위. 그 시점의 줄이 하나도 없으면 null이다. */
export interface Span {
  base: [number, number] | null;
  target: [number, number] | null;
}

/** 두 본문의 다른 줄 수가 이 값을 넘으면 줄을 맞추지 않고 앞 본문을 모두 삭제된 줄로, 뒤 본문을 모두 추가된 줄로 적는다. */
const MAX_EDITS = 2000;

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
 * a를 b로 바꾸는 가장 짧은 편집을 a와 b에서 서로 짝인 줄의 쌍으로 낸다(Myers의 O(ND) 방법). 쌍은 앞에서 뒤로 가는 순서다.
 * 다른 줄 수가 MAX_EDITS를 넘으면 짝이 없는 것으로 본다.
 */
function matches(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  /** k = x - y인 대각선마다 가장 멀리 간 x */
  let reach = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(reach.slice(offset - d - 1, offset + d + 2));
    const next = reach.slice();
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && reach[offset + k - 1] < reach[offset + k + 1]);
      let x = down ? reach[offset + k + 1] : reach[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        const pairs: [number, number][] = [];
        for (let step = d; step >= 0; step -= 1) {
          const before = trace[step];
          const diagonal = x - y;
          /** before는 대각선 -step-1부터 담고 있다. */
          const at = diagonal + step + 1;
          const fell = diagonal === -step || (diagonal !== step && before[at - 1] < before[at + 1]);
          const from = fell ? before[at + 1] : before[at - 1] + 1;
          const start = step === 0 ? 0 : from;
          while (x > start) {
            x -= 1;
            y -= 1;
            pairs.push([x, y]);
          }
          x = fell ? from : from - 1;
          y = x - (fell ? diagonal + 1 : diagonal - 1);
        }
        return pairs.reverse();
      }
    }
    reach = next;
  }
  return [];
}

/**
 * 기준 시점의 본문 base와 대상 시점의 본문 target을 엮는다. 파일이 그 시점에 없으면 null을 넘기고, 그때는 모든 줄이 추가된 줄이나
 * 삭제된 줄이다.
 */
export function weave(base: string | null, target: string | null): Woven {
  const a = linesOf(base);
  const b = linesOf(target);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head += 1;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }
  const middle = matches(a.slice(head, a.length - tail), b.slice(head, b.length - tail)).map(([x, y]): [number, number] => [x + head, y + head]);
  const pairs: [number, number][] = [
    ...Array.from({ length: head }, (_, i): [number, number] => [i, i]),
    ...middle,
    ...Array.from({ length: tail }, (_, i): [number, number] => [a.length - tail + i, b.length - tail + i]),
  ];
  const lines: string[] = [];
  const rows: Row[] = [];
  let x = 0;
  let y = 0;
  for (const [nextX, nextY] of [...pairs, [a.length, b.length] as [number, number]]) {
    for (; x < nextX; x += 1) {
      lines.push(a[x]);
      rows.push({ kind: "deleted", base: x + 1, target: null });
    }
    for (; y < nextY; y += 1) {
      lines.push(b[y]);
      rows.push({ kind: "added", base: null, target: y + 1 });
    }
    if (x < a.length) {
      lines.push(a[x]);
      rows.push({ kind: "same", base: x + 1, target: y + 1 });
      x += 1;
      y += 1;
    }
  }
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

/** 줄 번호 칸에 두 시점의 번호를 나란히 적는 함수와 그 글자 수. 그 시점에 없는 줄의 번호는 비운다. */
export function gutter(woven: Woven): { chars: number; label(line: number): string } {
  const width = (side: Side) => String(woven.rows.reduce((most, row) => Math.max(most, row[side] ?? 0), 0)).length;
  const widths = { base: width("base"), target: width("target") };
  const cell = (side: Side, row: Row | undefined) => String(row?.[side] ?? "").padStart(widths[side], " ");
  return {
    chars: widths.base + widths.target + 1,
    label: (line) => `${cell("base", woven.rows[line - 1])} ${cell("target", woven.rows[line - 1])}`,
  };
}
