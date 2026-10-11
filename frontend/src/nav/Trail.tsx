// 상단 줄의 탐색 경로 표시. 고른 노드(함수 시점 뷰에서는 가운데 함수)까지의 폴더·파일·클래스·함수를 단계로 그린다.
// 줄 폭이 모자라면 앞 단계부터 `…`로 줄이고 마지막 단계는 늘 남긴다. 상단 줄을 줄이는 단계(`fit.ts`)는 이 폭을 보지 않는다.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AtlasNode } from "../api/types";
import { labelOf, titleOf } from "../graph/layout";
import { nodeIndex } from "../graph/visible";
import { useAtlas } from "../state/store";
import type { Fit } from "./fit";

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

export function Trail({ fit }: { fit: Fit }) {
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
  /** 소스 루트 폴더 이름과 단계의 이름. 화면에 그리는 순서다. */
  const names = [...(rooted ? [source] : []), ...steps.map(stepName)];

  const nav = useRef<HTMLElement | null>(null);
  const path = `${names.join("/")}|${view.kind}|${fit}`;
  /** 앞에서부터 `…`로 줄인 이름 수. 경로, 상단 줄의 단계, 탐색 경로가 든 줄의 폭이 바뀌면 0에서 다시 센다. */
  const [cut, setCut] = useState({ path, count: 0 });
  const hidden = cut.path === path ? cut.count : 0;

  // 마지막 단계의 글자가 잘리면 앞의 이름을 하나 더 줄인다.
  useLayoutEffect(() => {
    const last = nav.current?.querySelector<HTMLElement>(".trail-last");
    if (last != null && last.scrollWidth > last.clientWidth && hidden < names.length - 1) {
      setCut({ path, count: hidden + 1 });
    }
  });
  useEffect(() => {
    const bar = nav.current?.parentElement;
    if (bar == null) {
      return;
    }
    const observer = new ResizeObserver(() => setCut((prev) => ({ path: prev.path, count: 0 })));
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const offset = rooted ? 1 : 0;
  return (
    <nav className="toolbar-trail" aria-label="탐색 경로" ref={nav}>
      {hidden > 0 && (
        <span className="trail-cut" title={names.slice(0, hidden).join(" > ")}>
          …
        </span>
      )}
      {rooted && hidden === 0 && <span className="trail-root">{source}</span>}
      {steps.map(
        (node, index) =>
          index + offset >= hidden && (
            <Fragment key={node.id}>
              {index + offset > 0 && (
                <span className="trail-gap" aria-hidden>
                  &gt;
                </span>
              )}
              <button
                className={index === steps.length - 1 ? "trail-step trail-last" : "trail-step"}
                data-node={node.id}
                title={titleOf(node)}
                onClick={() => show(node.id)}
              >
                {stepName(node)}
              </button>
            </Fragment>
          ),
      )}
      {view.kind === "function" && <span className="trail-view">함수 시점</span>}
    </nav>
  );
}
