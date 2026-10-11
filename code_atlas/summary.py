"""Claude Code CLI로 노드의 설명(요지, 하는 일, 앞뒤 흐름)을 만들고 캐시한다.

설명은 그 컴퓨터에 로그인한 Claude Code 구독 계정으로 `claude -p`를 불러 만든다.
실행 파일 찾기, 앞뒤 흐름 자료, 프롬프트, 호출, 캐시는 이 모듈만 한다.
"""

from __future__ import annotations

import ast
import asyncio
import copy
import hashlib
import json
import logging
import os
import shutil
import signal
import sqlite3
import tempfile
import textwrap
import time
from collections.abc import Iterable, Mapping
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path

from .model import Edge, Node

logger = logging.getLogger(__name__)

PROMPT_VERSION = 2
MODEL = "sonnet"
GENERATE_TIMEOUT = 120.0
STATUS_TIMEOUT = 10.0
MAX_CODE = 24_000
MAX_PROMPT = 60_000
MAX_STYLE_GUIDE = 100_000
MAX_DOC = 400
MAX_FILE_DOC = 1_200
MAX_PROCESSES = 2
CACHE_PATH = Path.home() / ".cache" / "code-atlas" / "summaries.db"
STYLE_GUIDE_ENV = "CODE_ATLAS_STYLE_GUIDE"

KIND_NAMES = {
    "module": "파일",
    "class": "클래스",
    "dataclass": "데이터 클래스",
    "function": "함수",
    "method": "메서드",
}
MARKS = ("하는 일", "앞뒤 흐름")

PROMPT_INTRO = """\
파이썬 코드베이스를 처음 보는 개발자에게 코드 한 덩어리를 설명하는 글을 쓴다. 독자는 파이썬 문법은 알지만 이 코드베이스의 함수 이름, 자료 구조, 업무 용어는 모른다.

사용자 메시지에는 설명할 대상의 종류·이름·위치, 대상의 코드, 정적 분석기가 모은 앞뒤 흐름 자료가 구획별로 들어 있다. 대상이 함수·메서드·클래스면 앞뒤 흐름 자료는 대상을 호출하는 코드 줄, 대상이 호출하는 함수의 시그니처와 문서 문자열, 대상이 쓰는 데이터 클래스의 필드, 대상이 읽고 바꾸는 모듈 변수의 정의, 대상이 든 파일의 문서 문자열이다. 대상이 파일이면 코드 대신 최상위 정의의 시그니처 목록이 있고, 앞뒤 흐름 자료는 이 파일을 쓰는 파일과 이 파일이 쓰는 파일이다.
"""

STYLE_GUIDE_HEAD = """# 서술 규약

아래는 설명의 모든 문장에 적용하는 서술 규약이다. 문장의 문법과 단어 선택을 정한 규칙을 모두 지킨다. 다른 종류의 글(대화 응답, 커밋 메시지, 문서 교정 절차)을 다루는 대목은 이 설명에 적용하지 않는다. 표와 제목 서식은 서술 규약 문서의 것이고, 설명의 구성은 뒤의 "출력 형식"을 따른다.
"""

BUILTIN_STYLE_GUIDE = """- 한 문장에 한 가지 내용만 담고, 주어와 서술어가 한 번씩 대응하게 쓴다.
- 행위자를 알면 행위자를 주어로 세워 능동문으로 쓴다.
- "~에 대해", "~를 통해", "~에 의해", "~를 위해"는 조사 하나로 바꾸고, "~할 수 있다"는 가능성을 말할 때만 쓴다.
- 명사를 "의"로 잇달아 잇지 않고 동사로 풀어 쓴다. "것", "점", "수"로 문장을 끝내지 않는다.
- "이것", "해당", "이러한" 대신 가리키는 대상의 이름을 쓰고, 같은 대상은 글이 끝날 때까지 같은 이름으로 부른다.
- "효율적으로", "다양한", "핵심적인" 같은 평가어를 빼고 실제 값과 동작을 쓴다.
- 도입 문구와 맺음 문구를 쓰지 않는다. 줄표(—)로 문장을 잇지 않고, 접속사 뒤에 쉼표를 붙이지 않는다.
- 원인은 "~때문에", "~므로"로, 조건은 "~면"으로 밝힌다.
"""

PROMPT_RULES = """# 출력 형식

아래 구성을 그대로 지킨다. 요지 앞과 마지막 문단 뒤에 다른 글을 붙이지 않는다.

{요지 한 문장}

하는 일
{문단 하나에서 셋}

앞뒤 흐름
{대상을 부르는 쪽 문단}
{대상이 부르는 쪽 문단}

- 요지: 대상이 무엇을 받아 무엇을 만들거나 바꾸는지를 한 문장으로 쓴다. 대상의 이름으로 시작하지 않고, 동사로 끝낸다. 대상의 종류를 가리키는 명사("함수다", "메서드다", "클래스다", "모듈이다")로 끝내지 않는다. "주문 목록을 받아 품목별 수량을 더한 표를 돌려주는 함수다"가 아니라 "주문 목록을 받아 품목별 수량을 더한 표를 돌려준다"로 쓴다.
- 하는 일: 입력을 받아 결과를 내기까지의 과정을 코드가 실행되는 순서대로 풀어 쓴다. 문단은 셋까지, 문단 하나는 네 문장까지 쓴다. 열 줄이 안 되는 코드는 문단 하나로 쓴다. 긴 코드는 실행 단계를 둘이나 셋으로 묶어 묶음마다 문단 하나를 쓰고, 분기를 하나씩 옮겨 적지 않고 그 단계가 무엇을 판정해 무엇을 만들거나 바꾸는지를 쓴다. 결과를 바꾸는 조건과 예외 처리는 어떤 경우에 무엇이 달라지는지를 적는다. 대상이 파일이면 정의를 맡은 일에 따라 둘이나 셋으로 묶어 묶음마다 문단 하나를 쓰고, 문단을 "첫째", "둘째"로 시작하지 않고 그 묶음이 맡은 일로 시작한다.
- 앞뒤 흐름: 문단 둘로 쓰고, 문단 하나는 세 문장까지 쓴다. 앞 문단에는 누가 어떤 상황에서 대상을 부르는지, 어떤 값을 넘기고 돌려받은 값을 어디에 쓰는지를 호출하는 코드 줄을 읽어 적는다. 뒤 문단에는 대상이 무엇을 불러 어떤 값을 넘겨받는지를 적는다. 대상이 파일이면 앞 문단에 어느 파일이 이 파일의 무엇을 가져다 쓰는지를, 뒤 문단에 이 파일이 어느 파일의 무엇을 가져다 쓰는지를 적는다.
- 문단은 줄을 바꿔 나누고 문단 안에서는 줄을 바꾸지 않는다. 표지 줄에는 `하는 일`, `앞뒤 흐름` 글자만 쓴다. 제목 기호, 굵은 글씨, 목록 기호, 번호, 코드 울타리, 표를 쓰지 않는다.
- 코드에 있는 식별자(함수·클래스·변수·필드 이름, 파일 이름)와 코드에 적힌 짧은 문자열 값은 백틱으로 감싼다. 인자를 붙인 호출식, 괄호를 붙인 함수 이름, 여러 식별자를 이은 코드 조각은 백틱에 넣지 않는다.

# 설명하는 법

- 식별자를 나열하지 않는다. 식별자를 처음 적을 때 그 값이 무엇이고 왜 필요한지를 함께 풀어 쓴다. 호출하는 함수가 많으면 하는 일이 같은 함수를 묶어 그 일을 적고, 대표가 되는 이름만 든다.
- 대상을 문장의 주어로 쓰지 않는다. 대상의 이름, "이 함수는", "이 메서드는", "이 클래스는", "이 파일은"으로 문장을 시작하지 않고 주어를 생략한다. "이 함수는 `today`로 날짜를 구한다"가 아니라 "`today`로 오늘 날짜를 구한다"로, "`f`는 다른 함수를 호출하지 않는다"가 아니라 "다른 함수를 호출하지 않는다"로 쓴다. 주어가 필요한 문장에는 그 문장에서 실제로 동작하거나 바뀌는 값의 이름을 쓴다.
- 코드와 자료에 있는 사실만 쓴다. 코드에 없는 동작과 목적, 자료에 없는 호출 관계를 추측해 적지 않는다. 시그니처와 문서 문자열만 주어진 함수는 그 둘이 말하는 범위까지만 적는다.
- 설명에는 코드가 하는 일만 적는다. "자료에 없다", "제공된 자료", "코드만으로는 확인하지 못한다"처럼 받은 자료를 말하는 문장을 쓰지 않고, 확인하지 못한 내용은 적지 않는다.
- 호출하는 쪽 자료가 "없음"이면 정적 분석에서 호출하는 곳을 찾지 못했다고 적는다. 자료에 진입점이라고 적혀 있으면 명령이나 요청으로 바깥에서 실행하는 코드라고 적는다. 테스트 코드만 대상을 호출하면 그렇게 적는다. 대상이 호출하는 쪽 자료가 "없음"이면 뒤 문단에 다른 함수를 호출하지 않는다고 적는다.
- 코드의 주석과 문서 문자열이 영어여도 설명은 한국어로 쓴다. 모든 문장은 "~한다"체로 끝낸다.
"""

# 프롬프트 끝에 붙이는 확인 목록. 규칙은 `PROMPT_RULES`에 있고 여기에는 글을 내기 직전에 다시 볼 항목만 적는다.
PROMPT_TAIL = """[내기 전에 확인]
- 요지가 동사로 끝나는가. "함수다", "클래스다", "모듈이다"로 끝나면 고친다.
- 대상의 이름, "이 함수는", "이 클래스는", "이 파일은"이 주어인 문장이 있으면 주어를 뺀다.
- 하는 일이 문단 셋, 문단마다 네 문장을 넘으면 단계로 묶어 줄인다.
- 앞뒤 흐름이 대상을 부르는 쪽 문단과 대상이 부르는 쪽 문단 둘인가.
- 백틱 안에 호출식이나 코드 조각이 있으면 식별자만 남긴다.
- "~에 대해", "~를 통해", "~에 의해", 행위자가 있는 피동, "첫째·둘째", 줄표가 있으면 고친다.
"""

GENERATE_HEAD = ("-p", "--model", MODEL, "--tools", "", "--system-prompt")
# 도구와 사용자 설정(CLAUDE.md, 스킬, 플러그인, hook, MCP 서버)을 끄고 응답 한 번으로 끝낸다.
GENERATE_TAIL = (
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "json",
)
STATUS_ARGS = ("auth", "status", "--json")


class SummaryError(Exception):
    """설명을 만들지 못한 까닭. 메시지를 그대로 사용자에게 보인다."""


def find_cli() -> str | None:
    """`PATH`와 `~/.local/bin/claude`에서 Claude Code 실행 파일을 찾는다."""
    found = shutil.which("claude")
    if found is not None:
        return found
    local = Path.home() / ".local" / "bin" / "claude"
    return str(local) if os.access(local, os.X_OK) else None


def find_style_guide(option: str | None) -> Path | None:
    """서술 규약 문서의 경로. `--style-guide` 옵션, 환경 변수 `CODE_ATLAS_STYLE_GUIDE` 순서로 찾고 둘 다 없으면 None이다."""
    chosen = option or os.environ.get(STYLE_GUIDE_ENV)
    return Path(chosen).expanduser() if chosen else None


def system_prompt_of(style_guide: Path | None) -> str:
    """시스템 프롬프트. 역할, 서술 규약, 출력 형식과 설명하는 법의 순서다. 서술 규약 문서를 읽어 전문을 넣고, 경로가 None이면 내장 지침을 넣는다."""
    if style_guide is None:
        return f"{PROMPT_INTRO}\n{STYLE_GUIDE_HEAD}\n{BUILTIN_STYLE_GUIDE}\n{PROMPT_RULES}"
    try:
        text = style_guide.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise SummaryError(f"서술 규약 문서를 읽지 못했다: {style_guide} ({type(exc).__name__})") from exc
    if not text.strip():
        raise SummaryError(f"서술 규약 문서가 비어 있다: {style_guide}")
    if len(text.encode()) > MAX_STYLE_GUIDE:
        raise SummaryError(f"서술 규약 문서가 {MAX_STYLE_GUIDE // 1000}KB를 넘는다: {style_guide}")
    return f"{PROMPT_INTRO}\n{STYLE_GUIDE_HEAD}\n<서술 규약 문서>\n{text.strip()}\n</서술 규약 문서>\n\n{PROMPT_RULES}"


def key_of(system: str, prompt: str) -> str:
    """캐시 키. 프롬프트 판 번호, 모델, 시스템 프롬프트(서술 규약 문서 포함), 프롬프트(코드와 앞뒤 흐름 자료)가 같으면 같은 설명을 쓴다."""
    return hashlib.sha256(f"{PROMPT_VERSION}\n{MODEL}\n{system}\n\0\n{prompt}".encode()).hexdigest()


# 앞뒤 흐름 자료


def _signature(d: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) -> str:
    """정의의 머리 줄. 여러 줄 시그니처는 한 줄로 잇고 데코레이터는 뺀다."""
    head = copy.copy(d)
    head.body = [ast.Expr(ast.Constant(...))]
    head.decorator_list = []
    return ast.unparse(head).splitlines()[0]


def _lead(doc: str | None) -> str | None:
    """문서 문자열의 첫 문단."""
    if not doc:
        return None
    first = " ".join(doc.strip().split("\n\n", 1)[0].split())
    return first[:MAX_DOC] + ("…" if len(first) > MAX_DOC else "")


def outline(source: str) -> str:
    """파일의 최상위 정의의 시그니처 목록. 정의마다 문서 문자열 첫 문단을, 클래스는 메서드 시그니처를 아래에 적는다.

    구문 오류가 있거나 정의가 없는 파일은 본문을 그대로 낸다.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return source
    defs = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
    lines: list[str] = []
    for node in tree.body:
        if not isinstance(node, defs):
            continue
        lines.append(_signature(node))
        doc = _lead(ast.get_docstring(node))
        if doc:
            lines.append(f'    """{doc}"""')
        if isinstance(node, ast.ClassDef):
            lines += [f"    {_signature(m)}" for m in node.body if isinstance(m, defs[:2])]
    return "\n".join(lines) if lines else source


def _head_of(lines: list[str], span: tuple[int, int]) -> tuple[str, str | None]:
    """줄 범위에 있는 정의의 시그니처와 문서 문자열 첫 문단. 그 범위를 따로 파싱하지 못하면 `def`·`class` 줄만 낸다."""
    body = lines[span[0] - 1 : span[1]]
    try:
        d = ast.parse(textwrap.dedent("\n".join(body))).body[0]
    except (SyntaxError, IndexError):
        d = None
    if isinstance(d, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return _signature(d), _lead(ast.get_docstring(d))
    first = next((s.strip() for s in body if s.lstrip().startswith(("def ", "async def ", "class "))), "")
    return first or (body[0].strip() if body else ""), None


def _title(node: Node) -> str:
    """자료에 적는 노드 이름. 파일은 경로, 그 밖의 정의는 `이름 (경로)`다."""
    if node.kind == "module" or ":" not in node.id:
        return node.path or node.id
    return f"{node.id.partition(':')[2]} ({node.path})"


def _fields(node: Node) -> str:
    return ", ".join(f["name"] if f["type"] is None else f"{f['name']}: {f['type']}" for f in node.fields or [])


@dataclass
class Caller:
    """대상을 호출하는 정의 하나와 호출한 줄 번호. 대상이 클래스면 그 메서드를 호출하는 정의도 든다."""

    title: str
    kind: str  # call·construct·pass·inherit
    path: str
    lines: list[int]
    test: bool


@dataclass
class Callee:
    """대상이 호출하는 정의 하나."""

    title: str
    signature: str
    doc: str | None


@dataclass
class Flow:
    """노드 하나의 앞뒤 흐름 자료. 함수·메서드·클래스는 callers·callees·externals·data·variables를, 파일은 users·used·externals를 쓴다."""

    file_doc: str | None = None
    owner: str | None = None  # 메서드가 든 클래스의 시그니처와 문서 문자열, 필드
    entry: bool = False
    unresolved: int = 0
    callers: list[Caller] = field(default_factory=list)
    callees: list[Callee] = field(default_factory=list)
    externals: list[str] = field(default_factory=list)
    data: list[str] = field(default_factory=list)
    variables: list[str] = field(default_factory=list)  # 대상이 읽고 바꾸는 모듈 변수의 정의
    users: list[tuple[str, list[str]]] = field(default_factory=list)  # (이 파일을 쓰는 파일, 가져다 쓰는 이름)
    used: list[tuple[str, list[str]]] = field(default_factory=list)  # (이 파일이 쓰는 파일, 가져다 쓰는 이름)


CALLER_KINDS = {"call": "호출", "construct": "생성", "pass": "호출하지 않고 이름을 넘김", "inherit": "상속"}


def _module_doc(text: str) -> str | None:
    try:
        return ast.get_docstring(ast.parse(text))
    except SyntaxError:
        return None


def _variables(text: str, names: set[str]) -> list[str]:
    """파일의 최상위 대입문 가운데 `names`의 변수를 정하는 문장. 문장마다 `MAX_DOC`자까지 적는다."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    found: list[str] = []
    for stmt in tree.body:
        targets = stmt.targets if isinstance(stmt, ast.Assign) else [getattr(stmt, "target", None)]
        if not isinstance(stmt, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            continue
        if any(isinstance(n, ast.Name) and n.id in names for t in targets if t is not None for n in ast.walk(t)):
            source = ast.get_source_segment(text, stmt) or ""
            found.append(source[:MAX_DOC] + ("…" if len(source) > MAX_DOC else ""))
    return found


def _file_flow(nodes: Mapping[str, Node], edges: Iterable[Edge], node: Node) -> Flow:
    flow = Flow(entry=node.entry)
    users: dict[str, list[str]] = {}
    used: dict[str, list[str]] = {}
    tests: set[str] = set()
    for edge in edges:
        source, target = nodes.get(edge.source), nodes.get(edge.target)
        if source is None or target is None or source.path == target.path:
            continue
        name = None if target.kind in ("module", "package") else target.id.partition(":")[2]
        if source.path == node.path:
            if target.kind == "external":
                if target.name not in flow.externals:
                    flow.externals.append(target.name)
                continue
            names = used.setdefault(target.path, [])
        elif target.path == node.path:
            names = users.setdefault(source.path, [])
            if source.test:
                tests.add(source.path)
        else:
            continue
        if name is not None and name not in names:
            names.append(name)
    flow.users = sorted(users.items(), key=lambda item: item[0] in tests)
    flow.used = list(used.items())
    return flow


def _def_flow(nodes: Mapping[str, Node], edges: Iterable[Edge], texts: Mapping[str, str], node: Node) -> Flow:
    lines = {path: text.splitlines() for path, text in texts.items()}
    flow = Flow(entry=node.entry, unresolved=node.unresolved)
    owner = nodes.get(node.parent) if node.kind == "method" and node.parent else None
    if owner is not None and owner.range is not None and owner.path in lines:
        signature, doc = _head_of(lines[owner.path], owner.range)
        flow.owner = "\n".join(
            [signature, *([f'    """{doc}"""'] if doc else []), *([f"    필드: {_fields(owner)}"] if owner.fields else [])]
        )
    inside = node.id + "." if node.kind in ("class", "dataclass") else None

    def within(nid: str) -> bool:
        """대상이거나, 대상이 클래스일 때 그 안의 메서드다."""
        return nid == node.id or (inside is not None and nid.startswith(inside))

    names = {
        name
        for n in nodes.values()
        if within(n.id)
        for name in (*n.reads, *n.writes)
        if "." not in name
    }
    flow.variables = _variables(texts[node.path], names) if names else []
    callers: dict[tuple[str, str, str], Caller] = {}
    seen: set[str] = set()
    for edge in edges:
        source, target = nodes.get(edge.source), nodes.get(edge.target)
        if source is None or target is None:
            continue
        if within(edge.target) and not within(edge.source) and edge.kind in CALLER_KINDS:
            title = f"{source.path}의 최상위 코드" if source.kind == "module" else _title(source)
            if edge.target != node.id:
                title += f" → {target.name}"
            for site in edge.sites:
                caller = callers.setdefault(
                    (edge.source, edge.target, edge.kind), Caller(title, edge.kind, site.path, [], source.test)
                )
                if site.path == caller.path and site.line not in caller.lines:
                    caller.lines.append(site.line)
        if not within(edge.source) or within(edge.target) or edge.target in seen:
            continue
        if target.kind == "dataclass" and target.fields:
            seen.add(edge.target)
            flow.data.append(f"{_title(target)}: {_fields(target)}")
        elif edge.kind in ("call", "construct"):
            seen.add(edge.target)
            if target.kind == "external":
                flow.externals.append(target.name)
            elif target.range is not None and target.path in lines:
                flow.callees.append(Callee(_title(target), *_head_of(lines[target.path], target.range)))
    flow.callers = sorted(callers.values(), key=lambda caller: caller.test)
    return flow


def flow_of(nodes: Mapping[str, Node], edges: Iterable[Edge], texts: Mapping[str, str], node: Node) -> Flow:
    """분석 결과에서 노드의 앞뒤 흐름 자료를 모은다. 테스트 코드에서 호출하는 쪽은 뒤에 둔다."""
    flow = _file_flow(nodes, edges, node) if node.kind == "module" else _def_flow(nodes, edges, texts, node)
    flow.file_doc = _module_doc(texts[node.path])
    return flow


@dataclass(frozen=True)
class Detail:
    """앞뒤 흐름 자료를 프롬프트에 적는 정도."""

    docs: bool  # 호출되는 쪽의 문서 문자열을 적는다
    around: int  # 호출한 줄의 앞뒤로 함께 적는 줄 수
    callers: int  # 호출하는 쪽과 이 파일을 쓰는 파일의 상한
    callees: int  # 호출되는 쪽과 이 파일이 쓰는 파일의 상한


# 프롬프트가 `MAX_PROMPT`를 넘으면 뒤의 단계로 줄인다. 마지막 단계에서도 넘으면 코드를 자른다.
DETAILS = (Detail(True, 1, 12, 20), Detail(False, 1, 12, 20), Detail(False, 0, 12, 20), Detail(False, 0, 4, 6))
MAX_SITES = 2
MAX_NAMES = 8


def _capped(items: list[str], limit: int, unit: str) -> list[str]:
    return items[:limit] + ([f"외 {len(items) - limit}{unit}"] if len(items) > limit else [])


def _snippet(lines: list[str], line: int, around: int) -> list[str]:
    first, last = max(1, line - around), min(len(lines), line + around)
    return [f"    {n}{'>' if n == line else ':'} {lines[n - 1].rstrip()}" for n in range(first, last + 1)]


def _flow_text(flow: Flow, node: Node, texts: Mapping[str, str], detail: Detail) -> str:
    parts: list[str] = []

    def section(title: str, body: list[str]) -> None:
        parts.append("\n".join([f"[{title}]", *(body or ["없음"])]))

    doc = (flow.file_doc or "")[:MAX_FILE_DOC]
    section("파일의 문서 문자열" if node.kind == "module" else "대상이 든 파일의 문서 문자열", [doc] if doc else [])
    if flow.owner:
        section("대상이 든 클래스", [flow.owner])
    if flow.entry:
        section("진입점", ["분석기가 대상을 진입점으로 판정했다(스크립트 등록 대상이거나 명령·라우트 데코레이터가 붙어 있다)"])
    if node.kind == "module":
        for title, found, limit in (
            ("이 파일을 쓰는 파일과 가져다 쓰는 이름", flow.users, detail.callers),
            ("이 파일이 쓰는 파일과 가져다 쓰는 이름", flow.used, detail.callees),
        ):
            files = [
                f"- {path}" + (f": {', '.join(_capped(names, MAX_NAMES, '개'))}" if names else "")
                for path, names in found
            ]
            section(title, _capped(files, limit, "개 파일"))
        if flow.externals:
            section("이 파일이 쓰는 외부 패키지", [", ".join(_capped(flow.externals, detail.callees, "개"))])
        return "\n\n".join(parts)
    callers: list[str] = []
    for caller in flow.callers[: detail.callers]:
        callers.append(f"- {caller.title} · {CALLER_KINDS[caller.kind]}")
        source = texts.get(caller.path, "").splitlines()
        for line in caller.lines[:MAX_SITES]:
            callers += _snippet(source, line, detail.around)
        if len(caller.lines) > MAX_SITES:
            callers.append(f"    외 {len(caller.lines) - MAX_SITES}곳")
    if len(flow.callers) > detail.callers:
        rest = flow.callers[detail.callers :]
        tests = sum(caller.test for caller in rest)
        callers.append(f"외 {len(rest)}곳" + (f"(테스트 코드 {tests}곳)" if tests else ""))
    section("대상을 호출하는 쪽", callers)
    callees: list[str] = []
    for callee in flow.callees[: detail.callees]:
        callees.append(f"- {callee.title}\n    {callee.signature}")
        if detail.docs and callee.doc:
            callees.append(f'    """{callee.doc}"""')
    if len(flow.callees) > detail.callees:
        callees.append(f"외 {len(flow.callees) - detail.callees}개")
    section("대상이 호출하는 쪽", callees)
    if flow.externals:
        section("대상이 호출하는 외부 패키지", [", ".join(_capped(flow.externals, detail.callees, "개"))])
    if flow.data:
        section("대상이 쓰는 데이터 클래스와 필드", [f"- {item}" for item in flow.data[: detail.callees]])
    if flow.variables:
        section("대상이 읽고 바꾸는 모듈 변수의 정의", flow.variables[: detail.callees])
    if flow.unresolved:
        section("분석기가 대상을 확인하지 못한 호출", [f"{flow.unresolved}곳. 위 목록에 없는 호출이 코드에 있다"])
    return "\n\n".join(parts)


def prompt_of(nodes: Mapping[str, Node], edges: Iterable[Edge], texts: Mapping[str, str], node_id: str) -> str | None:
    """노드의 종류·이름·위치, 코드, 앞뒤 흐름 자료, 확인 목록을 구획으로 나눈 프롬프트. 설명할 노드가 아니면 None이다.

    파일은 코드 대신 최상위 정의의 시그니처 목록을 넘긴다.
    """
    node = nodes.get(node_id)
    text = texts.get(node.path) if node is not None and node.kind in KIND_NAMES else None
    if node is None or text is None or node.range is None:
        return None
    edges = list(edges)
    if node.kind == "module":
        name, where, label, code = node.path, node.path, "최상위 정의의 시그니처 목록", outline(text)
    else:
        start, end = node.range
        name, where, label = node.id.partition(":")[2], f"{node.path} {start}~{end}줄", "코드"
        code = "\n".join(text.splitlines()[start - 1 : end])
    flow = flow_of(nodes, edges, texts, node)
    head = f"[대상]\n종류: {KIND_NAMES[node.kind]}\n이름: {name}\n위치: {where}\n\n[{label}]\n"
    code = code[:MAX_CODE] + ("\n(이하 생략)" if len(code) > MAX_CODE else "")
    for detail in DETAILS:
        tail = f"\n\n{_flow_text(flow, node, texts, detail)}\n\n{PROMPT_TAIL}"
        if len(head) + len(code) + len(tail) <= MAX_PROMPT:
            break
    else:
        code = code[: max(0, MAX_PROMPT - len(head) - len(tail) - 10)] + "\n(이하 생략)"
    return head + code + tail


def shaped(result: str) -> str:
    """CLI가 낸 글을 `요지`, 빈 줄, `하는 일` 표지와 문단, 빈 줄, `앞뒤 흐름` 표지와 문단으로 맞춘다. 세 부분 가운데 하나라도 없으면 `SummaryError`를 낸다."""
    parts: list[list[str]] = [[]]
    for line in (raw.strip() for raw in result.strip().splitlines()):
        mark = line.strip("#*:[] ")
        if len(parts) <= len(MARKS) and mark == MARKS[len(parts) - 1]:
            parts.append([])
        elif line:
            parts[-1].append(line)
    if len(parts) != len(MARKS) + 1 or not all(parts):
        raise SummaryError("Claude Code CLI가 낸 설명이 요지, 하는 일, 앞뒤 흐름 세 부분으로 나뉘지 않는다")
    lead, *bodies = ("\n".join(part) for part in parts)
    return "\n\n".join([" ".join(lead.split("\n")), *(f"{mark}\n{body}" for mark, body in zip(MARKS, bodies))])


async def _run(cli: str, args: tuple[str, ...], stdin: str, timeout: float) -> tuple[int, str, str]:
    """빈 임시 폴더에서 CLI를 띄워 종료 코드, 표준 출력, 표준 오류를 돌려준다. 시간 안에 끝나지 않으면 프로세스 묶음을 끝낸다."""
    with tempfile.TemporaryDirectory(prefix="code-atlas-summary-") as cwd:
        process = await asyncio.create_subprocess_exec(
            cli,
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            start_new_session=True,
        )
        try:
            out, err = await asyncio.wait_for(process.communicate(stdin.encode()), timeout)
        finally:
            if process.returncode is None:
                os.killpg(process.pid, signal.SIGKILL)
                await process.wait()
    return process.returncode, out.decode(errors="replace"), err.decode(errors="replace")


async def unavailable() -> str | None:
    """Claude Code CLI를 부를 수 없는 까닭. 부를 수 있으면 None이다."""
    cli = find_cli()
    if cli is None:
        return "Claude Code CLI를 찾지 못했다"
    try:
        _, out, _ = await _run(cli, STATUS_ARGS, "", STATUS_TIMEOUT)
    except (OSError, asyncio.TimeoutError):
        return "Claude Code CLI가 응답하지 않는다"
    try:
        logged_in = json.loads(out).get("loggedIn")
    except (ValueError, AttributeError):
        return None
    return "Claude Code에 로그인돼 있지 않다" if logged_in is False else None


async def generate(system: str, prompt: str) -> str:
    """`claude -p`에 시스템 프롬프트를 인자로, 프롬프트를 표준 입력으로 넘겨 설명을 받는다."""
    cli = find_cli()
    if cli is None:
        raise SummaryError("Claude Code CLI를 찾지 못했다")
    try:
        returncode, out, err = await _run(cli, (*GENERATE_HEAD, system, *GENERATE_TAIL), prompt, GENERATE_TIMEOUT)
    except asyncio.TimeoutError:
        raise SummaryError(f"Claude Code CLI가 {GENERATE_TIMEOUT:.0f}초 안에 응답하지 않았다") from None
    except OSError as exc:
        raise SummaryError(f"Claude Code CLI를 띄우지 못했다: {exc}") from exc
    try:
        body = json.loads(out)
        result, failed = str(body["result"]).strip(), bool(body["is_error"])
    except (ValueError, KeyError, TypeError):
        result, failed = "", True
    if returncode != 0 or failed or not result:
        detail = result or (err.strip().splitlines() or [""])[-1][:200]
        if "Not logged in" in detail:
            raise SummaryError("Claude Code에 로그인돼 있지 않다")
        raise SummaryError(f"Claude Code CLI가 설명을 내지 못했다(종료 코드 {returncode}): {detail}")
    return shaped(result)


class Cache:
    """설명을 담는 SQLite 표 하나."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._execute(
            "CREATE TABLE IF NOT EXISTS summaries (key TEXT PRIMARY KEY, summary TEXT NOT NULL, created TEXT NOT NULL)"
        )

    def _execute(self, sql: str, args: tuple = ()) -> tuple | None:
        with closing(sqlite3.connect(self.path, timeout=5)) as db, db:
            return db.execute(sql, args).fetchone()

    def get(self, key: str) -> str | None:
        row = self._execute("SELECT summary FROM summaries WHERE key = ?", (key,))
        return row[0] if row else None

    def put(self, key: str, summary: str) -> None:
        self._execute(
            "INSERT OR REPLACE INTO summaries (key, summary, created) VALUES (?, ?, ?)",
            (key, summary, time.strftime("%Y-%m-%dT%H:%M:%S%z")),
        )


@dataclass
class _Making:
    """만드는 중인 설명 하나."""

    task: asyncio.Task[str]
    waiting: int = 0  # 결과를 기다리는 호출자 수
    started: bool = False  # 동시 실행 자리를 얻어 `claude` 프로세스를 띄웠다


class Summaries:
    """캐시와 만드는 중인 설명. 서버가 떠 있는 동안 하나다."""

    def __init__(self, path: Path | None = None, style_guide: Path | None = None):
        self.cache = Cache(path or CACHE_PATH)
        self.style_guide = style_guide
        self._slots = asyncio.Semaphore(MAX_PROCESSES)
        self._making: dict[str, _Making] = {}
        self._checking = asyncio.Lock()
        self._ready = False

    async def unavailable(self) -> str | None:
        """설명을 만들 수 없는 까닭. 서술 규약 문서를 읽지 못하거나 Claude Code CLI를 부를 수 없으면 그 까닭이고, 만들 수 있으면 None이다.

        서술 규약 문서는 물을 때마다 읽는다. CLI는 함께 들어온 요청이 한 번만 묻고, 부를 수 있다고 확인한 뒤에는 다시 묻지 않는다.
        """
        try:
            system_prompt_of(self.style_guide)
        except SummaryError as exc:
            return str(exc)
        async with self._checking:
            if self._ready:
                return None
            reason = await unavailable()
            self._ready = reason is None
            return reason

    def cached(self, prompt: str) -> str | None:
        """캐시에 있는 설명. 서술 규약 문서를 읽지 못하면 None이다."""
        try:
            return self.cache.get(key_of(system_prompt_of(self.style_guide), prompt))
        except SummaryError:
            return None

    async def make(self, prompt: str, refresh: bool = False) -> str:
        """캐시에 있으면 그 설명을, 없거나 `refresh`면 새로 만든 설명을 돌려준다. 같은 프롬프트의 요청이 겹치면 한 번만 만든다.

        서술 규약 문서는 부를 때마다 읽는다. 기다리는 호출자가 모두 취소되면 동시 실행 자리를 기다리는 설명은 만들지 않고,
        프로세스를 띄운 설명은 끝까지 만들어 캐시에 넣는다.
        """
        system = system_prompt_of(self.style_guide)
        key = key_of(system, prompt)
        making = self._making.get(key)
        if making is None:
            cached = None if refresh else self.cache.get(key)
            if cached is not None:
                return cached
            making = _Making(asyncio.create_task(self._generate(key, system, prompt)))
            self._making[key] = making
            making.task.add_done_callback(lambda task: self._made(key, task))
        making.waiting += 1
        try:
            return await asyncio.shield(making.task)
        finally:
            making.waiting -= 1
            if not making.waiting and not making.started and not making.task.done():
                del self._making[key]
                making.task.cancel()

    def _made(self, key: str, task: asyncio.Task[str]) -> None:
        """끝난 태스크를 만드는 중 목록에서 빼고, 기다리는 호출자 없이 실패한 태스크의 예외를 받아 둔다."""
        making = self._making.get(key)
        if making is not None and making.task is task:
            del self._making[key]
        if not task.cancelled():
            task.exception()

    async def _generate(self, key: str, system: str, prompt: str) -> str:
        async with self._slots:
            self._making[key].started = True
            started = time.monotonic()
            summary = await generate(system, prompt)
            logger.info("summary %s made in %.1fs", key[:12], time.monotonic() - started)
        self.cache.put(key, summary)
        return summary
