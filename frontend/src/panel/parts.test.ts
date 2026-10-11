import { describe, expect, it } from "vitest";
import { partsOf, spansOf } from "./parts";

describe("partsOf", () => {
  it("요지, 하는 일 문단, 앞뒤 흐름 문단으로 나눈다", () => {
    const summary = "노트를 다시 만든다.\n\n하는 일\n첫 문단.\n둘째 문단.\n\n앞뒤 흐름\n부르는 쪽.\n불리는 쪽.";
    expect(partsOf(summary)).toEqual({
      lead: "노트를 다시 만든다.",
      sections: [
        { title: "하는 일", paragraphs: ["첫 문단.", "둘째 문단."] },
        { title: "앞뒤 흐름", paragraphs: ["부르는 쪽.", "불리는 쪽."] },
      ],
    });
  });

  it("표지 줄이 없는 설명은 전체가 요지다", () => {
    expect(partsOf("설정을 받아 엔진을 만든다.\n그리고 시작한다.")).toEqual({
      lead: "설정을 받아 엔진을 만든다. 그리고 시작한다.",
      sections: [],
    });
  });

  it("순서에 맞지 않는 표지 줄과 문단 안의 표지 글자는 문단으로 둔다", () => {
    const parts = partsOf("요지.\n\n앞뒤 흐름\n\n하는 일\n하는 일\n앞뒤 흐름을 적는다.\n\n앞뒤 흐름\n끝.");
    expect(parts.lead).toBe("요지. 앞뒤 흐름");
    expect(parts.sections).toEqual([
      { title: "하는 일", paragraphs: ["하는 일", "앞뒤 흐름을 적는다."] },
      { title: "앞뒤 흐름", paragraphs: ["끝."] },
    ]);
  });
});

describe("spansOf", () => {
  it("백틱으로 감싼 식별자를 가르고 백틱을 뗀다", () => {
    expect(spansOf("`today`로 날짜를 구하고 `note.todos`를 바꾼다")).toEqual([
      { text: "today", code: true },
      { text: "로 날짜를 구하고 ", code: false },
      { text: "note.todos", code: true },
      { text: "를 바꾼다", code: false },
    ]);
  });

  it("백틱이 없거나 짝이 없으면 글자로 둔다", () => {
    expect(spansOf("그대로 둔다")).toEqual([{ text: "그대로 둔다", code: false }]);
    expect(spansOf("짝 없는 ` 하나")).toEqual([{ text: "짝 없는 ` 하나", code: false }]);
    expect(spansOf("")).toEqual([]);
  });
});
