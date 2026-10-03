import { useMemo } from "react";
import type { AtlasNode, TreeEntry } from "../api/types";
import { useAtlas } from "../state/AtlasProvider";
import { TreeNode, type TreeHandlers } from "./TreeNode";

/** 선택한 노드를 품은 모듈 노드 id. 모듈 밖 노드(폴더 패키지, 외부)면 null이다. */
function moduleOf(id: string | null, nodes: Map<string, AtlasNode>): string | null {
  let node = id === null ? undefined : nodes.get(id);
  while (node !== undefined && node.kind !== "module" && node.kind !== "package") {
    node = node.parent === null ? undefined : nodes.get(node.parent);
  }
  return node?.path?.endsWith(".py") ? node.id : null;
}

export function FileTree() {
  const { repo, tree, graph, error, selection, showTests, select } = useAtlas();
  const nodes = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n])), [graph]);
  const activeModule = moduleOf(selection, nodes);

  const handlers: TreeHandlers = {
    showTests,
    isActive: (entry: TreeEntry) => entry.kind === "file" && entry.node !== null && entry.node === activeModule,
    onOpen: (entry: TreeEntry) => entry.node !== null && select(entry.node),
  };
  const entries = tree?.entries.filter((entry) => showTests || !entry.test) ?? [];

  return (
    <div className="explorer">
      <div className="explorer-header">{repo?.name ?? "code-atlas"}</div>
      <div className="explorer-body">
        {error !== null && <div className="explorer-error">{error}</div>}
        {error === null && tree === null && <div className="explorer-empty">불러오는 중</div>}
        <ul role="tree">
          {entries.map((entry) => (
            <TreeNode key={entry.path} entry={entry} depth={0} handlers={handlers} />
          ))}
        </ul>
      </div>
    </div>
  );
}
