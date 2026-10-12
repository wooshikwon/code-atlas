// 정보 패널의 분석 표시 요약. 분석 표시를 켜고 아무것도 고르지 않았을 때 레포 머리 줄 아래에 그 분석 표시의 결과 목록을 보인다.
// 미사용 후보 표시는 후보를 파일별로 묶어 이름과 줄 수를, 순환 의존 표시는 묶음마다 든 파일을, 시점 비교는 바뀐 정의를 파일별로 묶어 이름과
// 추가되고 삭제된 줄 수를 적는다. 행을 누르면 그 노드를 고른다.
import { useMemo, type ReactNode } from "react";
import { WORKTREE, type AtlasNode } from "../api/types";
import { callLabel } from "../graph/calls";
import { gone, inSource } from "../graph/compare";
import { KIND_NAMES } from "../graph/names";
import { hidden, unitOf } from "../graph/visible";
import { useCompare } from "../state/compare";
import { useCycles } from "../state/cycles";
import { useOverlay } from "../state/overlay";
import { useAtlas } from "../state/store";
import { LineCounts } from "../tree/TreeNode";

/** 줄 수 뒤에 종류를 적는 정의. 함수와 메서드는 이름의 `()`로 구분된다. */
const NAMED_KINDS = new Set<AtlasNode["kind"]>(["class", "dataclass"]);
/** 변경 목록에 정의로 적지 않는 종류. 파일은 묶음 머리가 적는다. */
const UNLISTED = new Set<AtlasNode["kind"]>(["module", "package", "external"]);

/** dim이면 흐린 단계로 그린다. */
function Row({ node, name, aside, dim = false }: { node: string; name: string; aside: ReactNode; dim?: boolean }) {
  const show = useAtlas((s) => s.show);
  return (
    <button className="overview-row" data-node={node} data-gone={dim ? "" : undefined} onClick={() => show(node)}>
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
        들어오는 실행·사용 선이 없는 함수·메서드·클래스입니다. 이름을 문자열로 부르는 동적 호출은 선으로 그리지 못하므로 실제로는 쓰일 수 있습니다.
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
    return <p className="overview-count">순환 묶음이 없습니다</p>;
  }
  return (
    <>
      <p className="overview-count">순환 묶음 {groups.length}개</p>
      <p className="overview-hint">묶음에 든 파일은 import를 따라가면 자기에게 돌아옵니다. 함수 안에서 하는 import는 세지 않습니다.</p>
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

/** 변경 목록에 적는 시점의 이름. 커밋은 해시의 앞 7자다. */
const pointName = (id: string) => (id === WORKTREE ? "작업 중인 상태" : id.slice(0, 7));

function Compared({ nodes }: { nodes: Map<string, AtlasNode> }) {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const result = useCompare((s) => s.result);

  /** 바뀐 파일마다 그 안의 바뀐 정의. 파일은 비교 결과의 순서, 정의는 소스 정의 순서다. 테스트 코드를 숨기면 그 파일을 뺀다. */
  const files = useMemo(() => {
    if (graph === null || result === null) {
      return [];
    }
    const off = hidden(graph, { showTests, showExternal });
    const inner = new Map<string, AtlasNode[]>();
    const units = new Map<string, string>();
    for (const node of graph.nodes) {
      if (node.kind === "module" && node.path !== null) {
        units.set(node.path, node.id);
      }
      if (result.nodes[node.id]?.change != null && !UNLISTED.has(node.kind) && !off.has(node.id)) {
        const file = unitOf(nodes, node.id);
        inner.set(file, [...(inner.get(file) ?? []), node]);
      }
    }
    return result.files
      .filter((file) => showTests || !file.test)
      .map((file) => ({ file, list: inSource(inner.get(units.get(file.path) ?? "") ?? [], result.nodes) }));
  }, [graph, nodes, result, showTests, showExternal]);
  if (result === null) {
    return null;
  }
  const off = gone(result).nodes;
  const count = files.reduce((sum, { list }) => sum + list.length, 0);

  return (
    <>
      <p className="overview-count">
        바뀐 정의 {count}개 · 파일 {files.length}개
      </p>
      <p className="overview-hint">
        기준 {pointName(result.base)} · 대상 {pointName(result.target)}
      </p>
      {files.map(({ file, list }) => (
        <section key={file.path}>
          <h4 className="overview-file" data-gone={file.status === "deleted" ? "" : undefined}>
            <span className="overview-path">{file.path}</span>
            {file.old !== null && <span className="overview-from">← {file.old}</span>}
            <LineCounts lines={file} />
          </h4>
          {list.map((node) => (
            <Row key={node.id} node={node.id} name={callLabel(nodes, node)} aside={<LineCounts lines={result.nodes[node.id]} />} dim={off.has(node.id)} />
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
  return <div className="overview">{kind === "unused" ? <Unused nodes={nodes} /> : kind === "cycles" ? <Cycles nodes={nodes} /> : <Compared nodes={nodes} />}</div>;
}
