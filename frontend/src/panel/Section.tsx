// 정보 패널의 구역 머리. 누르면 구역을 접거나 펴고, 접힌 구역은 이름 옆에 한 줄 요약을 보인다.
interface SectionHeadProps {
  name: string;
  open: boolean;
  toggle: () => void;
  /** 접힌 구역이 이름 옆에 적는 한 줄 요약 */
  brief: string;
}

export function SectionHead({ name, open, toggle, brief }: SectionHeadProps) {
  return (
    <button type="button" className="info-section-head" aria-expanded={open} onClick={toggle}>
      <span className="info-section-caret" aria-hidden />
      <span className="info-panel-label">{name}</span>
      {!open && <span className="info-section-brief">{brief}</span>}
    </button>
  );
}
