// 백엔드 호출은 모두 이 파일을 거친다. 화면 컴포넌트는 fetch를 직접 부르지 않는다.
import type {
  ApiErrorBody,
  Changes,
  Comparison,
  Definition,
  Explanation,
  Explanations,
  FileText,
  Graph,
  History,
  Hover,
  MadeSummary,
  MarkedCode,
  OldSpan,
  Repo,
  Stat,
  Status,
  Summaries,
  SummaryStatus,
  Tree,
  Unused,
} from "./types";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, signal?: AbortSignal, method = "GET", body?: unknown): Promise<T> {
  const sent = body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, { signal, method, ...sent });
  if (response.ok) {
    return (await response.json()) as T;
  }
  if (response.status === 404 || response.status === 500 || response.status === 503) {
    const body = (await response.json()) as ApiErrorBody;
    throw new ApiError(body.error, response.status);
  }
  throw new ApiError(`HTTP ${response.status} ${response.statusText}`, response.status);
}

/** 분석 결과가 없는 동안에도 응답한다. */
export function getStatus(): Promise<Status> {
  return request("/api/status");
}

export function getRepo(): Promise<Repo> {
  return request("/api/repo");
}

/** 서버가 레포를 다시 분석하게 하고 끝날 때까지 기다린다. 분석하지 못하면 서버는 앞의 분석 결과를 그대로 둔다. */
export function postReload(): Promise<Repo> {
  return request("/api/reload", undefined, "POST");
}

export function getTree(): Promise<Tree> {
  return request("/api/tree");
}

export function getGraph(): Promise<Graph> {
  return request("/api/graph");
}

const files = new Map<string, Promise<FileText>>();

/**
 * 코드 뷰어와 정보 상자가 같은 파일을 한 번만 받는다. 실패한 요청은 기억하지 않는다. at은 커밋 해시이고 그 커밋의 본문을 받는다.
 * at이 없으면 작업 중인 상태의 본문이다.
 */
export function getFile(path: string, at?: string): Promise<FileText> {
  const key = at === undefined ? path : `${at}:${path}`;
  let file = files.get(key);
  if (file === undefined) {
    file = request<FileText>(`/api/file?path=${encodeURIComponent(path)}${at === undefined ? "" : `&at=${at}`}`);
    file.catch(() => files.delete(key));
    files.set(key, file);
  }
  return file;
}

/** 받아 둔 파일 본문을 버린다. 서버가 레포를 다시 분석한 뒤에 부른다. */
export function forgetFiles(): void {
  files.clear();
}

function position(path: string, line: number, col: number): string {
  return `path=${encodeURIComponent(path)}&line=${line}&col=${col}`;
}

/** line은 1부터, col은 0부터 세는 UTF-16 단위다. */
export function getHover(path: string, line: number, col: number, signal?: AbortSignal): Promise<Hover> {
  return request(`/api/hover?${position(path, line, col)}`, signal);
}

export function getDefinition(path: string, line: number, col: number): Promise<Definition> {
  return request(`/api/definition?${position(path, line, col)}`);
}

/** 캐시에 있는 요약만 읽는다. */
export function getSummary(node: string): Promise<SummaryStatus> {
  return request(`/api/summary?node=${encodeURIComponent(node)}`);
}

/** 레포의 노드마다 남겨 둔 요약의 요지 */
export function getSummaries(): Promise<Summaries> {
  return request("/api/summaries");
}

/** 캐시에 없으면 요약을 만들게 한다. refresh면 캐시에 있어도 다시 만든다. */
export function makeSummary(node: string, refresh: boolean): Promise<MadeSummary> {
  return request(`/api/summary?node=${encodeURIComponent(node)}${refresh ? "&refresh=true" : ""}`, undefined, "POST");
}

function span(path: string, start: number, end: number, old?: OldSpan): string {
  const between = old === undefined ? "" : `&base=${old.base}&target=${old.target}&old_start=${old.start}&old_end=${old.end}`;
  return `path=${encodeURIComponent(path)}&start=${start}&end=${end}${between}`;
}

/** 파일에 저장해 둔 코드 분석. between을 넘기면 그 두 시점의 비교에 묶어 둔 설명을 함께 받는다. */
export function getExplanations(path: string, between?: { base: string; target: string }): Promise<Explanations> {
  return request(`/api/explanations?path=${encodeURIComponent(path)}${between === undefined ? "" : `&base=${between.base}&target=${between.target}`}`);
}

/**
 * 캐시에 없으면 코드 범위의 분석을 만들어 저장하게 한다. refresh면 캐시에 있어도 다시 만든다. question은 그 범위를 두고 적은 질문이고
 * 빈 글이면 범위를 설명하게 한다. 두 시점을 엮은 문서에서 고른 범위에 바뀐 줄이 있으면 marked에 표시를 붙인 본문을 싣고, 삭제된 줄이
 * 든 범위는 start와 end가 대상 시점의 줄(없으면 0)이다.
 */
export function makeExplanation(path: string, start: number, end: number, refresh: boolean, question: string, marked?: MarkedCode): Promise<Explanation> {
  const query = `${span(path, start, end, marked?.old ?? undefined)}${refresh ? "&refresh=true" : ""}`;
  const body = { ...(marked === undefined ? {} : { code: marked.code }), ...(question === "" ? {} : { question }) };
  return request(`/api/explanation?${query}`, undefined, "POST", Object.keys(body).length === 0 ? undefined : body);
}

export function deleteExplanation(path: string, start: number, end: number, question: string, old?: OldSpan): Promise<{ deleted: boolean }> {
  const asked = question === "" ? "" : `&question=${encodeURIComponent(question)}`;
  return request(`/api/explanation?${span(path, start, end, old)}${asked}`, undefined, "DELETE");
}

/** 마지막 커밋 뒤에 바뀐 파일과 노드 */
export function getChanges(): Promise<Changes> {
  return request("/api/changes");
}

/** 분석을 끝낼 때 판정한 미사용 후보 */
export function getUnused(): Promise<Unused> {
  return request("/api/unused");
}

/** 커밋 그래프의 줄. skip번째 줄부터 limit줄을 받는다. */
export function getHistory(skip: number, limit: number): Promise<History> {
  return request(`/api/history?skip=${skip}&limit=${limit}`);
}

/** 두 시점의 기준과 대상, 바뀐 파일 수와 줄 수. a와 b의 순서는 뜻이 없다. */
export function getStat(a: string, b: string): Promise<Stat> {
  return request(`/api/compare/stat?a=${a}&b=${b}`);
}

/** 두 시점을 견준 결과. 서버가 두 시점의 분석을 끝낸 뒤에 응답한다. base와 target은 `getStat`이 돌려준 값이다. */
export function postCompare(base: string, target: string): Promise<Comparison> {
  return request("/api/compare", undefined, "POST", { base, target });
}
