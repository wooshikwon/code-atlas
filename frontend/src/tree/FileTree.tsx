import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useAtlas } from "../state/store";
import { parentOf, rows, type Row } from "./rows";
import { TreeNode } from "./TreeNode";

const rowId = (index: number) => `tree-row-${index}`;

export function FileTree() {
  const repo = useAtlas((s) => s.repo);
  const tree = useAtlas((s) => s.tree);
  const graph = useAtlas((s) => s.graph);
  const error = useAtlas((s) => s.error);
  const selection = useAtlas((s) => s.selection);
  const collapsed = useAtlas((s) => s.collapsed);
  const showTests = useAtlas((s) => s.showTests);
  const structure = useAtlas((s) => s.view.kind === "structure");
  const select = useAtlas((s) => s.select);
  const show = useAtlas((s) => s.show);
  const toggleFolder = useAtlas((s) => s.toggleFolder);
  const selected = selection?.type === "node" ? selection.id : null;
  const list = useMemo(
    () => (tree === null || graph === null ? [] : rows(tree, graph, { collapsed, selected, showTests })),
    [tree, graph, collapsed, selected, showTests],
  );
  /** 키보드로 옮기는 활성 행의 key. 그 행이 목록에 없으면 첫 행이 활성 행이다. */
  const [cursor, setCursor] = useState<string | null>(null);
  const active = Math.max(
    list.findIndex((row) => row.key === cursor),
    0,
  );
  const activeKey = list[active]?.key;

  // 선택이 바뀌면 활성 행을 고른 행으로 옮긴다. 활성 행이 이미 고른 행이면 그대로 둔다.
  useEffect(() => {
    const row = list.find((r) => r.selected);
    if (row !== undefined) {
      setCursor((key) => (list.some((r) => r.selected && r.key === key) ? key : row.key));
    }
  }, [selected]);

  useEffect(() => {
    document.getElementById(rowId(active))?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  /**
   * 폴더 행은 접거나 펼치고, 파일·클래스·함수 행은 구조 뷰에서 고른다. 구조 뷰에서 고른 행을 다시 누르면 선택을 푼다.
   * 패키지 노드가 없는 폴더는 늘 펼쳐 둔다.
   */
  const pick = (row: Row) => {
    setCursor(row.key);
    if (row.node !== null) {
      (row.kind === "dir" ? toggleFolder : row.selected && structure ? select : show)(row.node);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const row = list[active];
    if (row === undefined || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const move = (index: number) => setCursor(list[Math.min(Math.max(index, 0), list.length - 1)].key);
    switch (event.key) {
      case "ArrowDown":
        move(active + 1);
        break;
      case "ArrowUp":
        move(active - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(list.length - 1);
        break;
      case "ArrowRight":
        if (row.expanded === false) {
          pick(row);
        } else if (row.expanded === true && active + 1 < list.length && list[active + 1].level > row.level) {
          move(active + 1);
        }
        break;
      case "ArrowLeft":
        if (row.kind === "dir" && row.expanded === true && row.node !== null) {
          pick(row);
        } else if (parentOf(list, active) >= 0) {
          move(parentOf(list, active));
        }
        break;
      case "Enter":
        pick(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className="explorer">
      <div className="explorer-header">{repo?.name ?? "code-atlas"}</div>
      <div className="explorer-body">
        {error !== null && <div className="explorer-error">{error}</div>}
        {error === null && tree === null && <div className="explorer-empty">불러오는 중</div>}
        <ul
          className="tree"
          role="tree"
          tabIndex={0}
          aria-activedescendant={activeKey === undefined ? undefined : rowId(active)}
          onKeyDown={onKeyDown}
        >
          {list.map((row, index) => (
            <TreeNode key={row.key} row={row} id={rowId(index)} cursor={index === active} onPick={pick} />
          ))}
        </ul>
      </div>
    </div>
  );
}
