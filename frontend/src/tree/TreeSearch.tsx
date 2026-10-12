import { useEffect, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { EntryKind } from "../search/index";
import { useNodeMenu } from "../nav/NodeMenu";
import { useSummaries } from "../state/summaries";
import { Icon } from "./Icon";
import type { Result } from "./rows";
import { ChangeMark } from "./TreeNode";

const KIND_NAMES: Record<EntryKind, string> = {
  file: "파일",
  class: "클래스",
  dataclass: "데이터 클래스",
  function: "함수",
  method: "메서드",
  variable: "변수",
};

const resultId = (index: number) => `tree-result-${index}`;

/** 일치한 글자를 굵게 그린다. */
function marked(text: string, positions: Set<number>): ReactNode {
  return [...text].map((char, index) => (positions.has(index) ? <b key={index}>{char}</b> : char));
}

interface SearchProps {
  /** 검색 칸. 결과 행을 누른 뒤 포커스를 돌려줄 때 쓴다. */
  input: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  list: Result[];
  /** 키보드로 옮기는 활성 결과 행의 번호 */
  active: number;
  onActive: (index: number) => void;
  onPick: (result: Result) => void;
}

/** 파일트리 맨 위 검색 칸. 질의가 있으면 오른쪽에 지우기 버튼을 그린다. */
export function TreeSearch({ input, query, onQuery, list, active, onActive, onPick }: SearchProps) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        onActive(Math.min(active + 1, list.length - 1));
        break;
      case "ArrowUp":
        onActive(Math.max(active - 1, 0));
        break;
      case "Enter":
        if (list[active] !== undefined) {
          onPick(list[active]);
        }
        break;
      case "Escape":
        onQuery("");
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="tree-search">
      <input
        ref={input}
        className="tree-search-input"
        role="combobox"
        aria-expanded={list.length > 0}
        aria-controls="tree-results"
        aria-activedescendant={list[active] === undefined ? undefined : resultId(active)}
        aria-autocomplete="list"
        aria-label="파일·클래스·함수 검색"
        placeholder="파일·클래스·함수 이름"
        spellCheck={false}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {query !== "" && (
        <button
          type="button"
          className="tree-search-clear"
          aria-label="검색 지우기"
          data-tip="검색 지우기"
          onClick={() => {
            onQuery("");
            input.current?.focus();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** 검색 결과 목록. 한 줄에 이름, 종류와 경로를 적는다. */
export function TreeResults({ list, active, onPick }: Pick<SearchProps, "list" | "active" | "onPick">) {
  const leads = useSummaries((s) => s.leads);
  useEffect(() => {
    document.getElementById(resultId(active))?.scrollIntoView({ block: "nearest" });
  }, [active, list]);

  return (
    <ul id="tree-results" className="tree-results" role="listbox">
      {list.map(({ hit, selected, change }, index) => (
        <li
          key={hit.entry.id}
          id={resultId(index)}
          className={`tree-row tree-result${selected ? " active" : ""}${index === active ? " cursor" : ""}`}
          role="option"
          aria-selected={index === active}
          data-full={`${hit.entry.name} · ${hit.entry.path}`}
          data-tip={leads[hit.entry.id]}
          data-node={hit.entry.id}
          onClick={() => onPick(list[index])}
          onContextMenu={(event) => useNodeMenu.getState().show(hit.entry.id, event.clientX, event.clientY, false) && event.preventDefault()}
        >
          <Icon kind={hit.entry.kind} />
          <span className="tree-label">{hit.field === "name" ? marked(hit.entry.name, hit.positions) : hit.entry.name}</span>
          <span className="tree-aside">
            {KIND_NAMES[hit.entry.kind]} · {hit.field === "path" ? marked(hit.entry.path, hit.positions) : hit.entry.path}
          </span>
          <ChangeMark change={change} />
        </li>
      ))}
    </ul>
  );
}
