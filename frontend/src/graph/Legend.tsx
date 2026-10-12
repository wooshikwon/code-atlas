// 그래프의 기호를 설명하는 창과, 그 창을 여는 왼쪽 아래 칸(`Dock.tsx`)의 물음표 버튼. 창은 화면 가운데에 뜨고 노드 모양, 선 모양, 표시 세 묶음을
// 보여 준다. 창은 `document.body`에 그려 정보 패널 위에 뜬다. 선 모양 옆에는 그 분류에 드는 선 종류를 적는다. 분석 표시나 시점 비교를 켜면 켠 표시의 견본을 표시 묶음 끝에 덧붙이고,
// 시점 비교가 켜져 있으면 그리지 않는 변경 표시 두 색을 뺀다. 창 밖을 누르거나 Esc를 누르면 닫힌다.
import { createPortal } from "react-dom";
import type { Change, EdgeGroup } from "../api/types";
import { CHANGE_LETTERS } from "../state/changes";
import { useOverlay, type OverlayKind } from "../state/overlay";
import { Ask, Title } from "../open/Asks";
import { useAtlas } from "../state/store";
import { DIM } from "./flow";
import { diffTexts } from "./layout";
import { EDGE_KIND_NAMES, GROUP_KINDS, GROUP_NAMES } from "./names";
import { CycleMark, ENTRY_PATH } from "./nodes/common";
import { MARK_SIZE } from "./view";

const SHAPES = [
  { key: "package", name: "접힌 폴더" },
  { key: "module", name: "파일" },
  { key: "class", name: "클래스" },
  { key: "dataclass", name: "데이터 클래스" },
  { key: "function", name: "함수·메서드" },
  { key: "variable", name: "모듈 변수" },
  { key: "external", name: "외부 노드" },
];

const MARKS = [
  { key: "entry", name: "진입점" },
  { key: "inside", name: "접힌 상자에 든 것의 수" },
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
    case "variable":
      return <polygon points="11,1.5 17.5,8 11,14.5 4.5,8" className="legend-node" />;
    case "external":
      return <rect x={1} y={3} width={20} height={10} rx={5} className="legend-external" />;
    case "entry":
      return <path d={ENTRY_PATH} transform="translate(5 2)" className="legend-entry" />;
    default:
      return (
        <g>
          <rect x={3} y={1} width={16} height={14} rx={7} className="legend-inside" />
          <text x={11} y={11.5} textAnchor="middle" className="legend-inside-count">
            12
          </text>
        </g>
      );
  }
}

/** 범례의 이름 옆 줄 수 견본 */
const DIFF_SAMPLE = diffTexts({ added: 12, deleted: 3 });

/** 시점 비교의 견본 세 줄: 이름 옆 줄 수, 삭제된 관계만 든 흐린 선과 빨강 점, 흐린 단계로 남는 삭제된 정의와 파일 */
function Compare() {
  return (
    <>
      <li className="legend-overlay" data-kind="compare">
        <span className="legend-diff">
          <span className="diff-added">{DIFF_SAMPLE.added}</span>
          <span className="diff-deleted">{DIFF_SAMPLE.deleted}</span>
        </span>
        이름 옆 수: 추가된 줄, 삭제된 줄
      </li>
      <li className="legend-overlay" data-kind="compare">
        <svg width={30} height={16}>
          <g opacity={DIM}>
            <path d="M2,8 L27,8" className="legend-edge tone-muted" markerEnd="url(#arrow-run-muted)" />
            <circle cx={12} cy={8} r={MARK_SIZE / 2} className="edge-gone" />
          </g>
        </svg>
        삭제된 연결
      </li>
      <li className="legend-overlay" data-kind="compare">
        <svg width={30} height={16}>
          <circle cx={15} cy={8} r={6} className="legend-node" opacity={DIM} />
        </svg>
        삭제된 정의와 파일
      </li>
    </>
  );
}

/** 켠 분석 표시의 견본과 뜻. 순환은 critical 색 import 선과 순환 아이콘, 미사용은 점선 테두리, 시점 비교는 `Compare`의 세 줄이다. */
function Overlay({ kind }: { kind: OverlayKind }) {
  if (kind === "compare") {
    return <Compare />;
  }
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
  const toggleLegend = useAtlas((s) => s.toggleLegend);
  const overlay = useOverlay((s) => s.kind);
  if (!open) {
    return null;
  }
  return createPortal(
    <Ask wide close={toggleLegend}>
      <Title>기호</Title>
      <div className="legend" id="legend">
        <section className="legend-group">
          <h3 className="ask-label">노드</h3>
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
        </section>
        <section className="legend-group">
          <h3 className="ask-label">선</h3>
          <ul className="legend-list">
            {GROUPS.map((group) => (
              <li key={group}>
                <svg width={30} height={16}>
                  <path d="M2,8 L27,8" className={`legend-edge edge-${group} tone-muted`} markerEnd={`url(#arrow-${group}-muted)`} />
                </svg>
                <span>
                  {GROUP_NAMES[group]}
                  <span className="legend-kinds">{GROUP_KINDS[group].map((kind) => EDGE_KIND_NAMES[kind]).join(", ")}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="legend-group">
          <h3 className="ask-label">표시</h3>
          <ul className="legend-list">
            {MARKS.map((s) => (
              <li key={s.key}>
                <svg width={22} height={16}>
                  <Shape kind={s.key} />
                </svg>
                {s.name}
              </li>
            ))}
            {overlay !== "compare" &&
              CHANGES.map(({ change, name }) => (
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
        </section>
      </div>
      <div className="ask-buttons">
        <button className="toolbar-button" data-first onClick={toggleLegend}>
          닫기
        </button>
      </div>
    </Ask>,
    document.body,
  );
}

export function LegendButton() {
  const open = useAtlas((s) => s.legendOpen);
  const toggleLegend = useAtlas((s) => s.toggleLegend);
  return (
    <button className="dock-button legend-button" onClick={toggleLegend} data-tip="기호 설명" aria-label="기호 설명" aria-haspopup="dialog" aria-expanded={open}>
      ?
    </button>
  );
}
