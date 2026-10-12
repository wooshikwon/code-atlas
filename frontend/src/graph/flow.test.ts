import { describe, expect, it } from "vitest";
import { repoFixture, routeFixture, variableFixture } from "./fixture";
import { DIM, flow, opacities, opacity } from "./flow";
import { lit, route } from "./route";
import { hidden } from "./visible";

const off = hidden(repoFixture, { showTests: false, showExternal: false });

describe("flow", () => {
  it("나가는 방향으로 단계를 세고 depth단계에서 멈춘다", () => {
    const three = flow(repoFixture, "app.web:index", 3, off);
    expect(three.unit).toBe("node");
    expect(three.file).toBe("app.web");
    expect(three.depth).toBe(3);
    expect([...three.out]).toEqual([
      ["app.web:render", 1],
      ["app.text:wrap", 2],
      ["app.text:pad", 3],
    ]);
    expect(flow(repoFixture, "app.web:index", 2, off).out.has("app.text:pad")).toBe(false);
  });

  it("고른 노드로 선을 보내는 노드를 모으고 숨긴 테스트 코드는 넣지 않는다", () => {
    expect([...flow(repoFixture, "pkg.mod:Store.load", 1, off).incoming]).toEqual(["main:run"]);
    const all = hidden(repoFixture, { showTests: true, showExternal: false });
    expect([...flow(repoFixture, "pkg.mod:Store.load", 1, all).incoming].sort()).toEqual([
      "main:run",
      "tests.test_mod:test_load",
    ]);
  });

  it("고른 노드의 자손이 모두 출발점이고 출발점 사이의 선은 세지 않는다", () => {
    const result = flow(repoFixture, "pkg.mod:Store", 1, off);
    expect([...result.seeds].sort()).toEqual(["pkg.mod:Store", "pkg.mod:Store.load", "pkg.mod:Store.save"]);
    expect([...result.out.keys()].sort()).toEqual(["main:helper", "pkg.mod:Row", "pkg.mod:parse"]);
  });

  it("파일 상자를 고르면 파일 단위로 세고 함수 안 import도 따라간다", () => {
    const result = flow(repoFixture, "pkg.mod", 2, off);
    expect(result.unit).toBe("file");
    expect(result.seeds.has("pkg.mod:Store.save")).toBe(true);
    expect(Object.fromEntries(result.out)).toEqual({ main: 1, "pkg.util": 1, common: 1, cli: 2 });
    expect([...result.incoming]).toEqual(["main"]);
  });

  it("폴더를 고르면 폴더 안의 노드를 그 폴더로 올려 상자 단위로 센다", () => {
    const result = flow(repoFixture, "pkg", 2, off);
    expect(result.unit).toBe("file");
    expect(result.file).toBe("pkg");
    expect(result.seeds.has("pkg.mod:Store.save") && result.seeds.has("pkg.util")).toBe(true);
    expect(Object.fromEntries(result.out)).toEqual({ main: 1, common: 1, cli: 2 });
    expect([...result.incoming]).toEqual(["main"]);
  });
});

describe("opacity", () => {
  it("흐름이 없으면 모두 1이다", () => {
    expect(opacity(null, "scratch")).toBe(1);
  });

  it("마지막 단계는 0.5, 그보다 앞 단계는 1, 흐름 밖은 흐린 단계다", () => {
    const three = flow(repoFixture, "app.web:render", 2, off);
    expect(opacity(three, "app.web:render")).toBe(1);
    expect(opacity(three, "app.web:index")).toBe(1);
    expect(opacity(three, "app.text:wrap")).toBe(1);
    expect(opacity(three, "app.text:pad")).toBe(0.5);
    expect(opacity(three, "scratch:todo")).toBe(DIM);
  });

  it("흐름이 depth보다 앞 단계에서 끝나면 끝 단계도 1이다", () => {
    expect(opacity(flow(repoFixture, "app.web:render", 3, off), "app.text:pad")).toBe(1);
  });

  it("depth가 1이면 마지막 단계도 1이다", () => {
    expect(opacity(flow(repoFixture, "app.web:render", 1, off), "app.text:wrap")).toBe(1);
  });
});

describe("opacities", () => {
  it("상자는 안에 든 노드 가운데 가장 큰 값을 받는다", () => {
    const result = opacities(repoFixture, flow(repoFixture, "main:run", 2, off), null);
    expect(result.get("main")).toBe(1);
    expect(result.get("main:helper")).toBe(1);
    expect(result.get("cli")).toBe(1);
    expect(result.get("pkg.mod:Store.save")).toBe(0.5);
    expect(result.get("pkg.mod:Store")).toBe(1);
    expect(result.get("pkg")).toBe(1);
    expect(result.get("pkg.util")).toBe(DIM);
    expect(result.get("app")).toBe(DIM);
  });

  it("파일 상자를 고르면 파일 상자와 그 폴더가 값을 받는다", () => {
    const result = opacities(repoFixture, flow(repoFixture, "pkg.mod", 2, off), null);
    expect(result.get("main")).toBe(1);
    expect(result.get("cli")).toBe(0.5);
    expect(result.get("pkg.util")).toBe(1);
    expect(result.get("app.web")).toBe(DIM);
  });

  it("폴더를 고르면 그 폴더와 흐름에 든 파일 상자가 값을 받는다", () => {
    const result = opacities(repoFixture, flow(repoFixture, "pkg", 2, off), null);
    expect(result.get("pkg")).toBe(1);
    expect(result.get("main")).toBe(1);
    expect(result.get("cli")).toBe(0.5);
    expect(result.get("app")).toBe(DIM);
  });

  it("강조하는 경로가 있으면 흐름을 보지 않고 경로 위 노드와 그 조상 상자를 1, 그 밖을 흐린 단계로 둔다", () => {
    const none = hidden(routeFixture, { showTests: false, showExternal: false });
    const path = lit(route(routeFixture, "flow.build:make", "flow.sink:tune", none), 0)!;
    const result = opacities(routeFixture, flow(routeFixture, "flow.walk:begin", 2, none), path);
    for (const id of ["flow.build:make", "flow.build:Engine", "flow.build:Engine.__init__", "flow.sink:tune", "flow.build", "flow.sink", "flow"]) {
      expect(result.get(id)).toBe(1);
    }
    for (const id of ["flow.build:Base", "flow.build:Base.run", "flow.walk", "flow.walk:begin", "flow.walk:left", "ring", "ring.a"]) {
      expect(result.get(id)).toBe(DIM);
    }
  });
});

describe("변수 노드의 흐름", () => {
  const none = hidden(variableFixture, { showTests: false, showExternal: false });

  it("변수를 고르면 흐름의 단위가 노드이고 값 안의 생성 선을 나가는 방향으로, 읽는 함수를 들어오는 쪽으로 센다", () => {
    const picked = flow(variableFixture, "conf:PRESETS", 2, none);
    expect(picked.unit).toBe("node");
    expect(picked.file).toBe("conf");
    expect([...picked.out]).toEqual([["conf:Preset", 1]]);
    expect([...picked.incoming]).toEqual(["app:run"]);
  });

  it("함수를 고르면 읽고 바꾸는 변수가 나가는 흐름에 들고 숨긴 외부 값 변수는 들지 않는다", () => {
    const out = flow(variableFixture, "conf:clamp", 2, none).out;
    expect(out.get("conf:LIMIT")).toBe(1);
    expect(out.get("conf:_cache")).toBe(1);
    expect(out.has("conf:logger")).toBe(false);
    const shownExternal = hidden(variableFixture, { showTests: false, showExternal: true });
    expect(flow(variableFixture, "conf:clamp", 2, shownExternal).out.get("conf:logger")).toBe(1);
  });
});
