"""`/api/changes`의 정의 판정. `HEAD`와 작업 중인 상태를 견준 `compare.definitions`의 판정을 쓴다."""

import sys

import pytest
from fastapi.testclient import TestClient
from history import run
from test_api import analysed

from code_atlas import api, git, summary
from code_atlas.api import create_app

ORDERS = "src/shop/orders.py"


@pytest.fixture
def served(history_repo, tmp_path):
    """고정 레포를 고치는 함수를 받아, 고친 뒤에 띄운 서버를 돌려준다."""
    repo, _ = history_repo
    opened = []

    def serve(edit=lambda repo: None) -> TestClient:
        edit(repo)
        client = TestClient(create_app(repo, sys.executable))
        opened.append(client.__enter__())
        return analysed(client)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
        patch.setattr(summary, "find_cli", lambda: None)
        patch.setattr(api, "STALE_MEMO", 0.0)
        yield serve
        for client in opened:
            client.__exit__(None, None, None)


def test_modified_definition_and_untracked_file(served):
    body = served().get("/api/changes").json()
    assert body["files"] == [
        {"path": "src/shop/notes.py", "status": "added", "stale": False, "test": False},
        {"path": "src/shop/pricing.py", "status": "modified", "stale": False, "test": False},
    ]
    assert body["nodes"] == {
        "shop.notes": "added",
        "shop.notes:remind": "added",
        "shop.pricing": "modified",
        "shop.pricing:tax": "modified",
    }


def test_definition_missing_from_head_is_added_and_shifted_ones_are_left_out(served):
    def edit(repo):
        orders = repo / ORDERS
        text = "# 주문\n" + orders.read_text()  # 모든 정의가 한 줄 밀린다
        text = text.replace("def checkout(order, percent):\n", "def cancel(order):\n    return refund(order)\n\n\ndef checkout(order, percent):\n")
        orders.write_text(text.replace("    return total(order.amount, 0)\n", "    return total(order.amount, 1)\n"))

    nodes = served(edit).get("/api/changes").json()["nodes"]
    assert {id: state for id, state in nodes.items() if id.startswith("shop.orders")} == {
        "shop.orders": "modified",
        "shop.orders:cancel": "added",
        "shop.orders:refund": "modified",
    }


def test_method_changed_marks_its_class(served):
    def edit(repo):
        orders = repo / ORDERS
        orders.write_text(orders.read_text().replace("total(self.amount, percent)", "total(self.amount, percent or 0)"))

    nodes = served(edit).get("/api/changes").json()["nodes"]
    assert {id: state for id, state in nodes.items() if id.startswith("shop.orders")} == {
        "shop.orders": "modified",
        "shop.orders:Order": "modified",
        "shop.orders:Order.price": "modified",
    }


def test_variable_node_with_changed_assignment_is_modified_and_untouched_one_is_left_out(served):
    def edit(repo):
        pricing = repo / "src/shop/pricing.py"
        pricing.write_text(pricing.read_text().replace("RATE = 0.1\n", "RATE = 0.2\nFLOOR = 0\n"))
        orders = repo / ORDERS
        orders.write_text(orders.read_text() + "\n\ndef rate():\n    from shop import inventory, pricing\n\n    return pricing.RATE, pricing.FLOOR, inventory.LEVELS\n")

    client = served(edit)
    kinds = {n["id"]: n["kind"] for n in client.get("/api/graph").json()["nodes"]}
    assert kinds["shop.pricing:RATE"] == kinds["shop.pricing:FLOOR"] == kinds["shop.inventory:LEVELS"] == "variable"
    nodes = client.get("/api/changes").json()["nodes"]
    assert (nodes["shop.pricing:RATE"], nodes["shop.pricing:FLOOR"]) == ("modified", "added")
    assert "shop.inventory:LEVELS" not in nodes


def test_renamed_file_keeps_its_definitions_unmarked(served):
    def edit(repo):
        run(repo, "mv", "src/shop/report.py", "src/shop/printing.py")
        for path in (repo / "src/shop").glob("*.py"):
            path.write_text(path.read_text().replace("shop.report", "shop.printing"))

    body = served(edit).get("/api/changes").json()
    states = {f["path"]: f["status"] for f in body["files"]}
    assert (states["src/shop/printing.py"], states["src/shop/report.py"]) == ("added", "deleted")
    assert {id: state for id, state in body["nodes"].items() if id.startswith("shop.printing")} == {"shop.printing": "added"}


def test_files_changed_after_the_analysis_show_only_the_file(served):
    client = served()
    repo = client.app.state.analyzed.files.root
    (repo / ORDERS).write_text((repo / ORDERS).read_text() + "\n\ndef late():\n    return 1\n")
    body = client.get("/api/changes").json()
    assert {"path": ORDERS, "status": "modified", "stale": True, "test": False} in body["files"]
    assert {id for id in body["nodes"] if id.startswith("shop.orders")} == {"shop.orders"}
    assert body["nodes"]["shop.pricing:tax"] == "modified"


def test_head_files_are_read_once_per_head(served, monkeypatch):
    client = served()
    shown: list[tuple[str, str]] = []
    real = git.show

    def counted(root, commit, path):
        shown.append((commit, path))
        return real(root, commit, path)

    monkeypatch.setattr(api.git, "show", counted)
    first = client.get("/api/changes").json()
    head = git.head(client.app.state.analyzed.files.root)
    assert shown == [(head, "src/shop/pricing.py")]
    assert client.get("/api/changes").json() == first and len(shown) == 1

    repo = client.app.state.analyzed.files.root
    run(repo, "add", "-A")
    run(repo, "commit", "-q", "-m", "커밋")
    assert client.get("/api/changes").json()["nodes"] == {} and len(shown) == 1
    (repo / "src/shop/pricing.py").write_text((repo / "src/shop/pricing.py").read_text() + "\nLIMIT = 1\n")
    client.post("/api/reload")
    assert client.get("/api/changes").json()["nodes"] == {"shop.pricing": "modified"}
    assert shown[-1] == (git.head(repo), "src/shop/pricing.py") and len(shown) == 2


def test_repo_without_commits_marks_every_definition_added(tmp_path):
    repo = tmp_path / "fresh"
    (repo / "pkg").mkdir(parents=True)
    (repo / "pkg" / "one.py").write_text("def first():\n    return 1\n")
    run(repo, "init", "-q", "--template=", "-b", "main")
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(summary, "CACHE_PATH", tmp_path / "summaries.db")
        patch.setattr(summary, "find_cli", lambda: None)
        with TestClient(create_app(repo, sys.executable)) as client:
            body = analysed(client).get("/api/changes").json()
    assert (body["git"], body["branch"]) == (True, "main")
    assert body["nodes"] == {"one": "added", "one:first": "added"}
