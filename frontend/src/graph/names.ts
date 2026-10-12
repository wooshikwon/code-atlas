// 노드 종류와 선 분류·종류를 화면에 적는 이름과, 수로 세는 관계의 종류, 선에 든 관계를 종류와 수로 적는 글. 그래프의 말풍선·범례와 정보 패널이 함께 쓴다.
import type { AtlasNode, EdgeGroup, EdgeKind } from "../api/types";
import type { StepKind } from "./route";

export const KIND_NAMES: Record<AtlasNode["kind"], string> = {
  package: "폴더",
  module: "파일",
  class: "클래스",
  dataclass: "데이터 클래스",
  function: "함수",
  method: "메서드",
  variable: "변수",
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
  read: "읽음",
  write: "바꿈",
  decorate: "데코레이터",
  type: "타입",
  inherit: "상속",
  override: "오버라이드",
};

/** 선 분류에 드는 선 종류. 범례가 분류 이름의 말풍선에 적는다. */
export const GROUP_KINDS: Record<EdgeGroup, EdgeKind[]> = {
  run: ["call", "construct"],
  use: ["import", "pass", "read", "write", "decorate", "type"],
  derive: ["inherit", "override"],
};

/** 선 종류 하나와 그 관계가 코드에 적힌 수: `호출 2곳`, `import 1줄`. import는 import 문의 줄을, 그 밖의 종류는 코드의 지점을 센다. */
export function relationOf(kind: EdgeKind, count: number): string {
  return `${EDGE_KIND_NAMES[kind]} ${count}${kind === "import" ? "줄" : "곳"}`;
}

/**
 * 수로 세는 관계의 종류. 실행할 때 그 코드가 실제로 도는 관계(호출, 생성, 전달, 읽음, 바꿈, 데코레이터, 상속, 오버라이드)다.
 * 선의 말풍선, 선 위의 수와 도착 노드 앞의 합계, 정보 패널의 연결 합계가 이 종류만 센다. 이름만 쓰는 관계(타입, import)는
 * 선으로 그리고 정보 패널의 `그 밖` 묶음과 코드 줄 목록에 남긴다.
 */
export const COUNTED_KINDS: EdgeKind[] = ["call", "construct", "pass", "read", "write", "decorate", "inherit", "override"];

/** 세는 관계가 없는 선에 수 대신 적는 글. 타입과 import가 함께 있으면 타입의 글을 쓴다. */
const ALONE: [EdgeKind, string][] = [
  ["type", "타입에만 쓰임"],
  ["import", "import 관계만 있음"],
];

type Kinds = Partial<Record<EdgeKind, number>>;

/** 종류마다의 수 kinds 가운데 `EDGE_KIND_NAMES`의 순서로 고른 종류. counted가 참이면 세는 관계, 거짓이면 그 밖의 관계다. */
export function kindsOf(kinds: Kinds, counted: boolean): EdgeKind[] {
  return (Object.keys(EDGE_KIND_NAMES) as EdgeKind[]).filter((kind) => kinds[kind] !== undefined && COUNTED_KINDS.includes(kind) === counted);
}

/** 종류마다의 수 kinds 가운데 세는 관계의 수 합 */
export function countedOf(kinds: Kinds): number {
  return kindsOf(kinds, true).reduce((sum, kind) => sum + kinds[kind]!, 0);
}

/**
 * 선에 든 관계를 적은 글. 세는 관계가 있으면 그 종류만 수와 함께 적고(`호출 5곳 · 생성 2곳`), 없으면 수 없이 `타입에만 쓰임`이나
 * `import 관계만 있음`으로 적는다. kinds는 종류마다의 수다.
 */
export function relationsOf(kinds: Kinds): string {
  const counted = kindsOf(kinds, true);
  if (counted.length > 0) {
    return counted.map((kind) => relationOf(kind, kinds[kind]!)).join(" · ");
  }
  return ALONE.find(([kind]) => kinds[kind] !== undefined)?.[1] ?? "";
}

/** 변수 노드의 값의 종류와 원소 수: `dict · 9개`, `str`. 변수 노드가 아니면 빈 글이다. */
export function valueAside(node: AtlasNode): string {
  if (node.value === null) {
    return "";
  }
  return node.value.size === null ? node.value.kind : `${node.value.kind} · ${node.value.size}개`;
}

/** 노드를 그 노드 하나로 가리킬 때 적는 이름. 파일은 파일 이름, 폴더는 `이름/`, 메서드는 `클래스.메서드()`, 변수는 괄호 없는 이름이다. */
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
