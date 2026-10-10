// 배치가 정한 직각 경로를 모서리를 둥글려 그린다. 선 분류는 선 모양과 화살촉으로, 초점은 선의 진하기로 가른다.
import type { Edge, EdgeProps, EdgeTypes } from "@xyflow/react";
import type { EdgeGroup } from "../../api/types";
import { midpoint, roundedPath, type EdgeView, type Tone } from "../view";

export type AtlasFlowEdge = Edge<EdgeView>;

const TONES: Tone[] = ["muted", "strong"];

function markerId(group: EdgeGroup, tone: Tone): string {
  return `arrow-${group}-${tone}`;
}

/** 분류 세 개와 진하기 두 개의 화살촉. 끝점이 노드 테두리에 닿도록 화살촉 끝을 경로 끝에 맞춘다. */
export function Markers() {
  return (
    <svg className="edge-markers" width={0} height={0} aria-hidden>
      <defs>
        {TONES.map((tone) => (
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

export function OrthogonalEdge({ data }: EdgeProps<AtlasFlowEdge>) {
  if (data === undefined) {
    return null;
  }
  const path = roundedPath(data.points);
  const mid = data.weight === null ? null : midpoint(data.points);
  return (
    <g className={`edge edge-${data.group} tone-${data.tone}`} data-key={data.key} style={{ opacity: data.opacity }}>
      <path className="edge-hit" d={path} />
      <path className="edge-line" d={path} markerEnd={`url(#${markerId(data.group, data.tone)})`} />
      {mid !== null && (
        <text className="edge-weight" x={mid.x} y={mid.y} dy="0.35em" textAnchor="middle">
          {data.weight}
        </text>
      )}
    </g>
  );
}

export const edgeTypes: EdgeTypes = { orthogonal: OrthogonalEdge };
