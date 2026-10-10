// 분석 결과와 화면 상태를 파일트리·그래프·정보 패널이 함께 쓴다. 컴포넌트는 선택자로 필요한 필드만 구독한다.
import { create } from "zustand";
import { getGraph, getRepo, getTree } from "../api/client";
import type { AtlasNode, Graph, Repo, Tree } from "../api/types";
import type { EdgeKey } from "../graph/scope";
import { applyTheme, preferredTheme, type Theme } from "../theme";
import { back, forward, jump, push, type History, type Place, type Selection, type View } from "./history";

export type { Place, Selection, View } from "./history";

export type Depth = 1 | 2 | 3;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OpenFile {
  path: string;
  /** 강조할 1부터 세는 시작 줄과 끝 줄. 없으면 강조하지 않는다. */
  range: [number, number] | null;
}

export interface AtlasStore {
  repo: Repo | null;
  graph: Graph | null;
  tree: Tree | null;
  error: string | null;
  view: View;
  selection: Selection;
  /** 접은 폴더(패키지 노드 id) */
  collapsed: Set<string>;
  /** 흐름 단계 */
  depth: Depth;
  showTests: boolean;
  showExternal: boolean;
  theme: Theme;
  history: History;
  /** 정보 패널의 사각형. null이면 기본 위치(오른쪽 위)다. */
  panel: Rect | null;
  legendOpen: boolean;
  paletteOpen: boolean;

  /** 저장해 둔 화면 설정을 되살리고 레포·그래프·파일트리를 받는다. */
  load(): void;
  /** 노드를 고른다. 같은 id를 다시 고르거나 null을 넘기면 선택을 푼다. */
  select(id: string | null): void;
  selectEdge(key: EdgeKey): void;
  toggleFolder(id: string): void;
  setDepth(depth: Depth): void;
  /** 함수 시점 뷰로 들어가 그 함수를 고른다. */
  enterFunction(id: string): void;
  /** 함수 시점 뷰에서 그 노드의 이웃을 한 단계 더 편다. */
  expandFunction(id: string): void;
  back(): void;
  forward(): void;
  jump(index: number): void;
  toggleTests(): void;
  toggleExternal(): void;
  setTheme(theme: Theme): void;
  setPanel(rect: Rect): void;
  toggleLegend(): void;
  setPalette(open: boolean): void;
}

/** 노드가 든 파일과 강조 범위. 파일이 없는 노드(폴더 패키지, 외부)면 null이다. 모듈 전체는 강조하지 않는다. */
export function fileOf(node: AtlasNode): OpenFile | null {
  if (node.path === null || !node.path.endsWith(".py")) {
    return null;
  }
  const whole = node.kind === "module" || node.kind === "package";
  return { path: node.path, range: whole ? null : node.range };
}

type Ui = Pick<AtlasStore, "panel" | "legendOpen" | "theme" | "depth">;

const UI_KEY = "code-atlas:ui:v1";

function isRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const rect = value as Record<string, unknown>;
  return [rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === "number" && Number.isFinite(n));
}

/** localStorage에 저장한 문자열에서 화면 설정을 읽는다. 형태가 맞지 않는 값은 기본값으로 둔다. */
export function parseUi(raw: string | null, theme: Theme): Ui {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (typeof parsed === "object" && parsed !== null) {
      saved = parsed as Record<string, unknown>;
    }
  } catch {
    // JSON이 아닌 문자열이면 모든 값을 기본값으로 둔다.
  }
  return {
    panel: isRect(saved.panel)
      ? { x: saved.panel.x, y: saved.panel.y, width: saved.panel.width, height: saved.panel.height }
      : null,
    legendOpen: saved.legendOpen === true,
    theme: saved.theme === "light" || saved.theme === "dark" ? saved.theme : theme,
    depth: saved.depth === 1 || saved.depth === 2 || saved.depth === 3 ? saved.depth : 2,
  };
}

function placeOf(state: Pick<AtlasStore, "view" | "selection" | "collapsed">): Place {
  return { view: state.view, selection: state.selection, collapsed: [...state.collapsed].sort() };
}

const START: Pick<AtlasStore, "view" | "selection" | "collapsed"> = {
  view: { kind: "structure" },
  selection: null,
  collapsed: new Set(),
};

export const useAtlas = create<AtlasStore>()((set, get) => {
  /** 뷰·선택·접은 폴더를 바꾸고 바뀐 뒤의 단계를 이력에 넣는다. */
  const visit = (change: Partial<Pick<AtlasStore, "view" | "selection" | "collapsed">>) =>
    set((state) => ({ ...change, history: push(state.history, placeOf({ ...state, ...change })) }));

  /** 이력의 지금 단계를 화면에 되돌린다. 이력에 새 단계를 넣지 않는다. */
  const restore = (history: History) => {
    if (history === get().history) {
      return;
    }
    const place = history.entries[history.index];
    set({ history, view: place.view, selection: place.selection, collapsed: new Set(place.collapsed) });
  };

  /** 화면 설정을 바꾸고 localStorage에 쓴다. */
  const keep = (change: Partial<Ui>) => {
    set(change);
    const { panel, legendOpen, theme, depth } = get();
    localStorage.setItem(UI_KEY, JSON.stringify({ panel, legendOpen, theme, depth }));
  };

  const has = (id: string) => get().graph?.nodes.some((n) => n.id === id) === true;

  return {
    repo: null,
    graph: null,
    tree: null,
    error: null,
    ...START,
    depth: 2,
    showTests: false,
    showExternal: false,
    theme: "light",
    history: { entries: [placeOf(START)], index: 0 },
    panel: null,
    legendOpen: false,
    paletteOpen: false,

    load: () => {
      const ui = parseUi(localStorage.getItem(UI_KEY), preferredTheme());
      set(ui);
      applyTheme(ui.theme);
      Promise.all([getRepo(), getGraph(), getTree()])
        .then(([repo, graph, tree]) => set({ repo, graph, tree, error: null }))
        .catch((caught: unknown) => set({ error: caught instanceof Error ? caught.message : String(caught) }));
    },

    select: (id) => {
      if (id === null) {
        visit({ selection: null });
        return;
      }
      if (!has(id)) {
        return;
      }
      const selection = get().selection;
      const same = selection?.type === "node" && selection.id === id;
      visit({ selection: same ? null : { type: "node", id } });
    },
    selectEdge: (key) => visit({ selection: { type: "edge", key } }),
    toggleFolder: (id) => {
      const collapsed = new Set(get().collapsed);
      if (!collapsed.delete(id)) {
        collapsed.add(id);
      }
      visit({ collapsed });
    },
    setDepth: (depth) => keep({ depth }),
    enterFunction: (id) => {
      if (has(id)) {
        visit({ view: { kind: "function", center: id, expanded: [] }, selection: { type: "node", id } });
      }
    },
    expandFunction: (id) => {
      const view = get().view;
      if (view.kind === "function" && !view.expanded.includes(id)) {
        visit({ view: { ...view, expanded: [...view.expanded, id] } });
      }
    },
    back: () => restore(back(get().history)),
    forward: () => restore(forward(get().history)),
    jump: (index) => restore(jump(get().history, index)),
    toggleTests: () => set((state) => ({ showTests: !state.showTests })),
    toggleExternal: () => set((state) => ({ showExternal: !state.showExternal })),
    setTheme: (theme) => {
      keep({ theme });
      applyTheme(theme);
    },
    setPanel: (rect) => keep({ panel: rect }),
    toggleLegend: () => keep({ legendOpen: !get().legendOpen }),
    setPalette: (open) => set({ paletteOpen: open }),
  };
});
