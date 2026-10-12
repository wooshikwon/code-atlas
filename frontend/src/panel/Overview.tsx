// 정보 패널의 분석 표시 요약. 분석 표시를 켜고 아무것도 고르지 않았을 때 레포 머리 줄 아래에 그 분석 표시의 결과 목록을 보인다.
// 미사용 후보 표시는 후보를 파일별로 묶어 이름과 줄 수를, 순환 의존 표시는 묶음마다 든 파일을 적는다. 행을 누르면 그 노드를 고른다.
import { useMemo } from "react";
import type { AtlasNode } from "../api/types";
import { callLabel } from "../graph/calls";
import { KIND_NAMES } from "../graph/names";
import { hidden, unitOf } from "../graph/visible";
import { useCycles } from "../state/cycles";
import { useOverlay } from "../state/overlay";
import { useAtlas } from "../state/store";

/** 줄 수 뒤에 종류를 적는 정의. 함수와 메서드는 이름의 `()`로 구분된다. */
const NAMED_KINDS = new Set<AtlasNode["kind"]>(["class", "dataclass"]);

function Row({ node, name, aside }: { node: string; name: string; aside: string | null }) {
  const show = useAtlas((s) => s.show);
  return (
    <button className="overview-row" data-node={node} onClick={() => show(node)}>
      <span className="overview-name">{name}</span>
      {aside !== null && <span className="overview-aside">{aside}</span>}
    </button>
  );
}

function Unused({ nodes }: { nodes: Map<string, AtlasNode> }) {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const unused = useOverlay((s) => s.unused);
  const definitions = useOverlay((s) => s.definitions);

  /** 파일마다 그 안의 후보. `/api/unused`가 준 순서(파일 경로, 시작 줄)를 따른다. */
  const files = useMemo(() => {
    const off = graph === null ? new Set<string>() : hidden(graph, { showTests, showExternal });
    const found = new Map<string, AtlasNode[]>();
    for (const id of unused) {
      const node = nodes.get(id);
      if (node !== undefined && !off.has(id)) {
        const file = unitOf(nodes, id);
        found.set(file, [...(found.get(file) ?? []), node]);
      }
    }
    return [...found];
  }, [graph, nodes, unused, showTests, showExternal]);
  const count = files.reduce((sum, [, list]) => sum + list.length, 0);

  return (
    <>
      <p className="overview-count">
        미사용 후보 {count}개 · 정의 {definitions}개 가운데
      </p>
      <p className="overview-hint">
        들어오는 실행·사용 선이 없는 함수·메서드·클래스다. 이름을 문자열로 부르는 동적 호출은 선으로 그리지 못하므로 실제로는 쓰일 수 있다.
      </p>
      {files.map(([file, list]) => (
        <section key={file}>
          <h4 className="overview-file">{nodes.get(file)?.path ?? file}</h4>
          {list.map((node) => (
            <Row
              key={node.id}
              node={node.id}
              name={callLabel(nodes, node)}
              aside={NAMED_KINDS.has(node.kind) ? `${node.loc}줄 · ${KIND_NAMES[node.kind]}` : `${node.loc}줄`}
            />
          ))}
        </section>
      ))}
    </>
  );
}

function Cycles({ nodes }: { nodes: Map<string, AtlasNode> }) {
  const groups = useCycles()?.groups ?? [];
  if (groups.length === 0) {
    return <p className="overview-count">순환 묶음이 없다</p>;
  }
  return (
    <>
      <p className="overview-count">순환 묶음 {groups.length}개</p>
      <p className="overview-hint">묶음에 든 파일은 import를 따라가면 자기에게 돌아온다. 함수 안에서 하는 import는 세지 않는다.</p>
      {groups.map((group, i) => (
        <section key={group[0]}>
          <h4 className="overview-file">
            묶음 {i + 1} · 파일 {group.length}개
          </h4>
          {group.map((id) => (
            <Row key={id} node={id} name={nodes.get(id)?.path ?? id} aside={null} />
          ))}
        </section>
      ))}
    </>
  );
}

export function Overview({ nodes }: { nodes: Map<string, AtlasNode> }) {
  const kind = useOverlay((s) => s.kind);
  if (kind === null) {
    return null;
  }
  return <div className="overview">{kind === "unused" ? <Unused nodes={nodes} /> : <Cycles nodes={nodes} />}</div>;
}
