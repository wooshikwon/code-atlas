// 정보 패널 머리 줄. 첫 줄에 이름과 종류 칩을, 둘째 줄에 위치와 수치, 변경 상태를 적는다.
import type { AtlasNode, EdgeGroup, EdgeKind, SiteRef } from "../api/types";
import { EDGE_KIND_NAMES, GROUP_NAMES, KIND_NAMES } from "../graph/names";
import { EntryMark } from "../graph/nodes/common";
import { CHANGE_NAMES, useChange } from "../state/changes";

/** 고른 선. 집계 선이면 kind가 null이고 kinds에 종류마다 지점 수를 담는다. */
export interface PickedEdge {
  source: string;
  target: string;
  group: EdgeGroup;
  kind: EdgeKind | null;
  kinds: Partial<Record<EdgeKind, number>>;
  deferred: boolean;
  sites: SiteRef[];
}

export type HeaderItem =
  | { type: "repo"; name: string }
  | { type: "file"; path: string }
  /**
   * 파일 상자와 폴더 상자의 incoming·outgoing은 화면에 그린 선으로 이어진 상대 상자 수이고 unresolved는 안에 든 노드까지 합친 값이다.
   * 그 밖의 노드는 그 노드에 닿는 선 수와 그 노드의 미확인 호출 수다.
   */
  | { type: "node"; node: AtlasNode; incoming: number; outgoing: number; unresolved: number; functions: number }
  | { type: "edge"; edge: PickedEdge };

interface HeaderProps {
  item: HeaderItem;
  nodes: Map<string, AtlasNode>;
}

function nameOf(nodes: Map<string, AtlasNode>, node: AtlasNode): string {
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

function whereOf(node: AtlasNode): string | null {
  if (node.path === null) {
    return null;
  }
  if (node.kind === "package") {
    return node.path.replace(/__init__\.py$/, "");
  }
  return node.kind === "module" || node.range === null ? node.path : `${node.path}:${node.range[0]}-${node.range[1]}`;
}

export function Header({ item, nodes }: HeaderProps) {
  const change = useChange(item.type === "node" ? item.node.id : null);
  let entry = false;
  let name: string;
  let chip: string;
  let facts: (string | null)[];
  if (item.type === "repo") {
    name = item.name;
    chip = "레포";
    facts = ["파일을 고르면 정보를, 함수를 고르면 코드를 보여 준다"];
  } else if (item.type === "file") {
    name = item.path.split("/").pop()!;
    chip = "파일";
    facts = [item.path];
  } else if (item.type === "node") {
    const { node } = item;
    entry = node.entry;
    name = nameOf(nodes, node);
    chip = [KIND_NAMES[node.kind], node.entry ? "진입점" : null, node.method_kind].filter((s) => s !== null).join(" · ");
    facts = [
      whereOf(node),
      node.kind === "external" ? null : `${node.loc}줄`,
      ...(node.kind === "module"
        ? [`쓰는 파일 ${item.outgoing}`, `이 파일을 쓰는 파일 ${item.incoming}`]
        : node.kind === "package"
          ? [`쓰는 파일 ${item.outgoing}`, `이 폴더를 쓰는 파일 ${item.incoming}`]
          : [`들어오는 선 ${item.incoming}`, `나가는 선 ${item.outgoing}`]),
      node.kind === "module" ? `함수 ${item.functions}개` : null,
      item.unresolved > 0 ? `미확인 호출 ${item.unresolved}` : null,
    ];
  } else {
    const { edge } = item;
    const end = (id: string) => {
      const node = nodes.get(id);
      return node === undefined ? id : nameOf(nodes, node);
    };
    name = `${end(edge.source)} → ${end(edge.target)}`;
    chip = GROUP_NAMES[edge.group];
    facts =
      edge.kind === null
        ? ["집계", ...(Object.entries(edge.kinds) as [EdgeKind, number][]).map(([k, n]) => `${EDGE_KIND_NAMES[k]} ${n}곳`)]
        : [EDGE_KIND_NAMES[edge.kind], edge.deferred ? "함수 안 import" : null, `${edge.sites.length}곳`];
  }
  return (
    <>
      <div className="info-panel-title">
        <b>
          {entry && <EntryMark />}
          {name}
        </b>
        <span className="info-panel-chip">{chip}</span>
      </div>
      <div className="info-panel-facts">
        <span className="info-panel-facts-text">
          {facts.filter((s) => s !== null).join(" · ")}
          {change !== null && " ·"}
        </span>
        {change !== null && (
          <span className="info-panel-change" data-change={change}>
            {CHANGE_NAMES[change]}
          </span>
        )}
      </div>
    </>
  );
}
