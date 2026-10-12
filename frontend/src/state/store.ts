// 분석 결과와 화면 상태를 파일트리·그래프·정보 패널이 함께 쓴다. 컴포넌트는 선택자로 필요한 필드만 구독한다.
import { create } from "zustand";
import { getGraph, getRepo, getTree } from "../api/client";
import type { AtlasNode, Graph, Repo, Tree } from "../api/types";
import { liveGraph } from "../graph/compare";
import { cycles } from "../graph/cycles";
import { lit, route, type Lit, type Route } from "../graph/route";
import { endsOf, type EdgeKey } from "../graph/scope";
import { hidden, packedIn } from "../graph/visible";
import { applyTheme, preferredTheme, type Theme } from "../theme";
import { useCompare } from "./compare";
import { back, focusOf, forward, jump, push, remap, type History, type Place, type Selection, type View } from "./history";
import { useOverlay } from "./overlay";

export type { Place, Selection, View } from "./history";

export type Depth = 1 | 2 | 3;
/** 칸 묶음의 배치. 가로창 모드는 파일트리 옆에 작업 영역을 두고, 세로창 모드는 작업 영역 아래에 파일트리와 정보 패널을 둔다. */
export type Mode = "landscape" | "portrait";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 경로 탐색 창과 경로 고정 상태. 탐색 이력에 넣지 않고 localStorage에 저장하지 않는다. */
export interface Finder {
  /** 경로 탐색 창을 폈는지 */
  open: boolean;
  from: string | null;
  to: string | null;
  /** 두 칸이 찼을 때 찾은 결과 */
  route: Route | null;
  /** 강조하는 경로의 번호(0부터) */
  pick: number;
  /** 정보 패널에 보이는 경로 위 노드 */
  focus: string | null;
  /** 고정 중에 막힌 액션이 불린 횟수 */
  blocked: number;
  /** focus를 정한 횟수. 같은 노드를 다시 받아도 는다. 그래프가 이 값이 늘 때마다 focus의 노드로 화면을 옮긴다. */
  aimed: number;
}

export interface AtlasStore {
  repo: Repo | null;
  graph: Graph | null;
  tree: Tree | null;
  error: string | null;
  view: View;
  selection: Selection;
  /**
   * 그래프에서 선을 눌러 지금 화면에 왔으면 누른 선의 키(선을 눌러 온 상태). 키가 선의 출발 노드·도착 노드·종류를 담고, 그 선의 어느 쪽
   * 노드로 왔는지는 selection이 따로 담는다. 정보 패널이 `연결`·`관계` 줄을 보이고 그래프가 그 선을 굵게 그린다.
   * 선택을 바꾸는 다른 액션이 null로 돌리고, 선택을 그대로 두는 액션(폴더 접기·펴기, 손잡이)은 그대로 둔다.
   */
  via: EdgeKey[] | null;
  /** 접은 폴더(패키지 노드 id). 레포를 열면 `startFolds`가 고른 폴더가 접혀 있다. */
  collapsed: Set<string>;
  /**
   * 전부 펼침 단계인 파일 상자(파일 노드 id). 펼친 파일 상자는 파일 밖과 선이 없는 자식을 손잡이로 묶고, 이 집합에 든 파일 상자는
   * 그 자식도 그린다. 파일 상자는 선택을 풀면 접히지만 이 집합에는 남아, 다시 고르면 전부 펼침으로 열린다.
   * 초점을 둔 노드가 손잡이에 묶이는 자식이거나 그 안에 든 노드면 그 파일 상자는 늘 이 집합에 있다(`unpackedFor`).
   */
  unpacked: Set<string>;
  /** 흐름 단계 */
  depth: Depth;
  showTests: boolean;
  showExternal: boolean;
  /** 노드를 고르면 캐시에 없는 LLM 요약을 만든다 */
  autoSummary: boolean;
  theme: Theme;
  /** 사용자가 상단 줄의 버튼으로 고른 모드. null이면 창의 크기로 판정한 모드를 쓴다(`nav/layout.ts`의 `judge`). */
  layout: Mode | null;
  history: History;
  finder: Finder;
  /**
   * 사용자가 옮기거나 크기를 바꾼 정보 패널의 사각형을 관계 그래프 영역의 크기로 나눈 값(`panel/rect.ts`의 `share`). x·width는 영역의 폭으로,
   * y·height는 영역의 높이로 나눈다. null이면 기본 사각형(`panel/rect.ts`의 `initial`)이다.
   */
  panel: Rect | null;
  /** 코드 뷰어와 함께 보이는 LLM 요약 칸의 높이를 정보 패널 높이로 나눈 값. null이면 요약 칸이 내용만큼, 패널 높이의 4분의 1까지 쓴다. */
  split: number | null;
  /** 정보 패널의 "정보" 구역과 "LLM 요약" 구역을 폈는지. 접은 구역은 한 줄 요약만 보인다. */
  factsOpen: boolean;
  summaryOpen: boolean;
  legendOpen: boolean;
  minimapOpen: boolean;
  paletteOpen: boolean;
  /** 서버가 레포를 다시 분석하는 중이다(`state/reload.ts`) */
  reloading: boolean;
  /** 마지막 새로고침이 실패한 까닭. 실패하지 않았으면 null이다. */
  reloadError: string | null;
  /** 다시 분석한 결과를 받은 횟수. 정보 패널이 이 값이 바뀌면 보이던 노드의 본문과 요약을 다시 받는다. */
  epoch: number;
  /** 화면을 초기화한 횟수(`resetView`). 구조 뷰가 이 값이 늘 때마다 화면을 레포를 연 처음 화면처럼 맞춘다. */
  homed: number;
  /**
   * 노드를 고른 횟수. 이미 고른 노드를 다시 골라 선택이 그대로일 때와 경로 고정 중에 경로 위의 노드를 골랐을 때도 는다.
   * 코드 뷰어가 이 값이 늘 때마다 보이는 범위를 처음 골랐을 때처럼 다시 가운데에 둔다.
   */
  picked: number;
  /** 배치 계산이 펼치기·접기의 움직임 시간을 넘겨 도는 중이다(`graph/arranging.tsx`). 그동안 그래프는 앞의 배치를 그대로 그린다. */
  arranging: boolean;
  /** 화면에 그린 배치를 계산하기 시작한 때의 탐색 이력. 그린 배치가 없으면 null이다. */
  arranged: History | null;
  /**
   * 구조 뷰의 화면이 그래프 전체를 맞춘 상태다(전체 맞춤 상태). 레포를 연 처음 화면과 "화면 맞춤"이 켜고, 사용자가 화면을 끌거나
   * 확대·축소하거나 미니맵으로 옮길 때와 고른 노드나 강조하는 경로로 화면이 옮겨질 때 꺼진다. 켜져 있는 동안 구조 뷰는 배치가
   * 바뀔 때마다 화면을 다시 맞춘다(`graph/viewport.ts`의 `autoView`).
   */
  fitted: boolean;

  /** 저장해 둔 화면 설정을 되살린다. */
  restore(): void;
  /** 레포·그래프·파일트리를 받는다. 받지 못하면 까닭을 error에 적는다. */
  load(): Promise<void>;
  /**
   * 다시 분석한 결과를 받는다. 보기 설정과 화면 상태는 그대로 두고, 뷰·선택·지나온 선·접은 폴더·전부 펼친 상자와 탐색 이력의 모든 단계를
   * 새 그래프에 맞춘다(`placeIn`). 경로 탐색 창의 출발과 도착은 새 그래프에 없으면 비우고, 두 칸이 차 있으면 경로를 다시 찾는다.
   * 시점 비교의 그래프를 받으면 삭제된 노드를 출발과 도착에서 비우고 삭제된 선을 뺀 그래프에서 경로를 찾는다.
   */
  refresh(repo: Repo, graph: Graph, tree: Tree): void;
  /**
   * 화면을 레포를 처음 연 상태로 되돌린다. 구조 뷰로 돌아가 선택과 지나온 선을 풀고, 폴더를 처음 화면처럼 접고(`startFolds`), 전부 펼친
   * 상자를 비운 단계를 이력에 넣는다. 보기 설정은 그대로 둔다. 경로 고정 중에는 막힌다.
   */
  resetView(): void;
  /**
   * 경로 고정 중에는 selectEdge, toggleFolder, togglePack, setDepth, enterFunction, expandFunction, open, back, forward, jump,
   * toggleTests, toggleExternal, resetView가 상태를 바꾸지 않고 finder.blocked를 1 늘리며 경로 탐색 창을 편다(`barred`). select와 show, follow는
   * 강조한 경로 위의 노드를 받으면 finder.focus만 그 노드로 바꾸고, 그 밖의 노드를 받으면 같은 방식으로 막힌다.
   * select(null)과 show(null)은 고정 중에 아무것도 하지 않는다.
   *
   * 노드를 고르고 그 노드를 품은 접은 폴더를 펼친다. 폴더를 고르면 그 폴더를 접는다.
   * null을 넘기거나 고른 파일 상자·폴더·외부 노드를 다시 고르면 선택을 푼다. 고른 함수·클래스·메서드를 다시 고르면 picked만 1 늘린다.
   */
  select(id: string | null): void;
  /** 구조 뷰로 돌아가 select처럼 노드를 고른다. 이미 고른 노드여도 선택을 풀지 않는다. null을 넘기면 구조 뷰로 돌아가 선택을 푼다. */
  show(id: string | null): void;
  /** 선을 고른다. 초점은 직전에 초점을 둔 노드에 그대로 둔다. */
  selectEdge(key: EdgeKey): void;
  /** 폴더를 접거나 펼친다. 초점을 둔 노드가 든 폴더를 접거나 초점을 둔 폴더를 펼치면 선택을 푼다. */
  toggleFolder(id: string): void;
  /**
   * 그래프에서 누른 선 keys를 따라 그 선의 한쪽 끝 노드 to로 간다. to가 폴더면 그 폴더를 펼치고 선택을 풀며, 그 밖의 노드면 그 노드를
   * 고른다(이미 고른 노드여도 선택을 풀지 않는다). 두 경우 모두 누른 선을 via에 담아 이력에 한 단계를 넣는다.
   */
  follow(keys: EdgeKey[], to: string): void;
  /**
   * 파일 상자의 손잡이를 눌러 전부 펼침과 펼침을 오간다. 선택과 초점은 바꾸지 않되, 초점을 둔 노드가 접는 손잡이에 묶이는 자식이거나
   * 그 안에 든 노드면 그 파일 상자를 고른다.
   */
  togglePack(id: string): void;
  setDepth(depth: Depth): void;
  /** 함수 시점 뷰로 들어가 그 함수를 고른다. */
  enterFunction(id: string): void;
  /** 함수 시점 뷰에서 그 노드의 이웃을 한 단계 더 편다. */
  expandFunction(id: string): void;
  /** 함수 시점 뷰에서 구조 뷰로 돌아가 고른 노드를 고른 채로 둔다. 고른 노드가 없으면 가운데 함수를 고른다. 구조 뷰에서는 아무것도 하지 않는다. */
  leaveFunction(): void;
  /**
   * 더블클릭한 함수·메서드를 열어 함수 시점 뷰로 들어간다. 첫 클릭이 넣은 이력 단계를 버리도록 첫 클릭 전의 이력
   * from에서 이어 한 단계만 넣는다. 함수 시점 뷰의 가운데 함수면 from으로 되돌리기만 한다.
   */
  open(id: string, from: History): void;
  /** 이력의 앞 단계로 돌아간다. 되돌릴 느린 배치가 있으면(`undoable`) 그 배치를 취소한다. */
  back(): void;
  forward(): void;
  jump(index: number): void;
  /**
   * 느린 배치를 취소한다. 뷰·선택·접은 폴더·전부 펼친 상자·탐색 이력을 화면에 그린 배치의 것(`arranged`)으로 되돌리고 참을 돌려준다.
   * 되돌릴 조작이 없으면(`undoable`) 아무것도 하지 않고 거짓을 돌려준다.
   */
  cancelArranging(): boolean;
  /** 두 칸이 차 있으면 바뀐 토글로 경로를 다시 찾는다. */
  toggleTests(): void;
  toggleExternal(): void;
  /** 경로 탐색 창을 펴거나 접는다. 고정 상태는 바꾸지 않는다. */
  toggleFinder(): void;
  /**
   * 출발 칸이나 도착 칸을 채우거나 비운다. 그래프에 없는 id와 폴더, 변수는 받지 않는다. 두 칸이 차면 경로를 찾아 첫 경로를
   * 강조하고 focus를 그 경로의 출발 노드에 둔다. 경로가 나왔는데 함수 시점 뷰면 구조 뷰로 돌아가는 단계를 이력에 넣는다.
   */
  setEnd(end: "from" | "to", id: string | null): void;
  /** 출발과 도착을 맞바꾸고 경로를 다시 찾는다. */
  swapEnds(): void;
  /** 강조할 경로를 고르고 focus를 그 경로의 출발 노드로 돌린다. 찾은 경로에 없는 번호는 넘긴다. */
  pickPath(index: number): void;
  /** 출발·도착·찾은 경로를 비워 경로 고정을 끈다. */
  clearFinder(): void;
  toggleAutoSummary(): void;
  setTheme(theme: Theme): void;
  setLayout(layout: Mode): void;
  setPanel(rect: Rect | null): void;
  setSplit(split: number | null): void;
  /** 정보 패널의 "정보" 구역과 "LLM 요약" 구역을 접거나 편다. */
  toggleFacts(): void;
  toggleSummary(): void;
  toggleLegend(): void;
  toggleMinimap(): void;
  setPalette(open: boolean): void;
}

type Ui = Pick<AtlasStore, "panel" | "split" | "factsOpen" | "summaryOpen" | "minimapOpen" | "theme" | "layout" | "depth" | "autoSummary">;

const UI_KEY = "code-atlas:ui:v3";

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
    split: typeof saved.split === "number" && saved.split > 0 && saved.split < 1 ? saved.split : null,
    factsOpen: saved.factsOpen !== false,
    summaryOpen: saved.summaryOpen !== false,
    minimapOpen: saved.minimapOpen !== false,
    theme: saved.theme === "light" || saved.theme === "dark" ? saved.theme : theme,
    layout: saved.layout === "landscape" || saved.layout === "portrait" ? saved.layout : null,
    depth: saved.depth === 1 || saved.depth === 2 || saved.depth === 3 ? saved.depth : 2,
    autoSummary: saved.autoSummary === true,
  };
}

function placeOf(state: Pick<AtlasStore, "view" | "selection" | "via" | "collapsed" | "unpacked">): Place {
  return { view: state.view, selection: state.selection, via: state.via, collapsed: [...state.collapsed].sort(), unpacked: [...state.unpacked].sort() };
}

/**
 * 레포를 열 때 접어 두는 폴더. 모든 폴더를 접되, 소스 루트부터 내려가며 그 층에 보이는 상자(파일 상자와 폴더 상자)가 폴더 하나뿐인
 * 동안 그 폴더를 펼친다. 테스트 코드 토글이 꺼져 숨는 파일과 폴더는 세지 않는다.
 */
export function startFolds(graph: Graph, showTests: boolean): Set<string> {
  const off = hidden(graph, { showTests, showExternal: false });
  const boxes = new Map<string | null, AtlasNode[]>();
  for (const node of graph.nodes) {
    if ((node.kind === "module" || node.kind === "package") && !off.has(node.id)) {
      boxes.set(node.parent, [...(boxes.get(node.parent) ?? []), node]);
    }
  }
  const folds = new Set(graph.nodes.filter((n) => n.kind === "package").map((n) => n.id));
  for (let layer = boxes.get(null) ?? []; layer.length === 1 && layer[0].kind === "package"; layer = boxes.get(layer[0].id) ?? []) {
    folds.delete(layer[0].id);
  }
  return folds;
}

/**
 * 탐색 이력의 단계 place를 다시 분석한 그래프 graph에 맞춘다. before는 앞의 그래프다. graph에 없는 노드는 접은 폴더와 전부 펼친 상자에서
 * 빼고, before에 없던 폴더는 접어 둔다. 고른 노드가 없으면 선택을 풀고, 고른 선의 끝 노드가 없으면 초점을 둔 노드를 고른다.
 * 선택이 바뀌었거나 끝 노드가 없는 지나온 선은 지운다. 함수 시점 뷰의 가운데 함수가 없으면 구조 뷰로 돌아간다.
 * 바뀌지 않은 뷰와 선택은 받은 객체 그대로 돌려준다.
 */
export function placeIn(place: Place, graph: Graph, before: Graph | null): Place {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const known = new Set(before?.nodes.map((n) => n.id));
  const drawn = (key: EdgeKey) => ids.has(endsOf(key).source) && ids.has(endsOf(key).target);
  const added = before === null ? [] : graph.nodes.filter((n) => n.kind === "package" && !known.has(n.id)).map((n) => n.id);

  let view = place.view;
  if (view.kind === "function") {
    const expanded = view.expanded.filter((id) => ids.has(id));
    view = !ids.has(view.center) ? { kind: "structure" } : expanded.length === view.expanded.length ? view : { ...view, expanded };
  }
  let selection = place.selection;
  if (selection?.type === "node" && !ids.has(selection.id)) {
    selection = null;
  } else if (selection?.type === "edge") {
    const focus = selection.focus !== null && ids.has(selection.focus) ? selection.focus : null;
    if (!drawn(selection.key)) {
      selection = focus === null ? null : { type: "node", id: focus };
    } else if (focus !== selection.focus) {
      selection = { ...selection, focus };
    }
  }
  const via = selection === place.selection && place.via !== null ? place.via.filter(drawn) : [];
  return {
    view,
    selection,
    via: via.length === 0 ? null : via,
    collapsed: [...place.collapsed.filter((id) => ids.has(id)), ...added].sort(),
    unpacked: place.unpacked.filter((id) => ids.has(id)),
  };
}

/** 경로 고정 상태인지. 찾은 경로가 하나라도 있으면 고정이다. */
export function pinned(finder: Finder): boolean {
  return finder.route !== null && finder.route.paths.length > 0;
}

/** 고정 중에 강조하는 경로. 고정이 아니면 null이다. */
export function litOf(finder: Finder): Lit | null {
  return finder.route === null ? null : lit(finder.route, finder.pick);
}

/**
 * 느린 배치를 취소해 되돌릴 조작이 있는지. 배치 계산이 길어지는 중이고, 화면에 그린 배치 뒤에 탐색 이력이 바뀌었을 때다.
 * 레포를 연 첫 배치, 토글·흐름 단계·경로 고정이 부른 배치는 이력을 바꾸지 않으므로 되돌릴 조작이 없다.
 */
export function undoable(state: Pick<AtlasStore, "arranging" | "arranged" | "history" | "finder">): boolean {
  return state.arranging && state.arranged !== null && state.arranged !== state.history && !pinned(state.finder);
}

/** 정보 패널·탐색 경로 표시·파일트리가 보이는 노드. 경로 고정 중에는 finder.focus이고 그 밖에는 고른 노드다. */
export function chosenOf(state: Pick<AtlasStore, "finder" | "selection">): string | null {
  if (pinned(state.finder)) {
    return state.finder.focus;
  }
  return state.selection?.type === "node" ? state.selection.id : null;
}

/**
 * 경로 고정 중이면 막힌 횟수를 늘리고 경로 탐색 창을 편 뒤 참을 돌려준다. 고정 중에 막는 진입은 모두 이 함수로 판정한다.
 */
export function barred(): boolean {
  const { finder } = useAtlas.getState();
  if (!pinned(finder)) {
    return false;
  }
  useAtlas.setState({ finder: { ...finder, open: true, blocked: finder.blocked + 1 } });
  return true;
}

type Boxes = Pick<AtlasStore, "graph" | "showTests" | "showExternal" | "selection" | "unpacked">;

/** 초점을 둔 노드가 손잡이에 묶이는 자식이거나 그 안에 든 노드면 그 노드가 든 파일 상자, 아니면 null이다. */
function packOf(state: Omit<Boxes, "unpacked">): string | null {
  const focus = focusOf(state.selection);
  return state.graph === null || focus === null ? null : packedIn(state.graph, hidden(state.graph, state), focus);
}

/** 초점을 둔 노드가 손잡이에 묶이는 자식이거나 그 안에 든 노드면 그 파일 상자를 더한 전부 펼친 상자 집합. 더할 상자가 없으면 받은 집합이다. */
function unpackedFor(state: Boxes): Set<string> {
  const box = packOf(state);
  return box === null || state.unpacked.has(box) ? state.unpacked : new Set([...state.unpacked, box]);
}

const START: Pick<AtlasStore, "view" | "selection" | "via" | "collapsed" | "unpacked"> = {
  view: { kind: "structure" },
  selection: null,
  via: null,
  collapsed: new Set(),
  unpacked: new Set(),
};

const FINDER: Finder = { open: false, from: null, to: null, route: null, pick: 0, focus: null, blocked: 0, aimed: 0 };

/** 받은 분석 결과와, 레포를 처음 열 때의 뷰·선택·접은 폴더·전부 펼친 상자·탐색 이력. 테스트 코드 토글이 showTests일 때의 화면이다. */
function opened(repo: Repo, graph: Graph, tree: Tree, showTests: boolean) {
  const collapsed = startFolds(graph, showTests);
  const place = placeOf({ ...START, collapsed });
  return { repo, graph, tree, error: null, ...START, collapsed, history: { entries: [place], index: 0 }, arranging: false, arranged: null };
}

/** 경로를 찾는 그래프. 시점 비교가 켜져 있으면 삭제된 노드와 선을 뺀 대상 시점의 그래프다. */
function routable(graph: Graph): Graph {
  return liveGraph(graph, useCompare.getState().result);
}

/** 레포를 열 때의 분석 표시. 지금 토글에서 순환 묶음이 하나라도 있으면 순환 의존 표시를 켜고 없으면 끈다. */
function cover(graph: Graph, toggles: { showTests: boolean; showExternal: boolean }): void {
  useOverlay.getState().set(cycles(graph, hidden(graph, toggles)).groups.length > 0 ? "cycles" : null);
}

export const useAtlas = create<AtlasStore>()((set, get) => {
  /**
   * 뷰·선택·지나온 선·접은 폴더·전부 펼친 상자를 바꾸고 바뀐 뒤의 단계를 이력에 넣는다. 선택을 바꾸는 change가 지나온 선을
   * 주지 않으면 지나온 선을 지운다. change가 노드를 고르면 picked를 1 늘린다.
   */
  const visit = (change: Partial<Pick<AtlasStore, "view" | "selection" | "via" | "collapsed" | "unpacked">>) =>
    set((state) => {
      const next = { ...("selection" in change ? { via: null } : {}), ...change };
      const unpacked = unpackedFor({ ...state, ...next });
      const picked = change.selection?.type === "node" ? state.picked + 1 : state.picked;
      return { ...next, unpacked, picked, history: push(state.history, placeOf({ ...state, ...next, unpacked })) };
    });

  /** 이력의 지금 단계를 화면에 되돌린다. 이력에 새 단계를 넣지 않는다. 그 단계를 넣은 뒤 토글이 바뀌었으면 전부 펼친 상자를 지금 토글로 다시 맞춘다. */
  const restore = (history: History) => {
    if (history === get().history) {
      return;
    }
    const place = history.entries[history.index];
    const unpacked = unpackedFor({ ...get(), selection: place.selection, unpacked: new Set(place.unpacked) });
    set({ history, view: place.view, selection: place.selection, via: place.via, collapsed: new Set(place.collapsed), unpacked });
  };

  /** 화면 설정을 바꾸고 localStorage에 쓴다. */
  const keep = (change: Partial<Ui>) => {
    set(change);
    const { panel, split, factsOpen, summaryOpen, minimapOpen, theme, layout, depth, autoSummary } = get();
    localStorage.setItem(UI_KEY, JSON.stringify({ panel, split, factsOpen, summaryOpen, minimapOpen, theme, layout, depth, autoSummary }));
  };

  /** 경로 고정 중에는 액션을 실행하지 않는다. */
  const guarded =
    <Args extends unknown[]>(action: (...args: Args) => void) =>
    (...args: Args) => {
      if (!barred()) {
        action(...args);
      }
    };

  /** 경로 고정 중에 null이나 강조한 경로 위의 노드를 받았는지. 경로 위의 노드면 finder.focus를 그 노드로 바꾸고 picked를 1 늘린다. */
  const focused = (id: string | null): boolean => {
    const finder = get().finder;
    if (!pinned(finder) || (id !== null && litOf(finder)?.nodes.has(id) !== true)) {
      return false;
    }
    if (id !== null) {
      set((state) => ({ finder: { ...finder, focus: id, aimed: finder.aimed + 1 }, picked: state.picked + 1 }));
    }
    return true;
  };

  /** 출발과 도착을 finder에 담고 두 칸이 찼으면 경로를 찾는다. 경로가 나왔는데 함수 시점 뷰면 구조 뷰로 돌아간다. */
  const seek = (from: string | null, to: string | null) => {
    const { graph, showTests, showExternal, view } = get();
    const found =
      graph !== null && from !== null && to !== null ? route(routable(graph), from, to, hidden(graph, { showTests, showExternal })) : null;
    const first = found?.paths[0];
    if (first !== undefined && view.kind === "function") {
      visit({ view: { kind: "structure" } });
    }
    set((state) => ({
      finder: { ...state.finder, from, to, route: found, pick: 0, focus: first?.[0] ?? null, aimed: state.finder.aimed + 1 },
    }));
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
    layout: null,
    history: { entries: [placeOf(START)], index: 0 },
    finder: FINDER,
    panel: null,
    split: null,
    factsOpen: true,
    summaryOpen: true,
    legendOpen: false,
    minimapOpen: true,
    paletteOpen: false,
    reloading: false,
    reloadError: null,
    epoch: 0,
    homed: 0,
    picked: 0,
    arranging: false,
    arranged: null,
    fitted: false,

    restore: () => {
      const ui = parseUi(localStorage.getItem(UI_KEY), preferredTheme());
      set(ui);
      applyTheme(ui.theme);
    },
    load: () =>
      Promise.all([getRepo(), getGraph(), getTree()])
        .then(([repo, graph, tree]) => {
          set(opened(repo, graph, tree, get().showTests));
          cover(graph, get());
        })
        .catch((caught: unknown) => set({ error: caught instanceof Error ? caught.message : String(caught) })),
    refresh: (repo, graph, tree) =>
      set((state) => {
        const fit = (place: Place) => placeIn(place, graph, state.graph);
        const { view, selection, via, collapsed, unpacked } = fit(placeOf(state));
        const toggles = { showTests: state.showTests, showExternal: state.showExternal };
        const live = routable(graph);
        const has = (id: string | null) => (id !== null && live.nodes.some((n) => n.id === id) ? id : null);
        const [from, to] = [has(state.finder.from), has(state.finder.to)];
        const found = from !== null && to !== null ? route(live, from, to, hidden(graph, toggles)) : null;
        const pick = found !== null && state.finder.pick < found.paths.length ? state.finder.pick : 0;
        const path = found?.paths[pick];
        const focus = state.finder.focus !== null && path?.includes(state.finder.focus) === true ? state.finder.focus : (path?.[0] ?? null);
        return {
          repo,
          graph,
          tree,
          error: null,
          view,
          selection,
          via,
          collapsed: new Set(collapsed),
          unpacked: unpackedFor({ graph, ...toggles, selection, unpacked: new Set(unpacked) }),
          history: remap(state.history, fit),
          finder: { ...state.finder, from, to, route: found, pick, focus },
          arranged: null,
          epoch: state.epoch + 1,
        };
      }),
    resetView: guarded(() => {
      const { graph, showTests } = get();
      if (graph === null) {
        return;
      }
      visit({ view: { kind: "structure" }, selection: null, collapsed: startFolds(graph, showTests), unpacked: new Set() });
      set((state) => ({ homed: state.homed + 1 }));
    }),

    select: (id) =>
      focused(id) ||
      guarded(() => {
        if (id === null) {
          visit({ selection: null });
          return;
        }
        const kind = kindOf(id);
        if (kind === undefined) {
          return;
        }
        const selection = get().selection;
        if (selection?.type === "node" && selection.id === id) {
          if (kind === "module" || kind === "package" || kind === "external") {
            visit({ selection: null });
          } else {
            set((state) => ({ picked: state.picked + 1 }));
          }
          return;
        }
        visit({ selection: { type: "node", id }, collapsed: revealed(id) });
      })(),
    show: (id) =>
      focused(id) ||
      guarded(() => {
        if (id === null) {
          visit({ view: { kind: "structure" }, selection: null });
        } else if (kindOf(id) !== undefined) {
          visit({ view: { kind: "structure" }, selection: { type: "node", id }, collapsed: revealed(id) });
        }
      })(),
    selectEdge: guarded((key) => visit({ selection: { type: "edge", key, focus: focusOf(get().selection) } })),
    toggleFolder: guarded(toggle),
    follow: (keys, to) =>
      focused(to) ||
      guarded(() => {
        const kind = kindOf(to);
        if (kind === undefined) {
          return;
        }
        const via = [...keys].sort();
        if (kind === "package") {
          visit({ collapsed: new Set([...get().collapsed].filter((folder) => folder !== to)), selection: null, via });
        } else {
          visit({ selection: { type: "node", id: to }, collapsed: revealed(to), via });
        }
      })(),
    togglePack: guarded((id) => {
      const unpacked = new Set(get().unpacked);
      if (!unpacked.delete(id)) {
        unpacked.add(id);
        visit({ unpacked });
      } else {
        visit(packOf(get()) === id ? { unpacked, selection: { type: "node", id } } : { unpacked });
      }
    }),
    setDepth: guarded((depth) => keep({ depth })),
    enterFunction: guarded((id) => {
      const kind = kindOf(id);
      if (kind !== undefined && kind !== "variable") {
        enter(id);
      }
    }),
    expandFunction: guarded((id) => {
      const view = get().view;
      if (view.kind === "function" && !view.expanded.includes(id)) {
        visit({ view: { ...view, expanded: [...view.expanded, id] } });
      }
    }),
    leaveFunction: () => {
      const { view, selection } = get();
      if (view.kind === "function") {
        get().show(focusOf(selection) ?? view.center);
      }
    },
    open: guarded((id, from) => {
      const kind = kindOf(id);
      const place = from.entries[from.index];
      const centered = place.view.kind === "function" && place.view.center === id;
      if (!centered && kind !== "function" && kind !== "method") {
        return;
      }
      restore(from);
      if (!centered) {
        enter(id);
      }
    }),
    back: guarded(() => {
      if (!get().cancelArranging()) {
        restore(back(get().history));
      }
    }),
    forward: guarded(() => restore(forward(get().history))),
    jump: guarded((index) => restore(jump(get().history, index))),
    cancelArranging: () => {
      const { arranged } = get();
      if (arranged === null || !undoable(get())) {
        return false;
      }
      restore(arranged);
      return true;
    },
    toggleTests: guarded(() => {
      set((state) => ({ showTests: !state.showTests, unpacked: unpackedFor({ ...state, showTests: !state.showTests }) }));
      seek(get().finder.from, get().finder.to);
    }),
    toggleExternal: guarded(() => {
      set((state) => ({ showExternal: !state.showExternal, unpacked: unpackedFor({ ...state, showExternal: !state.showExternal }) }));
      seek(get().finder.from, get().finder.to);
    }),
    toggleFinder: () => set((state) => ({ finder: { ...state.finder, open: !state.finder.open } })),
    setEnd: (end, id) => {
      const kind = id === null ? null : kindOf(id);
      if (kind === undefined || kind === "package" || kind === "variable") {
        return;
      }
      const { from, to } = get().finder;
      seek(end === "from" ? id : from, end === "to" ? id : to);
    },
    swapEnds: () => seek(get().finder.to, get().finder.from),
    pickPath: (index) => {
      const finder = get().finder;
      const path = finder.route?.paths[index];
      if (path !== undefined) {
        set({ finder: { ...finder, pick: index, focus: path[0], aimed: finder.aimed + 1 } });
      }
    },
    clearFinder: () => seek(null, null),
    toggleAutoSummary: () => keep({ autoSummary: !get().autoSummary }),
    setTheme: (theme) => {
      keep({ theme });
      applyTheme(theme);
    },
    setLayout: (layout) => keep({ layout }),
    setPanel: (rect) => keep({ panel: rect }),
    setSplit: (split) => keep({ split }),
    toggleFacts: () => keep({ factsOpen: !get().factsOpen }),
    toggleSummary: () => keep({ summaryOpen: !get().summaryOpen }),
    toggleLegend: () => set({ legendOpen: !get().legendOpen }),
    toggleMinimap: () => keep({ minimapOpen: !get().minimapOpen }),
    setPalette: (open) => set({ paletteOpen: open }),
  };
});
