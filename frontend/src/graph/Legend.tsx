// 그래프 왼쪽 아래의 둥근 범례 버튼과 그 위에 펼치는 범례. 노드 모양 여섯 개와 이름표 옆 표시 두 개, 선 모양 세 개, 변경 표시 두 색을 보여 준다.
import type { Change, EdgeGroup } from "../api/types";
import { CHANGE_LETTERS } from "../state/changes";
import { useAtlas } from "../state/store";
import { GROUP_NAMES } from "./names";

const SHAPES = [
  { key: "package", name: "접힌 폴더" },
  { key: "module", name: "파일" },
  { key: "class", name: "클래스" },
  { key: "dataclass", name: "데이터 클래스" },
  { key: "function", name: "함수·메서드" },
  { key: "external", name: "외부 노드" },
  { key: "inflow", name: "편재 노드: 숨긴 선의 출발 노드 수" },
  { key: "loc", name: "이름표 옆 숫자: 줄 수" },
];

const GROUPS: EdgeGroup[] = ["run", "use", "derive"];

const CHANGES: { change: Change; name: string }[] = [
  { change: "modified", name: "수정: 마지막 커밋 뒤 바뀜" },
  { change: "added", name: "추가: 마지막 커밋에 없음" },
];

function Shape({ kind }: { kind: string }) {
  switch (kind) {
    case "package":
      return <rect x={1} y={2} width={20} height={12} rx={4} className="legend-package" />;
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
    case "external":
      return <rect x={1} y={3} width={20} height={10} rx={5} className="legend-external" />;
    case "inflow":
      return (
        <text x={11} y={12} textAnchor="middle" className="legend-inflow">
          ←8
        </text>
      );
    default:
      return (
        <text x={11} y={12} textAnchor="middle" className="legend-loc">
          131
        </text>
      );
  }
}

export function Legend() {
  const open = useAtlas((s) => s.legendOpen);
  const toggleLegend = useAtlas((s) => s.toggleLegend);
  return (
    <>
      {open && (
        <div className="legend" id="legend">
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
            {CHANGES.map(({ change, name }) => (
              <li key={change} data-change={change}>
                <svg width={30} height={16}>
                  <rect x={1} y={2} width={3} height={12} className="legend-change-bar" />
                  <circle cx={11} cy={8} r={4.5} className="legend-change-ring" />
                  <text x={24} y={12} textAnchor="middle" className="legend-change-letter">
                    {CHANGE_LETTERS[change]}
                  </text>
                </svg>
                {name}
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        className="legend-button"
        onClick={toggleLegend}
        title="범례"
        aria-label="범례"
        aria-expanded={open}
        aria-controls="legend"
      >
        ?
      </button>
    </>
  );
}
