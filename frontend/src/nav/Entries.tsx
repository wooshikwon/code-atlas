// 상단 줄의 진입점 버튼. 테두리와 바탕이 없는 글자 `진입점 N`과 아래 화살표이고, 누르면 글자 아래로 진입점 이름의 메뉴가 내려온다.
// 상단 줄이 좁으면 수를 감춘다(styles.css).
// 이름을 고르면 구조 뷰에서 그 노드를 고른다.
import { useMemo, useRef, useState } from "react";
import { titleOf } from "../graph/layout";
import { EntryIcon } from "../graph/nodes/common";
import { ENTRY_TIP } from "../graph/tips";
import { hidden } from "../graph/visible";
import { useAtlas } from "../state/store";
import { MenuList, type MenuItem } from "./MenuList";

/** 버튼의 아래 끝과 메뉴 사이 */
const GAP = 4;

export function Entries() {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const show = useAtlas((s) => s.show);
  const button = useRef<HTMLButtonElement | null>(null);
  /** 편 메뉴. first는 키보드로 열었는지다. */
  const [menu, setMenu] = useState<{ first: boolean } | null>(null);
  const items = useMemo((): MenuItem[] => {
    if (graph === null) {
      return [];
    }
    const off = hidden(graph, { showTests, showExternal });
    return graph.nodes
      .filter((node) => node.entry && !off.has(node.id))
      .map((node) => ({
        key: node.id,
        node: node.id,
        full: titleOf(node),
        tip: node.kind === "module" || node.path === null ? undefined : node.path,
        label: (
          <>
            <EntryIcon />
            {titleOf(node)}
          </>
        ),
        run: () => show(node.id),
      }));
  }, [graph, showTests, showExternal, show]);
  const rect = menu === null ? undefined : button.current?.getBoundingClientRect();

  return (
    <>
      <button
        ref={button}
        className="toolbar-entries"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-controls="toolbar-entries"
        aria-label={`진입점 ${items.length}`}
        disabled={items.length === 0}
        data-tip={menu === null ? ENTRY_TIP : undefined}
        onClick={(event) => setMenu(menu === null ? { first: event.detail === 0 } : null)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && menu === null) {
            event.preventDefault();
            setMenu({ first: true });
          }
        }}
      >
        진입점
        <span className="toolbar-entries-count">{items.length}</span>
        <svg className="toolbar-entries-arrow" viewBox="0 0 8 8" width={8} height={8} aria-hidden>
          <path d="M1 2.5 L4 5.5 L7 2.5" />
        </svg>
      </button>
      {menu !== null && rect !== undefined && (
        <MenuList
          id="toolbar-entries"
          label="진입점"
          items={items}
          at={{ x: rect.left, y: rect.bottom + GAP }}
          first={menu.first}
          anchor={button}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
