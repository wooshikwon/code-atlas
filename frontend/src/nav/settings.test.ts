import { describe, expect, it } from "vitest";
import { changed, filterTip } from "./settings";

const base = { depth: 2, overlay: null, showTests: false, showExternal: false, autoSummary: false } as const;

describe("기본값과 다른 보기 설정", () => {
  it("모두 기본값이면 비어 있다", () => {
    expect(changed(base)).toEqual([]);
    expect(filterTip([])).toBe("필터 · 보기 설정이 모두 기본값이다");
  });

  it("흐름 단계, 덮개, 토글 세 개를 필터 창에 그리는 순서로 적는다", () => {
    const names = changed({ depth: 3, overlay: "cycles", showTests: true, showExternal: true, autoSummary: true });
    expect(names).toEqual(["흐름 단계 3", "덮개 순환 의존", "테스트 코드", "외부 노드", "자동 요약"]);
    expect(filterTip(names).split("\n")).toEqual(["필터 · 기본값과 다른 보기 설정", ...names]);
  });

  it("다른 값만 적는다", () => {
    expect(changed({ ...base, overlay: "unused" })).toEqual(["덮개 미사용 후보"]);
    expect(changed({ ...base, depth: 1 })).toEqual(["흐름 단계 1"]);
  });
});
