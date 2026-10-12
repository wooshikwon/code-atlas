// 한 노드에 닿는 선이 그 노드 곁에서 함께 지나는 줄기. 선 하나로 그리고 굵기는 합친 수와 무관하게 선 하나와 같다.
// 들어오는 줄기는 화살촉 하나와 합류점마다 채운 원을, 도착 노드 앞에 그 노드로 들어오는 관계의 합계를 그린다.
// 나가는 줄기는 화살촉과 수 없이 갈림점마다 빈 원을 그린다. 든 선이 모두 삭제된 관계만 든 선인 들어오는 줄기는 합계 대신 빨강 점을 그린다.
import { FORK_RIM, JOINT_RADIUS } from "../layout";
import { MARK_SIZE, roundedPath } from "../view";
import { around, markerId, numberCover, shadeStyle, strokes, TIP_COVER, dashPeriod, type Decor, type TrunkFlowEdge } from "./OrthogonalEdge";

/** clone은 위층에 한 번 더 그리는 것이어서(`EdgeLayer.tsx`) 줄기를 찾는 키와 누름 영역을 두지 않는다. */
export function Trunk({ data, clone }: { data: TrunkFlowEdge["data"]; clone: boolean }) {
  const [first, ...rest] = data.pieces.map((piece) => roundedPath(piece));
  const all = [first, ...rest].join(" ");
  const arrow = data.end === "in" ? `url(#${markerId(data.group, data.tone)})` : undefined;
  const reach = 2 * (JOINT_RADIUS + (data.end === "out" ? FORK_RIM / 2 : 0)) + 1;
  const decor: Decor[] = data.joints.map((joint, i) => ({
    cover: { box: around(joint, reach, reach) },
    node: <circle key={i} className={`edge-joint edge-joint-${data.end}`} cx={joint.x} cy={joint.y} r={JOINT_RADIUS} strokeWidth={data.end === "out" ? FORK_RIM : undefined} />,
  }));
  if (arrow !== undefined) {
    decor.push({ cover: { piece: 0, tail: TIP_COVER }, node: null });
  }
  if (data.at !== null) {
    decor.push({
      cover: numberCover(data.at, data.sites),
      node: (
        <text key="count" className="edge-trunk-count" x={data.at.x} y={data.at.y} dy="0.35em" textAnchor="middle">
          {data.sites}
        </text>
      ),
    });
  }
  if (data.mark !== null) {
    decor.push({ cover: { box: around(data.mark, MARK_SIZE + 2, MARK_SIZE + 2) }, node: <circle key="mark" className="edge-gone" cx={data.mark.x} cy={data.mark.y} r={MARK_SIZE / 2} /> });
  }
  const lines = [{ d: first, arrow }, ...(rest.length > 0 ? [{ d: rest.join(" ") }] : [])];
  // 묶음이 둘 이상이면 서로 붙는 곳에서 겹치므로, 장식이 없어도 긴 선을 경로 하나로 긋도록 가른다.
  const { shade, body } = strokes(lines, data.pieces, decor, dashPeriod(data.group, null), data.pointed || data.opacity === 1, arrow);
  return (
    <g
      className={`edge edge-trunk edge-${data.group} tone-${data.tone}`}
      data-key={clone ? undefined : data.key}
      data-end={data.end}
      data-node={data.node}
      data-pointed={data.pointed ? "" : undefined}
      data-step={data.route ? "" : undefined}
      data-gone={data.mark !== null ? "" : undefined}
      data-shade={shade}
      style={shadeStyle(data.opacity)}
    >
      {!clone && <path className="edge-hit" d={all} />}
      {body}
    </g>
  );
}
