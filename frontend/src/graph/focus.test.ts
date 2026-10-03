import { describe, expect, it } from "vitest";
import { fixture } from "./fixture";
import { focus } from "./focus";
import { visibleNodes } from "./scope";

const visible = visibleNodes(fixture, false);

describe("focus", () => {
  it("방향과 관계없이 단계를 센다. 1단계는 1, 2단계는 2, 그 밖은 3이다", () => {
    const levels = focus(fixture, visible, "pkg.mod:Store.save", 1);
    expect(levels.get("pkg.mod:Store.save")).toBe(0);
    expect(levels.get("main:helper")).toBe(1);
    expect(levels.get("pkg.mod:Store.load")).toBe(1);
    expect(levels.get("main:run")).toBe(2);
    expect(levels.get("pkg.mod:Row")).toBe(2);
    expect(levels.get("pkg.util")).toBe(3);
  });

  it("슬라이더 단계만큼 1을 준다", () => {
    const levels = focus(fixture, visible, "pkg.mod:Store.save", 2);
    expect(levels.get("main:run")).toBe(1);
    expect(levels.get("pkg.mod:Row")).toBe(1);
  });

  it("숨긴 테스트 코드를 거쳐 단계를 세지 않는다", () => {
    expect(focus(fixture, visible, "pkg.mod:Store.load", 1).has("tests.test_mod:test_load")).toBe(false);
  });

  it("상자 노드는 안에 든 노드 가운데 가장 가까운 단계를 받는다", () => {
    const levels = focus(fixture, visible, "pkg.mod:Store.save", 1);
    expect(levels.get("pkg.mod:Store")).toBe(1);
    expect(levels.get("pkg")).toBe(1);
    expect(levels.get("main")).toBe(1);
  });

  it("파일 상자를 고르면 안에 든 정의가 모두 출발점이다", () => {
    const levels = focus(fixture, visible, "pkg.mod", 1);
    expect(levels.get("pkg.mod:Store.load")).toBe(0);
    expect(levels.get("main:helper")).toBe(1);
    expect(levels.get("pkg.util")).toBe(1);
  });
});
