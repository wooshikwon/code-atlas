import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { hidden } from "../graph/visible";
import { useAtlas } from "../state/store";
import { SearchIcon } from "../tree/Icon";
import { HitRow } from "./HitRow";
import { build, find, recent, type Hit } from "./index";

const optionId = (index: number) => `palette-option-${index}`;

function PaletteBox() {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const history = useAtlas((s) => s.history);
  const show = useAtlas((s) => s.show);
  const setPalette = useAtlas((s) => s.setPalette);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const entries = useMemo(() => (graph === null ? [] : build(graph, hidden(graph, { showTests, showExternal }))), [graph, showTests, showExternal]);
  const hits = useMemo(() => find(entries, query, 50, recent(history)), [entries, query, history]);

  // 팔레트를 닫으면 열기 전에 포커스가 있던 요소로 돌아간다. 입력이 포커스를 받기 전인 첫 렌더에서 그 요소를 읽어 둔다.
  const [before] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      if (before instanceof HTMLElement) {
        before.focus();
      }
    },
    [before],
  );

  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active, hits]);

  /** 구조 뷰에서 고른 노드로 옮기고 닫는다. */
  const choose = (hit: Hit) => {
    show(hit.entry.id);
    setPalette(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
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
          choose(hits[active]);
        }
        break;
      case "Escape":
        setPalette(false);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="palette-backdrop" onMouseDown={() => setPalette(false)}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-field">
          <SearchIcon />
          <input
            className="palette-input"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="palette-list"
            aria-activedescendant={hits[active] === undefined ? undefined : optionId(active)}
            aria-autocomplete="list"
            aria-label="파일·클래스·함수 검색"
            placeholder="파일·클래스·함수 이름"
            spellCheck={false}
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul id="palette-list" className="palette-list" role="listbox">
          {hits.map((hit, index) => (
            <HitRow
              key={hit.entry.id}
              hit={hit}
              id={optionId(index)}
              className="palette-option"
              active={index === active}
              onActive={() => setActive(index)}
              onPick={() => choose(hit)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 검색 팔레트. 저장소의 paletteOpen이 참인 동안 그린다. */
export function Palette() {
  const open = useAtlas((s) => s.paletteOpen);
  return open ? <PaletteBox /> : null;
}
