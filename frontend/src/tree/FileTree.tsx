import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { hidden } from "../graph/visible";
import { host } from "../host";
import { modName } from "../nav/keys";
import { useNodeMenu } from "../nav/NodeMenu";
import { useOpened } from "../panel/opened";
import { useChanges } from "../state/changes";
import { useCompare } from "../state/compare";
import { useOpening } from "../state/opening";
import { running, useStatus } from "../state/status";
import { chosenOf, useAtlas } from "../state/store";
import { build } from "../search/index";
import { parentOf, results, rows, type Result, type Row } from "./rows";
import { Icon } from "./Icon";
import { TreeNode } from "./TreeNode";
import { TreeResults, TreeSearch } from "./TreeSearch";

const rowId = (index: number) => `tree-row-${index}`;

export function FileTree() {
  const repo = useAtlas((s) => s.repo);
  const tree = useAtlas((s) => s.tree);
  const graph = useAtlas((s) => s.graph);
  const error = useAtlas((s) => s.error);
  /** 서버가 첫 분석을 하는 중이거나 하지 못했다. 그동안은 관계 그래프 영역의 진행 표시가 상태를 적는다. */
  const analysing = useStatus((s) => running(s.status) || s.status?.phase === "failed");
  const collapsed = useAtlas((s) => s.collapsed);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const structure = useAtlas((s) => s.view.kind === "structure");
  const select = useAtlas((s) => s.select);
  const show = useAtlas((s) => s.show);
  const toggleFolder = useAtlas((s) => s.toggleFolder);
  const compared = useCompare((s) => s.result);
  /** 마지막 커밋 뒤의 변경 내용. 시점 비교가 켜져 있는 동안에는 그리지 않는다. */
  const changes = useChanges((s) => (compared === null ? s.changes : null));
  const opened = useOpened((s) => s.path);
  const toggleOpened = useOpened((s) => s.toggle);
  const selected = useAtlas(chosenOf);
  /** 펼친 폴더의 경로. 분석 대상 파일이 없는 폴더는 접어 두고 누르면 펼친다. */
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const list = useMemo(
    () =>
      tree === null || graph === null ? [] : rows(tree, graph, { collapsed, unfolded, selected, opened, showTests, showExternal, changes, compared }),
    [tree, graph, collapsed, unfolded, selected, opened, showTests, showExternal, changes, compared],
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
  const entries = useMemo(() => (graph === null ? [] : build(graph, hidden(graph, { showTests, showExternal }))), [graph, showTests, showExternal]);
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
   * 폴더 행은 접거나 펼치고, 파일·클래스·함수 행은 구조 뷰에서 고른다. 구조 뷰에서 고른 파일 행을 다시 누르면 선택을 풀고, 고른 클래스·함수 행을 다시 눌러도 선택은 그대로다.
   * 패키지 노드가 없는 폴더는 분석 대상 파일이 들었으면 늘 펼쳐 두고, 들지 않았으면 누를 때마다 펼치거나 접는다. 접으면 그 안에서 연 파일을 닫는다.
   * 모듈 노드가 없는 `__init__.py` 행과 분석 대상이 아닌 파일 행은 그래프 선택을 바꾸지 않고
   * 정보 패널에 그 파일의 코드를 열고, 다시 누르면 닫는다.
   */
  const pick = (row: Row) => {
    setCursor(row.key);
    if (row.node !== null) {
      (row.kind === "dir" ? toggleFolder : row.selected && structure ? select : show)(row.node);
    } else if (row.kind === "dir" && !row.source) {
      const next = new Set(unfolded);
      if (!next.delete(row.key)) {
        next.add(row.key);
      } else if (opened?.startsWith(`${row.key}/`)) {
        useOpened.getState().close();
      }
      setUnfolded(next);
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

  /**
   * index번째 행의 노드 메뉴를 열고, 열었으면 참을 돌려준다. at은 누른 화면 좌표이고, 키보드로 열어 null이면 그 행의 이름 아래에 연다.
   * 노드가 없는 행은 메뉴가 없다.
   */
  const menuAt = (index: number, at: { x: number; y: number } | null): boolean => {
    const node = list[index]?.node ?? null;
    const label = document.getElementById(rowId(index))?.querySelector(".tree-label")?.getBoundingClientRect();
    const point = at ?? (label === undefined ? null : { x: label.left, y: label.bottom });
    return node !== null && point !== null && useNodeMenu.getState().show(node, point.x, point.y, at === null);
  };

  /** 행을 우클릭하면 그 행의 메뉴를, 키보드의 메뉴 키로 부르면 활성 행의 메뉴를 연다. 활성 행과 선택은 그대로 둔다. */
  const onContextMenu = (event: MouseEvent) => {
    const element = (event.target as Element).closest(".tree-row");
    const index = element === null ? active : list.findIndex((_, i) => rowId(i) === element.id);
    if (menuAt(index, element === null ? null : { x: event.clientX, y: event.clientY })) {
      event.preventDefault();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const row = list[active];
    if (row === undefined || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      if (menuAt(active, null)) {
        event.preventDefault();
      }
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
        if (row.kind === "dir" && row.expanded === true && (row.node !== null || !row.source)) {
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
      <div className="explorer-header">
        <span className="explorer-name">{repo?.name ?? "code-atlas"}</span>
        <button
          className="toolbar-button explorer-open"
          aria-label="다른 레포 열기"
          data-tip={host.app ? `폴더 열기… ${modName("O")}` : "폴더 열기…"}
          onClick={() => void useOpening.getState().browse()}
        >
          <Icon kind="folder-open" />
        </button>
      </div>
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
        {error === null && tree === null && !analysing && <div className="explorer-empty">불러오는 중</div>}
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
            onContextMenu={onContextMenu}
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
                <li key={file.path} className="tree-deleted-row" data-full={file.path}>
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
