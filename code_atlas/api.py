"""HTTP 경로를 메모리의 분석 결과에 연결하고, 빌드한 프론트엔드를 같은 포트에서 서빙한다."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from .collect import RepoFiles
from .model import Analysis, to_dict

HOST = "127.0.0.1"
PORT = 8765
DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"


def _tree(files: RepoFiles, analysis: Analysis) -> list[dict]:
    """수집한 파일과 그 조상 폴더로 파일 트리를 만든다. 폴더가 앞, 그 안은 이름 순서다."""
    node_ids = {n.id for n in analysis.nodes}
    package_of = {n.path: n.id for n in analysis.nodes if n.kind == "package" and n.path}
    root: dict = {"children": {}}
    for f in files.files:
        parts = f.path.split("/")
        current = root
        for i, name in enumerate(parts[:-1]):
            path = "/".join(parts[: i + 1])
            init = path + "/__init__.py"
            current = current["children"].setdefault(
                name,
                {
                    "path": path,
                    "name": name,
                    "kind": "dir",
                    "test": f.test,
                    "node": package_of.get(path, package_of.get(init)),
                    "children": {},
                },
            )
            current["test"] = current["test"] and f.test
        current["children"][parts[-1]] = {
            "path": f.path,
            "name": parts[-1],
            "kind": "file",
            "test": f.test,
            "node": f.module_id if f.module_id in node_ids else None,
        }
    return _entries(root["children"])


def _entries(children: dict) -> list[dict]:
    ordered = sorted(children.values(), key=lambda e: (e["kind"] != "dir", e["name"]))
    return [{**e, "children": _entries(e["children"])} if e["kind"] == "dir" else e for e in ordered]


def create_app(analysis: Analysis, files: RepoFiles, python: str | None = None) -> FastAPI:
    app = FastAPI(title="code-atlas")
    known = {f.path for f in files.files}
    repo = {
        "name": files.root.name,
        "root": str(files.root),
        "source_root": files.source_root,
        "python": python,
        "stats": analysis.stats,
    }
    tree = {"entries": _tree(files, analysis)}
    graph = {"nodes": [to_dict(n) for n in analysis.nodes], "edges": [to_dict(e) for e in analysis.edges]}

    @app.exception_handler(HTTPException)
    def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    @app.get("/api/repo")
    def get_repo() -> dict:
        return repo

    @app.get("/api/tree")
    def get_tree() -> dict:
        return tree

    @app.get("/api/graph")
    def get_graph() -> dict:
        return graph

    @app.get("/api/file")
    def get_file(path: str) -> dict:
        if path not in known:
            raise HTTPException(status_code=404, detail=f"분석 대상 파일이 아니다: {path}")
        text = files.abs_path(path).read_bytes().decode("utf-8-sig", errors="replace")
        return {"path": path, "text": text}

    @app.get("/{path:path}", include_in_schema=False)
    def get_static(path: str) -> FileResponse:
        """dist 안의 파일을 돌려주고, 파일이 아닌 경로는 index.html로 넘긴다. /api 아래는 넘기지 않는다."""
        index = DIST_DIR / "index.html"
        if path == "api" or path.startswith("api/") or not index.is_file():
            raise HTTPException(status_code=404, detail=f"없는 경로다: /{path}")
        target = (DIST_DIR / path).resolve()
        if target.is_file() and target.is_relative_to(DIST_DIR.resolve()):
            return FileResponse(target)
        return FileResponse(index)

    return app
