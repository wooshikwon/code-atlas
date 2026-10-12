// 정보 패널 머리 줄. 이름 줄에 노드의 경로와 종류 칩, 변경 상태를 적는다. 경로가 길어 넘치면 앞쪽 경로를 줄이고 이름은 끝까지 보인다.
// 시점 비교가 켜져 있으면 변경 상태 대신 두 시점 사이의 `수정`·`추가`·`삭제`와 줄 수를 적는다.
// 경로 탐색 창을 편 동안에는 그 아래에 보이는 노드를 출발 칸이나 도착 칸에 넣는 버튼을 그린다.
import { useMemo } from "react";
import type { AtlasNode, EdgeGroup, NodeChange } from "../api/types";
import { lineTotals } from "../graph/compare";
import { GROUP_NAMES, KIND_NAMES, nameOf } from "../graph/names";
import { EntryMark } from "../graph/nodes/common";
import { Ends } from "../route/Ends";
import { CHANGE_NAMES, useChange } from "../state/changes";
import { useCompare } from "../state/compare";
import { useAtlas } from "../state/store";
import { LineCounts } from "../tree/TreeNode";
import { pathOf } from "./links";

export type HeaderItem =
  | { type: "repo"; name: string }
  | { type: "file"; path: string }
  | { type: "node"; node: AtlasNode }
  /** 고른 선. aggregated는 집계 선인지, deferred는 함수 안 import만 합친 선인지다. */
  | { type: "edge"; source: string; target: string; group: EdgeGroup; aggregated: boolean; deferred: boolean }
  /** 고른 줄기. target으로 들어오는 선이 sources개 노드에서 온다. */
  | { type: "trunk"; target: string; sources: number };

interface HeaderProps {
  item: HeaderItem;
  nodes: Map<string, AtlasNode>;
}

const COMPARED_NAMES: Record<NonNullable<NodeChange["change"]>, string> = { modified: "수정", added: "추가", deleted: "삭제" };

export function Header({ item, nodes }: HeaderProps) {
  const graph = useAtlas((s) => s.graph);
  const result = useCompare((s) => s.result);
  const change = useChange(result === null && item.type === "node" ? item.node.id : null);
  const id = item.type === "node" ? item.node.id : null;
  /** 시점 비교에서 고른 노드의 판정과 줄 수. 파일과 폴더는 판정 없이 줄 수만 있으면 수정으로 적는다. 바뀌지 않았으면 null이다. */
  const compared = useMemo(() => {
    if (graph === null || result === null || id === null) {
      return null;
    }
    const lines = lineTotals(graph, result.files).get(id) ?? result.nodes[id];
    const kind = result.nodes[id]?.change ?? (lines !== undefined && lines.added + lines.deleted > 0 ? "modified" : null);
    return kind === null || lines === undefined ? null : { kind, lines };
  }, [graph, result, id]);
  const named = (id: string) => {
    const node = nodes.get(id);
    return node === undefined ? id : nameOf(nodes, node);
  };
  let entry: AtlasNode | null = null;
  let path = "";
  let name: string;
  let chips: (string | null)[];
  if (item.type === "repo") {
    name = item.name;
    chips = ["레포"];
  } else if (item.type === "file") {
    const at = item.path.lastIndexOf("/") + 1;
    path = item.path.slice(0, at);
    name = item.path.slice(at);
    chips = ["파일"];
  } else if (item.type === "node") {
    const { node } = item;
    entry = node.entry ? node : null;
    ({ path, name } = pathOf(nodes, node));
    chips = [KIND_NAMES[node.kind], node.entry ? "진입점" : null, node.method_kind];
  } else if (item.type === "trunk") {
    name = `노드 ${item.sources}개 → ${named(item.target)}`;
    chips = ["합류"];
  } else {
    name = `${named(item.source)} → ${named(item.target)}`;
    chips = [GROUP_NAMES[item.group], item.aggregated ? "집계" : null, item.deferred ? "함수 안 import" : null];
  }
  return (
    <>
      <div className="info-panel-title">
        <b className="info-panel-name" data-full={path + name}>
          {entry !== null && <EntryMark node={entry} />}
          {path !== "" && (
            <span className="info-panel-path">
              <bdi>{path}</bdi>
            </span>
          )}
          <span className="info-panel-own">{name}</span>
        </b>
        {chips
          .filter((chip) => chip !== null)
          .map((chip) => (
            <span key={chip} className="info-panel-chip">
              {chip}
            </span>
          ))}
        {change !== null && (
          <span className="info-panel-change" data-change={change}>
            {CHANGE_NAMES[change]}
          </span>
        )}
        {compared !== null && (
          <span className="info-panel-compared" data-compared={compared.kind}>
            {COMPARED_NAMES[compared.kind]}
            <LineCounts lines={compared.lines} />
          </span>
        )}
      </div>
      {item.type === "repo" && <div className="info-panel-hint">파일을 고르면 정보를, 함수를 고르면 코드를 보여 준다</div>}
      {item.type === "node" && <Ends node={item.node} />}
    </>
  );
}
