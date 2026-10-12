import { describe, expect, it } from "vitest";
import { queueText } from "./SummaryQueue";

const batch = { total: 23, ended: 7, failed: 0, held: true, cancelled: false, usage: null };

describe("queueText", () => {
  it("끝난 수와 요청한 수를 적는다", () => {
    expect(queueText(batch, 14, 2)).toBe("요약 7 / 23");
    expect(queueText({ ...batch, failed: 2 }, 14, 2)).toBe("요약 7 / 23");
    expect(queueText({ ...batch, ended: 22 }, 0, 1)).toBe("요약 22 / 23");
  });

  it("취소한 뒤에는 서버로 보낸 요청의 수만 적고, 다시 차례를 기다리는 요청이 생기면 수를 센다", () => {
    const cancelled = { total: 2, ended: 1, failed: 0, held: true, cancelled: true, usage: null };
    expect(queueText(cancelled, 0, 1)).toBe("요약 만드는 중 1개");
    expect(queueText({ ...cancelled, total: 5 }, 2, 2)).toBe("요약 1 / 5");
  });
});
