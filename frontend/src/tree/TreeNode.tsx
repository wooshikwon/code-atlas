import type { Change } from "../api/types";
import { CHANGE_LETTERS } from "../state/changes";
import { Chevron, Icon } from "./Icon";
import type { Row } from "./rows";

/** 깊이 한 단계의 들여쓰기 폭(px) */
const INDENT = 14;

/** 행 오른쪽 끝의 변경 표시. 색 점과 글자를 그리고, letter가 거짓이면 색 점만 그린다. */
export function ChangeMark({ change, letter = true }: { change: Change | null; letter?: boolean }) {
  if (change === null) {
    return null;
  }
  return (
    <span className="tree-change" data-change={change} title={change === "modified" ? "수정됨" : "추가됨"}>
      {letter && CHANGE_LETTERS[change]}
    </span>
  );
}

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
      title={row.title}
      data-node={row.node ?? undefined}
      onClick={() => onPick(row)}
    >
      <span className="tree-indent" style={{ width: (row.level - 1) * INDENT }} />
      <span className="tree-toggle">{row.expanded !== null && <Chevron open={row.expanded} />}</span>
      <Icon kind={row.icon} />
      <span className="tree-label">{row.label}</span>
      <ChangeMark change={row.change} letter={row.kind !== "dir"} />
    </li>
  );
}
