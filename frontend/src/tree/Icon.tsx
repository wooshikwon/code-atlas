// 파일트리 행의 기호. 클래스·데이터 클래스·함수·변수는 그래프의 노드 모양과 같은 모양을 쓴다.

export type IconKind = "folder" | "folder-open" | "file" | "class" | "dataclass" | "function" | "method" | "variable";

function Shape({ kind }: { kind: IconKind }) {
  switch (kind) {
    case "folder":
      return <path d="M1.5 3.5h4l1.5 1.5h5.5v6.5h-11z" />;
    case "folder-open":
      return (
        <>
          <path d="M1.5 11.5v-8h4l1.5 1.5h4.5v1.5" />
          <path d="M1.5 11.5l2-5h9.5l-2 5z" />
        </>
      );
    case "file":
      return (
        <>
          <path d="M3.5 1.5h4.5l2.5 2.5v8.5h-7z" />
          <path d="M8 1.5v2.5h2.5" />
        </>
      );
    case "class":
      return <polygon points="3.5,2 10.5,2 13,7 10.5,12 3.5,12 1,7" />;
    case "dataclass":
      return (
        <>
          <rect x={2} y={1.5} width={10} height={11} />
          <line x1={2} y1={5.5} x2={12} y2={5.5} />
          <line x1={2} y1={9} x2={12} y2={9} />
        </>
      );
    case "variable":
      return <polygon points="7,2 12,7 7,12 2,7" />;
    default:
      return <circle cx={7} cy={7} r={4.5} />;
  }
}

/** 이름 왼쪽의 종류 기호 */
export function Icon({ kind }: { kind: IconKind }) {
  return (
    <svg className="tree-icon" width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
      <Shape kind={kind} />
    </svg>
  );
}

/** 검색 성격의 입력 칸 앞에 그리는 돋보기 */
export function SearchIcon() {
  return (
    <svg className="search-icon" width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
      <circle cx={6} cy={6} r={3.75} />
      <path d="M9 9l3.25 3.25" />
    </svg>
  );
}

/** 아래 행을 펼 수 있는 행의 펼침 화살표 */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className="tree-chevron" width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
      <path d={open ? "M3.5 5.5l3.5 3.5l3.5-3.5" : "M5.5 3.5l3.5 3.5l-3.5 3.5"} />
    </svg>
  );
}
