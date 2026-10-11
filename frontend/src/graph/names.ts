// 노드 종류와 선 분류·종류를 화면에 적는 이름과, 선에 든 관계를 종류와 수로 적는 글. 그래프의 말풍선·범례와 정보 패널이 함께 쓴다.
import type { AtlasNode, EdgeGroup, EdgeKind } from "../api/types";
import type { StepKind } from "./route";

export const KIND_NAMES: Record<AtlasNode["kind"], string> = {
  package: "폴더",
  module: "파일",
  class: "클래스",
  dataclass: "데이터 클래스",
  function: "함수",
  method: "메서드",
  external: "외부",
};

export const GROUP_NAMES: Record<EdgeGroup, string> = { run: "실행", use: "사용", derive: "계승" };

/** 경로의 걸음 종류. 생성자 이음과 오버라이드 이음은 실행 선이 없는 걸음이다. */
export const STEP_NAMES: Record<StepKind, string> = {
  call: "호출",
  construct: "생성",
  init: "생성자 이음",
  overridden: "오버라이드 이음",
};

export const EDGE_KIND_NAMES: Record<EdgeKind, string> = {
  call: "호출",
  construct: "생성",
  import: "import",
  pass: "전달",
  decorate: "데코레이터",
  type: "타입",
  inherit: "상속",
  override: "오버라이드",
};

/** 선 분류에 드는 선 종류. 범례가 분류 이름의 말풍선에 적는다. */
export const GROUP_KINDS: Record<EdgeGroup, EdgeKind[]> = {
  run: ["call", "construct"],
  use: ["import", "pass", "decorate", "type"],
  derive: ["inherit", "override"],
};

/** 선 종류 하나와 그 관계가 코드에 적힌 수: `호출 2곳`, `import 1줄`. import는 import 문의 줄을, 그 밖의 종류는 코드의 지점을 센다. */
export function relationOf(kind: EdgeKind, count: number): string {
  return `${EDGE_KIND_NAMES[kind]} ${count}${kind === "import" ? "줄" : "곳"}`;
}

/** 선에 든 관계를 종류마다 나눠 적은 글: `호출 2곳 · import 1줄`. kinds는 종류마다의 수이고 `EDGE_KIND_NAMES`의 순서로 적는다. */
export function relationsOf(kinds: Partial<Record<EdgeKind, number>>): string {
  return (Object.keys(EDGE_KIND_NAMES) as EdgeKind[])
    .filter((kind) => kinds[kind] !== undefined)
    .map((kind) => relationOf(kind, kinds[kind]!))
    .join(" · ");
}

/** 노드를 그 노드 하나로 가리킬 때 적는 이름. 파일은 파일 이름, 폴더는 `이름/`, 메서드는 `클래스.메서드()`다. */
export function nameOf(nodes: Map<string, AtlasNode>, node: AtlasNode): string {
  switch (node.kind) {
    case "module":
      return node.path?.split("/").pop() ?? node.name;
    case "package":
      return `${node.name}/`;
    case "method": {
      const owner = node.parent === null ? undefined : nodes.get(node.parent);
      return owner === undefined ? `${node.name}()` : `${owner.name}.${node.name}()`;
    }
    case "function":
      return `${node.name}()`;
    default:
      return node.name;
  }
}
