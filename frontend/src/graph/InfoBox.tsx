// 마우스를 올린 노드·선, 고정한 선, 고른 노드 순서로 하나를 골라 정보 상자에 보여 준다.
import { Fragment, useEffect, useState } from "react";
import { getFile } from "../api/client";
import type { AtlasNode, EdgeKind, SiteRef } from "../api/types";
import { labelOf } from "./layout1";
import type { EdgeKey } from "./scope";
import { EDGE_KIND_NAMES, GROUP_NAMES, KIND_NAMES, type EdgeIndex } from "./view";

const SITES_SHOWN = 2;

export type InfoItem = { type: "node"; node: AtlasNode } | { type: "edge"; key: EdgeKey };

interface InfoBoxProps {
  item: InfoItem;
  pinned: boolean;
  nodes: Map<string, AtlasNode>;
  index: EdgeIndex;
  degrees: Map<string, { incoming: number; outgoing: number }>;
  functions: Map<string, number>;
  openSite: (path: string, line: number) => void;
}

function nameOf(nodes: Map<string, AtlasNode>, id: string): string {
  const node = nodes.get(id);
  return node === undefined ? id : labelOf(node);
}

function NodeInfo({ node, degrees, functions }: { node: AtlasNode } & Pick<InfoBoxProps, "degrees" | "functions">) {
  const degree = degrees.get(node.id) ?? { incoming: 0, outgoing: 0 };
  const where =
    node.path === null ? null : node.range === null ? node.path : `${node.path}:${node.range[0]}-${node.range[1]}`;
  return (
    <>
      <div className="info-title">
        {node.entry && "▶ "}
        {labelOf(node)}
      </div>
      <div className="info-muted">
        {KIND_NAMES[node.kind]}
        {node.entry && " · 진입점"}
        {node.method_kind !== null && ` · ${node.method_kind}`}
      </div>
      {where !== null && <div className="info-path">{where}</div>}
      <dl className="info-facts">
        <dt>줄 수</dt>
        <dd>{node.loc}</dd>
        <dt>들어오는 선</dt>
        <dd>{degree.incoming}</dd>
        <dt>나가는 선</dt>
        <dd>{degree.outgoing}</dd>
        {node.unresolved > 0 && (
          <>
            <dt>미확인 호출</dt>
            <dd>{node.unresolved}</dd>
          </>
        )}
        {node.kind === "module" && (
          <>
            <dt>함수 수</dt>
            <dd>{functions.get(node.id) ?? 0}</dd>
          </>
        )}
        {node.reads.length > 0 && (
          <>
            <dt>읽는 변수</dt>
            <dd>{node.reads.join(", ")}</dd>
          </>
        )}
        {node.writes.length > 0 && (
          <>
            <dt>바꾸는 변수</dt>
            <dd>{node.writes.join(", ")}</dd>
          </>
        )}
      </dl>
      {node.fields !== null && node.fields.length > 0 && (
        <ul className="info-sites">
          {node.fields.map((f) => (
            <li key={f.name}>
              {f.name}
              {f.type !== null && <span className="info-muted">: {f.type}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
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

function EdgeInfo({ edgeKey, pinned, nodes, index, openSite }: { edgeKey: EdgeKey } & InfoBoxProps) {
  const raw = index.raw.get(edgeKey);
  const agg = index.agg.get(edgeKey);
  const sites = raw === undefined ? [] : pinned ? raw.sites : raw.sites.slice(0, SITES_SHOWN);
  const lines = useLines(sites);
  const edge = raw ?? agg;
  if (edge === undefined) {
    return null;
  }
  const count = raw?.sites.length ?? agg?.weight ?? 0;
  return (
    <>
      <div className="info-title">
        {nameOf(nodes, edge.source)} → {nameOf(nodes, edge.target)}
      </div>
      <div className="info-muted">
        {GROUP_NAMES[edge.group]}
        {raw !== undefined && ` · ${EDGE_KIND_NAMES[raw.kind]}`}
        {raw?.deferred === true && " · 함수 안 import"}
        {agg !== undefined && " · 집계"} · {count}곳
      </div>
      {agg !== undefined && (
        <dl className="info-facts">
          {(Object.entries(agg.kinds) as [EdgeKind, number][]).map(([kind, n]) => (
            <Fragment key={kind}>
              <dt>{EDGE_KIND_NAMES[kind]}</dt>
              <dd>{n}곳</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {raw !== undefined && (
        <ul className="info-sites">
          {sites.map((site) => (
            <li key={`${site.path}:${site.line}:${site.col}`}>
              <button className="info-site" onClick={() => openSite(site.path, site.line)} disabled={!pinned}>
                <span className="info-muted">
                  {site.path}:{site.line}
                </span>{" "}
                <code>{lines.get(`${site.path}:${site.line}`) ?? ""}</code>
              </button>
            </li>
          ))}
          {!pinned && raw.sites.length > SITES_SHOWN && (
            <li className="info-muted">외 {raw.sites.length - SITES_SHOWN}곳 · 선을 누르면 모두 보인다</li>
          )}
        </ul>
      )}
    </>
  );
}

export function InfoBox(props: InfoBoxProps) {
  const { item } = props;
  return (
    <div className={props.pinned ? "info-box info-box-pinned" : "info-box"}>
      {item.type === "node" ? (
        <NodeInfo node={item.node} degrees={props.degrees} functions={props.functions} />
      ) : (
        <EdgeInfo edgeKey={item.key} {...props} />
      )}
    </div>
  );
}
