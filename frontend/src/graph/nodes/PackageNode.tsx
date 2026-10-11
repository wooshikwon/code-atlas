import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useFolderChange } from "../../state/changes";
import { Badges, Handles, Inflow, Label, nodeProps, sameNode, type AtlasFlowNode } from "./common";

/**
 * 접힌 폴더는 폴더 경로를 가운데 적은 상자다. 펼친 폴더는 상자를 그리지 않고 자식 파일 상자의 자리만 잡는다.
 * 접힌 폴더 안에 마지막 커밋 뒤에 바뀐 노드가 있으면 수정으로 표시하고, 안에 든 노드의 미확인 호출 수를 합쳐
 * 오른쪽 위 배지에 적는다.
 */
export const PackageNode = memo(function PackageNode({ data }: NodeProps<AtlasFlowNode>) {
  const change = useFolderChange(data.node.id);
  if (data.expanded) {
    return (
      <div className="node-package-open">
        <Handles data={data} />
      </div>
    );
  }
  return (
    <div {...nodeProps("node-package", data, change)}>
      <Handles data={data} />
      {data.part === "face" && (
        <>
          <Label data={data} bold />
          <Inflow data={data} />
          <Badges data={data} />
        </>
      )}
    </div>
  );
}, sameNode);
