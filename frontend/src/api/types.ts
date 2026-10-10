// API 계약의 응답 형태. 필드 이름은 백엔드 model.py와 같다.

export interface Stats {
  files: number;
  nodes: number;
  edges: number;
  call_sites: number;
  resolved: number;
  unresolved: number;
  elapsed_ms: number;
}

export interface Repo {
  name: string;
  root: string;
  source_root: string;
  python: string | null;
  stats: Stats;
}

export interface TreeEntry {
  path: string;
  name: string;
  kind: "dir" | "file";
  test: boolean;
  /** 폴더면 패키지 노드 id, 파일이면 모듈 노드 id */
  node: string | null;
  children?: TreeEntry[];
}

export interface Tree {
  entries: TreeEntry[];
}

export type NodeKind = "package" | "module" | "class" | "dataclass" | "function" | "method" | "external";

export interface Field {
  name: string;
  type: string | null;
}

export interface AtlasNode {
  id: string;
  kind: NodeKind;
  name: string;
  parent: string | null;
  path: string | null;
  /** 1부터 세는 시작 줄과 끝 줄 */
  range: [number, number] | null;
  loc: number;
  unresolved: number;
  test: boolean;
  entry: boolean;
  reads: string[];
  writes: string[];
  global_write: boolean;
  fields: Field[] | null;
  method_kind: "property" | "static" | "class" | null;
  origin: "stdlib" | "thirdparty" | null;
}

export type EdgeGroup = "run" | "use" | "derive";

export type EdgeKind = "call" | "construct" | "import" | "pass" | "decorate" | "type" | "inherit" | "override";

/** line은 1부터, col은 0부터 세는 UTF-16 단위다. */
export interface SiteRef {
  path: string;
  line: number;
  col: number;
}

export interface AtlasEdge {
  group: EdgeGroup;
  kind: EdgeKind;
  source: string;
  target: string;
  sites: SiteRef[];
  deferred: boolean;
}

export interface Graph {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

export interface FileText {
  path: string;
  text: string;
}

export interface Hover {
  markdown: string | null;
  /** 시작 줄, 시작 열, 끝 줄, 끝 열. 줄은 1부터, 열은 0부터 세는 UTF-16 단위다. */
  range: [number, number, number, number] | null;
}

export interface DefinitionTarget {
  /** 레포 루트 기준 경로. 레포 밖이면 null이다. */
  path: string | null;
  line: number;
  col: number;
  /** 그 위치를 품은 가장 안쪽 노드 id */
  node: string | null;
  /** 레포 밖이면 `ext:{최상위 모듈}` */
  external: string | null;
}

export interface Definition {
  targets: DefinitionTarget[];
}

export interface ApiErrorBody {
  error: string;
}
