import { describe, expect, it } from "vitest";
import { countedOf, relationsOf } from "./names";

describe("relationsOf", () => {
  it("세는 관계(실행할 때 도는 관계)가 있으면 그 종류만 수와 함께 종류 이름의 순서로 적는다", () => {
    expect(relationsOf({ call: 5, construct: 2, import: 7, type: 1 })).toBe("호출 5곳 · 생성 2곳");
    expect(relationsOf({ inherit: 1, import: 1 })).toBe("상속 1곳");
    expect(relationsOf({ import: 2, type: 1, pass: 1 })).toBe("전달 1곳");
    expect(relationsOf({ override: 1, decorate: 2, pass: 3, call: 4 })).toBe("호출 4곳 · 전달 3곳 · 데코레이터 2곳 · 오버라이드 1곳");
  });

  it("세는 관계가 없으면 수 없이 타입에만 쓰이는지, import만 있는지를 적는다", () => {
    expect(relationsOf({ type: 3, import: 2 })).toBe("타입에만 쓰임");
    expect(relationsOf({ import: 2 })).toBe("import 관계만 있음");
    expect(relationsOf({})).toBe("");
  });
});

describe("countedOf", () => {
  it("세는 관계의 수만 더한다", () => {
    expect(countedOf({ call: 5, construct: 2, inherit: 1, import: 7, type: 1, pass: 2, decorate: 1, override: 1 })).toBe(12);
    expect(countedOf({ import: 7 })).toBe(0);
  });
});
