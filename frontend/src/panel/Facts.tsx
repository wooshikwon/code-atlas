// 정보 패널의 "정보" 구역. 주제와 내용 두 칸의 줄 목록이고, 주제 칸은 가장 긴 주제의 폭에 맞춘다.
// 누를 수 있는 내용은 --link 색으로 적고, 누르면 그 연결의 코드 줄 목록을 줄 목록 아래에 열거나 닫는다. 구역을 접으면 코드 줄 목록도 함께 접힌다.
import type { ReactNode } from "react";
import { useAtlas } from "../state/store";
import { SectionHead } from "./Section";

export interface FactRow {
  /** 줄을 가리는 이름. `data-row`에 적는다. */
  id: string;
  topic: string;
  text: string;
  /** 접힌 구역의 한 줄 요약에 적는 글. 없으면 요약에 넣지 않는다. */
  brief?: string;
  /** 내용을 눌렀을 때 부르는 함수. 없으면 누를 수 없는 글자다. */
  press?: () => void;
  /** 이 줄의 코드 줄 목록이 열려 있는지 */
  pressed?: boolean;
  /** 내용 뒤에 적는 둘째 글. 세지 않는 관계의 `그 밖` 묶음이고 누르면 그 묶음의 코드 줄 목록을 열거나 닫는다. */
  more?: { text: string; press: () => void; pressed: boolean };
}

interface FactsProps {
  rows: FactRow[];
  /** 줄 목록 아래에 그리는 코드 줄 목록 */
  children?: ReactNode;
}

export function Facts({ rows, children }: FactsProps) {
  const open = useAtlas((s) => s.factsOpen);
  const toggle = useAtlas((s) => s.toggleFacts);
  const brief = rows.flatMap((row) => (row.brief === undefined ? [] : [row.brief])).join(", ");
  return (
    <section className="info-panel-facts" data-folded={open ? undefined : ""}>
      <SectionHead name="정보" open={open} toggle={toggle} brief={brief} />
      {open && (
        <dl className="info-rows">
          {rows.map((row) => (
            <div key={row.id} className="info-row" data-row={row.id}>
              <dt>{row.topic}</dt>
              <dd>
                {row.press === undefined ? (
                  row.text
                ) : (
                  <button type="button" className="info-link" aria-expanded={row.pressed === true} onClick={row.press}>
                    {row.text}
                  </button>
                )}
                {row.more !== undefined && (
                  <button type="button" className="info-link info-more" aria-expanded={row.more.pressed} onClick={row.more.press}>
                    {row.more.text}
                  </button>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {open && children}
    </section>
  );
}
