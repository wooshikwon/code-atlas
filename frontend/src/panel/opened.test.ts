import { beforeEach, describe, expect, it } from "vitest";
import { repoFixture } from "../graph/fixture";
import { useAtlas } from "../state/store";
import { useOpened } from "./opened";

const opened = () => useOpened.getState().path;

beforeEach(() => {
  useAtlas.setState({ ...useAtlas.getInitialState(), graph: repoFixture }, true);
  useOpened.getState().close();
});

describe("연 파일", () => {
  it("같은 파일을 다시 열면 닫는다", () => {
    useOpened.getState().toggle("pkg/__init__.py");
    expect(opened()).toBe("pkg/__init__.py");
    useOpened.getState().toggle("pkg/__init__.py");
    expect(opened()).toBeNull();
  });

  it("그래프의 선택이 바뀌면 닫는다", () => {
    useOpened.getState().toggle("pkg/__init__.py");
    useAtlas.getState().select("main");
    expect(opened()).toBeNull();
  });

  it("그 파일이 든 폴더를 접으면 닫고, 다른 폴더를 접거나 펼치면 그대로 둔다", () => {
    useOpened.getState().toggle("pkg/__init__.py");
    useAtlas.getState().toggleFolder("app");
    useAtlas.getState().toggleFolder("app");
    expect(opened()).toBe("pkg/__init__.py");
    useAtlas.getState().toggleFolder("pkg");
    expect(opened()).toBeNull();
  });
});
