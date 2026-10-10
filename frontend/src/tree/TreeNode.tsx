import type { Row } from "./rows";

/** 파일트리의 행 하나. cursor는 키보드로 옮기는 활성 행이다. */
export function TreeNode({ row, id, cursor, onPick }: { row: Row; id: string; cursor: boolean; onPick: (row: Row) => void }) {
  return (
    <li
      id={id}
      role="treeitem"
      aria-level={row.level}
      aria-expanded={row.expanded ?? undefined}
      aria-selected={row.selected}
      className={`tree-row tree-${row.kind}${row.selected ? " active" : ""}${cursor ? " cursor" : ""}`}
      style={{ paddingLeft: (row.level - 1) * 14 + 4 }}
      title={row.title}
      data-node={row.node ?? undefined}
      onClick={() => onPick(row)}
    >
      <span className="tree-toggle">{row.kind === "dir" ? (row.expanded ? "▾" : "▸") : ""}</span>
      <span className="tree-label">{row.label}</span>
    </li>
  );
}
