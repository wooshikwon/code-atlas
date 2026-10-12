// 배치가 정한 직각 경로를 모서리를 둥글려 그린다. 선 분류는 선 모양과 화살촉으로, 초점은 선의 진하기로 가른다.
// 마우스를 올린 선은 `data-pointed`를 받아 1px 굵게, 진하기를 한 단계 올려(`scope.ts`의 `lifted`) 다른 선 위의 층에 그린다.
// 강조하는 경로의 걸음은 `data-route`에 걸음 종류를 받아 굵게 그리고, 선을 눌러 온 상태에서 지나온 선은 `data-via`를 받아 1px 굵게 그린다.
// 순환 의존 표시가 켜진 동안의 순환 선만 critical 색으로 그린다.
import type { Edge, EdgeProps, EdgeTypes } from "@xyflow/react";
import { useMemo, useRef } from "react";
import type { EdgeGroup } from "../../api/types";
import { LAYER } from "../layers";
import { lifted, type EdgeKey, type Tone } from "../scope";
import type { Point } from "../layout";
import { emphasized, ownNumbers, roundedPath, trunkShade, type EdgeView, type Lines, type TrunkView } from "../view";
import { Trunk } from "./Trunk";

/**
 * pointed는 마우스를 올린 선이고 cycle은 순환 의존 표시가 칠하는 순환 선이다. whole은 줄기에 든 선이 줄기 위에 전체 경로를 그리는지다.
 * own은 활성화된 선이 그 선 위에 적는 sites 수의 가운데 점이고, 적지 않으면 null이다. sum은 들어오는 줄기 위에 전체 경로를 그리는 선이
 * 줄기의 들어오는 합계를 자기 선 위에 한 번 더 적을 점과 값이다. 전체 경로가 줄기의 합계를 덮기 때문이다.
 */
export type AtlasFlowEdge = Edge<
  EdgeView & { pointed: boolean; cycle: boolean; whole: boolean; own: Point | null; sum: { at: Point; sites: number } | null },
  "orthogonal"
>;

/** 줄기 하나. pointed는 마우스를 올린 줄기다. */
export type TrunkFlowEdge = Edge<TrunkView & { tone: Tone; opacity: number; pointed: boolean }, "trunk">;

export type FlowEdge = AtlasFlowEdge | TrunkFlowEdge;

export function isTrunk(edge: FlowEdge): edge is TrunkFlowEdge {
  return edge.type === "trunk";
}

const texts = new WeakMap<FlowEdge, string>();

/** 선의 데이터를 적은 글. 두 선의 글이 같으면 그리는 내용이 같다. */
function written(edge: FlowEdge): string {
  let text = texts.get(edge);
  if (text === undefined) {
    text = JSON.stringify(edge.data);
    texts.set(edge, text);
  }
  return text;
}

/** 선이 줄기에 들었는지 */
function bundled(view: EdgeView): boolean {
  return view.trunks.in !== null || view.trunks.out !== null;
}

/**
 * 그릴 선마다 React Flow 선 하나와 줄기마다 하나. 마우스를 올린 선 pointed는 다른 선 위의 층에 그 선의 진하기에서 한 단계 올린
 * 진하기(`lifted`)로 그린다. 줄기에 든 선이 모두 pointed에 들면 그 줄기도 같은 방식으로 그린다. cycles에 든 선은 순환 선이다. 줄기에 든 선은 가지만 그리고,
 * 강조하는 선(`emphasized`)은 줄기 위에 전체 경로를 한 번 더 그리고 그 선의 수를 선 위에 적는다(`ownNumbers`).
 * 같은 층에서는 가지, 줄기, 강조하는 선 순서로 그린다. 마우스를 올려서만 강조하는 선은 다른 선 위의 층에 그리므로 순서를 옮기지 않아,
 * 마우스를 올리고 뗄 때 선의 순서가 바뀌지 않는다. 앞에 만든 선 before 가운데 층과 데이터의 내용이 그대로인 선은 그 객체를
 * 그대로 돌려줘, React Flow가 달라진 선만 다시 그리게 한다.
 */
export function flowEdges(all: Lines, pointed: Set<EdgeKey>, cycles: Set<EdgeKey>, before: FlowEdge[] = []): FlowEdge[] {
  const { views, trunks } = all;
  const drawn = new Map(before.map((edge) => [edge.id, edge]));
  const kept = <E extends FlowEdge>(edge: E): E => {
    const last = drawn.get(edge.id);
    return last !== undefined && last.type === edge.type && last.zIndex === edge.zIndex && written(last) === written(edge) ? (last as E) : edge;
  };
  const marks = (view: EdgeView) => ({ pointed: pointed.has(view.key), cycle: cycles.has(view.key) });
  const numbers = ownNumbers(
    all,
    views.filter((view) => emphasized(view, { pointed: pointed.has(view.key), cycle: false })),
  );
  const stemOf = new Map(trunks.map((trunk) => [trunk.key, trunk]));
  const lines = views.map((view): AtlasFlowEdge => {
    const { pointed: on, cycle } = marks(view);
    const whole = bundled(view) && emphasized(view, { pointed: on, cycle });
    const own = numbers.get(view.key) ?? null;
    const stem = whole && view.trunks.in !== null ? stemOf.get(view.trunks.in)! : null;
    const sum = stem === null || stem.at === null ? null : { at: stem.at, sites: stem.sites };
    return kept({
      id: view.key,
      source: view.source,
      target: view.target,
      type: "orthogonal",
      data: { ...view, ...(on ? lifted(view) : {}), pointed: on, cycle, whole, own, sum },
      zIndex: on ? LAYER.pointed : LAYER.edge,
    });
  });
  const byKey = new Map(views.map((view) => [view.key, view]));
  const stems = trunks.map((trunk): TrunkFlowEdge => {
    const members = trunk.keys.map((key) => byKey.get(key)!);
    const on = trunk.keys.every((key) => pointed.has(key));
    const shade = trunkShade(members, (view) => emphasized(view, marks(view)));
    return kept({
      id: trunk.key,
      source: members[0].source,
      target: members[0].target,
      type: "trunk",
      data: { ...trunk, ...(on ? lifted(shade) : shade), pointed: on },
      zIndex: on ? LAYER.pointed : LAYER.edge,
    });
  });
  const above = new Set(views.filter((view) => bundled(view) && emphasized(view, { pointed: false, cycle: cycles.has(view.key) })).map((view) => view.key));
  return [...lines.filter((line) => !above.has(line.id)), ...stems, ...lines.filter((line) => above.has(line.id))];
}

/** `flowEdges`의 결과. 다시 만들 때 앞의 결과를 넘겨 달라지지 않은 선의 객체를 유지한다. */
export function useFlowEdges(all: Lines, pointed: Set<EdgeKey>, cycles: Set<EdgeKey>): FlowEdge[] {
  const last = useRef<FlowEdge[]>([]);
  return useMemo(() => (last.current = flowEdges(all, pointed, cycles, last.current)), [all, pointed, cycles]);
}

/** 선과 화살촉의 색. 순환 선은 진하기와 관계없이 critical이다. */
export type Ink = Tone | "critical";

const INKS: Ink[] = ["muted", "strong", "critical"];

export function markerId(group: EdgeGroup, ink: Ink): string {
  return `arrow-${group}-${ink}`;
}

/** 분류 세 개와 색 세 개의 화살촉. 끝점이 노드 테두리에 닿도록 화살촉 끝을 경로 끝에 맞춘다. */
export function Markers() {
  return (
    <svg className="edge-markers" width={0} height={0} aria-hidden>
      <defs>
        {INKS.map((tone) => (
          <g key={tone}>
            <marker id={markerId("run", tone)} viewBox="0 0 10 10" refX={10} refY={5} markerWidth={9} markerHeight={9} markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M0,1 L10,5 L0,9 Z" className={`marker-fill tone-${tone}`} />
            </marker>
            <marker id={markerId("use", tone)} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={9} markerHeight={9} markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M1,1 L9,5 L1,9" className={`marker-open tone-${tone}`} />
            </marker>
            <marker id={markerId("derive", tone)} viewBox="0 0 12 12" refX={11} refY={6} markerWidth={13} markerHeight={13} markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M1,1 L11,6 L1,11 Z" className={`marker-hollow tone-${tone}`} />
            </marker>
          </g>
        ))}
      </defs>
    </svg>
  );
}

/**
 * 선 하나. 줄기에 든 선은 두 줄기 사이의 가지를 그리고, 강조하는 선이면 그 위에 출발부터 도착까지의 경로를 화살촉과 함께
 * 한 번 더 그린다. 가지는 들어오는 줄기에 들지 않았을 때만 화살촉을 단다. 누름 영역은 가지다. 숫자는 도착 노드 앞의 들어오는 합계와,
 * 강조하는 선 위에 적는 그 선의 수 두 가지다.
 */
export function OrthogonalEdge({ data }: EdgeProps<AtlasFlowEdge>) {
  if (data === undefined) {
    return null;
  }
  const ink: Ink = data.cycle ? "critical" : data.tone;
  const branch = roundedPath(data.branch);
  const arrow = `url(#${markerId(data.group, ink)})`;
  /** 따로 들어가는 선은 도착 노드 앞의 합계를 늘 적고, 들어오는 줄기에 든 선은 활성화됐을 때만 그 선 위에 그 선의 수를 적는다. */
  const number = data.into ?? data.own;
  return (
    <g
      className={`edge edge-${data.group} tone-${ink}`}
      data-key={data.key}
      data-trunk-in={data.trunks.in ?? undefined}
      data-trunk-out={data.trunks.out ?? undefined}
      data-whole={data.whole ? "" : undefined}
      data-below={data.below ? "" : undefined}
      data-sites={data.sites}
      data-pointed={data.pointed ? "" : undefined}
      data-cycle={data.cycle ? "" : undefined}
      data-route={data.route ?? undefined}
      data-via={data.via ? "" : undefined}
      style={{ opacity: data.opacity }}
    >
      <path className="edge-hit" d={branch} />
      {data.whole ? (
        <path className="edge-line" d={roundedPath(data.points)} markerEnd={arrow} />
      ) : (
        <path className="edge-line" d={branch} markerEnd={data.trunks.in === null ? arrow : undefined} />
      )}
      {number !== null && (
        <text className="edge-weight" x={number.x} y={number.y} dy="0.35em" textAnchor="middle">
          {data.sites}
        </text>
      )}
      {data.sum !== null && (
        <text className="edge-weight edge-sum" x={data.sum.at.x} y={data.sum.at.y} dy="0.35em" textAnchor="middle">
          {data.sum.sites}
        </text>
      )}
    </g>
  );
}

export const edgeTypes: EdgeTypes = { orthogonal: OrthogonalEdge, trunk: Trunk };
