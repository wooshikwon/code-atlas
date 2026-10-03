import { describe, expect, it } from "vitest";
import { fixture } from "./fixture";
import { aggregates, scope, visibleNodes } from "./scope";

const visible = visibleNodes(fixture, false);

describe("visibleNodes", () => {
  it("외부 노드를 숨기고 테스트 코드는 토글로 보인다", () => {
    expect(visible.has("ext:json")).toBe(false);
    expect(visible.has("tests.test_mod")).toBe(false);
    expect(visibleNodes(fixture, true).has("tests.test_mod:test_load")).toBe(true);
  });
});

describe("aggregates", () => {
  it("파일 상자 쌍마다 합치고 무게는 sites 수 합, 분류는 실행·사용·계승 순서로 앞선 것이다", () => {
    const agg = aggregates(fixture, visible).find((a) => a.key === "agg|main|pkg.mod")!;
    expect(agg.weight).toBe(4);
    expect(agg.group).toBe("run");
    expect(agg.kinds).toEqual({ import: 1, call: 3 });
  });

  it("같은 파일 상자 안의 선과 함수 안 import는 합치지 않는다", () => {
    const keys = aggregates(fixture, visible).map((a) => a.key);
    expect(keys.sort()).toEqual(["agg|main|pkg.mod", "agg|pkg.mod|main"]);
  });
});

describe("scope", () => {
  it("규칙 1: 고른 노드가 없으면 집계 선과 한 파일 상자 안의 선만 그린다", () => {
    expect(scope(fixture, visible, null, null).sort()).toEqual(
      [
        "agg|main|pkg.mod",
        "agg|pkg.mod|main",
        "main:run|main:helper|call",
        "pkg.mod:Store.load|pkg.mod:Row|construct",
        "pkg.mod:Store.load|pkg.mod:Store.save|call",
        "pkg.mod:Store.save|pkg.mod:parse|call",
      ].sort(),
    );
  });

  it("규칙 2: 고른 노드에 닿는 선은 파일 경계를 넘는 선까지 그린다", () => {
    const keys = scope(fixture, visible, "pkg.mod:Store.save", null);
    expect(keys).toContain("pkg.mod:Store.save|main:helper|call");
    expect(keys).not.toContain("main:run|pkg.mod:Store.load|call");
  });

  it("규칙 2: 마우스를 올린 노드도 같고, 함수 안 import도 그린다", () => {
    const keys = scope(fixture, visible, null, "pkg.mod");
    expect(keys).toContain("pkg.mod|pkg.util|import");
    expect(keys).not.toContain("pkg.mod|ext:json|import");
  });
});
