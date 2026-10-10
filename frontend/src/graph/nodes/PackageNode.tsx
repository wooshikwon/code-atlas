import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { Handles, Inflow, Label, nodeProps, sameNode, type AtlasFlowNode } from "./common";

/** 접힌 폴더는 폴더 경로를 가운데 적은 상자다. 펼친 폴더는 상자를 그리지 않고 자식 파일 상자의 자리만 잡는다. */
export const PackageNode = memo(function PackageNode({ data }: NodeProps<AtlasFlowNode>) {
  if (data.expanded) {
    return (
      <div className="node-package-open">
        <Handles />
      </div>
    );
  }
  return (
    <div {...nodeProps("node-package", data)}>
      <Handles />
      <Label data={data} bold />
      <Inflow data={data} />
    </div>
  );
}, sameNode);
