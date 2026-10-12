import { describe, expect, it } from "vitest";
import { added, cacheTip, kilo, usageText } from "./usage";

const usage = { input: 2, cache_write: 1487, cache_read: 16411, output: 527 };

describe("kilo", () => {
  it("1,000 미만은 그대로 적는다", () => {
    expect([0, 7, 840, 999].map(kilo)).toEqual(["0", "7", "840", "999"]);
  });

  it("10k 미만은 소수 한 자리까지, 10k부터는 정수로 반올림한다", () => {
    expect([1000, 1249, 1250, 9013, 9949].map(kilo)).toEqual(["1.0k", "1.2k", "1.3k", "9.0k", "9.9k"]);
    expect([9950, 9999, 20985, 21499, 21500, 180521, 201506, 1_900_000].map(kilo)).toEqual(["10k", "10k", "21k", "21k", "22k", "181k", "202k", "1900k"]);
  });
});

describe("added", () => {
  it("칸마다 더하고, 없는 쪽은 더하지 않는다", () => {
    expect(added(null, null)).toBeNull();
    expect(added(null, usage)).toEqual(usage);
    expect(added(usage, null)).toEqual(usage);
    expect(added(usage, { input: 3, cache_write: 2990, cache_read: 16411, output: 1100 })).toEqual({ input: 5, cache_write: 4477, cache_read: 32822, output: 1627 });
  });
});

describe("usageText", () => {
  it("입력은 캐시에서 읽지 않은 입력이고, 캐시에서 읽은 입력은 말풍선에 적는다", () => {
    expect(usageText(usage)).toBe("입력 1.5k · 출력 527");
    expect(cacheTip(usage)).toBe("캐시에서 읽은 입력 16k");
    const batch = { input: 22, cache_write: 20963, cache_read: 180521, output: 9013 };
    expect(usageText(batch)).toBe("입력 21k · 출력 9.0k");
    expect(cacheTip(batch)).toBe("캐시에서 읽은 입력 181k");
  });
});
