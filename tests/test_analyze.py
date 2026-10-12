import asyncio
import subprocess
import sys

import pytest

from code_atlas import analyze
from code_atlas.analyze import PythonNotFound, _request_all, require_python
from code_atlas.lsp import Location
from code_atlas.model import Site


def site(line: int, dynamic: bool = False, builtin: bool = False) -> Site:
    return Site("call", "a.py", line, 0, line, 0, "a:f", "g()", dynamic, builtin=builtin)


class FakeSession:
    """줄 번호가 짝수인 지점에만 정의 위치를 돌려주고, `late`에 적은 줄은 그 횟수만큼 시간 제한에 걸린다."""

    def __init__(self, late: dict[int, int]):
        self.late = dict(late)
        self.asked: list[int] = []
        self.running = 0
        self.peaks: dict[int, int] = {}  # 줄 번호 → 그 요청이 시작할 때 함께 돌던 요청 수

    async def definition(self, path, line, col, timeout):
        self.asked.append(line)
        self.running += 1
        self.peaks[line] = self.running
        try:
            await asyncio.sleep(0.001)
            if self.late.get(line, 0) > 0:
                self.late[line] -= 1
                raise asyncio.TimeoutError
            return [] if line % 2 else [Location("/repo/a.py", line, 0)]
        finally:
            self.running -= 1


@pytest.mark.asyncio
async def test_request_all_asks_each_site_once_and_skips_dynamic_and_builtin_sites():
    session = FakeSession({})
    sites = [site(line, dynamic=line == 5, builtin=line == 7) for line in range(1, 101)]
    found, late = await _request_all(session, sites)
    assert sorted(session.asked) == [line for line in range(1, 101) if line not in (5, 7)]
    assert late == set() and 4 not in found and 6 not in found  # 5번 줄의 지점 번호가 4다
    assert found[1] == [Location("/repo/a.py", 2, 0)] and found[0] == []
    assert max(session.peaks.values()) == analyze.CONCURRENCY


@pytest.mark.asyncio
async def test_request_all_asks_only_timed_out_sites_again_and_names_the_unanswered():
    session = FakeSession({50: 1, 60: 9})
    found, late = await _request_all(session, [site(line) for line in range(1, 101)])
    assert session.asked.count(50) == 2 and session.asked.count(60) == 2
    assert len(session.asked) == 102
    assert found[49] == [Location("/repo/a.py", 50, 0)]
    assert found[59] == [] and late == {59}
    assert max(session.peaks.values()) == analyze.CONCURRENCY


def test_require_python_finds_the_virtual_environment_and_names_what_it_tried(tmp_path):
    repo = tmp_path / "repo"
    (repo / "broken").mkdir(parents=True)
    (repo / "broken" / "pyvenv.cfg").write_text("home = /nowhere\n")
    with pytest.raises(PythonNotFound) as missing:
        require_python(repo, None)
    assert "가상환경을 찾지 못했다" in str(missing.value)
    assert f"{repo.resolve() / 'broken' / 'bin' / 'python'}: 없는 파일" in str(missing.value)

    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(repo / ".venv")], check=True)
    assert require_python(repo, None) == str(repo.resolve() / ".venv" / "bin" / "python")

    with pytest.raises(PythonNotFound, match="--python에 준 경로를 실행할 수 없다: /bin/ls") as given:
        require_python(repo, "/bin/ls")  # 준 값이 통과하지 못하면 레포의 가상환경으로 넘어가지 않는다
    assert "/bin/ls: 종료 코드 " in str(given.value)
