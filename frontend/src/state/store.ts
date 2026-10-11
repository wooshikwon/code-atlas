// 분석 결과와 화면 상태를 파일트리·그래프·정보 패널이 함께 쓴다. 컴포넌트는 선택자로 필요한 필드만 구독한다.
import { create } from "zustand";
import { getGraph, getRepo, getTree } from "../api/client";
import type { Graph, Repo, Tree } from "../api/types";
import type { EdgeKey } from "../graph/scope";
import { applyTheme, preferredTheme, type Theme } from "../theme";
import { back, focusOf, forward, jump, push, type History, type Place, type Selection, type View } from "./history";

export type { Place, Selection, View } from "./history";

export type Depth = 1 | 2 | 3;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AtlasStore {
  repo: Repo | null;
  graph: Graph | null;
  tree: Tree | null;
  error: string | null;
  view: View;
  selection: Selection;
  /** 접은 폴더(패키지 노드 id). 레포를 열면 `nestedFolders`가 고른 폴더가 접혀 있다. */
  collapsed: Set<string>;
  /** 흐름 단계 */
  depth: Depth;
  showTests: boolean;
  showExternal: boolean;
  /** 노드를 고르면 캐시에 없는 LLM 요약을 만든다 */
  autoSummary: boolean;
  theme: Theme;
  history: History;
  /** 정보 패널의 사각형. null이면 기본 위치(오른쪽 위)다. */
  panel: Rect | null;
  legendOpen: boolean;
  minimapOpen: boolean;
  paletteOpen: boolean;

  /** 저장해 둔 화면 설정을 되살리고 레포·그래프·파일트리를 받는다. */
  load(): void;
  /**
   * 노드를 고르고 그 노드를 품은 접은 폴더를 펼친다. 폴더를 고르면 그 폴더를 접는다.
   * 같은 id를 다시 고르거나 null을 넘기면 선택을 푼다.
   */
  select(id: string | null): void;
  /** 구조 뷰로 돌아가 select처럼 노드를 고른다. 이미 고른 노드여도 선택을 풀지 않는다. */
  show(id: string): void;
  /** 선을 고른다. 초점은 직전에 초점을 둔 노드에 그대로 둔다. */
  selectEdge(key: EdgeKey): void;
  /** 폴더를 접거나 펼친다. 초점을 둔 노드가 든 폴더를 접거나 초점을 둔 폴더를 펼치면 선택을 푼다. */
  toggleFolder(id: string): void;
  setDepth(depth: Depth): void;
  /** 함수 시점 뷰로 들어가 그 함수를 고른다. */
  enterFunction(id: string): void;
  /** 함수 시점 뷰에서 그 노드의 이웃을 한 단계 더 편다. */
  expandFunction(id: string): void;
  /**
   * 더블클릭한 함수·메서드를 열어 함수 시점 뷰로 들어간다. 첫 클릭이 넣은 이력 단계를 버리도록 첫 클릭 전의 이력
   * from에서 이어 한 단계만 넣는다. 함수 시점 뷰의 가운데 함수면 from으로 되돌리기만 한다.
   */
  open(id: string, from: History): void;
  back(): void;
  forward(): void;
  jump(index: number): void;
  toggleTests(): void;
  toggleExternal(): void;
  toggleAutoSummary(): void;
  setTheme(theme: Theme): void;
  setPanel(rect: Rect | null): void;
  toggleLegend(): void;
  toggleMinimap(): void;
  setPalette(open: boolean): void;
}

type Ui = Pick<AtlasStore, "panel" | "legendOpen" | "minimapOpen" | "theme" | "depth" | "autoSummary">;

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
    minimapOpen: saved.minimapOpen !== false,
    theme: saved.theme === "light" || saved.theme === "dark" ? saved.theme : theme,
    depth: saved.depth === 1 || saved.depth === 2 || saved.depth === 3 ? saved.depth : 2,
    autoSummary: saved.autoSummary === true,
  };
}

function placeOf(state: Pick<AtlasStore, "view" | "selection" | "collapsed">): Place {
  return { view: state.view, selection: state.selection, collapsed: [...state.collapsed].sort() };
}

/** 레포를 열 때 접어 두는 폴더. 소스 루트 바로 아래 폴더는 펼치고 그 아래의 폴더는 모두 접는다. */
export function nestedFolders(graph: Graph): Set<string> {
  return new Set(graph.nodes.filter((n) => n.kind === "package" && n.parent !== null).map((n) => n.id));
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
    const { panel, legendOpen, minimapOpen, theme, depth, autoSummary } = get();
    localStorage.setItem(UI_KEY, JSON.stringify({ panel, legendOpen, minimapOpen, theme, depth, autoSummary }));
  };

  const kindOf = (id: string) => get().graph?.nodes.find((n) => n.id === id)?.kind;

  /** 노드의 조상 id. 가까운 조상이 앞에 온다. */
  const ancestors = (id: string): string[] => {
    const parents = new Map(get().graph?.nodes.map((n) => [n.id, n.parent]));
    const ids: string[] = [];
    for (let parent = parents.get(id) ?? null; parent !== null; parent = parents.get(parent) ?? null) {
      ids.push(parent);
    }
    return ids;
  };

  /** 노드를 고른 뒤의 접은 폴더 집합. 노드를 품은 폴더를 빼고, 고른 노드가 폴더면 그 폴더를 넣는다. */
  const revealed = (id: string): Set<string> => {
    const collapsed = new Set(get().collapsed);
    ancestors(id).forEach((folder) => collapsed.delete(folder));
    if (kindOf(id) === "package") {
      collapsed.add(id);
    }
    return collapsed;
  };

  const enter = (id: string) =>
    visit({ view: { kind: "function", center: id, expanded: [] }, selection: { type: "node", id } });

  const toggle = (id: string) => {
    const collapsed = new Set(get().collapsed);
    const focus = focusOf(get().selection);
    if (collapsed.delete(id)) {
      visit(focus === id ? { collapsed, selection: null } : { collapsed });
      return;
    }
    collapsed.add(id);
    visit(focus !== null && ancestors(focus).includes(id) ? { collapsed, selection: null } : { collapsed });
  };

  return {
    repo: null,
    graph: null,
    tree: null,
    error: null,
    ...START,
    depth: 2,
    showTests: false,
    showExternal: false,
    autoSummary: false,
    theme: "light",
    history: { entries: [placeOf(START)], index: 0 },
    panel: null,
    legendOpen: false,
    minimapOpen: true,
    paletteOpen: false,

    load: () => {
      const ui = parseUi(localStorage.getItem(UI_KEY), preferredTheme());
      set(ui);
      applyTheme(ui.theme);
      Promise.all([getRepo(), getGraph(), getTree()])
        .then(([repo, graph, tree]) => {
          const collapsed = nestedFolders(graph);
          const place = placeOf({ ...START, collapsed });
          set({ repo, graph, tree, error: null, ...START, collapsed, history: { entries: [place], index: 0 } });
        })
        .catch((caught: unknown) => set({ error: caught instanceof Error ? caught.message : String(caught) }));
    },

    select: (id) => {
      if (id === null) {
        visit({ selection: null });
        return;
      }
      if (kindOf(id) === undefined) {
        return;
      }
      const selection = get().selection;
      if (selection?.type === "node" && selection.id === id) {
        visit({ selection: null });
        return;
      }
      visit({ selection: { type: "node", id }, collapsed: revealed(id) });
    },
    show: (id) => {
      if (kindOf(id) !== undefined) {
        visit({ view: { kind: "structure" }, selection: { type: "node", id }, collapsed: revealed(id) });
      }
    },
    selectEdge: (key) => visit({ selection: { type: "edge", key, focus: focusOf(get().selection) } }),
    toggleFolder: toggle,
    setDepth: (depth) => keep({ depth }),
    enterFunction: (id) => {
      if (kindOf(id) !== undefined) {
        enter(id);
      }
    },
    expandFunction: (id) => {
      const view = get().view;
      if (view.kind === "function" && !view.expanded.includes(id)) {
        visit({ view: { ...view, expanded: [...view.expanded, id] } });
      }
    },
    open: (id, from) => {
      const kind = kindOf(id);
      const place = from.entries[from.index];
      const centered = place.view.kind === "function" && place.view.center === id;
      if (!centered && kind !== "function" && kind !== "method") {
        return;
      }
      set({ history: from, view: place.view, selection: place.selection, collapsed: new Set(place.collapsed) });
      if (!centered) {
        enter(id);
      }
    },
    back: () => restore(back(get().history)),
    forward: () => restore(forward(get().history)),
    jump: (index) => restore(jump(get().history, index)),
    toggleTests: () => set((state) => ({ showTests: !state.showTests })),
    toggleExternal: () => set((state) => ({ showExternal: !state.showExternal })),
    toggleAutoSummary: () => keep({ autoSummary: !get().autoSummary }),
    setTheme: (theme) => {
      keep({ theme });
      applyTheme(theme);
    },
    setPanel: (rect) => keep({ panel: rect }),
    toggleLegend: () => keep({ legendOpen: !get().legendOpen }),
    toggleMinimap: () => keep({ minimapOpen: !get().minimapOpen }),
    setPalette: (open) => set({ paletteOpen: open }),
  };
});
