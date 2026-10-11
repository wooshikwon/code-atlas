// 상단 줄의 진입점 목록. 누르면 진입점 노드 이름이 펼쳐지고, 이름을 고르면 구조 뷰에서 그 노드를 고른다.
import { useMemo, useRef, useState } from "react";
import { titleOf } from "../graph/layout";
import { hidden } from "../graph/visible";
import { useAtlas } from "../state/store";
import { useDismiss } from "./menu";

export function Entries() {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const show = useAtlas((s) => s.show);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  const entries = useMemo(() => {
    if (graph === null) {
      return [];
    }
    const off = hidden(graph, { showTests, showExternal });
    return graph.nodes.filter((n) => n.entry && !off.has(n.id));
  }, [graph, showTests, showExternal]);

  useDismiss(open, root, setOpen);

  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="toolbar-entries" ref={root}>
      <button
        className="toolbar-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="toolbar-entries"
        onClick={() => setOpen(!open)}
      >
        진입점 {entries.length}
      </button>
      {open && (
        <ul className="toolbar-menu" id="toolbar-entries" role="menu">
          {entries.map((node) => (
            <li key={node.id} role="none">
              <button
                className="toolbar-menu-item"
                role="menuitem"
                data-node={node.id}
                title={node.path ?? node.id}
                onClick={() => {
                  show(node.id);
                  setOpen(false);
                }}
              >
                {titleOf(node)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
