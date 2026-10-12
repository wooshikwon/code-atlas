// "정보" 구역 안에 그리는 코드 줄 목록. 고른 선, 줄기, "정보" 구역에서 누른 연결의 코드 줄을 묶음마다 보인다. 묶음 줄은 묶은 노드의 이름과
// 그 묶음의 관계를 적는다. 이름을 누르면 그 노드로 가고, 관계를 누르면 묶음의 코드 줄을 펴거나 접는다. 코드 줄을 누르면 코드 뷰어가 그 줄을
// 열고, 연 줄을 다시 누르면 닫는다.
import { useEffect, useState } from "react";
import { getFile } from "../api/client";
import type { SiteRef } from "../api/types";
import { groupText, type SiteGroup } from "./links";

interface SitesProps {
  groups: SiteGroup[];
  /** 코드 줄을 편 묶음의 번호. 묶음 줄이 없는 묶음은 늘 코드 줄을 보인다. */
  spread: ReadonlySet<number>;
  /** 번호가 group인 묶음의 코드 줄을 펴거나 접는다. */
  toggle: (group: number) => void;
  /** 묶음 줄의 이름을 눌렀을 때 그 노드로 간다. */
  go: (id: string) => void;
  /** 코드 뷰어에 연 지점 */
  opened: SiteRef | null;
  open: (site: SiteRef) => void;
}

/** sites가 가리키는 코드 줄. 파일을 받기 전에는 경로와 줄 번호만 보인다. */
function useLines(sites: SiteRef[]): Map<string, string> {
  const [lines, setLines] = useState<Map<string, string>>(new Map());
  const paths = [...new Set(sites.map((s) => s.path))].join("\n");
  useEffect(() => {
    let cancelled = false;
    const wanted = paths === "" ? [] : paths.split("\n");
    Promise.all(wanted.map((p) => getFile(p).catch(() => null))).then((files) => {
      if (cancelled) {
        return;
      }
      const next = new Map<string, string>();
      for (const file of files) {
        file?.text.split("\n").forEach((line, i) => next.set(`${file.path}:${i + 1}`, line.trim()));
      }
      setLines(next);
    });
    return () => {
      cancelled = true;
    };
  }, [paths]);
  return lines;
}

export function Sites({ groups, spread, toggle, go, opened, open }: SitesProps) {
  const shown = (group: SiteGroup, g: number) => group.name === null || spread.has(g);
  const lines = useLines(groups.flatMap((group, g) => (shown(group, g) ? group.sites : [])));
  return (
    <ul className="info-panel-sites">
      {groups.map((group, g) => (
        <li key={g}>
          {group.id !== null && group.name !== null && (
            <div className="info-panel-sites-head">
              <button type="button" className="info-panel-sites-name" data-full={group.name} onClick={() => go(group.id!)}>
                {group.name}
              </button>
              <button type="button" className="info-link" aria-expanded={spread.has(g)} onClick={() => toggle(g)}>
                {groupText(group.kinds)}
              </button>
            </div>
          )}
          {shown(group, g) && (
            <ul>
              {group.sites.map((site, i) => (
                <li key={i}>
                  <button type="button" className="info-panel-site" aria-current={site === opened} onClick={() => open(site)}>
                    <span className="info-panel-hint">
                      {site.path}:{site.line}
                    </span>{" "}
                    <code>{lines.get(`${site.path}:${site.line}`) ?? ""}</code>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
