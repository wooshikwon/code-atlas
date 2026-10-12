// 그래프 왼쪽 아래 칸(`Dock.tsx`)의 둥근 범례 버튼과 그 위에 펼치는 범례. 노드 모양 여섯 개와 이름표 옆 표시와 접힌 상자의 배지, 선 모양 세 개와 합류, 찾은 경로의 선,
// 변경 표시 두 색을 보여 주고, 선 모양에 마우스를 올리면 그 분류에 드는 선 종류를 말풍선에 적는다. 분석 덮개를 켜면 그 덮개의 표시를 끝에 덧붙인다.
import type { Change, EdgeGroup } from "../api/types";
import { CHANGE_LETTERS } from "../state/changes";
import { useOverlay, type OverlayKind } from "../state/overlay";
import { useAtlas } from "../state/store";
import { EDGE_KIND_NAMES, GROUP_KINDS, GROUP_NAMES } from "./names";
import { CycleMark } from "./nodes/common";

const SHAPES = [
  { key: "package", name: "접힌 폴더" },
  { key: "module", name: "파일" },
  { key: "class", name: "클래스" },
  { key: "dataclass", name: "데이터 클래스" },
  { key: "function", name: "함수·메서드" },
  { key: "external", name: "외부 노드" },
  { key: "entry", name: "진입점" },
  { key: "inside", name: "접힌 상자의 배지: 안에 든 정의·파일 수" },
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
    case "entry":
      return (
        <text x={11} y={12} textAnchor="middle" className="legend-entry">
          ▶
        </text>
      );
    case "inside":
      return (
        <g>
          <rect x={3} y={1} width={16} height={14} rx={7} className="legend-inside" />
          <text x={11} y={11.5} textAnchor="middle" className="legend-inside-count">
            12
          </text>
        </g>
      );
    default:
      return (
        <text x={11} y={12} textAnchor="middle" className="legend-loc">
          131
        </text>
      );
  }
}

/** 켠 덮개의 견본과 뜻. 순환은 critical 색 import 선과 순환 아이콘, 미사용은 점선 테두리다. */
function Overlay({ kind }: { kind: OverlayKind }) {
  return kind === "cycles" ? (
    <li className="legend-overlay" data-kind={kind}>
      <svg width={30} height={16}>
        <path d="M2,8 L27,8" className="legend-edge edge-use tone-critical" markerEnd="url(#arrow-use-critical)" />
      </svg>
      <span>
        <CycleMark />
        순환 묶음과 묶음 안 import
      </span>
    </li>
  ) : (
    <li className="legend-overlay" data-kind={kind}>
      <svg width={30} height={16}>
        <circle cx={15} cy={8} r={6} className="legend-node legend-unused" />
      </svg>
      미사용 후보
    </li>
  );
}

export function Legend() {
  const open = useAtlas((s) => s.legendOpen);
  const overlay = useOverlay((s) => s.kind);
  if (!open) {
    return null;
  }
  return (
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
          <li key={group} data-tip={`${GROUP_NAMES[group]} 선: ${GROUP_KINDS[group].map((kind) => EDGE_KIND_NAMES[kind]).join(", ")}`}>
            <svg width={30} height={16}>
              <path
                d="M2,8 L27,8"
                className={`legend-edge edge-${group} tone-muted`}
                markerEnd={`url(#arrow-${group}-muted)`}
              />
            </svg>
            {GROUP_NAMES[group]}
          </li>
        ))}
        <li>
          <svg width={30} height={16}>
            <path d="M2,3 L10,3 L10,9 M2,14 L10,14 L10,9 L27,9" className="legend-edge tone-muted" markerEnd="url(#arrow-run-muted)" />
            <circle cx={10} cy={9} r={2.5} className="edge-joint tone-muted" />
            <text x={17} y={9} dy="0.35em" textAnchor="middle" className="edge-trunk-count tone-muted">
              7
            </text>
          </svg>
          합류와 들어오는 관계의 합계
        </li>
        <li>
          <svg width={30} height={16}>
            <path d="M2,8 L27,8" className="legend-edge legend-route tone-strong" />
          </svg>
          찾은 경로
        </li>
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
        {overlay !== null && <Overlay kind={overlay} />}
      </ul>
    </div>
  );
}

export function LegendButton() {
  const open = useAtlas((s) => s.legendOpen);
  const toggleLegend = useAtlas((s) => s.toggleLegend);
  return (
    <button
      className="dock-button legend-button"
      onClick={toggleLegend}
      data-tip="범례"
      aria-label="범례"
      aria-expanded={open}
      aria-controls="legend"
    >
      ?
    </button>
  );
}
