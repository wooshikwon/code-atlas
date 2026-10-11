# code-atlas

파이썬 레포의 패키지·모듈·클래스·함수를 노드로, 호출·사용·상속 관계를 선으로 그려 보여 주는 로컬 탐색기다. 파일 상자를 접힌 채로 열고, 파일이나 함수를 고르면 그 노드에서 나가는 흐름만 펼쳐 그리며, 그래프 위에 떠 있는 정보 패널이 고른 노드의 위치·요약·코드를 보여 준다. 구조는 `ast`로 읽고, 호출 대상은 basedpyright 언어 서버에 정의 위치를 물어 확인한다.

설계 문서는 vault `personal/projects/code-atlas/docs/`에 있다.

## 설치

Python 3.12 이상과 Node.js(npm)가 필요하다. macOS와 Linux에서 쓴다.

```bash
python3 -m venv .venv
.venv/bin/pip install -e .
cd frontend && npm install && npm run build
```

basedpyright는 Python 의존성으로 함께 설치한다. 화면은 `frontend/dist/`를 백엔드가 같은 포트에서 서빙하므로 처음 한 번과 `frontend/src`를 고친 뒤에 `npm run build`를 실행한다. 백엔드는 이 폴더의 `frontend/dist/`를 읽으므로 `pip install`에 `-e`를 붙인다.

## 실행

```bash
.venv/bin/code-atlas <레포 경로> [--python PATH] [--port 8766] [--no-open] [--style-guide PATH]
.venv/bin/code-atlas analyze <레포 경로> [--python PATH] [--json]
```

`code-atlas <레포 경로>`는 레포를 분석한 뒤 `http://127.0.0.1:8766`에 서버를 띄우고 브라우저를 연다. 분석이 끝나면 터미널에 `노드 695 · 선 1417 · 지점 4680 · 호출 해석률 87.2% (2043/2342) · 6033ms` 같은 줄을 한 번 출력한다. 언어 서버가 시간 안에 답하지 못한 지점이 있으면 `정의 요청 N개가 시간 안에 응답받지 못했다`를 표준 오류에 적고, 화면 상단 줄 통계에 `응답 없음 N`을 붙인다. `code-atlas analyze`는 서버를 띄우지 않고 같은 줄만 출력하며, `--json`을 주면 분석 결과 전체를 JSON으로 출력한다.

| 옵션 | 뜻 |
|---|---|
| `--python PATH` | 대상 레포의 파이썬 인터프리터. 실행 파일 경로나 `PATH`에 있는 이름을 준다 |
| `--port PORT` | 서버 포트. 기본값은 8766이고, 이미 쓰는 포트면 안내를 적고 끝난다 |
| `--no-open` | 브라우저를 열지 않고 주소만 출력한다. `DISPLAY`가 없는 Linux에서는 옵션 없이도 주소만 출력한다 |
| `--style-guide PATH` | LLM 요약의 문체를 정하는 서술 규약 문서 |

서버는 `127.0.0.1`에만 열린다. `Ctrl+C`를 한 번 누르면 분석 중에도 서버와 언어 서버 프로세스를 함께 끝낸다.

### 대상 레포의 인터프리터

basedpyright가 대상 레포의 외부 패키지 import를 해석하려면 그 레포의 파이썬 인터프리터가 필요하다. `--python`을 주지 않으면 레포 루트에서 `.venv/bin/python`, `venv/bin/python`, poetry 환경(`poetry.lock`이 있고 `poetry`가 설치돼 있을 때 `poetry env info -p`가 알려 준 환경) 순서로 찾는다. 찾지 못하면 `<레포>에서 가상환경을 찾지 못했다. --python으로 인터프리터 경로를 지정한다.`를 적고 종료 코드 2로 끝나므로, 인터프리터를 직접 지정한다.

```bash
.venv/bin/code-atlas ~/work/some-repo --python ~/work/some-repo/env/bin/python
.venv/bin/code-atlas ~/work/some-repo --python python3
```

`--python`에 준 경로를 실행할 수 없을 때도 안내를 적고 종료 코드 2로 끝난다. 가상환경이 없는 레포에 시스템 인터프리터를 지정하면 그 인터프리터에 설치되지 않은 외부 패키지의 import와 그 패키지 객체를 거친 호출은 대상을 확인하지 못해 미확인 호출로 셀 수 있다. 레포 안의 함수·클래스 사이 관계는 그대로 분석한다. code-atlas는 대상 레포에 파일을 쓰지 않는다.

### 화면 조작

| 동작 | 결과 |
|---|---|
| 파일 상자나 파일트리의 파일 클릭 | 그 파일을 펼치고 파일 단위 흐름을 보여 준다 |
| 함수·클래스 클릭 | 그 노드에서 나가는 흐름을 상단 줄의 "흐름 단계"(1~3, 기본 2)만큼 펼치고 정보 패널에 코드를 연다 |
| 함수 더블클릭 | 그 함수를 호출하는 함수와 그 함수가 호출하는 함수만 보여 주는 함수 시점 뷰로 들어간다 |
| 접힌 폴더 상자 더블클릭, 파일트리의 폴더 행 클릭 | 폴더를 펼치거나 접는다 |
| 선에 마우스 올리기 | 그 선을 굵게 그려 다른 선 위에 보여 주고 출발·도착 노드를 말풍선에 적는다 |
| 선 클릭 | 그 선의 도착 노드를 클릭한 것처럼 고른다 |
| 선 `Shift`+클릭 | 정보 패널에 관계가 일어난 코드 줄 목록을 띄운다 |
| 미니맵 클릭·끌기 | 확대 비율을 그대로 둔 채 그 위치로 화면을 옮긴다 |
| 그래프 바탕 클릭, `Esc` | 선택을 푼다 |
| `Mod+P`, `Mod+K` | 파일·클래스·함수 이름으로 검색한다 |
| `Alt+←`, `Alt+→` | 탐색 이력을 뒤로, 앞으로 옮긴다. macOS에서는 `Cmd+[`·`Cmd+]`도 쓴다 |

`Mod`는 macOS에서 `Cmd`, 그 밖에서 `Ctrl`이다. 상단 줄의 토글로 테스트 코드와 외부 모듈 노드를 켜고, 왼쪽 아래 둥근 버튼 두 개로 미니맵과 범례를 접고 편다. 미니맵은 전체 그래프의 축소 그림 위에 지금 화면에 보이는 영역을 사각형으로 그리고, 처음에 펼친 채로 연다. 정보 패널은 머리 줄을 끌어 옮기고 가장자리를 끌어 크기를 바꾸며, 머리 줄을 더블클릭하면 기본 위치와 크기로 돌아간다.

## LLM 요약

정보 패널의 LLM 요약 칸은 고른 파일·클래스·함수의 설명을 요지, 하는 일, 앞뒤 흐름 세 부분으로 보여 준다. 설명은 이 컴퓨터에 설치된 Claude Code CLI를 `claude -p`로 불러 만들고, Claude Code에 로그인한 구독 계정을 쓰므로 API 키가 필요 없다.

1. Claude Code CLI를 설치한다(npm으로는 `npm install -g @anthropic-ai/claude-code`). code-atlas는 `claude` 실행 파일을 `PATH`와 `~/.local/bin/claude`에서 찾는다.
2. 터미널에서 `claude auth login`을 실행해 Claude 구독 계정으로 로그인한다.
3. `claude auth status`가 `"loggedIn": true`를 출력하는지 확인한다.
4. code-atlas를 실행해 노드를 고르고 요약 칸의 "요약 생성"을 누른다.

요약은 레포를 열 때 만들지 않고 "요약 생성"을 누를 때 그 노드 하나만 만든다. 상단 줄의 "자동 요약" 토글(기본 꺼짐)을 켜면 노드를 고른 채 잠시 머물 때 만든다. 요약 하나가 `claude -p` 호출 한 번이고 구독 사용량을 쓴다. 호출할 때 고른 노드의 코드와, 분석 결과에서 모은 앞뒤 흐름(그 노드를 호출하는 코드 줄, 그 노드가 호출하는 함수의 시그니처와 문서 문자열, 데이터 클래스 필드, 파일의 문서 문자열)을 Claude에 보낸다.

- **모델**: `sonnet`. 응답이 120초 안에 없으면 요약 칸에 그 사실을 적는다.
- **캐시**: `~/.cache/code-atlas/summaries.db`. 코드, 앞뒤 흐름, 서술 규약 문서, 모델 가운데 하나가 바뀌기 전까지 다시 만들지 않는다. "다시 생성"을 누르면 캐시에 있어도 새로 만든다.
- **서술 규약 문서**: `--style-guide <경로>` 옵션이나 환경 변수 `CODE_ATLAS_STYLE_GUIDE`로 문체를 정한 문서를 주면 그 문서 전문을 시스템 프롬프트에 넣는다. 문서는 UTF-8이고 100KB 이하여야 한다. 주지 않으면 내장한 짧은 한국어 서술 지침을 쓴다.
- **정의 표기**: 설명은 레포 안의 함수·메서드·클래스를 `{파일 경로}::{정의 이름}`으로 적고(`arbiter.py::arbiter_sync`), 그 표기를 누르면 그래프가 그 노드를 고른다.

`claude`가 없거나 로그인돼 있지 않으면, 또는 서술 규약 문서를 읽지 못하면 요약 칸에 그 까닭을 적고 나머지 기능은 그대로 동작한다.

## 변경 표시

대상 레포가 git 저장소면 마지막 커밋(`HEAD`) 뒤에 수정하거나 추가한 파일과 함수를 그래프와 파일트리에 표시한다. 수정은 주황 `M`, 추가(스테이징한 새 파일과 추적하지 않는 파일)는 파랑 `A`이고, 지워진 파일은 파일트리 아래 목록에 적는다. 화면은 15초마다, 그리고 창이 포커스를 받을 때 변경 내용을 다시 읽는다. 상단 줄에는 현재 브랜치 이름을 적는다.

대상 레포에는 읽기 전용 git 명령(`status`, `diff`, `rev-parse`, `symbolic-ref`)만 부르고, 인덱스를 다시 쓰지 않으며, 원격에 접속하지 않는다. git 저장소가 아니면 변경 표시 없이 나머지 기능이 동작한다.

## 알려진 한계

- **Python 전용**: `.py` 파일만 분석한다. Windows에서는 확인하지 않았다.
- **파일이 많은 레포의 처음 화면**: 모든 파일을 접힌 파일 상자로 한 화면에 그린다. 폴더를 자동으로 접지 않으므로 파일트리에서 폴더 행을 눌러 접는다.
- **열어 둔 채 고친 코드**: 그래프의 노드와 줄 범위, 코드 뷰어와 요약의 본문은 레포를 열 때 분석한 값이다. 그 뒤 내용이 바뀐 파일은 상단 줄에 "분석 뒤 바뀐 파일 N개"로만 알리고 다시 분석하지 않는다. 바뀐 코드를 보려면 `Ctrl+C`로 끝내고 다시 실행한다.
- **동적 호출**: `getattr(obj, name)()`이나 타입 힌트 없는 인자의 메서드 호출처럼 정적 분석으로 대상을 확인하지 못한 호출은 선으로 그리지 않고 노드의 `?` 배지에 수로 적는다.
- **macOS의 이력 단축키**: `Option+←`·`Option+→`와 `Cmd+[`·`Cmd+]`는 브라우저의 이전·다음 페이지 단축키와 같은 키다. code-atlas가 이 키를 먼저 받아 탐색 이력을 옮기는 동작은 headless Chrome에서만 확인했다. 포커스가 코드 뷰어나 검색 칸에 있으면 `Option+←`·`Option+→`는 낱말 사이를 옮긴다.

## 구성

| 경로 | 역할 |
|---|---|
| `code_atlas/model.py` | 노드·선·지점·분석 결과 자료형. 필드는 HTTP API 계약과 같다 |
| `code_atlas/collect.py` | 분석할 `.py` 파일 수집(`.gitignore`·가상환경 폴더 제외), 소스 루트·테스트 코드 판정, `pyproject.toml`의 진입점 설정, 경로를 디스크에 적힌 이름으로 맞추기 |
| `code_atlas/extract.py` | 파일마다 `ast`로 정의 노드와 관계 후보 지점(호출·import·이름 사용·데코레이터·타입·상속)을 뽑는다 |
| `code_atlas/lsp.py` | basedpyright 언어 서버 세션 수명과 UTF-8 바이트·UTF-16 열 변환 |
| `code_atlas/resolve.py` | 언어 서버가 돌려준 정의 위치를 노드 id와 선 종류로 바꾼다 |
| `code_atlas/graph.py` | 노드·선 조립, 패키지 노드, 데이터 클래스·오버라이드·진입점 판정, 해석률 집계 |
| `code_atlas/analyze.py` | 수집부터 그래프 조립까지 차례로 부르는 분석 진입점. 인터프리터 확인과 분석 뒤 바뀐 파일 판정도 맡는다 |
| `code_atlas/venv.py` | 대상 레포의 가상환경 인터프리터 탐색 |
| `code_atlas/changes.py` | 대상 레포에서 `git status`·`git diff HEAD`를 읽어 마지막 커밋 뒤에 바뀐 파일과 줄 범위를 낸다. 인덱스를 다시 쓰지 않는 읽기 전용 명령만 부른다 |
| `code_atlas/summary.py` | 분석 결과에서 앞뒤 흐름 자료를 모아 프롬프트를 만들고, Claude Code CLI(`claude -p`)를 불러 노드의 설명을 받아 `~/.cache/code-atlas/summaries.db`에 저장한다 |
| `code_atlas/api.py` | 서버가 떠 있는 동안 언어 서버 세션 하나를 유지한다. `/api/repo`·`/api/tree`·`/api/graph`·`/api/file`(분석 결과. `/api/file`은 분석할 때 읽은 본문을 돌려준다), `/api/hover`·`/api/definition`(언어 서버에 묻는 타입 정보와 정의 위치), `/api/changes`(변경 표시), `/api/summary`(LLM 요약) 경로와 `frontend/dist/` 서빙. `127.0.0.1`에만 연다 |
| `code_atlas/cli.py` | `code-atlas <레포>`(분석 뒤 서버 실행)와 `code-atlas analyze <레포>`(결과 출력) 명령 |
| `frontend/src/api/` | API 계약 자료형과 백엔드 호출. 화면 컴포넌트는 `client.ts`만 거친다 |
| `frontend/src/state/` | `store.ts`의 zustand 저장소 `useAtlas(selector)`가 분석 결과, 선택, 뷰 종류, 접은 폴더, 흐름 단계, 토글, 정보 패널 사각형을 담고 `history.ts`가 탐색 이력을 맡는다. `changes.ts`는 `/api/changes`를 15초마다와 창이 포커스를 받을 때 다시 받는다 |
| `frontend/src/theme.ts` | 밝은 화면·어두운 화면 색 값과 CSS 변수 내보내기 |
| `frontend/src/tree/` | 파일트리. `rows.ts`가 폴더·파일·고른 파일의 클래스·함수 목록을 행 배열로 펴고, `TreeSearch.tsx`가 맨 위 검색 칸과 결과 목록을, `Icon.tsx`가 종류 기호를 그린다. 행 오른쪽 끝에 변경 표시를 붙인다 |
| `frontend/src/search/` | `Mod+P` 검색 팔레트. `index.ts`가 파일·클래스·함수 이름 색인과 `fzf` 매처를 맡는다 |
| `frontend/src/nav/` | 상단 줄. `Trail.tsx`는 탐색 경로 표시, `Entries.tsx`는 진입점 목록, `Toggles.tsx`는 토글 세 개와 "설정" 목록, `fit.ts`는 줄 폭에 맞춰 상단 줄을 줄이는 단계, `keys.ts`는 이력 이동·`Esc`·팔레트 열기 단축키다 |
| `frontend/src/panel/` | 그래프 위에 떠 있는 정보 패널. 머리 줄(`Header.tsx`), LLM 요약 칸(`Summary.tsx`, 설명을 세 부분과 정의 표기로 나누는 `parts.ts`), 선의 지점 목록(`Sites.tsx`), 끌기와 크기 조절(`usePanelRect.ts`·`rect.ts`), 그래프 노드가 없는 `__init__.py`를 여는 `opened.ts` |
| `frontend/src/code/` | 고른 노드의 줄 범위만 여는 읽기 전용 Monaco 코드 뷰어. `hover.ts`가 이름 위 hover를, `CodeView.tsx`가 `Mod`+클릭 정의 이동을 백엔드에 연결한다. Monaco는 CDN 없이 번들에 넣는다 |
| `frontend/src/graph/` | 구조 뷰와 함수 시점 뷰. `visible.ts`가 보이는 노드를, `flow.ts`가 고른 노드에서 나가는 흐름과 불투명도를, `scope.ts`가 그릴 선을, `columns.ts`가 열 번호와 연결 묶음·선반을 정한다. `layout.ts`가 ELK를 Web Worker로 돌려 좌표를 정하고, `view.ts`가 선마다 경로를, `motion.ts`가 배치 움직임을, `viewport.ts`가 화면 이동 좌표를, `layers.ts`가 노드·선·글자의 겹침 순서를 낸다. `calls.ts`·`CallView.tsx`는 함수 시점 뷰, `nodes/`·`edges/`는 React Flow 노드·선 컴포넌트, `Dock.tsx`는 왼쪽 아래 칸, `Minimap.tsx`·`Legend.tsx`·`Tooltip.tsx`는 미니맵·범례·말풍선이다 |
| `frontend/scripts/shots.mjs` | 화면 시나리오 스크립트. 떠 있는 서버에서 정해진 조작을 하고 확인 항목의 통과 여부와 스크린샷을 남긴다 |
| `scripts/measure_resolution.py` | 호출 지점 해석 상태별 비율 출력, 고정 시드 표본 JSONL 작성(`~/data/code-atlas/resolution-sample.jsonl`), `--report`로 직접 채운 판정 집계 |
| `tests/fixtures/sample_repo/` | 시험용 고정 레포. `src/` 소스 루트, 하위 패키지, 함수 안 import, 상속, dataclass, `__main__` 블록, 한글 문자열 뒤 호출, 동적 호출을 담는다 |

## 개발

```bash
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

`tests/test_lsp.py`·`tests/test_graph.py`·`tests/test_analyze.py`·`tests/test_api.py`·`tests/test_cli.py`는 code-atlas 가상환경의 basedpyright를 실제로 띄운다. LLM 요약 테스트는 가짜 `claude`를 쓰고 실제 CLI를 부르지 않는다. 테스트는 고정 레포를 임시 디렉토리에 복사해 돌린다. git에 담을 수 없는 무시 대상 파일과 가상환경 폴더는 `tests/conftest.py`가 복사본에 만든다.

화면을 고칠 때는 백엔드를 띄운 채 `frontend/`에서 `npm run dev`를 실행한다. Vite 개발 서버가 `/api`를 `localhost:8766`으로 넘긴다. `npm run typecheck`로 타입을 검사하고, `npm test`로 화면 없이 계산하는 모듈을 고정 그래프에서 확인한다. 대상은 저장소와 변경 내용(`state/`), 보이는 노드·흐름·그릴 선·열 배정·배치·선 경로·배치 움직임·화면 이동·함수 시점 뷰(`graph/`), 상단 줄 단계(`nav/fit`), 정보 패널 사각형·연 파일·설명 나누기(`panel/`), 검색 색인(`search/`), 파일트리 행(`tree/`)이다.

화면은 `frontend/`에서 화면 시나리오 스크립트로 확인한다.

```bash
node scripts/shots.mjs [주소] [--only 이름,이름] [--with-summary]
```

떠 있는 서버의 주소를 받고(기본 `http://127.0.0.1:8766`) 서버를 띄우지 않는다. 시나리오마다 새 브라우저 컨텍스트에서 조작하고 확인 항목을 `통과`·`실패`·`건너뜀`과 함께 한 줄씩 출력한다. 대상 레포에 입력이 없어 볼 수 없는 확인 항목은 `건너뜀`이고 실패로 세지 않는다. 실패한 확인 항목이나 페이지 오류·콘솔 오류가 있으면 종료 코드 1로 끝난다.

- **시나리오**: `open`, `file`, `function`, `body`, `panel`, `hover`, `edge`, `minimap`, `folder`, `folder-select`, `init-file`, `toolbar`, `callview`, `search`, `zoom`, `labels`, `external`, `dark`, `tree`, `tree-search`, `changes`, `zoom-keep`, `summary-ask`, `summary-ref`, `summary` 25개다. `--only`에 이름을 쉼표로 이어 주면 그 시나리오만 돌고, 모르는 이름을 주면 고를 이름을 적고 종료 코드 2로 끝난다.
- **기대값**: 노드 이름은 sync-engine을 연 서버가 기준이고, 노드 수·선 수·줄 범위는 서버 응답에서 읽는다.
- **`summary`**: 실제로 요약 하나를 만들어 Claude Code 구독 사용량을 쓰므로 `--only`로 지정하거나 `--with-summary`를 줬을 때만 돈다. 나머지 24개 시나리오는 요약을 만드는 요청을 서버로 보내지 않는다.
- **`changes`**: 대상 레포에서 `git status`·`git diff`를 직접 읽어 화면과 비교하므로 서버와 같은 컴퓨터에서 돌린다. 수정한 `.py` 파일이 없는 레포에서는 확인 항목을 건너뛴다.
- **스크린샷**: `~/data/code-atlas/screenshots/s2-{이름}.png`(1700×1000, 배율 2)에 남긴다. `toolbar`는 창 폭 1700·1440·1280·1160·980·900·720px마다 `s2-toolbar-{폭}.png`를 더 남긴다.
- **브라우저**: Playwright가 받은 chromium과 다른 실행 파일을 쓰려면 환경 변수 `CHROMIUM_PATH`에 경로를 넣는다.
