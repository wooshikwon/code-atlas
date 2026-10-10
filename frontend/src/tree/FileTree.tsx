import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useOpened } from "../panel/opened";
import { useChanges } from "../state/changes";
import { useAtlas } from "../state/store";
import { build } from "../search/index";
import { parentOf, results, rows, type Result, type Row } from "./rows";
import { TreeNode } from "./TreeNode";
import { TreeResults, TreeSearch } from "./TreeSearch";

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
  const changes = useChanges((s) => s.changes);
  const opened = useOpened((s) => s.path);
  const toggleOpened = useOpened((s) => s.toggle);
  const selected = selection?.type === "node" ? selection.id : null;
  const list = useMemo(
    () => (tree === null || graph === null ? [] : rows(tree, graph, { collapsed, selected, opened, showTests, changes })),
    [tree, graph, collapsed, selected, opened, showTests, changes],
  );
  /** 지워진 파일은 노드가 없으므로 파일트리 아래에 경로만 적는다. */
  const deleted = useMemo(() => (changes?.files ?? []).filter((file) => file.status === "deleted"), [changes]);
  /** 키보드로 옮기는 활성 행의 key. 그 행이 목록에 없으면 첫 행이 활성 행이다. */
  const [cursor, setCursor] = useState<string | null>(null);
  const active = Math.max(
    list.findIndex((row) => row.key === cursor),
    0,
  );
  const activeKey = list[active]?.key;
  /** 검색 칸의 질의. 비지 않으면 파일트리 대신 검색 결과 목록을 그린다. */
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const entries = useMemo(() => (graph === null ? [] : build(graph, showTests)), [graph, showTests]);
  const found = useMemo(() => results(entries, query, selected, changes), [entries, query, selected, changes]);
  /** 키보드로 옮기는 활성 결과 행의 번호 */
  const [mark, setMark] = useState(0);
  const search = useRef<HTMLInputElement | null>(null);

  // 선택이 바뀌면 활성 행을 고른 행으로 옮긴다. 활성 행이 이미 고른 행이면 그대로 둔다.
  useEffect(() => {
    const row = list.find((r) => r.selected);
    if (row !== undefined) {
      setCursor((key) => (list.some((r) => r.selected && r.key === key) ? key : row.key));
    }
  }, [selected]);

  useEffect(() => {
    document.getElementById(rowId(active))?.scrollIntoView({ block: "nearest" });
  }, [activeKey, searching]);

  /**
   * 폴더 행은 접거나 펼치고, 파일·클래스·함수 행은 구조 뷰에서 고른다. 구조 뷰에서 고른 행을 다시 누르면 선택을 푼다.
   * 패키지 노드가 없는 폴더는 늘 펼쳐 둔다. 모듈 노드가 없는 `__init__.py` 행은 그래프 선택을 바꾸지 않고
   * 정보 패널에 그 파일의 코드를 열고, 다시 누르면 닫는다.
   */
  const pick = (row: Row) => {
    setCursor(row.key);
    if (row.node !== null) {
      (row.kind === "dir" ? toggleFolder : row.selected && structure ? select : show)(row.node);
    } else if (row.file !== null) {
      toggleOpened(row.file);
    }
  };

  /** 검색 결과 행을 구조 뷰에서 고른다. 질의는 그대로 두고 포커스를 검색 칸에 돌려준다. */
  const pickResult = (result: Result) => {
    setMark(found.indexOf(result));
    show(result.hit.entry.id);
    search.current?.focus();
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
      <TreeSearch
        input={search}
        query={query}
        onQuery={(text) => {
          setQuery(text);
          setMark(0);
        }}
        list={found}
        active={mark}
        onActive={setMark}
        onPick={pickResult}
      />
      <div className="explorer-body">
        {error !== null && <div className="explorer-error">{error}</div>}
        {error === null && tree === null && <div className="explorer-empty">불러오는 중</div>}
        {searching && graph !== null && found.length === 0 && <div className="explorer-empty">이름이 맞는 항목 없음</div>}
        {searching ? (
          <TreeResults list={found} active={mark} onPick={pickResult} />
        ) : (
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
        )}
        {!searching && deleted.length > 0 && (
          <div className="tree-deleted">
            <div className="tree-deleted-title">지워진 파일</div>
            <ul>
              {deleted.map((file) => (
                <li key={file.path} className="tree-deleted-row" title={file.path}>
                  {file.path}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
