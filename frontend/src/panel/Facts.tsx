// 정보 패널의 "정보" 구역. 주제와 내용 두 칸의 줄 목록이고, 주제 칸은 가장 긴 주제의 폭에 맞춘다.
// 누를 수 있는 내용은 --link 색으로 적고, 누르면 그 연결의 코드 줄 목록을 열거나 닫는다.
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
}

export function Facts({ rows }: { rows: FactRow[] }) {
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
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
