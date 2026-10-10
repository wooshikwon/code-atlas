// 상단 줄의 탐색 경로 표시. 고른 노드(함수 시점 뷰에서는 가운데 함수)까지의 폴더·파일·클래스·함수를 단계로 그린다.
import { Fragment, useMemo } from "react";
import type { AtlasNode } from "../api/types";
import { labelOf, titleOf } from "../graph/layout";
import { nodeIndex } from "../graph/visible";
import { useAtlas } from "../state/store";

/** 한 단계의 이름. 폴더와 파일은 경로의 마지막 마디만 적는다. */
function stepName(node: AtlasNode): string {
  switch (node.kind) {
    case "package":
      return node.name;
    case "module":
      return `${node.name}.py`;
    default:
      return labelOf(node);
  }
}

export function Trail() {
  const repo = useAtlas((s) => s.repo);
  const graph = useAtlas((s) => s.graph);
  const view = useAtlas((s) => s.view);
  const selection = useAtlas((s) => s.selection);
  const show = useAtlas((s) => s.show);
  const nodes = useMemo(() => (graph === null ? null : nodeIndex(graph)), [graph]);

  const target = view.kind === "function" ? view.center : selection?.type === "node" ? selection.id : null;
  const steps: AtlasNode[] = [];
  for (let node = target === null ? undefined : nodes?.get(target); node !== undefined; ) {
    steps.unshift(node);
    node = node.parent === null ? undefined : nodes?.get(node.parent);
  }
  /** 소스 루트 폴더 이름. 소스 루트 밖의 노드를 골랐거나 소스 루트가 레포 루트이면 적지 않는다. */
  const source = repo?.source_root ?? "";
  const rooted = source !== "" && (steps.length === 0 || steps[0].path?.startsWith(`${source}/`) === true);

  return (
    <nav className="toolbar-trail" aria-label="탐색 경로">
      {rooted && <span className="trail-root">{source}</span>}
      {steps.map((node, index) => (
        <Fragment key={node.id}>
          {(rooted || index > 0) && (
            <span className="trail-gap" aria-hidden>
              &gt;
            </span>
          )}
          <button className="trail-step" data-node={node.id} title={titleOf(node)} onClick={() => show(node.id)}>
            {stepName(node)}
          </button>
        </Fragment>
      ))}
      {view.kind === "function" && <span className="trail-view">함수 시점</span>}
    </nav>
  );
}
