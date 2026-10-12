import { describe, expect, it } from "vitest";
import { countedOf, relationsOf } from "./names";

describe("relationsOf", () => {
  it("세는 관계(호출, 생성, 상속)가 있으면 그 종류만 수와 함께 적는다", () => {
    expect(relationsOf({ call: 5, construct: 2, import: 7, type: 1 })).toBe("호출 5곳 · 생성 2곳");
    expect(relationsOf({ inherit: 1, import: 1 })).toBe("상속 1곳");
  });

  it("세는 관계가 없으면 수 없이 타입에만 쓰이는지, import만 있는지를 적는다", () => {
    expect(relationsOf({ type: 3, import: 2 })).toBe("타입에만 쓰임");
    expect(relationsOf({ import: 2 })).toBe("import 관계만 있음");
    expect(relationsOf({})).toBe("");
  });
});

describe("countedOf", () => {
  it("세는 관계의 수만 더한다", () => {
    expect(countedOf({ call: 5, construct: 2, inherit: 1, import: 7, type: 1, pass: 2 })).toBe(8);
    expect(countedOf({ import: 7 })).toBe(0);
  });
});
