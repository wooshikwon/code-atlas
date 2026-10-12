import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useFolderChange } from "../../state/changes";
import { Badges, Below, Handles, Label, nodeProps, sameNode, shownChange, type AtlasFlowNode } from "./common";

/**
 * 접힌 폴더는 폴더 경로를 가운데 적은 상자다. 펼친 폴더는 안의 상자를 감싸는 영역이고 머리 줄에 폴더 경로를 적으며,
 * 머리 줄만 클릭을 받는다.
 * 접힌 폴더 안에 마지막 커밋 뒤에 바뀐 노드가 있으면 수정으로 표시한다. 접힌 상자와 펼친 영역 모두 안에 든 보이는 파일의 줄 수 합을 오른쪽 위 배지에 적는다.
 * 미사용 후보 표시를 켰으면 안에 든 미사용 후보 수를 상자 아래에 적는다. 안에 든 노드의 LLM 요약을 만드는 중이면 접힌 상자와
 * 펼친 영역 모두 왼쪽 위 모서리에 도는 원을 단다.
 */
export const PackageNode = memo(function PackageNode({ data }: NodeProps<AtlasFlowNode>) {
  const change = shownChange(data, useFolderChange(data.node.id));
  if (data.expanded) {
    return (
      <div className={`node-region node-${data.part}`} data-gone={data.compare?.gone === true ? "" : undefined}>
        <Handles data={data} />
        {data.part === "face" && (
          <>
            <div className="node-region-head">
              <Label data={data} bold />
            </div>
            <Badges data={data} />
          </>
        )}
      </div>
    );
  }
  return (
    <div {...nodeProps("node-package", data, change)}>
      <Handles data={data} />
      {data.part === "face" && (
        <>
          <Label data={data} bold />
          <Below data={data} />
          <Badges data={data} />
        </>
      )}
    </div>
  );
}, sameNode);
