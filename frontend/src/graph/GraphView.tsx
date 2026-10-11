// 관계 그래프. 저장소의 뷰 종류에 따라 구조 뷰나 함수 시점 뷰를 그린다. 구조 뷰는 저장소 상태에서 보이는 노드와
// 그릴 선을 정해 배치를 부르고, 배치가 바뀌면 노드를 움직이며 고른 노드나 선이 가리킨 폴더로 화면을 옮긴다. 경로 고정 중에는 고른 노드의 흐름 대신
// 강조하는 경로를 그리고, finder.focus를 정할 때마다 그 노드와 다음 걸음이 보이게 화면을 옮긴다. 전체 맞춤 상태(저장소의 fitted)에서는
// 배치가 바뀔 때마다 화면을 다시 맞추고, 이름표가 읽히는 확대 비율 아래로 줄이지 않는다.
import {
  getViewportForBounds,
  ReactFlow,
  useReactFlow,
  useStore,
  ViewportPortal,
  type NodeMouseHandler,
  type OnMove,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { AtlasNode, Graph } from "../api/types";
import { useOpened } from "../panel/opened";
import { focusOf, type History } from "../state/history";
import { useOverlay } from "../state/overlay";
import { chosenOf, litOf, useAtlas } from "../state/store";
import { makingKey, makingOf, useSummaries } from "../state/summaries";
import { useAim } from "./aim";
import { Arranging, keepLayout, watchLayout } from "./arranging";
import { CallView } from "./CallView";
import { columns, type Columns } from "./columns";
import { cycles } from "./cycles";
import { edgeTypes, Markers, useFlowEdges } from "./edges/OrthogonalEdge";
import { flow, opacities, type Flow } from "./flow";
import { functionCounts, labelOf, layout, packId, packLabel, titleOf, type Box, type Layout, type Point, type RouteEnd } from "./layout";
import { Dock } from "./Dock";
import { play, reducedMotion, settled, tween } from "./motion";
import { GROUP_NAMES, STEP_NAMES } from "./names";
import { faceId, LAYER } from "./layers";
import { flowNodes, parts, pointing, pressable, type AtlasFlowNode, type AtlasNodeData, type Drawn } from "./nodes/common";
import { nodeType, nodeTypes } from "./nodes";
import { isPack, type PackFlowNode } from "./nodes/PackNode";
import { cycleLines, cycleMarks, UNUSED_OPACITY, unusedCounts } from "./overlay";
import type { Lit } from "./route";
import { drawn, type EdgeKey } from "./scope";
import { clipped, nodeTip, packTip, tipOf } from "./tips";
import { Tooltip, type TooltipHandle } from "./Tooltip";
import { edgeViews, NO_LINES, parentFirst, type Lines } from "./view";
import { anchorOn, autoView, boundsOf, centerOn, cornerInto, fitPadding, FRAME_ZOOM, frameOn, NAMED_ZOOM, PAN_MS, stageOf, ZOOM_MAX, ZOOM_MIN, type Stage } from "./viewport";
import { hidden, insideCounts, lift, local, nodeIndex, shown, type Shown } from "./visible";

const SHELF_NAME = "연결 없음";
const NO_BOXES = new Map<string, Box>();
const SHELF_NAME_HEIGHT = 22;

/** 배치 한 번과 그 배치를 만든 입력. 노드와 선은 늘 같은 Scene에서 만든다. */
interface Scene {
  graph: Graph;
  columns: Columns;
  shown: Shown;
  flow: Flow | null;
  /** 경로 고정 중에 강조하는 경로. 있으면 flow와 focus는 null이다. */
  lit: Lit | null;
  /** 초점을 둔 노드 */
  focus: string | null;
  /** 토글, 접은 폴더, 전부 펼친 파일 상자, 미사용 덮개를 켰는지와 미사용 후보, 초점을 둔 노드, 흐름 단계를 적은 글. 같은 그래프와 경로에서 이 글이 같으면 배치가 같다. */
  key: string;
  /** 접은 폴더와 전부 펼친 파일 상자 */
  collapsed: Set<string>;
  unpacked: Set<string>;
  layout: Layout;
}

/** 분석 덮개가 노드에 더하는 표시 */
interface Cover {
  /** 순환 아이콘을 다는 상자와 묶음마다 든 파일 id */
  cycle: Map<string, string[][]>;
  /** 미사용 덮개가 표시하는 후보. 덮개를 껐으면 비어 있다. */
  unused: Set<string>;
  /** 파일과 폴더마다 미사용 후보 수. 덮개를 껐으면 비어 있다. */
  candidates: Map<string, number>;
}


/** 강조하는 경로의 출발 노드와 도착 노드 */
function endsOf(lit: Lit | null): Map<string, RouteEnd> {
  const ends = new Map<string, RouteEnd>();
  if (lit !== null) {
    ends.set(lit.path[0], "from").set(lit.path[lit.path.length - 1], "to");
  }
  return ends;
}

/** selected는 선택 고리를 그리는 노드이고 cover는 분석 덮개의 표시다. 경로 위의 미사용 후보는 점선 테두리만 받고 흐려지지 않는다. */
function itemsOf(
  scene: Scene,
  nodes: Map<string, AtlasNode>,
  functions: Map<string, number>,
  making: string[],
  selected: string | null,
  cover: Cover,
): Drawn<AtlasNodeData>[] {
  const order = parentFirst(scene.graph, scene.shown.nodes);
  const parents = new Set(order.map((n) => n.parent));
  const dim = opacities(scene.graph, scene.flow, scene.lit);
  const ends = endsOf(scene.lit);
  const inside = insideCounts(scene.graph, scene.shown.hidden);
  /** 화면에 보이는 노드마다, 그 노드로 올린 노드 가운데 요약을 만드는 중인 노드 수 */
  const busy = new Map<string | null, number>();
  for (const id of making) {
    const shownId = lift(nodes, scene.shown, id);
    busy.set(shownId, (busy.get(shownId) ?? 0) + 1);
  }
  return order.map((node) => {
    const opacity = dim.get(node.id) ?? 1;
    const expanded = parents.has(node.id);
    const route: AtlasNodeData["route"] = scene.lit?.nodes.has(node.id) === true ? (ends.get(node.id) ?? "via") : null;
    const { body, face } = parts({
      node,
      functions: functions.get(node.id) ?? 0,
      expanded,
      selected: node.id === selected,
      flow: (scene.flow !== null || scene.lit !== null) && opacity > 0.2,
      local: scene.flow !== null && node.id !== scene.flow.file && local(nodes, scene.flow, node.id),
      inside: expanded ? 0 : (inside.get(node.id) ?? 0),
      busy: busy.get(node.id) ?? 0,
      route,
      cycle: cover.cycle.get(node.id)?.map((group) => group.map((id) => titleOf(nodes.get(id)!))) ?? null,
      unused: cover.unused.has(node.id),
      candidates: cover.candidates.get(node.id) ?? 0,
    });
    return {
      id: node.id,
      type: nodeType(node.kind),
      opacity: cover.unused.has(node.id) && route === null ? Math.min(opacity, UNUSED_OPACITY) : opacity,
      body,
      face,
    };
  });
}

/**
 * 손잡이마다 화면 기준 상자 at에 놓은 React Flow 노드. 글자와 같은 층에 그리고 불투명도는 손잡이를 단 상자의 값을 쓴다.
 * covered는 미사용 덮개를 켰는지다.
 */
function packNodes(scene: Scene, nodes: Map<string, AtlasNode>, at: Map<string, Box>, opacity: Map<string, number>, covered: boolean, fresh: Set<string> | null): PackFlowNode[] {
  const result: PackFlowNode[] = [];
  for (const [box, pack] of scene.shown.packs) {
    const id = packId(box);
    const place = at.get(id);
    if (place === undefined) {
      continue;
    }
    result.push({
      id,
      type: "pack",
      position: { x: place.x, y: place.y },
      width: place.width,
      height: place.height,
      zIndex: LAYER.text,
      draggable: false,
      connectable: false,
      style: { opacity: fresh?.has(box) === true ? 0 : (opacity.get(box) ?? 1) },
      data: { box, label: packLabel(pack, covered), open: pack.open, tip: packTip(pack.ids.map((kid) => titleOf(nodes.get(kid)!))) },
    });
  }
  return result;
}

/** 선반 단위 가운데 가장 왼쪽 위 상자의 왼쪽 위. 선반이 비었으면 null이다. */
function shelfCorner(scene: Scene, at: Layout): Point | null {
  const boxes = scene.columns.shelf.map((id) => at.boxes.get(id)).filter((box) => box !== undefined);
  if (boxes.length === 0) {
    return null;
  }
  return { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)) };
}

/** 도착 표시를 상자의 테두리에 맞춰 그리는 자리 */
function ringOf(box: Box) {
  return { transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height };
}

/**
 * 코드가 스스로 맞추는 화면(`autoView`). 배치 전체가 이름표가 읽히는 확대 비율로 정보 패널이 가리지 않는 영역에 들어오면 전체를 맞추고
 * (확대 비율을 100%보다 키우지 않는다), 들어오지 않으면 사용자가 방금 펼치거나 접은 상자 pressed의 왼쪽 위를, 그런 상자가 없으면
 * 그래프의 왼쪽 위를 그 영역의 왼쪽 위에 놓는다.
 */
function fittedView(at: Layout, { area, free }: Stage, pressed: string | null): Viewport {
  const bounds = boundsOf(at.boxes.values());
  const whole = getViewportForBounds(bounds, area.width, area.height, ZOOM_MIN, FRAME_ZOOM, fitPadding(area, free));
  return autoView(whole, at.boxes.get(pressed ?? "") ?? bounds, free);
}

export function GraphView() {
  const view = useAtlas((s) => s.view);
  /** 구조 뷰의 화면 위치와 확대 비율. 레포를 열어 화면을 맞추기 전에는 null이다. */
  const home = useRef<Viewport | null>(null);
  return view.kind === "function" ? (
    <CallView center={view.center} expanded={view.expanded} />
  ) : (
    <StructureView home={home} />
  );
}

function StructureView({ home }: { home: RefObject<Viewport | null> }) {
  const graph = useAtlas((s) => s.graph);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const selection = useAtlas((s) => s.selection);
  const depth = useAtlas((s) => s.depth);
  const collapsed = useAtlas((s) => s.collapsed);
  const finder = useAtlas((s) => s.finder);
  const select = useAtlas((s) => s.select);
  const selectEdge = useAtlas((s) => s.selectEdge);
  const toggleFolder = useAtlas((s) => s.toggleFolder);
  const openFolder = useAtlas((s) => s.openFolder);
  const togglePack = useAtlas((s) => s.togglePack);
  const unpacked = useAtlas((s) => s.unpacked);
  const open = useAtlas((s) => s.open);
  const making = useSummaries(makingKey);
  const overlay = useOverlay((s) => s.kind);
  const candidates = useOverlay((s) => s.unused);
  const { getViewport, setViewport } = useReactFlow();
  /** 확대 비율 구간. 구간이 바뀔 때만 다시 그린다. */
  const zoom = useStore((s) => (s.transform[2] < 0.4 ? 0 : s.transform[2] < NAMED_ZOOM ? 1 : 2));

  const [scene, setScene] = useState<Scene | null>(null);
  const [nodes, setNodes] = useState<AtlasFlowNode[]>([]);
  const [packs, setPacks] = useState<PackFlowNode[]>([]);
  const [shelf, setShelf] = useState<Point | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 선을 눌러 간 폴더와 간 횟수. 그 폴더 영역에 도착 표시를 잠깐 그린다. */
  const [reached, setReached] = useState<{ id: string; count: number } | null>(null);
  /** 마우스를 올린 노드 id */
  const [hover, setHover] = useState<string | null>(null);
  /** 마우스를 올린 노드 가운데 그 위치에서 눌리는 노드 id. 경로 고정 중에는 경로 위 노드만이다. */
  const [aimedNode, setAimedNode] = useState<string | null>(null);

  /** 이 컴포넌트를 그리기 시작할 때의 화면 */
  const [start] = useState(() => home.current ?? undefined);
  const root = useRef<HTMLDivElement | null>(null);
  const tip = useRef<TooltipHandle | null>(null);
  /** 지금 화면에 그린 배치. 움직임은 여기서 출발한다. */
  const onScreen = useRef<Layout | null>(null);
  /** 화면에 그린 배치의 입력 */
  const arranged = useRef<Pick<Scene, "graph" | "columns" | "lit" | "key"> | null>(null);
  /** 화면에 그린 배치의 그래프와 접은 폴더, 전부 펼친 상자. 다음 배치에서 펼치거나 접은 상자 하나를 찾는 데 쓴다. */
  const folds = useRef<Pick<Scene, "graph" | "collapsed" | "unpacked"> | null>(null);
  /** 화면을 옮겨 둔 노드나 경로와 그때의 finder.aimed */
  const panned = useRef<{ aim: string | Lit | null; aimed: number }>({ aim: null, aimed: 0 });
  /** 선을 눌러 가는 폴더. 그 폴더를 펼친 배치가 오면 화면을 옮긴다. */
  const bound = useRef<string | null>(null);
  /** 직전에 한 번 누른 노드와 누르기 전의 이력. 두 번째 클릭이 어디에 떨어져도 이 노드의 더블클릭으로 본다. */
  const clicked = useRef<{ id: string; from: History } | null>(null);
  /** 초점을 둔 노드. 선을 골라도 직전에 고른 노드의 초점을 유지한다. */
  const focus = focusOf(selection);
  const lit = useMemo(() => litOf(finder), [finder.route, finder.pick]);
  const pinFocus = finder.focus;
  const aimed = finder.aimed;

  const index = useMemo(
    () => (graph === null ? null : { nodes: nodeIndex(graph), functions: functionCounts(graph) }),
    [graph],
  );
  const cols = useMemo(
    () => (graph === null ? null : columns(graph, { showTests, showExternal })),
    [graph, showTests, showExternal],
  );
  const target = useMemo(() => {
    if (graph === null || index === null) {
      return null;
    }
    const toggles = { showTests, showExternal };
    const off = hidden(graph, toggles);
    const covered = overlay === "unused";
    const boxes = { collapsed, unpacked, marked: covered ? candidates : undefined, candidates };
    const state = [toggles, [...collapsed].sort(), [...unpacked].sort(), covered, [...candidates].sort()];
    if (lit !== null) {
      return { flow: null, lit, focus: null, key: JSON.stringify(state), collapsed, unpacked, shown: shown(graph, { ...toggles, ...boxes, flow: null, lit }) };
    }
    const picked = focus !== null && index.nodes.has(focus) && !off.has(focus) ? flow(graph, focus, depth, off) : null;
    const key = JSON.stringify([...state, picked === null ? null : [focus, depth]]);
    return { flow: picked, lit, focus: picked === null ? null : focus, key, collapsed, unpacked, shown: shown(graph, { ...toggles, ...boxes, flow: picked, lit }) };
  }, [graph, index, showTests, showExternal, collapsed, unpacked, overlay, candidates, focus, depth, lit]);

  /** 상자가 정보 패널과 왼쪽 아래 칸이 가리지 않는 영역의 가운데에 오게 화면을 옮기고 전체 맞춤 상태를 끈다. 확대 비율은 `NAMED_ZOOM`보다 작을 때만 그 값으로 키운다. */
  const panTo = (box: Box) => {
    if (root.current === null) {
      return;
    }
    const scale = Math.max(getViewport().zoom, NAMED_ZOOM);
    useAtlas.setState({ fitted: false });
    void setViewport({ ...centerOn(box, stageOf(root.current).clear, scale), zoom: scale }, { duration: reducedMotion() ? 0 : PAN_MS });
  };
  /** 선을 눌러 폴더 id에 왔다. 전체 맞춤 상태가 아니면 그 폴더의 상자로 화면을 옮기고, 도착 표시를 그린다. */
  const arrive = (id: string, box: Box) => {
    setReached((before) => ({ id, count: (before?.count ?? 0) + 1 }));
    if (!useAtlas.getState().fitted) {
      panTo(box);
    }
  };

  // 느린 배치를 취소하면 입력이 화면에 그린 배치의 입력으로 돌아오므로 다시 계산하지 않는다.
  useEffect(() => {
    if (graph === null || cols === null || target === null) {
      return;
    }
    const input = { graph, columns: cols, lit: target.lit, key: target.key };
    const last = arranged.current;
    if (last !== null && last.graph === graph && last.columns === cols && last.lit === input.lit && last.key === input.key) {
      keepLayout();
      return;
    }
    return watchLayout(
      layout(graph, target.shown, cols, endsOf(target.lit)),
      (result) => {
        arranged.current = input;
        setScene({ graph, columns: cols, ...target, layout: result });
      },
      setError,
    );
  }, [graph, cols, target]);

  // 레포를 열면 정보 패널이 가리지 않는 영역에 그래프 전체를 맞추고 확대 비율을 100%보다 키우지 않는다. 함수 시점 뷰에서 돌아오면 떠날 때의 화면에서 시작한다.
  useEffect(() => {
    if (scene === null || home.current !== null || root.current === null) {
      return;
    }
    home.current = fittedView(scene.layout, stageOf(root.current), null);
    void setViewport(home.current);
    useAtlas.setState({ fitted: true });
  }, [scene, home, setViewport]);
  useEffect(
    () => () => {
      if (home.current !== null) {
        home.current = getViewport();
      }
    },
    [home, getViewport],
  );

  /** 지금 배치의 순환 묶음. 배치가 순환 아이콘의 폭을 잡을 때와 같은 숨긴 노드로 찾는다. */
  const loops = useMemo(() => (scene === null ? null : cycles(scene.graph, scene.shown.hidden)), [scene]);
  const cover = useMemo((): Cover | null => {
    if (scene === null || loops === null) {
      return null;
    }
    const unused = overlay === "unused" ? candidates : new Set<string>();
    return { cycle: cycleMarks(scene.graph, loops, scene.shown), unused, candidates: unusedCounts(scene.graph, unused) };
  }, [scene, loops, overlay, candidates]);

  useEffect(() => {
    if (scene === null || index === null || cover === null) {
      return;
    }
    const items = itemsOf(scene, index.nodes, index.functions, makingOf(making), scene.lit === null ? scene.focus : pinFocus, cover);
    const to = scene.layout;
    const from = onScreen.current;
    const still = reducedMotion();
    const dims = new Map(items.map((item) => [item.id, item.opacity]));

    const last = folds.current;
    folds.current = scene;
    const differ = (a: Set<string>, b: Set<string>) => [...a].filter((id) => !b.has(id)).concat([...b].filter((id) => !a.has(id)));
    const changed = last === null || last.graph !== scene.graph ? [] : [...differ(last.collapsed, scene.collapsed), ...differ(last.unpacked, scene.unpacked)];
    const aim = scene.lit ?? scene.focus;
    const fresh = aim !== panned.current.aim;
    /** 이 배치가 펼친, 선을 눌러 가는 폴더의 상자. 배치가 그 폴더를 펼치지 않았으면(느린 배치를 취소했으면) 가지 않는다. */
    const came = last === scene || bound.current === null || scene.collapsed.has(bound.current) ? undefined : to.boxes.get(bound.current);
    if (last !== scene) {
      if (came !== undefined) {
        arrive(bound.current!, came);
      }
      bound.current = null;
    }

    // 고른 노드나 강조하는 경로가 바뀌면 화면을 옮기고 전체 맞춤 상태를 끈다. 경로 고정 중에는 finder.focus를 정할 때마다 옮긴다.
    // 강조하는 경로의 배치가 아직 오지 않았으면 그 배치가 올 때까지 기다린다.
    if (scene.lit === lit && (fresh || (lit !== null && aimed !== panned.current.aimed)) && root.current !== null) {
      panned.current = { aim, aimed };
      const path = scene.lit?.path.filter((id) => to.boxes.has(id)) ?? [];
      const at = Math.max(path.indexOf(pinFocus ?? ""), 0);
      const box = to.boxes.get(scene.lit === null ? (scene.focus ?? "") : path[at]);
      if (box !== undefined && scene.lit === null) {
        panTo(box);
      } else if (box !== undefined) {
        const boxes = path.map((id) => to.boxes.get(id)!);
        const step = boundsOf([box, boxes[at + 1] ?? boxes[at - 1] ?? box]);
        useAtlas.setState({ fitted: false });
        void setViewport(frameOn(boxes, step, box, stageOf(root.current).clear, getViewport(), fresh), { duration: still ? 0 : PAN_MS });
      }
    }

    // 전체 맞춤 상태에서 배치가 바뀌면 화면을 다시 맞춘다(`fittedView`).
    const whole = useAtlas.getState().fitted;
    if (whole && from !== null && !settled(from, to) && root.current !== null) {
      void setViewport(fittedView(to, stageOf(root.current), changed.length === 1 ? changed[0] : null), { duration: still ? 0 : PAN_MS });
    }

    // 전체 맞춤 상태가 아닐 때 폴더나 손잡이를 눌러 상자 하나를 펼치거나 접었으면 그 상자의 왼쪽 위 모서리를 화면의 같은 좌표에 둔다.
    // 확대 비율은 그대로다. 노드를 골라 그 노드를 품은 폴더가 펼쳐졌으면 고른 노드로, 선을 눌러 폴더를 펼쳤으면 그 폴더로 화면을 옮기므로
    // 상자를 붙잡지 않는다.
    const toggled = !whole && came === undefined && changed.length === 1 && (aim === null || !fresh) ? changed[0] : null;
    const before = toggled === null ? undefined : from?.boxes.get(toggled);
    const held = before === undefined ? null : { id: toggled!, before, view: getViewport() };

    const draw = (at: Layout, fresh: Set<string> | null) => {
      onScreen.current = at;
      setNodes(flowNodes(items, at.boxes, fresh));
      setPacks(packNodes(scene, index.nodes, at.boxes, dims, overlay === "unused", fresh));
      setShelf(shelfCorner(scene, at));
      const box = held === null ? undefined : at.boxes.get(held.id);
      if (held !== null && box !== undefined) {
        void setViewport(anchorOn(held.before, box, held.view));
      }
    };
    /** 펼치거나 접은 상자의 왼쪽 위 모서리가 정보 패널과 왼쪽 아래 칸이 가리지 않는 영역을 벗어났으면 모서리가 들어오게만 옮긴다. */
    const reveal = () => {
      const box = toggled === null ? undefined : to.boxes.get(toggled);
      if (box === undefined || root.current === null) {
        return;
      }
      const view = held === null ? getViewport() : anchorOn(held.before, box, held.view);
      const next = cornerInto(box, stageOf(root.current).clear, view);
      if (next.x !== view.x || next.y !== view.y) {
        void setViewport(next, { duration: still ? 0 : PAN_MS });
      }
    };

    if (from === null || still || settled(from, to)) {
      draw(to, null);
      setMoving(false);
      reveal();
      return;
    }
    const added = new Set(items.filter((item) => !from.boxes.has(item.id)).map((item) => item.id));
    draw(tween(from, to, 0), added);
    setMoving(true);
    return play(
      from,
      to,
      (at) => draw(at, null),
      () => {
        setMoving(false);
        reveal();
      },
    );
  }, [scene, index, making, lit, pinFocus, aimed, cover, overlay, getViewport, setViewport]);

  const hovered = hover !== null && scene?.shown.nodes.has(hover) === true ? hover : null;
  /** 그릴 선과 그 가운데 순환 선의 키. 순환 덮개를 켠 동안에만 순환 선을 넣고 칠한다. */
  const lines = useMemo(() => {
    if (scene === null || loops === null) {
      return { edges: [], keys: new Set<EdgeKey>() };
    }
    const edges = drawn(scene.graph, scene.shown, scene.flow, hovered, scene.lit);
    return overlay === "cycles" ? cycleLines(scene.graph, scene.shown, scene.flow, scene.lit, edges, loops) : { edges, keys: new Set<EdgeKey>() };
  }, [scene, loops, overlay, hovered]);
  const views = useMemo(
    (): Lines => (scene === null || index === null ? NO_LINES : edgeViews(lines.edges, scene.layout, index.nodes)),
    [scene, index, lines],
  );
  const chosen = chosenOf({ finder, selection });
  const nameOf = (id: string) => {
    const node = index?.nodes.get(id);
    return node === undefined ? id : titleOf(node);
  };
  /**
   * 선의 hover와 클릭(`aim.tsx`). 선을 누르면 도착 노드를 고르고 이미 고른 노드면 그대로 둔다. 도착 노드가 폴더면 그 폴더로 간다(`go`). Shift를 누른 채면 그 선을 골라
   * 정보 패널에 지점 목록을 연다. 경로 고정 중에는 경로의 걸음만 강조하고, 그 밖의 선은 말풍선만 띄운다.
   */
  const aim = useAim({
    lines: views,
    boxes: scene?.layout.boxes ?? NO_BOXES,
    tip,
    name: nameOf,
    describe: ({ source, target, group, sites, route }) =>
      `${nameOf(source)} → ${nameOf(target)} · ${sites === 0 && route !== null ? STEP_NAMES[route] : `${GROUP_NAMES[group]} · ${sites}곳`}`,
    only: lit === null ? null : (view) => view.route !== null,
    skip: (event) => {
      const again = repeated(event);
      clicked.current = null;
      return again;
    },
    pick: (target) => {
      clicked.current = null;
      if (index?.nodes.get(target)?.kind === "package") {
        go(target);
      } else if (target !== chosen) {
        select(target);
      }
    },
    open: selectEdge,
  });
  const edges = useFlowEdges(views, aim.pointed, lines.keys);
  const drawnNodes = useMemo(() => [...pointing(nodes, aimedNode), ...packs], [nodes, aimedNode, packs]);

  /**
   * 연달아 누른 두 번째 클릭이면 처음 누른 노드를 열고 참을 돌려준다. 함수·메서드 노드는 함수 시점 뷰로 들어간다.
   * 세 번째부터는 아무 일도 하지 않는다.
   */
  const repeated = (event: ReactMouseEvent): boolean => {
    if (event.detail < 2) {
      return false;
    }
    if (event.detail === 2 && clicked.current !== null) {
      open(clicked.current.id, clicked.current.from);
    }
    return true;
  };

  /**
   * 노드를 누른 동작. 접힌 폴더 상자는 한 단계 펼치고 펼친 폴더 영역의 머리 줄은 그 폴더를 접는다. 그 밖의 노드는 고른다.
   * 손잡이는 `onNodeClick`이 따로 받아 전부 펼침과 펼침을 오간다.
   */
  const press = (id: string) => {
    if (index?.nodes.get(id)?.kind === "package") {
      clicked.current = null;
      toggleFolder(id);
      return;
    }
    clicked.current = { id, from: useAtlas.getState().history };
    select(id);
  };

  /**
   * 선이 가리키는 폴더로 간다. 접힌 폴더면 펼치고 선택을 푼 뒤, 새 배치가 오면 펼친 폴더 영역으로 화면을 옮긴다(`arrive`).
   * 이미 펼쳐 있고 고른 노드도 없어 배치가 그대로면 바로 옮긴다.
   */
  const go = (id: string) => {
    const before = useAtlas.getState().history;
    openFolder(id);
    if (useAtlas.getState().history !== before) {
      bound.current = id;
      return;
    }
    const box = onScreen.current?.boxes.get(id);
    if (lit === null && box !== undefined) {
      arrive(id, box);
    }
  };

  const onNodeClick: NodeMouseHandler<AtlasFlowNode | PackFlowNode> = (event, node) => {
    tip.current?.hide();
    if (isPack(node)) {
      clicked.current = null;
      togglePack(node.data.box);
      return;
    }
    if (repeated(event)) {
      return;
    }
    const opened = node.data.expanded && node.data.node.kind === "module";
    if (opened && (event.target as Element).closest(".node-module-head") === null) {
      clicked.current = null;
      return;
    }
    press(node.data.node.id);
  };
  const onPaneClick = (event: ReactMouseEvent) => {
    tip.current?.hide();
    if (repeated(event)) {
      return;
    }
    clicked.current = null;
    if (useOpened.getState().path !== null) {
      useOpened.getState().close();
    } else {
      select(null);
    }
  };
  /**
   * 마우스 아래가 배지나 표시면 그 뜻을, 아니면 노드의 말풍선(`nodeTip`)을 띄운다. 그 위치에서 눌리는 노드면 선의 hover처럼
   * 가장 진한 단계로 그린다. 경로 고정 중에는 경로 위 노드만 그렇게 그린다. 마우스 버튼을 누른 동안(화면을 끄는 동안)에는
   * 아무것도 하지 않는다.
   */
  const onNodeOver: NodeMouseHandler<AtlasFlowNode | PackFlowNode> = (event, node) => {
    if (event.buttons !== 0) {
      return;
    }
    if (isPack(node)) {
      tip.current?.show(node.data.tip, event.clientX, event.clientY);
      return;
    }
    setHover(node.data.node.id);
    setAimedNode((lit === null || node.data.route !== null) && pressable(node.data, event.target) ? node.data.node.id : null);
    const { id } = node.data.node;
    const title = titleOf(node.data.node);
    const cut = labelOf(node.data.node) !== title || clipped(root.current?.querySelector(`[data-id="${CSS.escape(faceId(id))}"] .node-label`) ?? null);
    const text = tipOf(event.target) ?? nodeTip(cut ? title : null, useSummaries.getState().leads[id] ?? null, node.data.unused);
    tip.current?.show(text, event.clientX, event.clientY);
  };
  /** 사용자가 화면을 끌거나 확대·축소하면 전체 맞춤 상태를 끈다. 코드가 옮긴 화면은 event가 null이다. */
  const released: OnMove = (event) => {
    if (event !== null && useAtlas.getState().fitted) {
      useAtlas.setState({ fitted: false });
    }
  };
  const onNodeLeave = () => {
    setHover(null);
    setAimedNode(null);
    tip.current?.hide();
  };
  if (scene === null) {
    return (
      <div className="graph">
        <div className="graph-empty">{error ?? (graph === null ? "불러오는 중" : "배치하는 중")}</div>
      </div>
    );
  }

  return (
    <div
      className="graph"
      ref={root}
      data-zoom={zoom}
      data-moving={moving ? "" : undefined}
      data-pinned={scene.lit !== null ? "" : undefined}
      data-overlay={overlay ?? undefined}
    >
      <Markers />
      <ReactFlow
        nodes={drawnNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeOver}
        onNodeMouseMove={onNodeOver}
        onNodeMouseLeave={onNodeLeave}
        onEdgeClick={aim.onEdgeClick}
        onEdgeMouseEnter={aim.onEdgeEnter}
        onEdgeMouseMove={aim.onEdgeMove}
        onEdgeMouseLeave={aim.onEdgeLeave}
        onPaneClick={onPaneClick}
        onMove={released}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        zIndexMode="manual"
        defaultViewport={start}
        minZoom={ZOOM_MIN}
        maxZoom={ZOOM_MAX}
        proOptions={{ hideAttribution: true }}
      >
        {reached !== null && !moving && scene.layout.boxes.has(reached.id) && (
          <ViewportPortal>
            <span
              key={reached.count}
              className="reached"
              data-node={reached.id}
              style={{ zIndex: LAYER.text, ...ringOf(scene.layout.boxes.get(reached.id)!) }}
              onAnimationEnd={() => setReached(null)}
            />
          </ViewportPortal>
        )}
        {shelf !== null && (
          <ViewportPortal>
            <span
              className="shelf-name"
              style={{ zIndex: LAYER.text, transform: `translate(${shelf.x}px, ${shelf.y - SHELF_NAME_HEIGHT}px)` }}
            >
              {SHELF_NAME}
            </span>
          </ViewportPortal>
        )}
      </ReactFlow>
      <Dock />
      <Arranging />
      <Tooltip ref={tip} />
      {aim.menu}
    </div>
  );
}
