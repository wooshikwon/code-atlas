import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { describe, expect, it } from "vitest";
import { fixture } from "./fixture";
import { fromElk, type Box, type Point } from "./layout";
import { elkGraph } from "./layout1";
import { visibleNodes } from "./scope";

const measure = (text: string) => text.length * 7;
const visible = visibleNodes(fixture, false);

function find(node: ElkNode, id: string): ElkNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children ?? []) {
    const hit = find(child, id);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

function onBorder(p: Point, box: Box): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  const insideX = p.x >= box.x - 0.5 && p.x <= box.x + box.width + 0.5;
  const insideY = p.y >= box.y - 0.5 && p.y <= box.y + box.height + 0.5;
  return (
    (insideY && (near(p.x, box.x) || near(p.x, box.x + box.width))) ||
    (insideX && (near(p.y, box.y) || near(p.y, box.y + box.height)))
  );
}

describe("elkGraph", () => {
  const root = elkGraph(fixture, visible, measure);

  it("parent 사슬을 3단 중첩으로 바꾸고 형제를 폴더, 파일, 소스 정의 순서로 둔다", () => {
    expect(root.children?.map((c) => c.id)).toEqual(["pkg", "main"]);
    expect(find(root, "pkg")?.children?.map((c) => c.id)).toEqual(["pkg.mod", "pkg.util"]);
    expect(find(root, "pkg.mod")?.children?.map((c) => c.id)).toEqual(["pkg.mod:Store", "pkg.mod:Row", "pkg.mod:parse"]);
    expect(find(root, "pkg.mod:Store")?.children?.map((c) => c.id)).toEqual([
      "pkg.mod:Store.load",
      "pkg.mod:Store.save",
    ]);
    expect(find(root, "main")?.children?.map((c) => c.id)).toEqual(["main:run", "main:helper"]);
  });

  it("외부 노드와 테스트 코드를 넣지 않는다", () => {
    expect(find(root, "ext:json")).toBeUndefined();
    expect(find(root, "tests.test_mod")).toBeUndefined();
  });

  it("상자 노드에 위쪽 이름표 여백을 둔다", () => {
    expect(find(root, "pkg")?.layoutOptions?.["elk.padding"]).toBe("[top=32,left=16,bottom=16,right=16]");
  });

  it("선은 한 파일 상자 안의 선과 파일 상자 사이 집계 선이고 함수 안 import를 뺀다", () => {
    const ids = root.edges?.map((e) => e.id) ?? [];
    expect(ids).not.toContain("pkg.mod|pkg.util|import");
    expect(ids).not.toContain("main:run|pkg.mod:Store.load|call");
    expect(ids).toContain("pkg.mod:Store.save|pkg.mod:parse|call");
    expect(ids).toContain("agg|main|pkg.mod");
    expect(ids).toContain("agg|pkg.mod|main");
    expect(ids.some((id) => id.includes("ext:") || id.includes("tests."))).toBe(false);
  });

  it("다른 노드가 쓰지 않는 진입점을 열0에 고정한다", () => {
    expect(find(root, "main")?.layoutOptions?.["elk.layered.layering.layerConstraint"]).toBe("FIRST");
  });
});

describe("fromElk", async () => {
  const result = fromElk(await new ELK().layout(elkGraph(fixture, visible, measure)));

  it("부모 기준 좌표를 더해 절대 좌표를 만든다", () => {
    const pkg = result.boxes.get("pkg")!;
    const mod = result.positions.get("pkg.mod")!;
    expect(result.boxes.get("pkg.mod")).toMatchObject({ x: pkg.x + mod.x, y: pkg.y + mod.y });
  });

  it("계층을 넘는 선의 절대 좌표 경로가 출발·도착 노드 테두리에 닿는다", () => {
    for (const [key, source, target] of [
      ["pkg.mod:Store.load|pkg.mod:Row|construct", "pkg.mod:Store.load", "pkg.mod:Row"],
      ["pkg.mod:Store.save|pkg.mod:parse|call", "pkg.mod:Store.save", "pkg.mod:parse"],
      ["pkg.mod:Store.load|pkg.mod:Store.save|call", "pkg.mod:Store.load", "pkg.mod:Store.save"],
      ["agg|main|pkg.mod", "main", "pkg.mod"],
    ]) {
      const route = result.routes.get(key)!;
      expect(onBorder(route[0], result.boxes.get(source)!), `${key} start`).toBe(true);
      expect(onBorder(route.at(-1)!, result.boxes.get(target)!), `${key} end`).toBe(true);
    }
  });

  it("직각 경로의 이웃한 점은 가로 또는 세로로 잇는다", () => {
    for (const route of result.routes.values()) {
      for (let i = 1; i < route.length; i++) {
        const [a, b] = [route[i - 1], route[i]];
        expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5).toBe(true);
      }
    }
  });
});
