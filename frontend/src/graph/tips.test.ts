import { describe, expect, it } from "vitest";
import { repoFixture, variableFixture } from "./fixture";
import { busyTip, cycleTip, globalTip, insideTip, locTip, nodeTip, packCount, packTip, valueTip } from "./tips";
import { nodeIndex } from "./visible";

const nodes = nodeIndex(repoFixture);
const [file, folder, fn] = [nodes.get("main")!, nodes.get("pkg")!, nodes.get("main:run")!];

describe("배지 말풍선", () => {
  it("접힌 상자의 배지는 파일 상자면 안에 든 함수·클래스·변수 수, 폴더 상자면 안에 든 파일 수를 적는다", () => {
    expect(insideTip(file, 9)).toBe("안에 든 함수·클래스·변수 9개 · 고르면 보인다");
    expect(insideTip(folder, 30)).toBe("안에 든 파일 30개 · 펼치면 보인다");
  });

  it("손잡이는 안에서만 쓰이는 자식의 수와 이름을 적고 여섯 개부터는 줄인다", () => {
    expect(packTip({ definitions: 2, variables: 0 }, ["_parse()", "_merge()"])).toBe("이 파일 안에서만 쓰이는 내부 함수 2개 · _parse(), _merge()");
    expect(packTip({ definitions: 7, variables: 0 }, ["a()", "b()", "c()", "d()", "e()", "f()", "g()"])).toBe(
      "이 파일 안에서만 쓰이는 내부 함수 7개 · a(), b(), c(), d(), e() 외 2개",
    );
  });

  it("손잡이에 변수가 있으면 함수와 변수의 수를 나눠 적고 변수만 있으면 변수의 수만 적는다", () => {
    expect(packCount({ definitions: 14, variables: 0 })).toBe("내부 함수 14개");
    expect(packCount({ definitions: 14, variables: 6 })).toBe("내부 함수 14개 · 변수 6개");
    expect(packCount({ definitions: 0, variables: 3 })).toBe("내부 변수 3개");
    expect(packTip({ definitions: 1, variables: 2 }, ["_parse()", "LIMIT", "DEFAULT"])).toBe("이 파일 안에서만 쓰이는 내부 함수 1개 · 변수 2개 · _parse(), LIMIT, DEFAULT");
  });

  it("모듈 변수 변경은 바꿈 선의 도착 변수 이름을 적는다", () => {
    expect(globalTip(["counter", "REGISTRY"])).toBe("모듈 변수 변경: counter, REGISTRY을 바꾼다");
    expect(globalTip([])).toBe("모듈 변수 변경: 모듈 변수를 바꾼다");
  });

  it("변수 노드의 말풍선은 값의 종류와 원소 수, 값의 글을 적고 글이 없으면 종류와 원소 수만 적는다", () => {
    const variables = nodeIndex(variableFixture);
    expect(valueTip(variables.get("conf:PRESETS")!)).toBe('dict · 2개 · {"fast": Preset("fast"), "slow": Preset("slow")}');
    expect(valueTip(variables.get("conf:LIMIT")!)).toBe("int · 3");
    expect(valueTip(variables.get("tests.test_conf:SAMPLE")!)).toBe("tuple · 0개");
    expect(valueTip(fn)).toBe("");
  });

  it("도는 원, 줄 수는 수를 함께 적는다", () => {
    expect(busyTip(fn, 1)).toBe("LLM 요약을 만드는 중 1개");
    expect(busyTip(file, 2)).toBe("LLM 요약을 만드는 중 2개 · 이 상자와 안에 든 노드");
    expect(busyTip(folder, 12)).toBe("LLM 요약을 만드는 중 · 안에 든 노드 남은 12개");
    expect(locTip({ ...fn, loc: 131 })).toBe("줄 수 131줄 · 빈 줄을 뺀 수");
  });

  it("순환 아이콘은 묶음의 파일 수와 이름을 적고 여섯 개부터는 줄인다", () => {
    expect(cycleTip(file, [["a.py", "b.py", "c.py"]])).toBe("순환 묶음: 파일 3개가 서로를 import해 돌아온다\na.py, b.py, c.py");
    const seven = ["a.py", "b.py", "c.py", "d.py", "e.py", "f.py", "g.py"];
    expect(cycleTip(file, [seven]).split("\n")[1]).toBe("a.py, b.py, c.py, d.py, e.py 외 2개");
    expect(cycleTip(folder, [["a.py", "b.py"]]).split("\n")[0]).toBe("순환 묶음: 파일 2개가 서로를 import해 돌아온다 · 이 폴더 안의 파일이 든 묶음");
    expect(cycleTip(folder, [["a.py", "b.py"], ["c.py", "d.py", "e.py"]]).split("\n")).toEqual([
      "순환 묶음 2개 · 이 폴더 안의 파일이 든 묶음",
      "파일 2개: a.py, b.py",
      "파일 3개: c.py, d.py, e.py",
    ]);
  });

  it("노드의 말풍선은 잘린 이름, 요약의 요지, 미사용 후보의 뜻을 줄마다 적고 적을 줄이 없으면 띄우지 않는다", () => {
    expect(nodeTip(null, null, false)).toBeNull();
    expect(nodeTip(null, "주문 목록을 받아 품목별 수량을 더한다", false)).toBe("주문 목록을 받아 품목별 수량을 더한다");
    expect(nodeTip("pkg/parser/common_helpers.py", null, false)).toBe("pkg/parser/common_helpers.py");
    expect(nodeTip("run_everything()", "설정을 읽어 엔진을 띄운다", true)!.split("\n")).toEqual([
      "run_everything()",
      "설정을 읽어 엔진을 띄운다",
      "미사용 후보 · 들어오는 실행·사용 선이 없다 · 동적 호출이면 실제로는 쓰일 수 있다",
    ]);
  });
});
