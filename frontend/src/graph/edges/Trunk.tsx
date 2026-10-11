// 같은 노드로 들어가는 선이 도착 노드 앞에서 함께 지나는 줄기. 선 하나와 화살촉 하나로 그리고, 합류점마다 점을, 도착 노드 앞에
// 합친 선의 수를 그린다. 굵기는 합친 수와 무관하게 선 하나와 같다.
import type { EdgeProps } from "@xyflow/react";
import { roundedPath } from "../view";
import { markerId, type TrunkFlowEdge } from "./OrthogonalEdge";

/** 합류점의 반지름. 선 굵기 1.5px의 선이 만나는 곳에서 눈에 띄는 가장 작은 지름 5px다. */
const JOINT_RADIUS = 2.5;

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
        {data.keys.length}
      </text>
    </g>
  );
}
