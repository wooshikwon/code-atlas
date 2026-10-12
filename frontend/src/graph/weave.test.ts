import { describe, expect, it } from "vitest";
import { gutter, holds, marked, rowOf, rowsOf, spanOf, weave, widened, type Hunk, type Woven } from "./weave";

const text = (lines: string[]) => lines.map((line) => `${line}\n`).join("");
/** 엮은 문서를 줄마다 `표시 기준번호 대상번호 글`로 적는다. */
const drawn = (woven: Woven) =>
  woven.rows.map((row, i) => `${{ same: " ", deleted: "-", added: "+" }[row.kind]} ${row.base ?? "."} ${row.target ?? "."} ${woven.lines[i]}`);

const BASE = text(["def f(a):", "    x = a", "    y = x", "    return y", "", "def g():", "    return 1"]);
const TARGET = text(["def f(a):", "    x = a + 1", "    z = 0", "    y = x", "    return y", "", "def h():", "    return 2"]);
/** BASE와 TARGET 사이의 줄 토막 */
const HUNKS: Hunk[] = [
  [2, 1, 2, 2],
  [6, 2, 7, 2],
];

describe("weave", () => {
  it("바뀌지 않은 줄은 한 번, 바뀐 곳은 삭제된 줄을 먼저 적고 추가된 줄을 이어 적는다", () => {
    expect(drawn(weave(BASE, TARGET, HUNKS))).toEqual([
      "  1 1 def f(a):",
      "- 2 .     x = a",
      "+ . 2     x = a + 1",
      "+ . 3     z = 0",
      "  3 4     y = x",
      "  4 5     return y",
      "  5 6 ",
      "- 6 . def g():",
      "- 7 .     return 1",
      "+ . 7 def h():",
      "+ . 8     return 2",
    ]);
  });

  it("같은 본문은 모든 줄이 그대로인 줄이다", () => {
    const woven = weave(BASE, BASE, []);
    expect(woven.rows.every((row) => row.kind === "same" && row.base === row.target)).toBe(true);
    expect(woven.lines).toHaveLength(7);
  });

  it("한쪽 시점에만 있는 파일은 모든 줄이 삭제된 줄이나 추가된 줄이다", () => {
    expect(drawn(weave(text(["a", "b"]), null, [[1, 2, 0, 0]]))).toEqual(["- 1 . a", "- 2 . b"]);
    expect(drawn(weave(null, text(["a", "b"]), [[0, 0, 1, 2]]))).toEqual(["+ . 1 a", "+ . 2 b"]);
    expect(weave(null, null, []).rows).toEqual([]);
  });

  it("파일 끝의 줄바꿈이 한쪽에만 있어도 줄 수는 같다", () => {
    expect(drawn(weave("a\nb", "a\nb\n", []))).toEqual(["  1 1 a", "  2 2 b"]);
  });

  it("가운데 줄을 지우거나 끼우면 그 줄만 바뀐 줄이다", () => {
    expect(drawn(weave(text(["a", "b", "c"]), text(["a", "c"]), [[2, 1, 1, 0]]))).toEqual(["  1 1 a", "- 2 . b", "  3 2 c"]);
    expect(drawn(weave(text(["a", "c"]), text(["a", "b", "c"]), [[1, 0, 2, 1]]))).toEqual(["  1 1 a", "+ . 2 b", "  2 3 c"]);
  });

  it("되풀이되는 줄에서 토막이 가리키는 줄을 삭제된 줄로 적는다", () => {
    const base = text(["x", "", "y", "", "z", ""]);
    const target = text(["x", "", "z", ""]);
    expect(drawn(weave(base, target, [[3, 2, 2, 0]]))).toEqual(["  1 1 x", "  2 2 ", "- 3 . y", "- 4 . ", "  5 3 z", "  6 4 "]);
    expect(drawn(weave(base, target, [[2, 2, 1, 0]]))).toEqual(["  1 1 x", "- 2 . ", "- 3 . y", "  4 2 ", "  5 3 z", "  6 4 "]);
  });

  it("삭제된 줄과 추가된 줄의 수가 토막의 줄 수와 같다", () => {
    const woven = weave(BASE, TARGET, HUNKS);
    const count = (kind: string) => woven.rows.filter((row) => row.kind === kind).length;
    expect([count("deleted"), count("added")]).toEqual([HUNKS.reduce((n, h) => n + h[1], 0), HUNKS.reduce((n, h) => n + h[3], 0)]);
  });

  it("엮은 문서에서 한 시점의 줄만 모으면 그 시점의 본문이다", () => {
    const woven = weave(BASE, TARGET, HUNKS);
    const side = (key: "base" | "target") => text(woven.lines.filter((_, i) => woven.rows[i][key] !== null));
    expect(side("base")).toBe(BASE);
    expect(side("target")).toBe(TARGET);
  });
});

describe("rowsOf", () => {
  const woven = weave(BASE, TARGET, HUNKS);

  it("대상 시점의 줄 범위는 사이에 든 삭제된 줄을 품는다", () => {
    expect(rowsOf(woven, "target", [1, 5])).toEqual([1, 6]);
  });

  it("추가된 줄만 든 범위는 그 줄만 가리킨다", () => {
    expect(rowsOf(woven, "target", [7, 8])).toEqual([10, 11]);
    expect(rowsOf(woven, "target", [2, 3])).toEqual([3, 4]);
    expect(rowOf(woven, "target", 4)).toBe(5);
    expect(rowOf(woven, "base", 2)).toBe(2);
    expect(rowOf(woven, "target", 9)).toBeNull();
  });

  it("기준 시점의 줄 범위는 삭제된 줄의 묶음을 가리킨다", () => {
    expect(rowsOf(woven, "base", [6, 7])).toEqual([8, 9]);
  });

  it("그 시점의 본문을 벗어난 범위는 null이다", () => {
    expect(rowsOf(woven, "target", [7, 9])).toBeNull();
    expect(rowsOf(woven, "base", [8, 8])).toBeNull();
  });
});

describe("widened", () => {
  const woven = weave(BASE, TARGET, HUNKS);

  it("첫 줄이 추가된 줄이면 바로 앞의 삭제된 줄까지 넓힌다", () => {
    expect(widened(woven, rowsOf(woven, "target", [7, 8])!)).toEqual([8, 11]);
  });

  it("끝 줄 뒤에 삭제된 줄이 붙어 있으면 그 줄까지 넓힌다", () => {
    const cut = weave(text(["def f():", "    a", "    b", "", "x = 1"]), text(["def f():", "    a", "", "x = 1"]), [[3, 1, 2, 0]]);
    expect(widened(cut, rowsOf(cut, "target", [1, 2])!)).toEqual([1, 3]);
  });

  it("앞뒤에 삭제된 줄이 붙어 있지 않으면 그대로다", () => {
    expect(widened(woven, [1, 6])).toEqual([1, 6]);
    expect(widened(woven, [5, 6])).toEqual([5, 6]);
  });
});

describe("spanOf", () => {
  const woven = weave(BASE, TARGET, HUNKS);

  it("엮은 문서의 줄 범위를 두 시점의 줄 범위로 되돌린다", () => {
    expect(spanOf(woven, 1, 6)).toEqual({ base: [1, 4], target: [1, 5] });
    expect(spanOf(woven, 3, 4)).toEqual({ base: null, target: [2, 3] });
    expect(spanOf(woven, 8, 9)).toEqual({ base: [6, 7], target: null });
  });

  it("두 시점의 줄 범위에서 엮은 문서의 줄 범위를 다시 얻는다", () => {
    for (const [from, to] of [[1, 6], [2, 5], [8, 9], [7, 10], [2, 2]] as const) {
      const span = spanOf(woven, from, to);
      const found = woven.rows.flatMap((row, i) =>
        (span.base !== null && row.base !== null && span.base[0] <= row.base && row.base <= span.base[1]) ||
        (span.target !== null && row.target !== null && span.target[0] <= row.target && row.target <= span.target[1])
          ? [i + 1]
          : [],
      );
      expect([found[0], found.at(-1)]).toEqual([from, to]);
      expect(found).toHaveLength(to - from + 1);
    }
  });
});

describe("marked", () => {
  const woven = weave(BASE, TARGET, HUNKS);

  it("바뀐 줄이 든 범위는 줄 머리에 표시를 붙인다", () => {
    expect(marked(woven, 1, 5)).toBe(["def f(a):", "    x = a", "    x = a + 1", "    z = 0", "    y = x"].map((line, i) => " -++ "[i] + line).join("\n"));
    expect(holds(woven, 1, 5, "deleted")).toBe(true);
    expect(holds(woven, 3, 5, "deleted")).toBe(false);
    expect(holds(woven, 3, 5, "added")).toBe(true);
  });

  it("바뀐 줄이 없는 범위는 표시 없이 잇는다", () => {
    expect(marked(woven, 5, 7)).toBe("    y = x\n    return y\n");
  });

  it("줄마다 적을 글을 받으면 그 글에 표시를 붙인다", () => {
    expect(marked(woven, 2, 3, ["= a", "    x ="])).toBe("-= a\n+    x =");
  });
});

describe("gutter", () => {
  it("두 시점의 번호를 폭을 맞춰 나란히 적고 없는 번호는 비운다", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const { chars, label } = gutter(weave(text(lines), text([...lines.slice(0, 9), "new", ...lines.slice(10)]), [[10, 1, 10, 1]]));
    const drawnLabel = (line: number) => label(line).replaceAll(" ", "_");
    expect(chars).toBe(5);
    expect(drawnLabel(1)).toBe("_1__1");
    expect(drawnLabel(10)).toBe("10___");
    expect(drawnLabel(11)).toBe("___10");
    expect(drawnLabel(13)).toBe("12_12");
  });
});
