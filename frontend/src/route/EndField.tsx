// 경로 탐색 창의 출발 칸과 도착 칸. 칸을 누르면 입력으로 바뀌고 `Mod+P` 검색과 같은 색인에서 찾은 결과를 칸 아래에 그린다.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { AtlasNode } from "../api/types";
import { nameOf } from "../graph/names";
import { HitRow } from "../search/HitRow";
import { find, recent, type Entry } from "../search/index";
import { useAtlas } from "../state/store";
import { fileOf } from "./words";

export type End = "from" | "to";

const END_NAMES: Record<End, string> = { from: "출발", to: "도착" };

const HIT_LIMIT = 8;

interface EndFieldProps {
  end: End;
  /** 검색 색인 */
  entries: Entry[];
  nodes: Map<string, AtlasNode>;
}

export function EndField({ end, entries, nodes }: EndFieldProps) {
  const id = useAtlas((s) => s.finder[end]);
  const history = useAtlas((s) => s.history);
  const setEnd = useAtlas((s) => s.setEnd);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const hits = useMemo(
    () => (editing ? find(entries, query, HIT_LIMIT, recent(history)) : []),
    [editing, entries, query, history],
  );
  const node = id === null ? undefined : nodes.get(id);
  const optionId = (index: number) => `finder-${end}-option-${index}`;

  useEffect(() => {
    document.getElementById(`finder-${end}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [end, active, hits]);

  const close = () => {
    setEditing(false);
    setQuery("");
    setActive(0);
  };

  const choose = (picked: string) => {
    setEnd(end, picked);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        setActive(Math.min(active + 1, hits.length - 1));
        break;
      case "ArrowUp":
        setActive(Math.max(active - 1, 0));
        break;
      case "Enter":
        if (hits[active] !== undefined) {
          choose(hits[active].entry.id);
        }
        break;
      case "Escape":
        event.currentTarget.blur();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="finder-end">
      <div className="finder-field" data-end={end}>
        {node === undefined || editing ? (
          <input
            className="finder-input"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={`finder-${end}-list`}
            aria-activedescendant={hits[active] === undefined ? undefined : optionId(active)}
            aria-autocomplete="list"
            aria-label={`${END_NAMES[end]} 검색`}
            placeholder={`${END_NAMES[end]}: 파일·클래스·함수 이름`}
            spellCheck={false}
            autoFocus={editing}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onFocus={() => setEditing(true)}
            onBlur={close}
            onKeyDown={onKeyDown}
          />
        ) : (
          <>
            <button
              type="button"
              className="finder-value"
              data-tip={`${END_NAMES[end]} 다시 고르기`}
              onClick={() => setEditing(true)}
            >
              <span className="finder-name">{nameOf(nodes, node)}</span>
              <span className="finder-aside">{node.kind === "module" ? node.path : fileOf(node)}</span>
            </button>
            <button
              type="button"
              className="finder-unset"
              aria-label={`${END_NAMES[end]} 비우기`}
              data-tip={`${END_NAMES[end]} 비우기`}
              onClick={() => setEnd(end, null)}
            >
              ×
            </button>
          </>
        )}
      </div>
      {/* 결과 행을 눌러도 입력이 포커스를 잃지 않게 한다. */}
      <ul id={`finder-${end}-list`} className="finder-hits" role="listbox" onMouseDown={(event) => event.preventDefault()}>
        {hits.map((hit, index) => (
          <HitRow
            key={hit.entry.id}
            hit={hit}
            id={optionId(index)}
            className="palette-option finder-hit"
            active={index === active}
            onActive={() => setActive(index)}
            onPick={() => choose(hit.entry.id)}
          />
        ))}
      </ul>
    </div>
  );
}
