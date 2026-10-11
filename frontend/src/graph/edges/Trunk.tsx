// 같은 노드로 들어가는 선이 도착 노드 앞에서 함께 지나는 줄기. 선 하나와 화살촉 하나로 그리고, 합류점마다 점을, 도착 노드 앞에
// 그 노드로 들어오는 관계의 합계를 그린다. 굵기는 합친 수와 무관하게 선 하나와 같다.
import type { EdgeProps } from "@xyflow/react";
import { JOINT_RADIUS } from "../layout";
import { roundedPath } from "../view";
import { markerId, type TrunkFlowEdge } from "./OrthogonalEdge";

export function Trunk({ data }: EdgeProps<TrunkFlowEdge>) {
  if (data === undefined) {
    return null;
  }
  const [first, ...rest] = data.pieces.map((piece) => roundedPath(piece));
  const all = [first, ...rest].join(" ");
  return (
    <g
      className={`edge edge-trunk edge-${data.group} tone-${data.tone}`}
      data-key={data.key}
      data-target={data.target}
      data-pointed={data.pointed ? "" : undefined}
      data-step={data.route ? "" : undefined}
      style={{ opacity: data.opacity }}
    >
      <path className="edge-hit" d={all} />
      <path className="edge-line" d={first} markerEnd={`url(#${markerId(data.group, data.tone)})`} />
      {rest.length > 0 && <path className="edge-line" d={rest.join(" ")} />}
      {data.joints.map((joint, i) => (
        <circle key={i} className="edge-joint" cx={joint.x} cy={joint.y} r={JOINT_RADIUS} />
      ))}
      <text className="edge-trunk-count" x={data.at.x} y={data.at.y} dy="0.35em" textAnchor="middle">
        {data.sites}
      </text>
    </g>
  );
}
