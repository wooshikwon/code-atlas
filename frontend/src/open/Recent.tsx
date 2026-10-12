// 최근에 연 레포 목록. 행마다 이름, 경로, 마지막으로 연 날을 적고 누르면 그 레포를 연다. 폴더가 없어진 레포는 흐리게 그리고
// 누를 수 없다. 행 끝의 버튼이 그 레포를 목록에서 지운다.
import type { RecentRepo } from "../api/types";
import { useOpening } from "../state/opening";

/** 마지막으로 연 날: `2026-10-12` */
function dayOf(repo: RecentRepo): string {
  const at = new Date(repo.opened * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

export function Recent() {
  const repos = useOpening((s) => s.repos);
  const choose = useOpening((s) => s.choose);
  const forget = useOpening((s) => s.forget);

  if (repos.length === 0) {
    return null;
  }
  return (
    <section className="recent" aria-label="최근에 연 레포">
      <h2 className="recent-title">최근에 연 레포</h2>
      <ul className="recent-list">
        {repos.map((repo) => (
          <li key={repo.root} className="recent-row" data-missing={repo.exists ? undefined : ""}>
            <button className="recent-open" disabled={!repo.exists} onClick={() => void choose(repo.root, { asIs: true })}>
              <span className="recent-name">{repo.name}</span>
              <span className="recent-path" data-full={repo.root}>
                <bdi>{repo.root}</bdi>
              </span>
              <span className="recent-day">{repo.exists ? dayOf(repo) : "폴더가 없다"}</span>
            </button>
            <button className="recent-forget" data-tip="목록에서 지우기" aria-label={`${repo.name} 목록에서 지우기`} onClick={() => void forget(repo.root)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
