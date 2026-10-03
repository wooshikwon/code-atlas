// 분석 결과와 화면 상태를 파일트리·그래프·코드 뷰어가 함께 쓴다.
import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { getGraph, getRepo, getTree } from "../api/client";
import { applyTheme, preferredTheme, type Theme } from "../theme";
import { atlasReducer, initialState, type AtlasState } from "./model";

interface AtlasContextValue extends AtlasState {
  /** 노드를 고르고 그 노드의 파일을 코드 뷰어에 연다. null이면 선택을 푼다. */
  select: (id: string | null) => void;
  hover: (key: string | null) => void;
  /** 코드 뷰어에 파일을 열고 그 줄을 강조한다. */
  openSite: (path: string, line: number) => void;
  toggleTests: () => void;
  setTheme: (theme: Theme) => void;
}

const AtlasContext = createContext<AtlasContextValue | null>(null);

export function AtlasProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(atlasReducer, preferredTheme(), initialState);

  useEffect(() => {
    Promise.all([getRepo(), getGraph(), getTree()])
      .then(([repo, graph, tree]) => dispatch({ type: "loaded", repo, graph, tree }))
      .catch((caught: unknown) =>
        dispatch({ type: "failed", error: caught instanceof Error ? caught.message : String(caught) }),
      );
  }, []);

  useEffect(() => {
    applyTheme(state.theme);
  }, [state.theme]);

  const actions = useMemo(
    () => ({
      select: (id: string | null) => dispatch({ type: "select", id }),
      hover: (key: string | null) => dispatch({ type: "hover", key }),
      openSite: (path: string, line: number) => dispatch({ type: "openSite", path, line }),
      toggleTests: () => dispatch({ type: "toggleTests" }),
      setTheme: (theme: Theme) => dispatch({ type: "setTheme", theme }),
    }),
    [],
  );

  const value = useMemo(() => ({ ...state, ...actions }), [state, actions]);

  return <AtlasContext value={value}>{children}</AtlasContext>;
}

export function useAtlas(): AtlasContextValue {
  const value = useContext(AtlasContext);
  if (value === null) {
    throw new Error("useAtlas must be used inside AtlasProvider");
  }
  return value;
}
