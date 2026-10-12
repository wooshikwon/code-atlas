import type { Change } from "../api/types";
import type { Lines } from "../graph/compare";
import { CHANGE_LETTERS, CHANGE_NAMES } from "../state/changes";
import { useSummaries } from "../state/summaries";
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
    <span className="tree-change" data-change={change} role="img" aria-label={CHANGE_NAMES[change]} data-tip={CHANGE_NAMES[change]}>
      {letter && CHANGE_LETTERS[change]}
    </span>
  );
}

/** 시점 비교의 두 시점 사이에 추가되고 삭제된 줄 수. 0인 쪽은 적지 않는다. */
export function LineCounts({ lines }: { lines: Lines | null }) {
  if (lines === null || (lines.added === 0 && lines.deleted === 0)) {
    return null;
  }
  return (
    <span className="line-counts">
      {lines.added > 0 && <span className="lines-added">+{lines.added}</span>}
      {lines.deleted > 0 && <span className="lines-deleted">−{lines.deleted}</span>}
    </span>
  );
}

/** 파일트리의 행 하나. cursor는 키보드로 옮기는 활성 행이다. */
export function TreeNode({ row, id, cursor, onPick }: { row: Row; id: string; cursor: boolean; onPick: (row: Row) => void }) {
  const lead = useSummaries((s) => (row.node === null ? undefined : s.leads[row.node]));
  return (
    <li
      id={id}
      role="treeitem"
      aria-level={row.level}
      aria-expanded={row.expanded ?? undefined}
      aria-selected={row.selected}
      className={`tree-row tree-${row.kind}${row.selected ? " active" : ""}${cursor ? " cursor" : ""}`}
      data-full={row.title}
      data-tip={lead}
      data-node={row.node ?? undefined}
      data-gone={row.gone ? "" : undefined}
      onClick={() => onPick(row)}
    >
      <span className="tree-indent" style={{ width: (row.level - 1) * INDENT }} />
      <span className="tree-toggle">{row.expanded !== null && <Chevron open={row.expanded} />}</span>
      <Icon kind={row.icon} />
      <span className="tree-label">{row.label}</span>
      {row.from !== null && <span className="tree-from">← {row.from}</span>}
      <ChangeMark change={row.change} letter={row.kind !== "dir"} />
      <LineCounts lines={row.lines} />
    </li>
  );
}
