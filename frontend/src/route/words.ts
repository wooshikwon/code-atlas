// 경로 탐색 창에 적는 글. 찾은 경로와 노드에서 숫자 버튼의 말풍선, 단계 목록의 행, 경로 없음 문구를 만든다.
import type { AtlasNode } from "../api/types";
import { nameOf } from "../graph/names";
import type { Path, Route, StepKind } from "../graph/route";
import { within } from "../graph/visible";

/** 이음으로 넘어온 단계의 이름 앞에 적는 글자 */
const STEP_MARKS: Partial<Record<StepKind, string>> = { init: "생성자", overridden: "오버라이드" };

export interface StepRow {
  id: string;
  name: string;
  /** 노드가 든 파일의 이름 */
  file: string;
  /** 이음으로 넘어온 단계면 `생성자`나 `오버라이드`, 아니면 null */
  mark: string | null;
}

/** 노드가 든 파일의 이름. 경로가 없는 노드는 빈 문자열이다. */
export function fileOf(node: AtlasNode): string {
  return node.path?.split("/").pop() ?? "";
}

/** 경로의 단계 수. 걸음 하나가 한 단계다. */
export function stepCount(path: Path): number {
  return path.length - 1;
}

/** 숫자 버튼의 말풍선. 단계 수와 경로가 거치는 파일 수를 적는다. */
export function pickTip(path: Path, nodes: Map<string, AtlasNode>): string {
  const files = new Set(path.map((id) => nodes.get(id)?.path));
  return `${stepCount(path)}단계 · 파일 ${files.size}개`;
}

/** 단계 목록의 행. 경로의 노드 순서 그대로다. */
export function stepRows(route: Route, path: Path, nodes: Map<string, AtlasNode>): StepRow[] {
  return path.map((id, index) => {
    const node = nodes.get(id);
    const kind = index === 0 ? undefined : route.kinds.get(`${path[index - 1]}|${id}`);
    return {
      id,
      name: node === undefined ? id : nameOf(nodes, node),
      file: node === undefined ? "" : fileOf(node),
      mark: (kind === undefined ? undefined : STEP_MARKS[kind]) ?? null,
    };
  });
}

/**
 * 경로가 없을 때 적는 문구. 줄마다 원소 하나다. 출발과 도착이 같거나 한쪽이 다른 쪽을 품으면 한 줄만 낸다.
 * 그 밖에는 첫 줄 아래에 출발에서 닿는 함수 수와 그 안의 미확인 호출 수를 적고, 반대 방향에 경로가 있으면 한 줄을 덧붙인다.
 */
export function emptyText(route: Route, nodes: Map<string, AtlasNode>): string[] {
  if (within(nodes, route.from, route.to) || within(nodes, route.to, route.from)) {
    return ["출발과 도착이 같은 곳입니다"];
  }
  return [
    "실행 선으로 이어지는 경로가 없습니다",
    route.unresolved === 0
      ? `출발에서 닿는 함수는 ${route.reach}개이고 그 안에 대상을 확인하지 못한 호출(?)은 없습니다`
      : `출발에서 닿는 함수 ${route.reach}개 안에 대상을 확인하지 못한 호출(?)이 ${route.unresolved}곳 있습니다. 그 호출을 거쳐 실제로는 닿을 수 있습니다`,
    ...(route.reverse ? ["반대 방향에는 경로가 있습니다"] : []),
  ];
}
