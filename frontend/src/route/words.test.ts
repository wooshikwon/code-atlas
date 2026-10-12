import { describe, expect, it } from "vitest";
import { routeFixture } from "../graph/fixture";
import { route } from "../graph/route";
import { hidden, nodeIndex } from "../graph/visible";
import { emptyText, pickTip, stepCount, stepRows } from "./words";

const nodes = nodeIndex(routeFixture);
const off = hidden(routeFixture, { showTests: false, showExternal: false });
const found = (from: string, to: string) => route(routeFixture, from, to, off);

describe("emptyText", () => {
  it("미확인 호출이 없으면 닿는 함수 수와 미확인 호출이 없음을 적는다", () => {
    expect(emptyText(found("flow.sink:emit", "flow.walk:begin"), nodes)).toEqual([
      "실행 선으로 이어지는 경로가 없습니다",
      "출발에서 닿는 함수는 1개이고 그 안에 대상을 확인하지 못한 호출(?)은 없습니다",
    ]);
  });

  it("미확인 호출이 있으면 닿는 함수 수와 미확인 호출 수를 적는다", () => {
    expect(emptyText(found("flow.build:Base.run", "flow.walk:begin"), nodes)).toEqual([
      "실행 선으로 이어지는 경로가 없습니다",
      "출발에서 닿는 함수 4개 안에 대상을 확인하지 못한 호출(?)이 1곳 있습니다. 그 호출을 거쳐 실제로는 닿을 수 있습니다",
    ]);
  });

  it("반대 방향에 경로가 있으면 한 줄을 덧붙인다", () => {
    expect(emptyText(found("flow.walk:finish", "flow.walk:begin"), nodes)).toEqual([
      "실행 선으로 이어지는 경로가 없습니다",
      "출발에서 닿는 함수 1개 안에 대상을 확인하지 못한 호출(?)이 3곳 있습니다. 그 호출을 거쳐 실제로는 닿을 수 있습니다",
      "반대 방향에는 경로가 있습니다",
    ]);
  });

  it("출발과 도착이 같거나 한쪽이 다른 쪽을 품으면 같은 곳이라고만 적는다", () => {
    const same = ["출발과 도착이 같은 곳입니다"];
    expect(emptyText(found("flow.walk:begin", "flow.walk:begin"), nodes)).toEqual(same);
    expect(emptyText(found("flow.walk", "flow.walk:finish"), nodes)).toEqual(same);
    expect(emptyText(found("flow.build:Engine.__init__", "flow.build:Engine"), nodes)).toEqual(same);
  });
});

describe("단계 목록과 숫자 버튼", () => {
  it("단계 수는 걸음 수이고 말풍선은 경로가 거치는 파일 수를 함께 적는다", () => {
    const [short] = found("flow.walk:begin", "flow.walk:finish").paths;
    expect(stepCount(short)).toBe(2);
    expect(pickTip(short, nodes)).toBe("2단계 · 파일 1개");
    const [across] = found("flow.build:make", "flow.sink:tune").paths;
    expect(pickTip(across, nodes)).toBe("3단계 · 파일 2개");
  });

  it("행은 경로의 노드 순서로 이름과 파일 이름을 적고 이음으로 넘어온 단계를 표시한다", () => {
    const made = found("flow.build:make", "flow.sink:tune");
    expect(stepRows(made, made.paths[0], nodes)).toEqual([
      { id: "flow.build:make", name: "make()", file: "build.py", mark: null },
      { id: "flow.build:Engine", name: "Engine", file: "build.py", mark: null },
      { id: "flow.build:Engine.__init__", name: "Engine.__init__()", file: "build.py", mark: "생성자" },
      { id: "flow.sink:tune", name: "tune()", file: "sink.py", mark: null },
    ]);
    const stepped = found("flow.build:Base.run", "flow.sink:emit");
    expect(stepRows(stepped, stepped.paths[0], nodes).map((row) => row.mark)).toEqual([null, null, "오버라이드", null]);
  });
});
