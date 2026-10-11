import { describe, expect, it } from "vitest";
import { repoFixture } from "../graph/fixture";
import { nodeIndex } from "../graph/visible";
import { blocksOf, partsOf, refsOf, spansOf } from "./parts";

const p = (text: string) => ({ kind: "paragraph", text });

describe("partsOf", () => {
  it("요지, 하는 일 문단, 앞뒤 흐름 문단으로 나눈다", () => {
    const summary = "노트를 다시 만든다.\n\n하는 일\n첫 문단.\n둘째 문단.\n\n앞뒤 흐름\n부르는 쪽.\n불리는 쪽.";
    expect(partsOf(summary)).toEqual({
      lead: "노트를 다시 만든다.",
      sections: [
        { title: "하는 일", blocks: [p("첫 문단."), p("둘째 문단.")] },
        { title: "앞뒤 흐름", blocks: [p("부르는 쪽."), p("불리는 쪽.")] },
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
      { title: "하는 일", blocks: [p("하는 일"), p("앞뒤 흐름을 적는다.")] },
      { title: "앞뒤 흐름", blocks: [p("끝.")] },
    ]);
  });
});

describe("spansOf", () => {
  it("백틱으로 감싼 식별자를 가르고 백틱을 뗀다", () => {
    expect(spansOf("`today`로 날짜를 구하고 `note.todos`를 바꾼다")).toEqual([
      { text: "today", code: true, ref: false, bold: false },
      { text: "로 날짜를 구하고 ", code: false, ref: false, bold: false },
      { text: "note.todos", code: true, ref: false, bold: false },
      { text: "를 바꾼다", code: false, ref: false, bold: false },
    ]);
  });

  it("백틱이 없거나 짝이 없으면 글자로 둔다", () => {
    expect(spansOf("그대로 둔다")).toEqual([{ text: "그대로 둔다", code: false, ref: false, bold: false }]);
    expect(spansOf("짝 없는 ` 하나")).toEqual([{ text: "짝 없는 ` 하나", code: false, ref: false, bold: false }]);
    expect(spansOf("")).toEqual([]);
  });
});

describe("정의 표기", () => {
  const refs = (text: string) => spansOf(text).filter((span) => span.ref).map((span) => span.text);

  it("백틱으로 감싼 표기와 감싸지 않은 표기를 모두 가르고 뒤에 붙은 조사와 마침표는 뺀다", () => {
    expect(spansOf("`arbiter.py::arbiter_sync`가 parser/plan.py::Plan.load를 부른다.")).toEqual([
      { text: "arbiter.py::arbiter_sync", code: true, ref: true, bold: false },
      { text: "가 ", code: false, ref: false, bold: false },
      { text: "parser/plan.py::Plan.load", code: true, ref: true, bold: false },
      { text: "를 부른다.", code: false, ref: false, bold: false },
    ]);
    expect(refs("끝에 온 note_common.py::ExtractedTodo.")).toEqual(["note_common.py::ExtractedTodo"]);
  });

  it("파일 경로, 외부 함수, 백틱 안의 다른 글자가 섞인 조각은 표기가 아니다", () => {
    expect(refs("`src/arbiter.py`와 `re.sub`, `Path.glob`, `a.py::f(x)`, `std::move`")).toEqual([]);
  });

  it("refsOf는 파일 상자 이름표와 정의 이름으로 함수·메서드·클래스·데이터 클래스 노드를 찾는다", () => {
    const found = refsOf(nodeIndex(repoFixture));
    expect(found.get("pkg/mod.py::Store.load")).toBe("pkg.mod:Store.load");
    expect(found.get("pkg/mod.py::Store")).toBe("pkg.mod:Store");
    expect(found.get("cli.py::main")).toBe("cli:main");
    expect(found.get("app/__init__.py::version")).toBe("app:version");
    expect(found.get("pkg/mod.py::nothing")).toBeUndefined();
    expect(found.get("src/cli.py::main")).toBeUndefined();
    expect([...found.values()].every((id) => id.includes(":"))).toBe(true);
  });
});

describe("굵은 글씨", () => {
  it("`**`로 감싼 글을 굵은 조각으로 가르고 그 안의 백틱 식별자와 정의 표기도 가른다", () => {
    expect(spansOf("먼저 **`today`를 부른다** 그다음 **끝**.")).toEqual([
      { text: "먼저 ", code: false, ref: false, bold: false },
      { text: "today", code: true, ref: false, bold: true },
      { text: "를 부른다", code: false, ref: false, bold: true },
      { text: " 그다음 ", code: false, ref: false, bold: false },
      { text: "끝", code: false, ref: false, bold: true },
      { text: ".", code: false, ref: false, bold: false },
    ]);
    expect(spansOf("**`arbiter.py::arbiter_sync`**")).toEqual([{ text: "arbiter.py::arbiter_sync", code: true, ref: true, bold: true }]);
  });

  it("짝이 없는 `**`와 백틱 안의 `**`는 글자로 둔다", () => {
    expect(spansOf("a ** b")).toEqual([{ text: "a ** b", code: false, ref: false, bold: false }]);
    expect(spansOf("`model(**batch)`로 부르고 `f(**kw)`도 부른다").filter((span) => span.bold)).toEqual([]);
    expect(spansOf("`model(**batch)`로 부른다")[0]).toEqual({ text: "model(**batch)", code: true, ref: false, bold: false });
  });
});

describe("blocksOf", () => {
  it("줄마다 문단 하나로 나누고 빈 줄은 뺀다", () => {
    expect(blocksOf("첫 문단.\n\n  둘째 문단.  \n")).toEqual([p("첫 문단."), p("둘째 문단.")]);
  });

  it("`-`·`*`로 시작하는 줄과 번호로 시작하는 줄을 이어진 것끼리 목록으로 묶는다", () => {
    expect(blocksOf("순서:\n- 하나\n* 둘\n1. 첫째\n2) 둘째\n끝.")).toEqual([
      p("순서:"),
      { kind: "list", ordered: false, items: ["하나", "둘"] },
      { kind: "list", ordered: true, items: ["첫째", "둘째"] },
      p("끝."),
    ]);
    expect(blocksOf("-1을 돌려준다\n3.5배다")).toEqual([p("-1을 돌려준다"), p("3.5배다")]);
  });

  it("코드 울타리 사이의 줄은 들여쓰기를 둔 코드 블록 하나다", () => {
    expect(blocksOf("예:\n```python\nif x:\n    - y\n\n    return 1\n```\n끝.")).toEqual([
      p("예:"),
      { kind: "code", text: "if x:\n    - y\n\n    return 1" },
      p("끝."),
    ]);
    expect(blocksOf("```\n닫지 않은 코드")).toEqual([{ kind: "code", text: "닫지 않은 코드" }]);
  });

  it("partsOf는 구역 안의 목록과 코드 블록을 가르고 코드 블록 안의 표지 글자를 표지 줄로 보지 않는다", () => {
    const parts = partsOf("요지.\n\n하는 일\n- 읽는다\n- 쓴다\n```\n앞뒤 흐름\n```\n\n앞뒤 흐름\n끝.");
    expect(parts).toEqual({
      lead: "요지.",
      sections: [
        { title: "하는 일", blocks: [{ kind: "list", ordered: false, items: ["읽는다", "쓴다"] }, { kind: "code", text: "앞뒤 흐름" }] },
        { title: "앞뒤 흐름", blocks: [p("끝.")] },
      ],
    });
  });
});
