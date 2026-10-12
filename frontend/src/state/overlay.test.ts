import { beforeEach, describe, expect, it, vi } from "vitest";
import { getUnused } from "../api/client";
import { compareFixture } from "../graph/fixture";
import { useCompare } from "./compare";
import { useOverlay } from "./overlay";

vi.mock("../api/client", () => ({ getUnused: vi.fn() }));

const received = vi.mocked(getUnused);

const store = () => useOverlay.getState();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useOverlay.setState(useOverlay.getInitialState(), true);
  useCompare.setState(useCompare.getInitialState(), true);
  received.mockReset();
});

describe("load", () => {
  it("받은 미사용 후보와 판정 대상 정의 수를 담는다", async () => {
    received.mockResolvedValue({ definitions: 180, candidates: ["date_engine:tomorrow", "doc_update:execute_all_reverse_ready"] });
    store().load();
    expect(store().unused).toEqual(new Set());
    await settle();
    expect(store().unused).toEqual(new Set(["date_engine:tomorrow", "doc_update:execute_all_reverse_ready"]));
    expect(store().definitions).toBe(180);
  });

  it("받지 못하면 직전 값을 그대로 둔다", async () => {
    received.mockResolvedValue({ definitions: 3, candidates: ["a:f"] });
    store().load();
    await settle();
    received.mockRejectedValue(new Error("연결 끊김"));
    store().load();
    await settle();
    expect(store().unused).toEqual(new Set(["a:f"]));
    expect(store().definitions).toBe(3);
  });

  it("켠 분석 표시를 바꾸지 않는다", async () => {
    received.mockResolvedValue({ definitions: 3, candidates: [] });
    store().set("cycles");
    store().load();
    await settle();
    expect(store().kind).toBe("cycles");
  });
});

describe("set", () => {
  it("분석 표시 없이 시작하고, 분석 표시를 켜고 바꾸고 끈다", () => {
    expect(store().kind).toBeNull();
    store().set("unused");
    expect(store().kind).toBe("unused");
    store().set("cycles");
    expect(store().kind).toBe("cycles");
    store().set(null);
    expect(store().kind).toBeNull();
  });

  it("시점 비교가 켜져 있는데 다른 값으로 바꾸면 비교를 끄고, compare로 바꾸면 끄지 않는다", () => {
    const clear = vi.fn(async () => undefined);
    useCompare.setState({ result: compareFixture, clear });
    store().set("compare");
    expect(clear).not.toHaveBeenCalled();
    store().set("cycles");
    expect(clear).toHaveBeenCalledTimes(1);
    store().set(null);
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("시점 비교가 꺼져 있으면 비교를 끄지 않는다", () => {
    const clear = vi.fn(async () => undefined);
    useCompare.setState({ clear });
    store().set("unused");
    expect(clear).not.toHaveBeenCalled();
  });
});
