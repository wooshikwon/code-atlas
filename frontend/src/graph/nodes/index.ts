import type { NodeTypes } from "@xyflow/react";
import type { NodeKind } from "../../api/types";
import { ClassNode } from "./ClassNode";
import { DataClassNode } from "./DataClassNode";
import { ExternalNode } from "./ExternalNode";
import { FunctionNode } from "./FunctionNode";
import { ModuleNode } from "./ModuleNode";
import { PackageNode } from "./PackageNode";

export const nodeTypes: NodeTypes = {
  package: PackageNode,
  module: ModuleNode,
  class: ClassNode,
  dataclass: DataClassNode,
  function: FunctionNode,
  external: ExternalNode,
};

/** 메서드는 함수와 같은 모양이다. */
export function nodeType(kind: NodeKind): string {
  return kind === "method" ? "function" : kind;
}
