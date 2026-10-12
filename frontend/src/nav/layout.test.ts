import { describe, expect, it } from "vitest";
import { judge, layoutTip, other } from "./layout";

describe("judge", () => {
  it("창의 높이가 폭보다 크면 세로창 모드다", () => {
    expect(judge({ width: 800, height: 1200 })).toBe("portrait");
    expect(judge({ width: 800, height: 801 })).toBe("portrait");
  });

  it("창의 높이가 폭과 같거나 작으면 가로창 모드다", () => {
    expect(judge({ width: 800, height: 800 })).toBe("landscape");
    expect(judge({ width: 1700, height: 1000 })).toBe("landscape");
  });
});

describe("모드 버튼", () => {
  it("누르면 지금 쓰는 모드의 반대 모드로 바뀌고 말풍선이 바뀌는 모드를 적는다", () => {
    expect(other("landscape")).toBe("portrait");
    expect(other("portrait")).toBe("landscape");
    expect(layoutTip("landscape")).toBe("세로창 모드로 바꾸기");
    expect(layoutTip("portrait")).toBe("가로창 모드로 바꾸기");
  });
});
