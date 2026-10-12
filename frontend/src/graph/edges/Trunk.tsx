// 한 노드에 닿는 선이 그 노드 곁에서 함께 지나는 줄기. 선 하나로 그리고 굵기는 합친 수와 무관하게 선 하나와 같다.
// 들어오는 줄기는 화살촉 하나와 합류점마다 채운 원을, 도착 노드 앞에 그 노드로 들어오는 관계의 합계를 그린다.
// 나가는 줄기는 화살촉과 수 없이 갈림점마다 빈 원을 그린다. 든 선이 모두 삭제된 관계만 든 선인 들어오는 줄기는 합계 대신 빨강 점을 그린다.
import type { EdgeProps } from "@xyflow/react";
import { FORK_RIM, JOINT_RADIUS } from "../layout";
import { MARK_SIZE, roundedPath } from "../view";
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
      data-end={data.end}
      data-node={data.node}
      data-pointed={data.pointed ? "" : undefined}
      data-step={data.route ? "" : undefined}
      data-gone={data.mark !== null ? "" : undefined}
      style={{ opacity: data.opacity }}
    >
      <path className="edge-hit" d={all} />
      <path className="edge-line" d={first} markerEnd={data.end === "in" ? `url(#${markerId(data.group, data.tone)})` : undefined} />
      {rest.length > 0 && <path className="edge-line" d={rest.join(" ")} />}
      {data.joints.map((joint, i) => (
        <circle key={i} className={`edge-joint edge-joint-${data.end}`} cx={joint.x} cy={joint.y} r={JOINT_RADIUS} strokeWidth={data.end === "out" ? FORK_RIM : undefined} />
      ))}
      {data.at !== null && (
        <text className="edge-trunk-count" x={data.at.x} y={data.at.y} dy="0.35em" textAnchor="middle">
          {data.sites}
        </text>
      )}
      {data.mark !== null && <circle className="edge-gone" cx={data.mark.x} cy={data.mark.y} r={MARK_SIZE / 2} />}
    </g>
  );
}
