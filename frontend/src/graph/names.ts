// 노드 종류와 선 분류·종류를 화면에 적는 이름. 그래프의 말풍선·범례와 정보 패널이 함께 쓴다.
import type { AtlasNode, EdgeGroup, EdgeKind } from "../api/types";

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
