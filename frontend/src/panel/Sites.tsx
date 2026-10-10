// 고른 선의 관계가 일어난 지점 목록. 줄을 누르면 코드 뷰어가 그 줄을 연다.
import { useEffect, useState } from "react";
import { getFile } from "../api/client";
import type { SiteRef } from "../api/types";

interface SitesProps {
  sites: SiteRef[];
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

export function Sites({ sites, opened, open }: SitesProps) {
  const lines = useLines(sites);
  return (
    <ul className="info-panel-sites">
      {sites.map((site, i) => (
        <li key={i}>
          <button className="info-panel-site" aria-current={site === opened} onClick={() => open(site)}>
            <span className="info-panel-hint">
              {site.path}:{site.line}
            </span>{" "}
            <code>{lines.get(`${site.path}:${site.line}`) ?? ""}</code>
          </button>
        </li>
      ))}
    </ul>
  );
}
