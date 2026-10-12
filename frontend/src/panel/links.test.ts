import { describe, expect, it } from "vitest";
import { repoFixture } from "../graph/fixture";
import { hidden, nodeIndex } from "../graph/visible";
import { COUNTED_KINDS } from "../graph/names";
import { contentsOf, followedOf, linksOf, linksText, pathOf, relationText, restText, sizeText } from "./links";

const nodes = nodeIndex(repoFixture);
const off = hidden(repoFixture, { showTests: false, showExternal: false });
const sites = (list: { sites: unknown[] }[]) => list.reduce((sum, item) => sum + item.sites.length, 0);
const counted = <E extends { kind: (typeof COUNTED_KINDS)[number] | string }>(edges: E[], yes = true) => edges.filter((e) => COUNTED_KINDS.includes(e.kind as never) === yes);

describe("linksOf", () => {
  it("함수는 자기에게 닿는 선의 코드 줄을 세는 관계와 그 밖의 관계로 나눠 종류마다 세고 상대 노드마다 묶는다", () => {
    const { out, into } = linksOf(repoFixture, nodes, off, "main:helper");
    const incoming = repoFixture.edges.filter((e) => e.target === "main:helper" && !off.has(e.source));
    const none = { total: 0, kinds: {}, groups: [] };
    expect(out).toEqual({ counted: none, rest: none });
    expect(into.counted.total).toBe(sites(counted(incoming)));
    expect(into.rest.total).toBe(sites(counted(incoming, false)));
    expect(sites(into.counted.groups)).toBe(into.counted.total);
    expect(into.counted.groups).toHaveLength(new Set(counted(incoming).map((e) => e.source)).size);
  });

  it("파일 상자는 경계를 넘는 선만 세고 상대 노드가 든 파일 상자마다 묶는다", () => {
    const { out, into } = linksOf(repoFixture, nodes, off, "main");
    const crossing = (from: boolean) =>
      repoFixture.edges.filter((e) => !off.has(e.source) && !off.has(e.target) && e.source.split(":")[0] !== e.target.split(":")[0] && (from ? e.source : e.target).split(":")[0] === "main");
    expect(out.counted.total).toBe(sites(counted(crossing(true))));
    expect(out.rest.total).toBe(sites(counted(crossing(true), false)));
    expect(out.rest.total).toBeGreaterThan(0);
    expect(into.counted.total + into.rest.total).toBe(sites(crossing(false)));
    const files = (edges: typeof repoFixture.edges) => [...new Set(edges.map((e) => nodes.get(e.target.split(":")[0])!.path!.split("/").pop()))].sort();
    expect(out.counted.groups.map((group) => group.name).sort()).toEqual(files(counted(crossing(true))));
    expect(out.rest.groups.map((group) => group.name).sort()).toEqual(files(counted(crossing(true), false)));
  });

  it("토글로 숨긴 노드와의 선은 세지 않는다", () => {
    const user = repoFixture.edges.find((e) => e.target === "ext:json")!.source;
    const shownAll = hidden(repoFixture, { showTests: false, showExternal: true });
    const total = ({ counted: a, rest: b }: ReturnType<typeof linksOf>["out"]) => a.total + b.total;
    expect(total(linksOf(repoFixture, nodes, shownAll, user).out) - total(linksOf(repoFixture, nodes, off, user).out)).toBe(
      sites(repoFixture.edges.filter((e) => e.source === user && e.target === "ext:json")),
    );
  });
});

describe("followedOf", () => {
  it("집계 선 키가 가리키는 선을 모아 출발 노드와 도착 노드, 종류마다의 수를 낸다", () => {
    const found = followedOf(repoFixture, nodes, off, ["agg|main|pkg"])!;
    const edges = repoFixture.edges.filter((e) => e.source.split(":")[0] === "main" && e.target.startsWith("pkg."));
    expect(found.sources).toEqual(["main"]);
    expect(found.target).toBe("pkg");
    expect(found.links.total).toBe(sites(edges));
    expect(found.links.groups).toHaveLength(1);
  });

  it("도착 노드가 같은 선 여러 개는 출발 노드마다 묶고, 그래프에 없는 키는 null이다", () => {
    const into = repoFixture.edges.filter((e) => e.target === "main:helper" && !off.has(e.source));
    const found = followedOf(repoFixture, nodes, off, into.map((e) => `${e.source}|${e.target}|${e.kind}`))!;
    expect(found.sources).toEqual([...new Set(into.map((e) => e.source))]);
    expect(found.links.groups).toHaveLength(found.sources.length);
    expect(followedOf(repoFixture, nodes, off, ["없는|선|call"])).toBeNull();
  });
});

describe("contentsOf", () => {
  it("파일은 함수와 클래스, 클래스는 메서드, 폴더는 파일을 세고 없는 것은 뺀다", () => {
    const text = (id: string) => contentsOf(repoFixture, nodes, off, nodes.get(id)!).map(({ name, count }) => `${name} ${count}`);
    expect(text("pkg.mod")).toEqual(["함수 1", "클래스 2"]);
    expect(text("pkg.mod:Store")).toEqual(["메서드 2"]);
    expect(text("pkg")).toEqual(["파일 2"]);
    expect(text("main")).toEqual(["함수 2"]);
    expect(text("main:run")).toEqual([]);
  });
});

describe("글", () => {
  it("연결 합계는 세는 관계만 `곳`으로 적고, 종류가 하나면 종류와 수를, 여럿이면 합과 종류마다의 수를 적는다", () => {
    expect(linksText({ call: 2 })).toBe("호출 2곳");
    expect(linksText({ import: 3, call: 10, construct: 3 })).toBe("13곳 (호출 10곳, 생성 3곳)");
    expect(linksText({ type: 4, call: 10, pass: 2, decorate: 1 })).toBe("13곳 (호출 10곳, 전달 2곳, 데코레이터 1곳)");
    expect(linksText({ import: 3, type: 1 })).toBe("없음");
    expect(linksText({})).toBe("없음");
  });

  it("그 밖 묶음은 세지 않는 관계를 종류마다 적고 없으면 null이다", () => {
    expect(restText({ call: 9, pass: 1, import: 3, type: 2 })).toBe("그 밖 import 3줄, 타입 2곳");
    expect(restText({ call: 9 })).toBeNull();
  });

  it("선 하나의 관계는 말풍선과 같은 글이고 세는 관계와 함께 있는 그 밖의 관계를 덧붙인다", () => {
    expect(relationText({ call: 2, import: 1 })).toBe("호출 2곳 · 그 밖 import 1줄");
    expect(relationText({ call: 2, construct: 1 })).toBe("호출 2곳 · 생성 1곳");
    expect(relationText({ type: 2, import: 1 })).toBe("타입에만 쓰임");
    expect(relationText({ import: 1 })).toBe("import 관계만 있음");
  });

  it("정의는 줄 수와 줄 범위를, 파일과 폴더는 줄 수만 적고 외부 노드는 적지 않는다", () => {
    expect(sizeText(nodes.get("main:run")!)).toBe("9줄 (5~15)");
    expect(sizeText(nodes.get("main")!)).toBe("40줄");
    expect(sizeText(nodes.get("ext:json")!)).toBeNull();
  });

  it("이름 줄은 정의를 `파일 경로::이름`으로, 파일과 폴더를 앞쪽 경로와 이름으로 나눈다", () => {
    expect(pathOf(nodes, nodes.get("pkg.mod:Store.save")!)).toEqual({ path: "pkg/mod.py::", name: "Store.save()" });
    expect(pathOf(nodes, nodes.get("pkg.mod")!)).toEqual({ path: "pkg/", name: "mod.py" });
    expect(pathOf(nodes, nodes.get("main")!)).toEqual({ path: "", name: "main.py" });
    expect(pathOf(nodes, nodes.get("pkg")!)).toEqual({ path: "", name: "pkg/" });
    expect(pathOf(nodes, nodes.get("ext:json")!)).toEqual({ path: "", name: "json" });
  });
});
