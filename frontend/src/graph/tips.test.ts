import { describe, expect, it } from "vitest";
import { repoFixture } from "./fixture";
import { busyTip, globalTip, inflowTip, locTip, unresolvedTip } from "./tips";
import { nodeIndex } from "./visible";

const nodes = nodeIndex(repoFixture);
const [file, folder, fn] = [nodes.get("main")!, nodes.get("pkg")!, nodes.get("main:run")!];

describe("배지 말풍선", () => {
  it("미확인 호출 수는 수와 뜻을 적고, 접힌 파일·폴더 상자는 합친 수임을 밝힌다", () => {
    expect(unresolvedTip(fn, 4, false).split("\n")[0]).toBe("대상을 확인하지 못한 호출 4곳");
    expect(unresolvedTip(file, 9, false).split("\n")[0]).toBe("대상을 확인하지 못한 호출 9곳 · 이 파일 안의 함수에서 합친 수");
    expect(unresolvedTip(folder, 30, false).split("\n")[0]).toBe("대상을 확인하지 못한 호출 30곳 · 이 폴더 안의 함수에서 합친 수");
    expect(unresolvedTip(file, 2, true).split("\n")[0]).toBe("대상을 확인하지 못한 호출 2곳");
    expect(unresolvedTip(fn, 4, false).split("\n")).toHaveLength(3);
  });

  it("모듈 변수 변경은 바꾸는 모듈 변수 이름을 적고 self 속성은 뺀다", () => {
    expect(globalTip({ ...fn, writes: ["counter", "self.calls", "REGISTRY"] })).toBe("모듈 변수 변경: global 문으로 counter, REGISTRY을 바꾼다");
    expect(globalTip({ ...fn, writes: [] })).toBe("모듈 변수 변경: global 문으로 모듈 변수를 바꾼다");
  });

  it("도는 원, 편재 노드, 줄 수는 수를 함께 적는다", () => {
    expect(busyTip(fn, 1)).toBe("LLM 요약을 만드는 중 1개");
    expect(busyTip(folder, 2)).toBe("LLM 요약을 만드는 중 2개 · 이 상자와 안에 든 노드");
    expect(inflowTip(8).split("\n")[0]).toBe("편재 노드: 선을 숨긴 출발 노드 8개");
    expect(locTip({ ...fn, loc: 131 })).toBe("줄 수 131줄 · 빈 줄을 뺀 수");
  });
});
