// 탐색 경로 표시의 레포 이름 옆 아래 화살표. 누르면 화살표 아래로 최근에 연 다른 레포와 `폴더 열기…`, `레포 닫기`가 든 메뉴가
// 내려온다. 레포를 고르면 그 레포로 바꿔 연다. 폴더가 없어진 레포는 고를 수 없다. 화살표는 진입점 버튼의 것과 같은 모양이다.
import { useEffect, useRef, useState } from "react";
import { host } from "../host";
import { useOpening } from "../state/opening";
import { useAtlas } from "../state/store";
import { modName } from "./keys";
import { MenuList, type MenuItem } from "./MenuList";

/** 버튼의 아래 끝과 메뉴 사이 */
const GAP = 4;

export function RepoMenu() {
  const root = useAtlas((s) => s.repo?.root ?? null);
  const repos = useOpening((s) => s.repos);
  const button = useRef<HTMLButtonElement | null>(null);
  /** 편 메뉴. first는 키보드로 열었는지다. */
  const [menu, setMenu] = useState<{ first: boolean } | null>(null);

  // 목록은 뜰 때 받아 두고 메뉴를 펼 때마다 다시 받는다.
  useEffect(() => void useOpening.getState().list(), []);
  const open = (first: boolean) => {
    void useOpening.getState().list();
    setMenu({ first });
  };
  const opening = useOpening.getState();
  const items: MenuItem[] = [
    ...repos
      .filter((repo) => repo.root !== root)
      .map(
        (repo): MenuItem => ({
          key: repo.root,
          label: repo.exists ? repo.name : `${repo.name} · 폴더가 없다`,
          tip: repo.root,
          disabled: !repo.exists,
          run: () => void opening.choose(repo.root, { asIs: true }),
        }),
      ),
    { key: "open", label: "폴더 열기…", tip: host.app ? modName("O") : undefined, rule: true, run: () => void opening.browse() },
    { key: "close", label: "레포 닫기", run: () => void opening.close() },
  ];
  const rect = menu === null ? undefined : button.current?.getBoundingClientRect();

  return (
    <>
      <button
        ref={button}
        className="trail-repo"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-controls="trail-repo"
        aria-label="레포 메뉴"
        data-tip={menu === null ? "다른 레포 열기" : undefined}
        onClick={(event) => (menu === null ? open(event.detail === 0) : setMenu(null))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && menu === null) {
            event.preventDefault();
            open(true);
          }
        }}
      >
        <svg className="toolbar-entries-arrow" viewBox="0 0 8 8" width={8} height={8} aria-hidden>
          <path d="M1 2.5 L4 5.5 L7 2.5" />
        </svg>
      </button>
      {menu !== null && rect !== undefined && (
        <MenuList id="trail-repo" label="레포 메뉴" items={items} at={{ x: rect.left, y: rect.bottom + GAP }} first={menu.first} anchor={button} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
