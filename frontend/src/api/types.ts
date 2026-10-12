// API 계약의 응답 형태. 필드 이름은 백엔드 model.py와 같다.

export interface Stats {
  files: number;
  nodes: number;
  edges: number;
  call_sites: number;
  resolved: number;
  unresolved: number;
  /** 언어 서버가 끝까지 응답하지 않은 지점 수 */
  timed_out?: number;
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
  /** 폴더면 패키지 노드 id, 파일이면 모듈 노드 id. 함수·클래스 정의가 없는 패키지의 `__init__.py`는 모듈 노드가 없으므로 null이다. */
  node: string | null;
  children?: TreeEntry[];
}

export interface Tree {
  entries: TreeEntry[];
}

export type NodeKind = "package" | "module" | "class" | "dataclass" | "function" | "method" | "variable" | "external";

export interface Field {
  name: string;
  type: string | null;
}

/** API 엔드포인트 하나. 웹 프레임워크의 라우트 데코레이터 하나에서 읽는다. */
export interface Route {
  /** HTTP 메서드. 웹소켓은 `WS`이고, 읽지 못했으면 비어 있다. */
  methods: string[];
  /** 주소. 문자열 상수로 적히지 않아 읽지 못했으면 null이다. */
  path: string | null;
  /** 데코레이터가 붙은 함수의 이름 */
  handler: string;
  /** 그 함수의 `def` 줄 */
  line: number;
}

/** 모듈 변수의 첫 대입문이 담은 값의 요약 */
export interface Value {
  /** 값의 종류: `str`, `dict`, `TaskPreset(…)`, `alias`, `type`, `expr` */
  kind: string;
  /** 컨테이너의 원소 수. 셀 수 없는 값은 null이다. */
  size: number | null;
  /** 값 식의 글. 80자에서 잘려 있다. */
  text: string;
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
  /** 변수 노드만 담는다. 그 밖의 노드는 null이다. */
  value: Value | null;
  /** 값을 만든 호출의 대상이 외부 노드인 변수다 */
  external_value: boolean;
  /** 이 함수에 붙었거나 이 함수 안에서 선언한 API 엔드포인트. 소스 순서다. */
  routes: Route[];
}

export type EdgeGroup = "run" | "use" | "derive";

export type EdgeKind = "call" | "construct" | "import" | "pass" | "read" | "write" | "decorate" | "type" | "inherit" | "override";

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

export interface SummaryStatus {
  /** 보여 줄 요약. 한 번도 만들지 않았으면 null이다. */
  summary: string | null;
  /** 요약을 만든 뒤 코드나 앞뒤 흐름, 서술 규약 문서가 바뀌었다 */
  stale: boolean;
  /** Claude Code CLI를 부를 수 있는지 */
  available: boolean;
  /** 부를 수 없는 까닭 */
  reason: string | null;
}

export interface MadeSummary {
  summary: string;
  /** 요약을 만든 `claude` 호출의 사용량. 캐시에서 읽은 요약과 CLI가 사용량을 적지 않은 요약은 null이다. */
  usage: Usage | null;
}

/** `claude` 호출 한 번이 쓴 토큰 수 */
export interface Usage {
  /** 캐시에서 읽지도 캐시에 넣지도 않은 입력 */
  input: number;
  /** 캐시에 새로 넣은 입력 */
  cache_write: number;
  /** 캐시에서 읽은 입력 */
  cache_read: number;
  output: number;
}

/** 요약이 있는 노드와 그 요약의 요지 */
export interface Summaries {
  summaries: { node: string; lead: string }[];
}

/** 코드 범위 하나의 설명. start와 end는 1부터 세는 파일 줄 번호다. */
export interface Explanation {
  start: number;
  end: number;
  /** 문단마다 한 줄 */
  text: string;
  /** 설명을 만든 뒤 그 줄 범위의 코드가 바뀌었다 */
  stale: boolean;
}

export interface Explanations {
  explanations: Explanation[];
}

export type Change = "modified" | "added";

export interface ChangedFile {
  /** 레포 루트 기준 경로 */
  path: string;
  /** unchanged는 마지막 커밋과 같고 분석한 뒤에 내용만 바뀐 파일이다. */
  status: Change | "deleted" | "unchanged";
  /** 레포를 열어 분석한 뒤 내용이 바뀌었다 */
  stale: boolean;
  /** 테스트 코드다 */
  test: boolean;
}

/** 마지막 커밋 뒤에 바뀐 `.py` 파일과 노드. git 저장소가 아니면 git이 거짓이고 files는 분석한 뒤 바뀐 파일만 담는다. */
export interface Changes {
  git: boolean;
  branch: string | null;
  files: ChangedFile[];
  /** 노드 id → 변경 상태. 분석한 뒤 바뀐 파일은 파일 노드만 담는다. */
  nodes: Record<string, Change>;
}

/** 미사용 후보. candidates는 `/api/graph`에 있는 노드 id이고 파일 경로, 시작 줄 순서다. */
export interface Unused {
  /** 판정 대상 정의 수(테스트 코드가 아닌 함수·메서드·클래스·데이터 클래스) */
  definitions: number;
  candidates: string[];
}

export type Phase = "collect" | "extract" | "resolve" | "build" | "ready" | "failed";

/** 분석의 단계와 진행 수, 결과의 판 번호, 언어 서버의 상태 */
export interface Status {
  phase: Phase;
  /** extract에서 추출한 파일 수와 전체 파일 수, resolve에서 보낸 정의 요청 수와 보낼 전체 수. 나머지 단계에서는 0이다. total은 resolve 도중에 커진다. */
  done: number;
  total: number;
  /** 서버가 분석 결과를 바꾼 횟수. 결과가 아직 없으면 0이다. */
  revision: number;
  /** 다시 물을 지점이 남은 결과다. 다 물으면 다음 판이 온다. */
  draft: boolean;
  lsp: "starting" | "ready";
  /** phase가 failed일 때의 까닭 */
  error: string | null;
  /** 지금 판을 분석한 뒤 내용이 달라졌거나 생기거나 없어진 파일. paths는 레포 루트 기준 경로의 앞 5개다. */
  stale: { count: number; paths: string[] };
  /** 비교할 시점을 분석하는 단계와 진행 수. 비교를 분석하는 중이 아니면 null이다. */
  compare: { phase: Phase; done: number; total: number } | null;
}

/** 비교할 시점의 이름. 커밋은 40자 해시, 작업 중인 상태는 `worktree`다. */
export const WORKTREE = "worktree";

export interface Commit {
  hash: string;
  /** 부모 커밋의 해시. 첫째 부모가 앞이다. */
  parents: string[];
  /** 커밋한 시각(초) */
  time: number;
  subject: string;
  /** 이 커밋을 가리키는 브랜치와 태그의 이름. 원격 브랜치는 `origin/main` 꼴이다. */
  refs: string[];
}

/** 커밋 그래프의 한 묶음. git 저장소가 아니면 git이 거짓이고 commits가 비어 있다. */
export interface History {
  git: boolean;
  /** 지금 커밋의 해시. 커밋이 없으면 null이다. */
  head: string | null;
  branch: string | null;
  /** 기본 브랜치가 가리키는 커밋의 해시 */
  default: string | null;
  /** 커밋하지 않은 `.py` 변경이 있다 */
  dirty: boolean;
  /** 최신이 앞이다. */
  commits: Commit[];
  /** 이 묶음 뒤에 커밋이 더 있다 */
  more: boolean;
}

/** 고른 두 시점의 기준과 대상, 그 사이에 바뀐 분석 대상 `.py`의 파일 수와 줄 수 */
export interface Stat {
  base: string;
  target: string;
  /** 두 시점이 조상 관계가 아닐 때 기준이 된 갈라진 커밋의 해시 */
  fork: string | null;
  files: number;
  added: number;
  deleted: number;
}

export interface NodeChange {
  /** null은 줄 수만 있는 파일·폴더와, 기준 시점에만 있던 변수·외부 노드(only가 base)다. */
  change: "added" | "deleted" | "modified" | null;
  added: number;
  deleted: number;
  /** 삭제된 정의가 대상 시점의 본문에서 놓였을 줄 번호 */
  slot?: number;
  /** 삭제된 관계의 끝으로만 그래프에 든 노드 */
  only?: "base";
}

export interface EdgeChange {
  /** null은 양쪽 시점에 있고 sites 수만 달라진 선이다. */
  change: "added" | "deleted" | null;
  /** 기준 시점의 sites 수 */
  before: number | null;
}

export interface ComparedFile {
  /** 레포 루트 기준 경로. 삭제된 파일은 기준 시점의 경로다. */
  path: string;
  /** 이름이 바뀌기 전의 경로 */
  old: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  added: number;
  deleted: number;
  test: boolean;
}

/**
 * 두 시점의 비교. graph는 대상 시점의 그래프에 삭제된 노드와 선을 더한 것이고 tree는 대상 시점의 파일트리에 삭제된 파일과 폴더를 더한 것이다.
 * 삭제된 노드의 path와 range는 기준 시점의 값이다.
 */
export interface Comparison {
  base: string;
  target: string;
  /** 대상이 작업 중인 상태일 때 이 비교가 쓴 분석 결과의 판 번호. 대상이 커밋이면 0이다. */
  revision: number;
  graph: Graph;
  tree: Tree;
  /** 노드 id → 변경 내용. 바뀐 노드만 담는다. */
  nodes: Record<string, NodeChange>;
  /** 선의 키(`{source}|{target}|{kind}`) → 변경 내용. 바뀐 선만 담는다. */
  edges: Record<string, EdgeChange>;
  files: ComparedFile[];
  /** 대상 시점의 미사용 후보 */
  unused: Unused;
}

export interface ApiErrorBody {
  error: string;
}
