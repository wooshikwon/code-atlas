import { describe, expect, it } from "vitest";
import { repoFixture } from "../graph/fixture";
import { nodeIndex } from "../graph/visible";
import { partsOf, refsOf, spansOf } from "./parts";

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
      { text: "today", code: true, ref: false },
      { text: "로 날짜를 구하고 ", code: false, ref: false },
      { text: "note.todos", code: true, ref: false },
      { text: "를 바꾼다", code: false, ref: false },
    ]);
  });

  it("백틱이 없거나 짝이 없으면 글자로 둔다", () => {
    expect(spansOf("그대로 둔다")).toEqual([{ text: "그대로 둔다", code: false, ref: false }]);
    expect(spansOf("짝 없는 ` 하나")).toEqual([{ text: "짝 없는 ` 하나", code: false, ref: false }]);
    expect(spansOf("")).toEqual([]);
  });
});

describe("정의 표기", () => {
  const refs = (text: string) => spansOf(text).filter((span) => span.ref).map((span) => span.text);

  it("백틱으로 감싼 표기와 감싸지 않은 표기를 모두 가르고 뒤에 붙은 조사와 마침표는 뺀다", () => {
    expect(spansOf("`arbiter.py::arbiter_sync`가 parser/plan.py::Plan.load를 부른다.")).toEqual([
      { text: "arbiter.py::arbiter_sync", code: true, ref: true },
      { text: "가 ", code: false, ref: false },
      { text: "parser/plan.py::Plan.load", code: true, ref: true },
      { text: "를 부른다.", code: false, ref: false },
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
