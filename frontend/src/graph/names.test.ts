import { describe, expect, it } from "vitest";
import { variableFixture } from "./fixture";
import { countedOf, EDGE_KIND_NAMES, GROUP_KINDS, KIND_NAMES, kilo, kindsOf, nameOf, relationOf, relationsOf, valueAside } from "./names";
import { nodeIndex } from "./visible";

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

  it("읽음과 바꿈은 세는 관계다", () => {
    expect(countedOf({ read: 3, write: 1, type: 2 })).toBe(4);
    expect(kindsOf({ read: 3, write: 1, type: 2, import: 1 }, false)).toEqual(["import", "type"]);
  });
});

describe("읽음과 바꿈", () => {
  it("종류의 순서는 전달 다음이고 사용 분류에 든다", () => {
    expect(Object.keys(EDGE_KIND_NAMES)).toEqual(["call", "construct", "import", "pass", "read", "write", "decorate", "type", "inherit", "override"]);
    expect(GROUP_KINDS.use).toEqual(["import", "pass", "read", "write", "decorate", "type"]);
    expect(relationsOf({ write: 1, decorate: 1, read: 3, pass: 2, call: 1 })).toBe("호출 1곳 · 전달 2곳 · 읽음 3곳 · 바꿈 1곳 · 데코레이터 1곳");
  });

  it("코드의 지점을 `곳`으로 센다", () => {
    expect(relationOf("read", 3)).toBe("읽음 3곳");
    expect(relationOf("write", 1)).toBe("바꿈 1곳");
  });
});

describe("변수 노드의 이름", () => {
  const nodes = nodeIndex(variableFixture);

  it("종류 이름은 변수이고 이름에 괄호를 붙이지 않는다", () => {
    expect(KIND_NAMES.variable).toBe("변수");
    expect(nameOf(nodes, nodes.get("conf:PRESETS")!)).toBe("PRESETS");
  });

  it("값의 종류를 적고 원소 수가 있으면 함께 적는다. 변수 노드가 아니면 빈 글이다", () => {
    expect(valueAside(nodes.get("conf:PRESETS")!)).toBe("dict · 2개");
    expect(valueAside(nodes.get("conf:_cache")!)).toBe("dict · 0개");
    expect(valueAside(nodes.get("conf:LIMIT")!)).toBe("int");
    expect(valueAside(nodes.get("conf:DEFAULT")!)).toBe("expr");
    expect(valueAside(nodes.get("conf:logger")!)).toBe("logging.getLogger(…)");
    expect(valueAside(nodes.get("conf:clamp")!)).toBe("");
  });
});

describe("kilo", () => {
  it("1,000 미만은 그대로 적는다", () => {
    expect([0, 7, 840, 999].map(kilo)).toEqual(["0", "7", "840", "999"]);
  });

  it("10k 미만은 소수 한 자리까지, 10k부터는 정수로 반올림한다", () => {
    expect([1000, 1249, 1250, 9013, 9949].map(kilo)).toEqual(["1.0k", "1.2k", "1.3k", "9.0k", "9.9k"]);
    expect([9950, 9999, 20985, 21499, 21500, 180521, 201506, 1_900_000].map(kilo)).toEqual(["10k", "10k", "21k", "21k", "22k", "181k", "202k", "1900k"]);
  });
});
