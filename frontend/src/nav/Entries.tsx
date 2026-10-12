// 상단 줄의 진입점 버튼. 테두리와 바탕이 없는 글자 `진입점 N`과 아래 화살표이고, 누르면 글자 아래로 진입점 이름의 메뉴가 내려온다.
// 상단 줄이 좁으면 수를 감춘다(styles.css).
// 이름을 고르면 구조 뷰에서 그 노드를 고른다. API 엔드포인트는 하나마다 `GET /api/graph` 한 줄이고, 다른 진입점 아래에 주소순으로 모은다.
import { useMemo, useRef, useState } from "react";
import type { AtlasNode } from "../api/types";
import { titleOf } from "../graph/layout";
import { routeText } from "../graph/names";
import { EntryIcon } from "../graph/nodes/common";
import { ENTRIES_TIP } from "../graph/tips";
import { hidden } from "../graph/visible";
import { useAtlas } from "../state/store";
import { MenuList, type MenuItem } from "./MenuList";

/** 주소를 글자 코드 순서로 견준다. 화면의 언어 설정과 관계없이 같은 순서다. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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
    const entries = graph.nodes.filter((node) => node.entry && !off.has(node.id));
    const item = (key: string, node: AtlasNode, text: string, tip: string | undefined): MenuItem => ({
      key,
      node: node.id,
      full: text,
      tip,
      label: (
        <>
          <EntryIcon />
          {text}
        </>
      ),
      run: () => show(node.id),
    });
    const endpoints = entries
      .flatMap((node) => node.routes.map((route, i) => ({ node, route, key: `${node.id}#${i}`, text: routeText(route) })))
      .sort((a, b) => Number(a.route.path === null) - Number(b.route.path === null) || compare(a.route.path ?? "", b.route.path ?? "") || compare(a.text, b.text));
    return [
      ...entries.filter((node) => node.routes.length === 0).map((node) => item(node.id, node, titleOf(node), node.kind === "module" || node.path === null ? undefined : node.path)),
      ...endpoints.map(({ node, route, key, text }) => item(key, node, text, `${route.handler}() · ${node.path}`)),
    ];
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
        data-tip={menu === null ? ENTRIES_TIP : undefined}
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
