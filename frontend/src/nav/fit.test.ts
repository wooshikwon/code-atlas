import { describe, expect, it } from "vitest";
import { cramped, FITS, TRAIL_ROOM } from "./fit";

describe("cramped", () => {
  it("탐색 경로에 남는 폭이 TRAIL_ROOM보다 좁을 때만 참이다", () => {
    expect(cramped(70 + 900 + TRAIL_ROOM, 70, 900)).toBe(false);
    expect(cramped(70 + 900 + TRAIL_ROOM - 1, 70, 900)).toBe(true);
  });

  it("줄이는 순서는 통계 문구, 토글, 두 줄이다", () => {
    expect(FITS).toEqual(["full", "brief", "menu", "rows"]);
  });
});
