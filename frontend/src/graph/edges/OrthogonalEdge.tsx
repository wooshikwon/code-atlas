// 배치가 정한 직각 경로를 모서리를 둥글려 그린다. 선 분류는 선 모양과 화살촉으로, 초점은 선의 진하기로 가른다.
// 강조하는 경로의 걸음은 `data-route`에 걸음 종류를 받아 굵게 그린다.
// 순환 덮개가 켜진 동안의 순환 선만 critical 색으로 그린다.
import type { Edge, EdgeProps, EdgeTypes } from "@xyflow/react";
import type { EdgeGroup } from "../../api/types";
import { LAYER } from "../layers";
import { EDGE_OPACITY, type EdgeKey, type Tone } from "../scope";
import { emphasized, roundedPath, trunkShade, type EdgeView, type Lines, type TrunkView } from "../view";
import { Trunk } from "./Trunk";

/** pointed는 마우스를 올린 선이고 cycle은 순환 덮개가 칠하는 순환 선이다. whole은 줄기에 든 선이 줄기 위에 전체 경로를 그리는지다. */
export type AtlasFlowEdge = Edge<EdgeView & { pointed: boolean; cycle: boolean; whole: boolean }, "orthogonal">;

/** 줄기 하나. pointed는 마우스를 올린 줄기다. */
export type TrunkFlowEdge = Edge<TrunkView & { tone: Tone; opacity: number; pointed: boolean }, "trunk">;

export type FlowEdge = AtlasFlowEdge | TrunkFlowEdge;

export function isTrunk(edge: FlowEdge): edge is TrunkFlowEdge {
  return edge.type === "trunk";
}

/**
 * 그릴 선마다 React Flow 선 하나와 줄기마다 하나. 마우스를 올린 선 pointed는 다른 선 위의 층에 본문 잉크, 불투명도 1로 그린다.
 * pointed에 줄기의 키가 들면 그 줄기를 같은 방식으로 그린다. cycles에 든 선은 순환 선이다. 줄기에 든 선은 가지만 그리고,
 * 강조하는 선(`emphasized`)은 줄기 위에 전체 경로를 한 번 더 그린다. 같은 층에서는 가지, 줄기, 강조하는 선 순서로 그린다.
 */
export function flowEdges({ views, trunks }: Lines, pointed: Set<EdgeKey>, cycles: Set<EdgeKey>): FlowEdge[] {
  const marks = (view: EdgeView) => ({ pointed: pointed.has(view.key), cycle: cycles.has(view.key) });
  const lines = views.map((view): AtlasFlowEdge => {
    const { pointed: on, cycle } = marks(view);
    const whole = view.trunk !== null && emphasized(view, { pointed: on, cycle });
    return {
      id: view.key,
      source: view.source,
      target: view.target,
      type: "orthogonal",
      data: on ? { ...view, tone: "strong", opacity: EDGE_OPACITY.full, pointed: true, cycle, whole } : { ...view, pointed: false, cycle, whole },
      zIndex: on ? LAYER.pointed : LAYER.edge,
    };
  });
  const byKey = new Map(views.map((view) => [view.key, view]));
  const stems = trunks.map((trunk): TrunkFlowEdge => {
    const on = pointed.has(trunk.key);
    const members = trunk.keys.map((key) => byKey.get(key)!);
    const shade = on ? { tone: "strong" as const, opacity: EDGE_OPACITY.full } : trunkShade(members, (view) => emphasized(view, marks(view)));
    return {
      id: trunk.key,
      source: members[0].source,
      target: trunk.target,
      type: "trunk",
      data: { ...trunk, ...shade, pointed: on },
      zIndex: on ? LAYER.pointed : LAYER.edge,
    };
  });
  return [...lines.filter((line) => line.data?.whole !== true), ...stems, ...lines.filter((line) => line.data?.whole === true)];
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
 * 선 하나. 줄기에 든 선은 줄기 앞까지의 가지를 화살촉 없이 그리고, 강조하는 선이면 그 위에 출발부터 도착까지의 경로를 화살촉과 함께
 * 한 번 더 그린다. 누름 영역은 가지다.
 */
export function OrthogonalEdge({ data }: EdgeProps<AtlasFlowEdge>) {
  if (data === undefined) {
    return null;
  }
  const ink: Ink = data.cycle ? "critical" : data.tone;
  const branch = roundedPath(data.branch);
  const arrow = `url(#${markerId(data.group, ink)})`;
  return (
    <g
      className={`edge edge-${data.group} tone-${ink}`}
      data-key={data.key}
      data-branch={data.trunk ?? undefined}
      data-whole={data.whole ? "" : undefined}
      data-pointed={data.pointed ? "" : undefined}
      data-cycle={data.cycle ? "" : undefined}
      data-route={data.route ?? undefined}
      style={{ opacity: data.opacity }}
    >
      <path className="edge-hit" d={branch} />
      {data.whole ? (
        <path className="edge-line" d={roundedPath(data.points)} markerEnd={arrow} />
      ) : (
        <path className="edge-line" d={branch} markerEnd={data.trunk === null ? arrow : undefined} />
      )}
      {data.weight !== null && (
        <text className="edge-weight" x={data.weight.at.x} y={data.weight.at.y} dy="0.35em" textAnchor="middle">
          {data.weight.count}
        </text>
      )}
    </g>
  );
}

export const edgeTypes: EdgeTypes = { orthogonal: OrthogonalEdge, trunk: Trunk };
