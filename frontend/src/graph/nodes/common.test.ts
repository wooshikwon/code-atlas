import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { DIM, HALF } from "../flow";
import { faceId } from "../layers";
import { NODE_GAP } from "../layout";
import { GROW, grown, nodeProps, pointing, shownChange, type AtlasNodeData } from "./common";

const flowNode = (id: string, kind: string, expanded: boolean, width: number, height: number): Node<AtlasNodeData> =>
  ({ id, position: { x: 10, y: 20 }, width, height, style: { opacity: 1 }, data: { node: { id: id.replace(/#face$/, ""), kind }, expanded } }) as unknown as Node<AtlasNodeData>;

const pair = (id: string, kind: string, expanded: boolean, width: number, height: number) => [flowNode(id, kind, expanded, width, height), flowNode(faceId(id), kind, expanded, width, height)];

describe("grown", () => {
  it("넓은 상자와 작은 노드의 네 변이 같은 길이 GROW만큼 나간다", () => {
    for (const [width, height] of [[320, 40], [120, 18], [78, 40]]) {
      const scale = grown(width, height);
      expect((width * scale.x - width) / 2).toBeCloseTo(GROW);
      expect((height * scale.y - height) / 2).toBeCloseTo(GROW);
    }
  });

  it("GROW는 선이 한쪽으로 굵어지는 0.5px보다 크고 이웃과의 간격의 절반보다 작다", () => {
    expect(GROW).toBeGreaterThan(0.5);
    expect(GROW).toBeLessThan(NODE_GAP / 2);
  });
});

describe("pointing", () => {
  const nodes = [...pair("a", "module", false, 320, 40), ...pair("b", "module", true, 400, 300), ...pair("c", "class", true, 200, 120), ...pair("b:f", "function", false, 120, 18)];
  const grow = (list: Node<AtlasNodeData>[], id: string) => (list.find((node) => node.id === id)!.style as Record<string, unknown>)["--grow-x"];

  it("잎 노드의 두 요소에 확대 비율을 넣고 위치와 크기는 그대로 둔다", () => {
    const drawn = pointing(nodes, "a");
    expect(grow(drawn, "a")).toBeCloseTo(324 / 320);
    expect(grow(drawn, faceId("a"))).toBeCloseTo(324 / 320);
    expect(drawn[0]).toMatchObject({ position: { x: 10, y: 20 }, width: 320, height: 40 });
    expect(grow(pointing(nodes, "b:f"), "b:f")).toBeCloseTo(124 / 120);
    expect(pointing(nodes, "b:f").filter((node) => node.className !== undefined).map((node) => node.id)).toEqual(["b:f", faceId("b:f")]);
  });

  it("펼친 파일 상자와 펼친 클래스에는 확대 비율을 넣지 않는다", () => {
    expect(grow(pointing(nodes, "b"), faceId("b"))).toBeUndefined();
    expect(grow(pointing(nodes, "c"), "c")).toBeUndefined();
    expect(grow(pointing(nodes, "c"), faceId("c"))).toBeUndefined();
  });
});

describe("시점 비교의 노드", () => {
  const gone = (node: Node<AtlasNodeData>): Node<AtlasNodeData> => ({ ...node, style: { opacity: DIM }, data: { ...node.data, compare: { lines: null, gone: true } } });
  const kept = (node: Node<AtlasNodeData>): Node<AtlasNodeData> => ({ ...node, style: { opacity: DIM }, data: { ...node.data, compare: { lines: null, gone: false } } });

  it("삭제된 노드는 마우스를 올려도 흐린 단계 그대로이고 그 밖의 흐린 노드는 한 단계 오른다", () => {
    const [body] = pointing(pair("a:f", "function", false, 120, 18).map(gone), "a:f");
    expect(body).toMatchObject({ className: "pointed", style: { opacity: DIM } });
    const [other] = pointing(pair("a:f", "function", false, 120, 18).map(kept), "a:f");
    expect(other.style?.opacity).toBe(HALF);
  });

  it("비교가 켜져 있는 동안에는 마지막 커밋 뒤의 변경 상태를 그리지 않는다", () => {
    const [node] = pair("a:f", "function", false, 120, 18);
    expect(shownChange({ ...node.data, compare: null }, "modified")).toBe("modified");
    expect(shownChange(kept(node).data, "modified")).toBeNull();
    expect(nodeProps("node-function", { ...node.data, cycle: null, compare: null }, null)["data-gone"]).toBeUndefined();
    expect(nodeProps("node-function", { ...gone(node).data, cycle: null }, null)["data-gone"]).toBe("");
  });
});
