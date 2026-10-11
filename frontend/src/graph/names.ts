// 노드 종류와 선 분류·종류를 화면에 적는 이름. 그래프의 말풍선·범례와 정보 패널이 함께 쓴다.
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
