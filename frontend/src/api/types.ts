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

/** 코드 범위 하나의 코드 분석. start와 end는 1부터 세는 파일 줄 번호다. 같은 범위에 질문이 다른 분석이 여럿 있을 수 있다. */
export interface Explanation {
  start: number;
  end: number;
  /** 그 범위를 두고 적은 질문. 질문 없이 범위를 설명하게 했으면 빈 글이다. */
  question: string;
  /** 문단마다 한 줄 */
  text: string;
  /** 분석을 만든 뒤 그 줄 범위의 코드가 바뀌었다 */
  stale: boolean;
  /** 분석을 만든 `claude` 호출의 사용량. 만든 응답에만 있고, 캐시에서 읽은 분석은 null이다. */
  usage?: Usage | null;
}

/** 두 시점을 엮은 문서에서 고른, 삭제된 줄이 든 범위가 기준 시점에서 차지하는 줄. base와 target은 견준 두 시점의 이름이다. */
export interface OldSpan {
  base: string;
  target: string;
  start: number;
  end: number;
}

/** 줄 머리에 `-`·`+`·빈칸 표시를 붙인 범위의 본문. 삭제된 줄이 든 범위는 old에 기준 시점의 줄을 담는다. */
export interface MarkedCode {
  code: string;
  old: OldSpan | null;
}

/**
 * 두 시점의 비교에 묶어 둔 코드 분석. 삭제된 줄이 든 범위의 분석이다. start와 end는 대상 시점의 줄이고 그 범위에 대상 시점의 줄이
 * 없으면 둘 다 0이다. digest는 설명을 만든 때의 표시 붙은 본문의 SHA-256이다.
 */
export interface ComparedExplanation {
  start: number;
  end: number;
  old_start: number;
  old_end: number;
  question: string;
  text: string;
  digest: string;
}

export interface Explanations {
  explanations: Explanation[];
  /** 두 시점을 넘겨 물었을 때만 있다. */
  compared?: ComparedExplanation[];
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

/** 분석의 단계. 연 레포가 없으면 idle이다. */
export type Phase = "collect" | "extract" | "resolve" | "build" | "ready" | "failed" | "idle";

/** 분석의 단계와 진행 수, 결과의 판 번호, 언어 서버의 상태, 서버가 레포를 열고 닫은 횟수 */
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
  /** 서버가 뜰 때 1이고 레포를 열거나 닫을 때마다 1씩 는다. */
  session: number;
}

/** 도구의 후보 하나를 실행해 본 결과 */
export interface Attempt {
  /** 후보의 출처: 저장한 경로(saved), 환경(env), 알려진 위치(known) */
  source: string;
  path: string | null;
  ok: boolean;
  /** 판 번호나 통과하지 못한 까닭 */
  detail: string;
}

/** 도구 하나를 찾은 결과 */
export interface Found {
  /** claude, git, python */
  tool: string;
  /** 확인을 통과한 경로. 없으면 null이다. */
  path: string | null;
  version: string | null;
  /** 통과한 후보의 출처 */
  source: string | null;
  attempts: Attempt[];
  /** 경로는 통과했지만 쓰지 못하는 까닭 */
  note: string | null;
  /** claude만: CLI가 알려 준 로그인 방법 */
  auth: string | null;
  /** python만: `sys.prefix` */
  prefix: string | null;
  /** python만: 가상환경인지 */
  venv: boolean | null;
}

/** 로그인 셸에서 환경을 읽은 결과. 앱이 띄운 실행에서만 읽는다. */
export interface ShellEnv {
  /** 사용자 계정의 셸 경로 */
  shell: string;
  ok: boolean;
  /** 읽지 못한 까닭. 읽었으면 빈 글이다. */
  detail: string;
  /** 읽는 데 걸린 초 */
  seconds: number;
}

/** 환경 점검의 값. shell은 터미널에서 띄운 실행에서 null이고, python은 연 레포가 없으면 null이다. */
export interface Tools {
  shell: ShellEnv | null;
  claude: Found;
  git: Found;
  python: Found | null;
}

/** 직접 고르는 도구 */
export type Pickable = "claude" | "git";

/** `claude -p`에 요청 하나를 보내 본 결과. detail은 답하지 않은 까닭이고 답했으면 빈 글이다. */
export interface Answer {
  ok: boolean;
  seconds: number;
  detail: string;
}

/** 앱의 판. commit과 built는 빌드 명령으로 만든 앱에서만 값이 있다. */
export interface About {
  commit: string | null;
  built: string | null;
  python: string;
  basedpyright: string;
}

/** 고른 폴더를 레포로 열기 전의 판정 */
export interface Probe {
  /** 디스크에 적힌 대소문자로 맞춘 절대 경로 */
  path: string;
  exists: boolean;
  python_files: boolean;
  /** 조상 가운데 `.git`이나 `pyproject.toml`이 있는 가장 가까운 폴더 */
  project: string | null;
  /** 바로 아래 폴더 가운데 `.git`이 있는 폴더의 이름 */
  nested: string[];
  git: boolean;
  /** 레포의 인터프리터. 열 수 없는 폴더는 찾지 않아 시도 목록이 비어 있다. */
  python: Found;
}

/** 연 적이 있는 레포 */
export interface RecentRepo {
  root: string;
  name: string;
  /** 인터프리터를 고르는 화면에서 고른 경로 */
  python: string | null;
  /** 마지막으로 연 시각(epoch 초) */
  opened: number;
  /** 폴더가 지금도 있는지 */
  exists: boolean;
}

/** 비교할 시점의 이름. 커밋은 40자 해시, 작업 중인 상태는 `worktree`다. */
export const WORKTREE = "worktree";

/** 커밋을 가리키는 이름표 하나. kind는 로컬 브랜치(branch), 태그(tag), 원격 브랜치(remote)이고 원격 브랜치의 name은 `origin/main` 꼴이다. */
export interface Ref {
  name: string;
  kind: "branch" | "tag" | "remote";
}

export interface Commit {
  hash: string;
  /** 부모 커밋의 해시. 첫째 부모가 앞이다. */
  parents: string[];
  /** 커밋한 시각(초) */
  time: number;
  subject: string;
  /** 이 커밋을 가리키는 이름표. 로컬 브랜치, 태그, 원격 브랜치 순서다. */
  refs: Ref[];
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
  /** 그 파일의 줄 토막(`git diff -U0`). 하나가 [기준 쪽 시작 줄, 줄 수, 대상 쪽 시작 줄, 줄 수]이고 줄 수의 합이 deleted와 added다. */
  hunks: [number, number, number, number][];
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
