// 정보 패널 머리 줄의 `출발로`·`도착으로` 버튼. 경로 탐색 창을 편 동안 정보 패널이 보이는 노드를 출발 칸이나 도착 칸에 넣는다.
import type { SyntheticEvent } from "react";
import type { AtlasNode } from "../api/types";
import { useAtlas } from "../state/store";
import type { End } from "./EndField";

const ENDS: { end: End; name: string }[] = [
  { end: "from", name: "출발로" },
  { end: "to", name: "도착으로" },
];
/** 경로의 끝점으로 고를 수 있는 종류 */
const PICKABLE = new Set<AtlasNode["kind"]>(["module", "class", "dataclass", "function", "method"]);

/** 머리 줄이 받는 끌기와 더블클릭이 버튼에서 시작하지 않게 한다. */
const stop = (event: SyntheticEvent) => event.stopPropagation();

export function Ends({ node }: { node: AtlasNode }) {
  const open = useAtlas((s) => s.finder.open);
  const setEnd = useAtlas((s) => s.setEnd);
  if (!open || !PICKABLE.has(node.kind)) {
    return null;
  }
  return (
    <div className="info-panel-ends" onPointerDown={stop} onDoubleClick={stop}>
      {ENDS.map(({ end, name }) => (
        <button key={end} type="button" className="info-panel-end" data-end={end} onClick={() => setEnd(end, node.id)}>
          {name}
        </button>
      ))}
    </div>
  );
}
