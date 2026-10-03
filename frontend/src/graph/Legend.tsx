// 그래프 왼쪽 아래에 늘 띄우는 범례. 노드 모양 여섯 개, 선 모양 세 개, 초점 방향 색 두 개를 보여 준다.
import type { EdgeGroup } from "../api/types";
import { GROUP_NAMES } from "./view";

const SHAPES = [
  { key: "package", name: "폴더" },
  { key: "module", name: "파일" },
  { key: "class", name: "클래스" },
  { key: "dataclass", name: "데이터 클래스" },
  { key: "function", name: "함수·메서드" },
  { key: "entry", name: "진입점" },
];

const GROUPS: EdgeGroup[] = ["run", "use", "derive"];

function Shape({ kind }: { kind: string }) {
  switch (kind) {
    case "package":
      return <rect x={1} y={2} width={20} height={12} rx={3} className="legend-package" />;
    case "module":
      return <rect x={1} y={2} width={20} height={12} rx={2} className="legend-module" />;
    case "class":
      return <polygon points="5,2.5 17,2.5 21,8 17,13.5 5,13.5 1,8" className="legend-node" />;
    case "dataclass":
      return (
        <g className="legend-node">
          <rect x={3} y={1} width={16} height={14} />
          <line x1={3} y1={6} x2={19} y2={6} />
          <line x1={3} y1={10.5} x2={19} y2={10.5} />
        </g>
      );
    case "function":
      return <circle cx={11} cy={8} r={6} className="legend-node" />;
    default:
      return (
        <text x={11} y={12} textAnchor="middle" className="legend-entry">
          ▶
        </text>
      );
  }
}

export function Legend() {
  return (
    <div className="legend">
      <ul className="legend-list">
        {SHAPES.map((s) => (
          <li key={s.key}>
            <svg width={22} height={16}>
              <Shape kind={s.key} />
            </svg>
            {s.name}
          </li>
        ))}
      </ul>
      <ul className="legend-list">
        {GROUPS.map((group) => (
          <li key={group}>
            <svg width={30} height={16}>
              <path d="M2,8 L27,8" className={`legend-edge edge-${group} tone-muted`} markerEnd={`url(#arrow-${group}-muted)`} />
            </svg>
            {GROUP_NAMES[group]}
          </li>
        ))}
        <li>
          <svg width={30} height={16}>
            <path d="M2,8 L27,8" className="legend-edge edge-run tone-outgoing" markerEnd="url(#arrow-run-outgoing)" />
          </svg>
          고른 노드가 쓰는 쪽
        </li>
        <li>
          <svg width={30} height={16}>
            <path d="M2,8 L27,8" className="legend-edge edge-run tone-incoming" markerEnd="url(#arrow-run-incoming)" />
          </svg>
          고른 노드를 쓰는 쪽
        </li>
      </ul>
    </div>
  );
}
