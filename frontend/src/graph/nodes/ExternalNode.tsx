import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { Handles, Inflow, Label, nodeProps, sameNode, type AtlasFlowNode } from "./common";

/** 레포 밖 모듈은 회색 알약 모양에 모듈 이름을 적는다. */
export const ExternalNode = memo(function ExternalNode({ data }: NodeProps<AtlasFlowNode>) {
  return (
    <div {...nodeProps("node-external", data)}>
      <Handles />
      <Label data={data} />
      <Inflow data={data} />
    </div>
  );
}, sameNode);
