import { useState } from "react";
import type { TreeEntry } from "../api/types";

export interface TreeHandlers {
  showTests: boolean;
  isActive: (entry: TreeEntry) => boolean;
  onOpen: (entry: TreeEntry) => void;
}

export function TreeNode({ entry, depth, handlers }: { entry: TreeEntry; depth: number; handlers: TreeHandlers }) {
  const [open, setOpen] = useState(true);
  const children = (entry.children ?? []).filter((child) => handlers.showTests || !child.test);
  const isDir = entry.kind === "dir";

  return (
    <li role="treeitem" aria-expanded={isDir ? open : undefined}>
      <div
        className={`tree-row tree-${entry.kind}${handlers.isActive(entry) ? " active" : ""}`}
        style={{ paddingLeft: depth * 14 + 4 }}
        title={entry.path}
        onClick={() => (isDir ? setOpen(!open) : handlers.onOpen(entry))}
      >
        <span className="tree-toggle">{isDir ? (open ? "▾" : "▸") : ""}</span>
        <span className="tree-label">{entry.name}</span>
      </div>
      {isDir && open && children.length > 0 && (
        <ul role="group">
          {children.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} handlers={handlers} />
          ))}
        </ul>
      )}
    </li>
  );
}
