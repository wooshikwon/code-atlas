// 백엔드 호출은 모두 이 파일을 거친다. 화면 컴포넌트는 fetch를 직접 부르지 않는다.
import type {
  ApiErrorBody,
  Changes,
  Definition,
  Explanation,
  Explanations,
  FileText,
  Graph,
  Hover,
  MadeSummary,
  Repo,
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

async function request<T>(path: string, signal?: AbortSignal, method = "GET"): Promise<T> {
  const response = await fetch(path, { signal, method });
  if (response.ok) {
    return (await response.json()) as T;
  }
  if (response.status === 404 || response.status === 503) {
    const body = (await response.json()) as ApiErrorBody;
    throw new ApiError(body.error, response.status);
  }
  throw new ApiError(`HTTP ${response.status} ${response.statusText}`, response.status);
}

export function getRepo(): Promise<Repo> {
  return request("/api/repo");
}

export function getTree(): Promise<Tree> {
  return request("/api/tree");
}

export function getGraph(): Promise<Graph> {
  return request("/api/graph");
}

const files = new Map<string, Promise<FileText>>();

/** 코드 뷰어와 정보 상자가 같은 파일을 한 번만 받는다. 실패한 요청은 기억하지 않는다. */
export function getFile(path: string): Promise<FileText> {
  let file = files.get(path);
  if (file === undefined) {
    file = request<FileText>(`/api/file?path=${encodeURIComponent(path)}`);
    file.catch(() => files.delete(path));
    files.set(path, file);
  }
  return file;
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

/** 캐시에 없으면 요약을 만들게 한다. refresh면 캐시에 있어도 다시 만든다. */
export function makeSummary(node: string, refresh: boolean): Promise<MadeSummary> {
  return request(`/api/summary?node=${encodeURIComponent(node)}${refresh ? "&refresh=true" : ""}`, undefined, "POST");
}

function span(path: string, start: number, end: number): string {
  return `path=${encodeURIComponent(path)}&start=${start}&end=${end}`;
}

/** 파일에 저장해 둔 코드 범위 설명 */
export function getExplanations(path: string): Promise<Explanations> {
  return request(`/api/explanations?path=${encodeURIComponent(path)}`);
}

/** 캐시에 없으면 코드 범위의 설명을 만들어 저장하게 한다. refresh면 캐시에 있어도 다시 만든다. */
export function makeExplanation(path: string, start: number, end: number, refresh: boolean): Promise<Explanation> {
  return request(`/api/explanation?${span(path, start, end)}${refresh ? "&refresh=true" : ""}`, undefined, "POST");
}

export function deleteExplanation(path: string, start: number, end: number): Promise<{ deleted: boolean }> {
  return request(`/api/explanation?${span(path, start, end)}`, undefined, "DELETE");
}

/** 마지막 커밋 뒤에 바뀐 파일과 노드 */
export function getChanges(): Promise<Changes> {
  return request("/api/changes");
}

/** 분석을 끝낼 때 판정한 미사용 후보 */
export function getUnused(): Promise<Unused> {
  return request("/api/unused");
}
