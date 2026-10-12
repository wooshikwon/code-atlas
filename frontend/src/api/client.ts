// 백엔드 호출은 모두 이 파일을 거친다. 화면 컴포넌트는 fetch를 직접 부르지 않는다. 주소의 앞부분은 `host`가 준다.
import { host } from "../host";
import type {
  About,
  Answer,
  ApiErrorBody,
  Changes,
  Comparison,
  Definition,
  Explanation,
  Explanations,
  FileText,
  Found,
  Graph,
  History,
  Hover,
  MadeSummary,
  MarkedCode,
  OldSpan,
  Pickable,
  Probe,
  RecentRepo,
  Repo,
  Stat,
  Status,
  Summaries,
  SummaryStatus,
  Tools,
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
  const response = await fetch(`${await host.base()}${path}`, { signal, method, ...sent });
  if (response.ok) {
    return (await response.json()) as T;
  }
  if ([400, 404, 409, 500, 503].includes(response.status)) {
    const body = (await response.json()) as ApiErrorBody;
    throw new ApiError(body.error, response.status);
  }
  throw new ApiError(`HTTP ${response.status} ${response.statusText}`, response.status);
}

/** 분석 결과가 없는 동안에도 응답한다. */
export function getStatus(): Promise<Status> {
  return request("/api/status");
}

/** 고른 폴더를 레포로 열기 전의 판정. 폴더를 읽지 못하면 까닭을 적은 400이다. */
export function postProbe(path: string): Promise<Probe> {
  return request("/api/probe", undefined, "POST", { path });
}

/**
 * 폴더를 레포로 연다. 서버는 앞의 레포를 닫고 첫 분석을 띄운 뒤 분석을 기다리지 않고 응답한다. python은 인터프리터를 고르는 화면에서
 * 고른 경로이고 서버가 그 레포의 인터프리터로 기억한다. 열지 못하면 까닭을 적은 400이고 앞의 레포는 그대로다.
 */
export function postOpen(path: string, python?: string): Promise<{ session: number }> {
  return request("/api/open", undefined, "POST", { path, ...(python === undefined ? {} : { python }) });
}

export function postClose(): Promise<{ session: number }> {
  return request("/api/close", undefined, "POST");
}

/** 연 적이 있는 레포. 마지막으로 연 레포가 앞이다. */
export function getRepos(): Promise<{ repos: RecentRepo[] }> {
  return request("/api/repos");
}

export function deleteRepo(root: string): Promise<unknown> {
  return request(`/api/repos?root=${encodeURIComponent(root)}`, undefined, "DELETE");
}

/** 인터프리터를 고르는 화면의 후보. 실행해 확인한 것만 온다. */
export function getInterpreters(): Promise<{ found: Found[] }> {
  return request("/api/interpreters");
}

/** 로그인 셸의 환경, `claude`, `git`, 연 레포의 인터프리터를 찾은 결과 */
export function getTools(): Promise<Tools> {
  return request("/api/tools");
}

/** 찾아 둔 값을 버리고 다시 찾게 한다. */
export function postToolsCheck(): Promise<Tools> {
  return request("/api/tools/check", undefined, "POST");
}

/** 직접 고른 실행 파일을 그 도구의 경로로 저장한다. 실행해 확인하지 못하면 까닭을 적은 400이고 저장하지 않는다. */
export function putTool(tool: Pickable, path: string): Promise<Found> {
  return request(`/api/tools/${tool}`, undefined, "PUT", { path });
}

/** 저장한 경로를 지우고 다시 찾게 한다. */
export function deleteTool(tool: Pickable): Promise<Found> {
  return request(`/api/tools/${tool}`, undefined, "DELETE");
}

/** `claude -p`에 한 낱말을 답하게 하는 요청 하나를 보낸다. 구독 사용량을 쓰므로 `응답 확인`을 누를 때만 부른다. */
export function postClaudeAsk(): Promise<Answer> {
  return request("/api/tools/claude/ask", undefined, "POST");
}

export function getAbout(): Promise<About> {
  return request("/api/about");
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
