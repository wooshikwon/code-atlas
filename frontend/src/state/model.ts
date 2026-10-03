import type { AtlasNode, Graph, Repo, Tree } from "../api/types";
import type { Theme } from "../theme";

export interface OpenFile {
  path: string;
  /** 강조할 1부터 세는 시작 줄과 끝 줄. 없으면 강조하지 않는다. */
  range: [number, number] | null;
}

export interface AtlasState {
  repo: Repo | null;
  graph: Graph | null;
  tree: Tree | null;
  error: string | null;
  selection: string | null;
  /** 마우스를 올린 노드 id 또는 edge_key */
  hovered: string | null;
  openFile: OpenFile | null;
  showTests: boolean;
  theme: Theme;
}

export type AtlasAction =
  | { type: "loaded"; repo: Repo; graph: Graph; tree: Tree }
  | { type: "failed"; error: string }
  | { type: "select"; id: string | null }
  | { type: "hover"; key: string | null }
  | { type: "openSite"; path: string; line: number }
  | { type: "toggleTests" }
  | { type: "setTheme"; theme: Theme };

export function initialState(theme: Theme): AtlasState {
  return {
    repo: null,
    graph: null,
    tree: null,
    error: null,
    selection: null,
    hovered: null,
    openFile: null,
    showTests: false,
    theme,
  };
}

/** 노드가 든 파일과 강조 범위. 파일이 없는 노드(폴더 패키지, 외부)면 null이다. 모듈 전체는 강조하지 않는다. */
export function fileOf(node: AtlasNode): OpenFile | null {
  if (node.path === null || !node.path.endsWith(".py")) {
    return null;
  }
  const whole = node.kind === "module" || node.kind === "package";
  return { path: node.path, range: whole ? null : node.range };
}

export function atlasReducer(state: AtlasState, action: AtlasAction): AtlasState {
  switch (action.type) {
    case "loaded":
      return { ...state, repo: action.repo, graph: action.graph, tree: action.tree, error: null };
    case "failed":
      return { ...state, error: action.error };
    case "select": {
      if (action.id === null) {
        return { ...state, selection: null };
      }
      const node = state.graph?.nodes.find((n) => n.id === action.id);
      if (node === undefined) {
        return state;
      }
      return { ...state, selection: node.id, openFile: fileOf(node) ?? state.openFile };
    }
    case "hover":
      return { ...state, hovered: action.key };
    case "openSite":
      return { ...state, openFile: { path: action.path, range: [action.line, action.line] } };
    case "toggleTests":
      return { ...state, showTests: !state.showTests };
    case "setTheme":
      return { ...state, theme: action.theme };
  }
}
