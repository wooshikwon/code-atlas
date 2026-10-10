# code-atlas

파이썬 레포의 패키지·모듈·클래스·함수를 노드로, 호출·사용·상속 관계를 선으로 그려 보여 주는 로컬 탐색기다. 파일 상자를 접힌 채로 열고, 파일이나 함수를 고르면 그 노드에서 나가는 흐름만 펼쳐 그리며, 그래프 위에 떠 있는 정보 패널이 고른 노드의 위치·요약·코드를 보여 준다. 구조는 `ast`로 읽고, 호출 대상은 basedpyright 언어 서버에 정의 위치를 물어 확인한다.

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
| `code_atlas/changes.py` | 대상 레포에서 `git status`·`git diff HEAD`를 읽어 마지막 커밋 뒤에 바뀐 파일과 줄 범위를 낸다. 인덱스를 다시 쓰지 않는 읽기 전용 명령만 부른다 |
| `code_atlas/summary.py` | Claude Code CLI(`claude -p`)를 불러 노드의 한두 문장 요약을 만들고 `~/.cache/code-atlas/summaries.db`에 저장한다 |
| `code_atlas/api.py` | 서버가 떠 있는 동안 언어 서버 세션 하나를 유지한다. `/api/repo`·`/api/tree`·`/api/graph`·`/api/file`(분석 결과), `/api/hover`·`/api/definition`(언어 서버에 묻는 타입 정보와 정의 위치), `/api/changes`(변경 표시), `/api/summary`(LLM 요약) 경로와 `frontend/dist/` 서빙. `127.0.0.1`에만 연다 |
| `code_atlas/cli.py` | `code-atlas <레포>`(분석 뒤 서버 실행)와 `code-atlas analyze <레포>`(결과 출력) 명령 |
| `frontend/src/api/` | API 계약 자료형과 백엔드 호출. 화면 컴포넌트는 `client.ts`만 거친다 |
| `frontend/src/state/` | `store.ts`의 zustand 저장소 `useAtlas(selector)`가 분석 결과, 선택, 뷰 종류, 접은 폴더, 흐름 단계, 토글, 정보 패널 사각형을 담고 `history.ts`가 탐색 이력을 맡는다. `changes.ts`는 `/api/changes`를 15초마다와 창이 포커스를 받을 때 다시 받는다 |
| `frontend/src/theme.ts` | 밝은 화면·어두운 화면 색 값과 CSS 변수 내보내기 |
| `frontend/src/tree/` | 파일트리. `rows.ts`가 폴더·파일·고른 파일의 클래스·함수 목록을 행 배열로 펴고, `TreeSearch.tsx`가 맨 위 검색 칸과 결과 목록을, `Icon.tsx`가 종류 기호를 그린다. 행 오른쪽 끝에 변경 표시를 붙인다 |
| `frontend/src/search/` | `Mod+P` 검색 팔레트. `index.ts`가 파일·클래스·함수 이름 색인과 `fzf` 매처를 맡는다 |
| `frontend/src/nav/` | `Trail.tsx`는 상단 줄의 탐색 경로 표시, `keys.ts`는 이력 이동(`Alt+←`·`Alt+→`)·`Esc`·팔레트 열기 단축키다 |
| `frontend/src/panel/` | 그래프 위에 떠 있는 정보 패널. 머리 줄(`Header.tsx`), LLM 요약 칸(`Summary.tsx`), 선의 지점 목록(`Sites.tsx`), 끌기와 크기 조절(`usePanelRect.ts`·`rect.ts`) |
| `frontend/src/code/` | 고른 노드의 줄 범위만 여는 읽기 전용 Monaco 코드 뷰어. `hover.ts`가 이름 위 hover를, `CodeView.tsx`가 `Mod`+클릭 정의 이동을 백엔드에 연결한다. Monaco는 CDN 없이 번들에 넣는다 |
| `frontend/src/graph/` | 구조 뷰와 함수 시점 뷰. `visible.ts`가 보이는 노드를, `flow.ts`가 고른 노드에서 나가는 흐름과 불투명도를, `scope.ts`가 그릴 선을, `columns.ts`가 열 번호와 연결 묶음·선반을 정한다. `layout.ts`가 ELK를 Web Worker로 돌려 좌표를 정하고, `view.ts`가 선마다 경로를, `motion.ts`가 배치 움직임을, `viewport.ts`가 화면 이동 좌표를 낸다. `callview.ts`·`CallView.tsx`는 함수 시점 뷰, `nodes/`·`edges/`는 React Flow 노드·선 컴포넌트, `Legend.tsx`·`Tooltip.tsx`는 범례와 말풍선이다 |
| `frontend/scripts/shots.mjs` | 화면 시나리오 스크립트. 떠 있는 서버에서 정해진 조작을 하고 확인 항목의 통과 여부와 스크린샷을 남긴다 |
| `scripts/measure_resolution.py` | 호출 지점 해석 상태별 비율 출력, 고정 시드 표본 JSONL 작성(`~/data/code-atlas/resolution-sample.jsonl`), `--report`로 직접 채운 판정 집계 |
| `tests/fixtures/sample_repo/` | 시험용 고정 레포. `src/` 소스 루트, 하위 패키지, 함수 안 import, 상속, dataclass, `__main__` 블록, 한글 문자열 뒤 호출, 동적 호출을 담는다 |

## 실행

```bash
.venv/bin/code-atlas <레포 경로> [--python PATH] [--port 8766] [--no-open]
.venv/bin/code-atlas analyze <레포 경로> [--python PATH] [--json]
```

화면은 `frontend/dist/`를 같은 포트에서 서빙하므로 먼저 `cd frontend && npm install && npm run build`로 빌드한다. 대상 레포의 인터프리터는 `.venv`, `venv`, poetry 환경 순서로 찾고, 찾지 못하면 `--python`으로 지정한다. 화면이 없는 서버에서는 브라우저를 열지 않고 주소만 출력한다.

LLM 요약은 이 기계에 설치된 Claude Code CLI를 구독 계정 로그인으로 부르므로 API 키가 필요 없다. `claude`가 없거나 `claude auth login`으로 로그인돼 있지 않으면 요약 칸에 그 사실을 적고 나머지 기능은 그대로 동작한다. 요약은 노드를 고른 채 머물 때 그 노드 하나만 만든다.

대상 레포가 git 저장소면 마지막 커밋 뒤에 수정하거나 추가한 파일과 함수를 그래프와 파일트리에 표시한다. 대상 레포에는 읽기 전용 git 명령(`status`, `diff`, `rev-parse`, `symbolic-ref`)만 부르고 파일을 쓰지 않는다.

## 개발

Python 3.12 이상이 필요하다.

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

`tests/test_lsp.py`·`tests/test_graph.py`·`tests/test_api.py`는 code-atlas 가상환경의 basedpyright를 실제로 띄운다. `tests/test_summary.py`는 가짜 `claude` 실행 파일을 쓰고 실제 CLI를 부르지 않는다. 테스트는 고정 레포를 임시 디렉토리에 복사해 돌린다. git에 담을 수 없는 무시 대상 파일과 가상환경 폴더는 `tests/conftest.py`가 복사본에 만든다.

화면을 고칠 때는 백엔드를 띄운 채 `frontend/`에서 `npm run dev`를 실행한다. Vite 개발 서버가 `/api`를 `localhost:8766`으로 넘긴다. `npm run typecheck`로 타입을 검사하고 `npm test`로 저장소·보이는 노드·흐름·그릴 선·열 배정·배치·검색 색인·파일트리 행 계산을 고정 그래프에서 확인한다.

화면은 `frontend/`에서 화면 시나리오 스크립트로 확인한다.

```bash
node scripts/shots.mjs [주소] [--only 이름,이름] [--with-summary]
```

떠 있는 서버의 주소를 받고(기본 `http://127.0.0.1:8766`) 서버를 띄우지 않는다. 시나리오마다 새 브라우저 컨텍스트에서 조작하고 확인 항목을 `통과`·`실패`와 함께 한 줄씩 출력하며, 스크린샷을 `~/data/code-atlas/screenshots/s2-{이름}.png`(1700×1000, 배율 2)에 남긴다. 실패한 확인 항목이나 페이지 오류·콘솔 오류가 있으면 종료 코드 1로 끝난다. 시나리오는 `open`, `file`, `function`, `body`, `panel`, `hover`, `folder`, `callview`, `search`, `zoom`, `external`, `dark`, `tree`, `tree-search`, `changes`, `zoom-keep`, `summary`이고, 노드 이름과 수의 기대값은 sync-engine을 연 서버가 기준이다. `summary`는 Claude Code 구독 사용량을 쓰므로 `--only`로 지정하거나 `--with-summary`를 줬을 때만 돌고, 다른 시나리오는 요약을 만드는 요청을 서버로 보내지 않는다. `changes`는 대상 레포에서 `git status`·`git diff`를 직접 읽어 화면과 비교하므로 서버와 같은 기계에서 돌린다. Playwright가 받은 chromium과 다른 실행 파일을 쓰려면 `CHROMIUM_PATH`에 경로를 넣는다.
