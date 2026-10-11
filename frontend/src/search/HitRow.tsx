// 검색 결과 한 행. 이름과 종류·경로를 적고 일치한 글자를 굵게 그린다. 검색 팔레트와 경로 탐색 창의 검색 칸이 함께 쓴다.
import type { ReactNode } from "react";
import type { EntryKind, Hit } from "./index";

const KIND_NAMES: Record<EntryKind, string> = {
  file: "파일",
  class: "클래스",
  dataclass: "데이터 클래스",
  function: "함수",
  method: "메서드",
};

/** 일치한 글자를 굵게 그린다. */
function marked(text: string, positions: Set<number>): ReactNode {
  return [...text].map((char, index) => (positions.has(index) ? <b key={index}>{char}</b> : char));
}

interface HitRowProps {
  hit: Hit;
  id: string;
  className: string;
  /** 키보드로 옮기는 활성 행인지 */
  active: boolean;
  onActive: () => void;
  onPick: () => void;
}

export function HitRow({ hit, id, className, active, onActive, onPick }: HitRowProps) {
  return (
    <li
      id={id}
      className={`${className}${active ? " active" : ""}`}
      role="option"
      aria-selected={active}
      data-node={hit.entry.id}
      onMouseMove={onActive}
      onClick={onPick}
    >
      <span className="palette-name">{hit.field === "name" ? marked(hit.entry.name, hit.positions) : hit.entry.name}</span>
      <span className="palette-aside">
        {KIND_NAMES[hit.entry.kind]} · {hit.field === "path" ? marked(hit.entry.path, hit.positions) : hit.entry.path}
      </span>
    </li>
  );
}
