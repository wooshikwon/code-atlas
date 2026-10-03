// 백엔드 호출은 모두 이 파일을 거친다. 화면 컴포넌트는 fetch를 직접 부르지 않는다.
import type { ApiErrorBody, FileText, Graph, Repo, Tree } from "./types";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (response.ok) {
    return (await response.json()) as T;
  }
  if (response.status === 404) {
    const body = (await response.json()) as ApiErrorBody;
    throw new ApiError(body.error, 404);
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

export function getFile(path: string): Promise<FileText> {
  return request(`/api/file?path=${encodeURIComponent(path)}`);
}
