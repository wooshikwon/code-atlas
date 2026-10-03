# code-atlas

파이썬 레포의 패키지·모듈·클래스·함수를 노드로, 호출·사용·상속 관계를 선으로 그려 보여 주는 로컬 탐색기다. 왼쪽 파일 트리에서 파일을 고르면 오른쪽 그래프가 그 노드에 초점을 맞추고, 코드 뷰어가 정의를 보여 준다. 구조는 `ast`로 읽고, 호출 대상은 basedpyright 언어 서버에 정의 위치를 물어 확인한다.

설계 문서는 vault `personal/projects/code-atlas/docs/`에 있다.

## 구성

| 경로 | 역할 |
|---|---|
| `code_atlas/model.py` | 노드·선·지점·분석 결과 자료형. 필드는 HTTP API 계약과 같다 |
| `code_atlas/collect.py` | 분석할 `.py` 파일 수집(`.gitignore`·가상환경 폴더 제외), 소스 루트·테스트 코드 판정, `pyproject.toml`의 진입점 설정 |
| `code_atlas/extract.py` | 파일마다 `ast`로 정의 노드와 관계 후보 지점(호출·import·이름 사용·데코레이터·타입·상속)을 뽑는다 |
| `code_atlas/lsp.py` | basedpyright 언어 서버 세션 수명과 UTF-8 바이트·UTF-16 열 변환 |
| `code_atlas/resolve.py` | 언어 서버가 돌려준 정의 위치를 노드 id와 선 종류로 바꾼다 |
| `code_atlas/graph.py` | 노드·선 조립, 패키지 노드, 데이터 클래스·오버라이드·진입점 판정, 해석률 집계 |
| `code_atlas/analyze.py` | 수집부터 그래프 조립까지 차례로 부르는 분석 진입점 |
| `code_atlas/venv.py` | 대상 레포의 가상환경 인터프리터 탐색 |
| `code_atlas/api.py` | `/api/repo`·`/api/tree`·`/api/graph`·`/api/file` 경로와 `frontend/dist/` 서빙. `127.0.0.1`에만 연다 |
| `code_atlas/cli.py` | `code-atlas <레포>`(분석 뒤 서버 실행)와 `code-atlas analyze <레포>`(결과 출력) 명령 |
| `frontend/src/api/` | API 계약 자료형과 백엔드 호출. 화면 컴포넌트는 `client.ts`만 거친다 |
| `frontend/src/state/` | 분석 결과와 선택·마우스 올림·연 파일·테스트 코드 표시·화면 색 상태를 담는 저장소 `useAtlas()` |
| `frontend/src/theme.ts` | 밝은 화면·어두운 화면 색 값과 CSS 변수 내보내기 |
| `frontend/src/tree/` | 파일 트리. 파일을 누르면 그 모듈 노드를 고른다 |
| `frontend/src/code/` | 읽기 전용 Monaco 코드 뷰어와 범위 강조. Monaco는 CDN 없이 번들에 넣는다 |
| `frontend/src/graph/` | 구조 뷰. `layout.ts`가 ELK를 Web Worker로 돌려 좌표를 정하고, `scope.ts`가 그릴 선을, `focus.ts`가 초점 단계를, `view.ts`가 선마다 경로·색·불투명도를 정한다. `nodes/`·`edges/`는 React Flow 노드·선 컴포넌트, `Legend.tsx`·`InfoBox.tsx`는 범례와 정보 상자다 |
| `tests/fixtures/sample_repo/` | 시험용 고정 레포. `src/` 소스 루트, 하위 패키지, 함수 안 import, 상속, dataclass, `__main__` 블록, 한글 문자열 뒤 호출, 동적 호출을 담는다 |

## 실행

```bash
.venv/bin/code-atlas <레포 경로> [--python PATH] [--port 8766] [--no-open]
.venv/bin/code-atlas analyze <레포 경로> [--python PATH] [--json]
```

화면은 `frontend/dist/`를 같은 포트에서 서빙하므로 먼저 `cd frontend && npm install && npm run build`로 빌드한다. 대상 레포의 인터프리터는 `.venv`, `venv`, poetry 환경 순서로 찾고, 찾지 못하면 `--python`으로 지정한다. 화면이 없는 서버에서는 브라우저를 열지 않고 주소만 출력한다.

## 개발

Python 3.12 이상이 필요하다.

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

`tests/test_lsp.py`·`tests/test_graph.py`는 code-atlas 가상환경의 basedpyright를 실제로 띄운다. 테스트는 고정 레포를 임시 디렉토리에 복사해 돌린다. git에 담을 수 없는 무시 대상 파일과 가상환경 폴더는 `tests/conftest.py`가 복사본에 만든다.

화면을 고칠 때는 백엔드를 띄운 채 `frontend/`에서 `npm run dev`를 실행한다. Vite 개발 서버가 `/api`를 `localhost:8766`으로 넘긴다. `npm run typecheck`로 타입을 검사하고 `npm test`로 배치·그리는 범위·초점 계산을 고정 그래프에서 확인한다. `node scripts/screenshot.mjs [주소] [노드 id]`는 밝은 화면·어두운 화면·초점 상태 세 장을 `~/data/code-atlas/screenshots/`에 찍는다. Playwright가 받은 chromium과 다른 실행 파일을 쓰려면 `CHROMIUM_PATH`에 경로를 넣는다.
