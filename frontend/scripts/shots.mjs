// 2단계 화면을 시나리오마다 조작해 확인 항목의 통과 여부를 한 줄씩 출력하고 스크린샷을 남긴다.
// 사용: node scripts/shots.mjs [주소] [--only 이름,이름] [--with-summary]
// 떠 있는 서버의 주소를 받고(기본 http://127.0.0.1:8766) 서버를 띄우지 않는다. 노드 이름은 sync-engine을 연 서버가 기준이고 노드 수·선 수·줄 범위는 서버 응답에서 읽는다.
// 시나리오마다 localStorage가 빈 새 브라우저 컨텍스트에서 시작한다. 실패한 확인 항목이 있으면 종료 코드 1로 끝난다.
// 대상 레포에 입력이 없어 볼 수 없는 확인 항목은 "건너뜀"으로 출력하고 실패로 세지 않는다.
// summary 시나리오는 Claude Code 구독 사용량을 쓰므로 --only로 지정하거나 --with-summary를 줬을 때만 돈다.
// 다른 시나리오가 보내는 POST /api/summary는 서버로 보내지 않고 붙잡아 두었다가 버린다.
// changes 시나리오는 /api/repo의 root에서 git status와 git diff를 읽기 전용으로 부르므로 서버와 같은 기계에서 돌린다.
// 수정한 .py 파일이 없는 레포에서는 changes의 확인 항목을 건너뛴다.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const VIEW = { width: 1700, height: 1000 };
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const OUT = join(homedir(), "data", "code-atlas", "screenshots");
const FILE = "arbiter";
const FUNCTION = "arbiter:_rebuild_note_sections";
/** 초점 상태에서 흐름 밖 노드가 받는 불투명도 */
const DIM = 0.2;
/** 함수 이름표가 모두 보이는 확대 비율 구간의 시작값. 이보다 작은 확대 비율에서 노드를 고르면 이 값이 된다. */
const NAMED_ZOOM = 0.8;
/** 큰 상자를 패널을 뺀 영역의 시작 끝에서 띄우는 폭 */
const INSET = 20;
const DARK = { surface: "#1a1a19", ink: "#ffffff" };
/** 좁은 창에서 상단 줄을 확인할 때 고르는 함수와 창 폭 */
const NARROW = { owner: "parser.plan", id: "parser.plan:_parse_week_header", label: "_parse_week_header()", widths: [1700, 1440, 1280, 1160, 980, 900, 720] };
/** 글자 요소가 그리는 글자와 배지. 이 요소의 가운데 점에서는 늘 그 노드가 눌린다. */
const TEXTS = ".node-label, .loc, .change-mark, .badge, .node-aside, .node-below, .node-inflow, .node-field, .call-file";

let url = "http://127.0.0.1:8766";
let only = null;
let withSummary = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--only") {
    only = (process.argv[++i] ?? "").split(",").filter((name) => name !== "");
  } else if (arg === "--with-summary") {
    withSummary = true;
  } else {
    url = arg;
  }
}

const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 노드의 바탕 요소(테두리와 채움)를 감싼 React Flow 노드 */
const node = (id) => `.react-flow__node[data-id="${id}"]`;
/** 노드의 글자 요소(이름표·줄 수 숫자·배지·선택 고리)를 감싼 React Flow 노드 */
const face = (id) => `.react-flow__node[data-id="${id}#face"]`;
const api = async (path) => (await fetch(new URL(path, url))).json();

// ── 서버 응답에서 읽는 기대값 ─────────────────────────────────────

/** 파일 상자 id의 파일에 정의된 클래스·함수·메서드 노드 */
function definedIn(graph, file) {
  const path = graph.nodes.find((n) => n.id === file)?.path;
  return graph.nodes.filter((n) => n.path === path && n.id !== file);
}

/** 토글이 꺼진 화면에서 노드에 닿는 선 수. 테스트 코드와 외부 모듈로 가는 선은 세지 않는다. */
function touchingOf(graph, id) {
  const drawn = new Set(graph.nodes.filter((n) => !n.test && n.kind !== "external").map((n) => n.id));
  return {
    out: graph.edges.filter((e) => e.source === id && drawn.has(e.target)).length,
    into: graph.edges.filter((e) => e.target === id && drawn.has(e.source)).length,
  };
}

/** 정보 패널 머리 줄에 적히는 `경로:시작-끝` */
function spanOf(graph, id) {
  const found = graph.nodes.find((n) => n.id === id);
  return { from: found.range[0], text: `${found.path}:${found.range[0]}-${found.range[1]}` };
}

// ── 화면에서 읽는 값 ──────────────────────────────────────────────

const zoomOf = (page) =>
  page.evaluate(() => {
    const transform = document.querySelector(".react-flow__viewport")?.style.transform ?? "";
    return Number(/scale\(([^)]+)\)/.exec(transform)?.[1] ?? NaN);
  });

const rectOf = (page, selector) =>
  page.evaluate((sel) => {
    const rect = document.querySelector(sel)?.getBoundingClientRect();
    return rect === undefined ? null : { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, selector);

const selectedOf = (page) =>
  page.evaluate(() => document.querySelector(".react-flow__node .node-selected")?.closest(".react-flow__node")?.dataset.id ?? null);

const headOf = (page) => page.evaluate(() => document.querySelector(".info-panel-head")?.innerText ?? "");

const count = (page, selector) => page.evaluate((sel) => document.querySelectorAll(sel).length, selector);

/** 파일 상자마다 화면 위치와 확대하기 전 크기. 이름표·배지·변경 상태 글자는 글자 요소에서 읽는다. */
const boxes = (page) =>
  page.evaluate(() => {
    const transform = document.querySelector(".react-flow__viewport")?.style.transform ?? "";
    const zoom = Number(/scale\(([^)]+)\)/.exec(transform)?.[1] ?? 1);
    return [...document.querySelectorAll(".react-flow__node")]
      .filter((wrapper) => wrapper.querySelector(":scope > .node-body.node-module") !== null)
      .map((wrapper) => {
        const rect = wrapper.getBoundingClientRect();
        const root = wrapper.querySelector(":scope > .node-module");
        const text = document.querySelector(`.react-flow__node[data-id="${CSS.escape(wrapper.dataset.id)}#face"] > .node-module`);
        return {
          id: wrapper.dataset.id,
          label: text?.querySelector(".node-label")?.textContent ?? "",
          x: rect.left,
          y: rect.top,
          bottom: rect.bottom,
          width: rect.width / zoom,
          height: rect.height / zoom,
          open: root.classList.contains("node-module-open"),
          inflow: text?.querySelector(".node-inflow")?.textContent ?? null,
          change: root.dataset.change ?? null,
          mark: text?.querySelector(".change-mark")?.textContent ?? null,
        };
      });
  });

/** 왼쪽 x가 같은 상자를 한 열로 묶어 열은 왼쪽부터, 열 안은 위부터 적은 id 목록 */
function columnsOf(list, skip = () => false) {
  const columns = [];
  for (const box of [...list].filter((b) => !skip(b.id)).sort((a, b) => a.x - b.x || a.y - b.y)) {
    const last = columns.at(-1);
    if (last !== undefined && near(last.x, box.x)) {
      last.ids.push(box.id);
    } else {
      columns.push({ x: box.x, ids: [box.id] });
    }
  }
  return columns.map((column) => column.ids);
}

/** 관계 그래프 영역, 정보 패널, 패널을 뺀 네 사각형 가운데 가장 넓은 사각형(frontend/src/graph/viewport.ts의 freeRect와 같은 계산) */
const stageOf = (page) =>
  page.evaluate(() => {
    const plain = (r) => ({ x: r.left, y: r.top, width: r.width, height: r.height });
    const area = plain(document.querySelector(".graph").getBoundingClientRect());
    const panel = plain(document.querySelector(".info-panel").getBoundingClientRect());
    const clampX = (x) => Math.max(area.x, Math.min(x, area.x + area.width));
    const clampY = (y) => Math.max(area.y, Math.min(y, area.y + area.height));
    const [left, right, top, bottom] = [clampX(panel.x), clampX(panel.x + panel.width), clampY(panel.y), clampY(panel.y + panel.height)];
    let free = area;
    if (left < right && top < bottom) {
      free = [
        { ...area, width: left - area.x },
        { ...area, x: right, width: area.x + area.width - right },
        { ...area, height: top - area.y },
        { ...area, y: bottom, height: area.y + area.height - bottom },
      ].reduce((best, side) => (side.width * side.height > best.width * best.height ? side : best));
    }
    return { area, panel, free };
  });

/** 그린 선마다 양 끝, 진하기, 불투명도, 선 색 */
const edgesOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge .edge[data-key]")].map((edge) => {
      const parts = edge.dataset.key.split("|");
      const [source, target] = parts[0] === "agg" ? [parts[1], parts[2]] : [parts[0], parts[1]];
      return {
        key: edge.dataset.key,
        source,
        target,
        tone: edge.classList.contains("tone-strong") ? "strong" : "muted",
        opacity: Number(getComputedStyle(edge).opacity),
        stroke: getComputedStyle(edge.querySelector(".edge-line")).stroke,
      };
    }),
  );

/** 선마다 경로의 시작점·끝점(그래프 좌표), 선 굵기, 층, 마우스를 올린 선인지 */
const linesOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge .edge[data-key]")].map((edge) => {
      const line = edge.querySelector(".edge-line");
      const total = line.getTotalLength();
      const [start, end] = [line.getPointAtLength(0), line.getPointAtLength(total)];
      return {
        key: edge.dataset.key,
        start: { x: start.x, y: start.y },
        end: { x: end.x, y: end.y },
        width: parseFloat(getComputedStyle(line).strokeWidth),
        glow: getComputedStyle(line).filter !== "none",
        layer: getComputedStyle(edge.closest("svg")).zIndex,
        pointed: edge.hasAttribute("data-pointed"),
        tone: edge.classList.contains("tone-strong") ? "strong" : "muted",
        opacity: Number(getComputedStyle(edge).opacity),
      };
    }),
  );

/** 노드마다 그래프 좌표의 상자 */
const flowBoxes = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll(".react-flow__node")]
        .filter((wrapper) => !wrapper.dataset.id.endsWith("#face"))
        .map((wrapper) => {
          const [x, y] = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(wrapper.style.transform).slice(1).map(Number);
          return [wrapper.dataset.id, { x, y, width: parseFloat(wrapper.style.width), height: parseFloat(wrapper.style.height) }];
        }),
    ),
  );

/**
 * 선 위에서 맨 위 요소가 그 선인 화면 좌표. 경로를 따라 8px마다 찾고, 관계 그래프 영역 밖과 정보 패널 아래는 건너뛴다.
 * 없으면 null이다.
 */
const edgePoint = (page, key) =>
  page.evaluate((want) => {
    const edge = [...document.querySelectorAll(".react-flow__edge .edge[data-key]")].find((e) => e.dataset.key === want);
    const line = edge?.querySelector(".edge-line");
    if (line == null) {
      return null;
    }
    const matrix = line.getScreenCTM();
    const total = line.getTotalLength();
    for (let step = 0; step <= total / 2; step += 8) {
      for (const length of [total / 2 - step, total / 2 + step]) {
        const point = new DOMPoint(line.getPointAtLength(length).x, line.getPointAtLength(length).y).matrixTransform(matrix);
        if (document.elementFromPoint(point.x, point.y)?.closest(".edge") === edge) {
          return { x: point.x, y: point.y };
        }
      }
    }
    return null;
  }, key);

/** lines 가운데 누를 점이 있는 첫 선과 그 점. 다른 선의 누름 영역에 모두 덮인 선은 건너뛴다. 없으면 null이다. */
async function hittable(page, lines) {
  for (const line of lines) {
    const at = await edgePoint(page, line.key);
    if (at !== null) {
      return { line, at };
    }
  }
  return null;
}

/** 선의 진하기 세 단계마다 그린 선 수 */
function toneLevels(edges) {
  const ink = edges.filter((e) => e.tone === "strong").length;
  const full = edges.filter((e) => e.tone === "muted" && e.opacity === 1).length;
  const dim = edges.filter((e) => e.tone === "muted" && e.opacity === DIM).length;
  return `본문 잉크 ${ink}개, muted 100% ${full}개, muted 20% ${dim}개`;
}

/** CSS 변수의 값과 그 값을 브라우저가 계산한 rgb 문자열 */
const colorOf = (page, name) =>
  page.evaluate((variable) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return { value: getComputedStyle(document.documentElement).getPropertyValue(variable).trim(), rgb };
  }, name);

// ── 조작 ─────────────────────────────────────────────────────────

/** 배치 움직임(300ms)과 화면 이동(400ms)이 끝나 노드 수와 화면 위치가 quiet ms 동안 그대로일 때까지 기다린다. */
async function settle(page, quiet = 500) {
  await page.waitForFunction(
    (ms) => {
      const graph = document.querySelector(".graph");
      const busy = graph === null || graph.hasAttribute("data-moving") || document.querySelector(".graph-empty") !== null;
      const now = [
        busy,
        document.querySelector(".react-flow__viewport")?.style.transform,
        document.querySelectorAll(".react-flow__node").length,
        document.querySelector(".info-panel")?.getBoundingClientRect().height,
      ].join("|");
      if (window.__shotsSeen !== now) {
        window.__shotsSeen = now;
        window.__shotsSince = performance.now();
        return false;
      }
      return !busy && performance.now() - window.__shotsSince >= ms;
    },
    quiet,
    { polling: 50, timeout: 30_000 },
  );
}

async function load(page) {
  await page.goto(url);
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
}

/** 노드의 이름표(펼친 파일 상자는 머리 줄) 가운데를 마우스로 누른다. times가 2면 더블클릭이다. */
async function clickNode(page, id, times = 1) {
  const at = await page.evaluate(
    ([body, text]) => {
      const wrappers = [document.querySelector(body), document.querySelector(text)];
      if (wrappers[0] === null) {
        return null;
      }
      const rect = (wrappers[1]?.querySelector(".node-module-head, .node-module-name, .node-label") ?? wrappers[0]).getBoundingClientRect();
      const [x, y] = [rect.left + rect.width / 2, rect.top + rect.height / 2];
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: hit !== null && wrappers.some((wrapper) => wrapper?.contains(hit) === true) };
    },
    [node(id), face(id)],
  );
  if (at === null) {
    throw new Error(`노드가 화면에 없다: ${id}`);
  }
  if (!at.hit) {
    throw new Error(`노드가 화면 밖에 있거나 다른 요소에 가려 누르지 못한다: ${id} (${Math.round(at.x)}, ${Math.round(at.y)})`);
  }
  await (times === 2 ? page.mouse.dblclick(at.x, at.y) : page.mouse.click(at.x, at.y));
}

/**
 * 화면에 보이는 글자와 배지마다 가운데 점의 맨 위 요소가 그 노드의 글자 요소인지 본다.
 * 관계 그래프 영역 밖에 있거나 정보 패널·범례 버튼 아래에 있는 글자는 세지 않는다.
 */
const coveredTexts = (page) =>
  page.evaluate((selector) => {
    const area = document.querySelector(".graph").getBoundingClientRect();
    const result = { seen: 0, covered: [] };
    for (const text of document.querySelectorAll(`.node-face :is(${selector})`)) {
      const rect = text.getBoundingClientRect();
      const [x, y] = [rect.left + rect.width / 2, rect.top + rect.height / 2];
      if (getComputedStyle(text).visibility !== "visible" || x <= area.left || x >= area.right || y <= area.top || y >= area.bottom) {
        continue;
      }
      const hit = document.elementFromPoint(x, y);
      if (hit === null || hit.closest(".react-flow__viewport") === null) {
        continue;
      }
      result.seen += 1;
      const wrapper = text.closest(".react-flow__node");
      if (!wrapper.contains(hit)) {
        const over = hit.closest(".react-flow__node")?.dataset.id ?? hit.closest(".edge")?.dataset.key ?? hit.tagName;
        result.covered.push(`${wrapper.dataset.id.replace(/#face$/, "")}의 "${text.textContent}" 위에 ${over}`);
      }
    }
    return result;
  }, TEXTS);

async function waitSelected(page, id) {
  await page.waitForFunction(
    (want) => (document.querySelector(".react-flow__node .node-selected")?.closest(".react-flow__node")?.dataset.id ?? null) === want,
    id,
    { timeout: 30_000 },
  );
  await settle(page);
}

/** 그래프의 노드를 눌러 고르고 새 배치와 화면 이동이 끝날 때까지 기다린다. */
async function pick(page, id) {
  await clickNode(page, id);
  await waitSelected(page, id);
}

/** 패널을 뺀 영역 가운데에서 휠을 돌려 확대 비율을 target으로 맞추고 맞춘 값을 돌려준다. */
async function zoomTo(page, target) {
  const { free } = await stageOf(page);
  await page.mouse.move(free.x + free.width / 2, free.y + free.height / 2);
  for (let i = 0; i < 6; i += 1) {
    const zoom = await zoomOf(page);
    if (near(zoom, target, 0.005)) {
      break;
    }
    // d3-zoom은 휠 한 번에 확대 비율을 2^(-deltaY × 0.002)배로 바꾼다.
    await page.mouse.wheel(0, -Math.log2(target / zoom) / 0.002);
    await page.waitForTimeout(250);
  }
  await settle(page);
  return zoomOf(page);
}

async function drag(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
}

const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const sameRect = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
const rectText = (r) => `(${r.x.toFixed(0)}, ${r.y.toFixed(0)}) ${r.width.toFixed(0)}×${r.height.toFixed(0)}`;

// ── 시나리오 ──────────────────────────────────────────────────────

async function open(t, page) {
  await load(page);
  const graph = await api("/api/graph");
  const files = graph.nodes.filter((n) => n.kind === "module" && !n.test).length;
  const all = await boxes(page);
  t.check(
    `파일 상자 ${files}개가 모두 320×40이다`,
    all.length === files && all.every((b) => near(b.width, 320, 0.5) && near(b.height, 40, 0.5)),
    `${all.length}개, 크기 ${[...new Set(all.map((b) => `${Math.round(b.width)}×${Math.round(b.height)}`))].join("·")}`,
  );
  const [arbiter, batch] = [all.find((b) => b.id === "arbiter"), all.find((b) => b.id === "note_batch")];
  const leftmost = Math.min(...all.map((b) => b.x));
  t.check(
    "arbiter.py와 note_batch.py의 왼쪽 x가 같고 가장 작다",
    arbiter !== undefined && batch !== undefined && near(arbiter.x, batch.x) && near(arbiter.x, leftmost),
    `arbiter.py ${arbiter?.x.toFixed(1)}, note_batch.py ${batch?.x.toFixed(1)}, 최소 ${leftmost.toFixed(1)}`,
  );
  const init = all.find((b) => b.label === "__init__.py");
  const others = Math.max(...all.filter((b) => b !== init).map((b) => b.bottom));
  const shelf = await page.evaluate(() => {
    const name = document.querySelector(".shelf-name");
    return name === null ? null : { text: name.textContent, top: name.getBoundingClientRect().top };
  });
  t.check(
    '__init__.py가 다른 상자 아래 "연결 없음" 선반에 있다',
    init !== undefined && shelf !== null && shelf.text === "연결 없음" && shelf.top >= others && init.y > shelf.top,
    `__init__.py 위 ${init?.y.toFixed(0)}, 선반 이름 ${shelf?.text ?? "없음"} 위 ${shelf?.top.toFixed(0)}, 다른 상자 아래 끝 ${others.toFixed(0)}`,
  );
  t.check("범례 목록이 보이지 않는다", (await count(page, ".legend")) === 0 && (await count(page, ".legend-button")) === 1);
  const badged = all.filter((b) => b.inflow !== null).map((b) => `${b.label} ${b.inflow}`);
  t.check("편재 노드 배지가 붙은 파일 상자는 parser/common.py 하나다", badged.length === 1 && badged[0].startsWith("parser/common.py"), badged.join(", "));
  const edges = await edgesOf(page);
  const into = (id) => edges.filter((e) => e.key.startsWith("agg|") && e.target === id).length;
  t.check(
    "parser/plan.py와 date_engine.py로 들어오는 집계 선이 그려진다",
    into("parser.plan") > 0 && into("date_engine") > 0,
    `parser/plan.py ${into("parser.plan")}개, date_engine.py ${into("date_engine")}개, 그린 선 ${edges.length}개`,
  );
  const { area, panel } = await stageOf(page);
  const gaps = { top: panel.y - area.y, right: area.x + area.width - panel.x - panel.width, bottom: area.y + area.height - panel.y - panel.height };
  t.check(
    "정보 패널이 관계 그래프 영역의 오른쪽에 붙어 위·오른쪽·아래에 같은 여백을 두고 위에서 아래까지 찬다",
    gaps.top > 0 && near(gaps.top, gaps.bottom) && near(gaps.top, gaps.right) && near(panel.width, 480),
    `여백 위 ${gaps.top}, 오른쪽 ${gaps.right}, 아래 ${gaps.bottom}, 패널 ${panel.width}×${panel.height}, 영역 높이 ${area.height}`,
  );
  const unresolved = graph.nodes.filter((n) => !n.test).reduce((sum, n) => sum + n.unresolved, 0);
  const badges = await page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node .badge-unresolved")].map((badge) => Number(badge.textContent.slice(1))),
  );
  t.check(
    "접힌 파일 상자의 미확인 호출 배지를 합치면 테스트 코드를 뺀 미확인 호출 수다",
    badges.length > 0 && unresolved > 0 && badges.reduce((sum, n) => sum + n, 0) === unresolved,
    `배지 ${badges.length}개의 합 ${badges.reduce((sum, n) => sum + n, 0)}, 그래프 ${unresolved}`,
  );
}

async function file(t, page) {
  await load(page);
  const before = { columns: columnsOf(await boxes(page)), zoom: await zoomOf(page), panel: await rectOf(page, ".info-panel") };
  await pick(page, FILE);
  const graph = await api("/api/graph");
  const all = await boxes(page);
  const [functions, defined] = [await count(page, ".react-flow__node .node-body.node-function"), definedIn(graph, FILE).filter((n) => n.kind === "function" || n.kind === "method").length];
  t.check(`함수 노드 ${defined}개가 나타난다`, defined > 0 && functions === defined, `${functions}개`);
  const opened = all.filter((b) => b.open).map((b) => b.id);
  t.check("다른 파일 상자는 접혀 있다", same(opened, [FILE]), `펼친 상자 ${opened.join(", ")}`);
  t.check("누르기 전과 후에 파일 상자의 열 순서와 열 안 순서가 같다", same(columnsOf(all), before.columns), JSON.stringify(columnsOf(all)));
  const [panel, head, summary] = [await rectOf(page, ".info-panel"), await rectOf(page, ".info-panel-head"), await rectOf(page, ".info-panel-summary")];
  t.check(
    "정보 패널에 코드 뷰어가 없고, 패널의 사각형이 고르기 전과 같으며, LLM 요약 칸이 머리 줄 아래의 남은 높이를 쓴다",
    (await count(page, ".info-panel .code")) === 0 && summary !== null && sameRect(panel, before.panel) && near(panel.height, head.height + summary.height + 2),
    `패널 ${rectText(before.panel)} → ${rectText(panel)}, 머리 줄 ${head.height}, 요약 칸 ${summary?.height}`,
  );
  const zoom = await zoomOf(page);
  const named = Math.max(before.zoom, NAMED_ZOOM);
  t.check("확대 비율이 누르기 전과 같거나, 80%보다 작았으면 80%다", near(zoom, named, 0.001), `${before.zoom.toFixed(3)} → ${zoom.toFixed(3)}`);
  const edges = await edgesOf(page);
  const touching = edges.filter((e) => e.source === FILE || e.target === FILE);
  const levels = toneLevels(edges);
  t.check(
    "arbiter.py 상자에서 나가고 들어오는 집계 선만 본문 잉크이고 상자 안의 선은 muted 잉크 100%다",
    touching.length > 0 &&
      touching.every((e) => e.key.startsWith("agg|") && e.tone === "strong" && e.opacity === 1) &&
      edges.every((e) => touching.includes(e) || e.tone === "muted") &&
      edges.filter((e) => e.source.startsWith(`${FILE}:`) && e.target.startsWith(`${FILE}:`)).every((e) => e.opacity === 1),
    `그린 선 ${edges.length}개: ${levels}`,
  );
  const title = await headOf(page);
  const [uses, users] = [new Set(touching.filter((e) => e.source === FILE).map((e) => e.target)), new Set(touching.filter((e) => e.target === FILE).map((e) => e.source))];
  t.check(
    "머리 줄의 상대 상자 수가 arbiter.py 상자에 닿는 집계 선의 수와 같다",
    title.includes(`쓰는 파일 ${uses.size} · 이 파일을 쓰는 파일 ${users.size}`),
    title.replaceAll("\n", " / "),
  );
  const unresolved = graph.nodes.filter((n) => n.path === `src/${FILE}.py`).reduce((sum, n) => sum + n.unresolved, 0);
  const badges = await page.evaluate((sel) => {
    const numbers = (list) => [...list].map((badge) => Number(badge.textContent.slice(1)));
    return {
      box: document.querySelectorAll(`${sel} > .node-module > .badge-unresolved`).length,
      inner: numbers(document.querySelectorAll(".react-flow__node .node-function .badge-unresolved")),
    };
  }, face(FILE));
  t.check(
    "펼친 arbiter.py 상자는 미확인 호출 배지가 없고, 안의 함수 배지의 합과 머리 줄의 미확인 호출 수가 같다",
    unresolved > 0 && badges.box === 0 && badges.inner.reduce((sum, n) => sum + n, 0) === unresolved && title.includes(`미확인 호출 ${unresolved}`),
    `함수 배지 ${badges.inner.length}개의 합 ${badges.inner.reduce((sum, n) => sum + n, 0)}, 그래프 ${unresolved}`,
  );
  const { free } = await stageOf(page);
  const box = await rectOf(page, node(FILE));
  const placed = (start, length, from, room) =>
    length > room ? near(start, from + INSET) : near(start + length / 2, from + room / 2);
  t.check(
    "arbiter.py 상자의 중심이 패널을 뺀 영역의 중심에 있거나, 상자가 영역보다 긴 축에서는 시작 끝이 20px 안쪽에 있다",
    placed(box.x, box.width, free.x, free.width) && placed(box.y, box.height, free.y, free.height),
    `상자 (${box.x.toFixed(1)}, ${box.y.toFixed(1)}) ${box.width.toFixed(0)}×${box.height.toFixed(0)}, 영역 (${free.x.toFixed(1)}, ${free.y.toFixed(1)}) ${free.width.toFixed(0)}×${free.height.toFixed(0)}`,
  );
}

/** 파일 상자를 펼치고 함수를 고른 뒤 function 시나리오의 확인 항목을 본다. dark 시나리오가 함께 쓴다. */
async function focused(t, page) {
  const opened = await rectOf(page, ".info-panel");
  await pick(page, FILE);
  const before = await zoomOf(page);
  await pick(page, FUNCTION);
  await page.waitForSelector(".info-panel .monaco-editor .line-numbers", { timeout: 30_000 });
  const [panel, summary, code] = [await rectOf(page, ".info-panel"), await rectOf(page, ".info-panel-summary"), await rectOf(page, ".info-panel .code")];
  t.check(
    "함수를 골라도 패널의 사각형이 처음과 같고, LLM 요약 칸이 패널 높이의 4분의 1을 넘지 않으며 코드 뷰어가 나머지 높이를 쓴다",
    sameRect(panel, opened) && summary.height <= panel.height / 4 + 1 && near(code.y + code.height, panel.y + panel.height - 1),
    `패널 ${rectText(opened)} → ${rectText(panel)}, 요약 칸 ${summary.height}, 코드 뷰어 ${code.height}`,
  );
  const graph = await api("/api/graph");
  const [want, span] = [touchingOf(graph, FUNCTION), spanOf(graph, FUNCTION)];
  const edges = await edgesOf(page);
  const strong = edges.filter((e) => e.tone === "strong");
  const [out, into] = [strong.filter((e) => e.source === FUNCTION).length, strong.filter((e) => e.target === FUNCTION).length];
  t.check(
    `본문 잉크 선은 고른 함수에 닿는 ${want.out + want.into}개(나가는 선 ${want.out}개, 들어오는 선 ${want.into}개)뿐이고 불투명도가 1이다`,
    want.out > 0 && out === want.out && into === want.into && strong.length === out + into && strong.every((e) => e.opacity === 1),
    `나가는 선 ${out}개, 들어오는 선 ${into}개, 그린 선 ${edges.length}개: ${toneLevels(edges)}`,
  );
  const rest = edges.filter((e) => e.tone === "muted");
  t.check(
    "그 밖의 선은 muted 잉크이고 불투명도가 1(흐름에 든 노드 사이)이나 0.2다",
    rest.some((e) => e.opacity === 1) && rest.some((e) => e.opacity === DIM) && rest.every((e) => e.opacity === 1 || e.opacity === DIM),
    `불투명도 ${[...new Set(rest.map((e) => e.opacity))].sort().join("·")}`,
  );
  const [ink, muted] = [await colorOf(page, "--ink"), await colorOf(page, "--muted")];
  const strokes = [...new Set(edges.map((e) => e.stroke))].sort();
  t.check("선의 색이 --ink와 --muted 두 값뿐이다", same(strokes, [ink.rgb, muted.rgb].sort()), strokes.join(", "));
  const head = await headOf(page);
  t.check(`정보 패널 머리 줄이 ${span.text}를 담는다`, head.includes(span.text), head.replaceAll("\n", " / "));
  const first = await page.evaluate(() => {
    const numbers = [...document.querySelectorAll(".info-panel .monaco-editor .line-numbers")];
    numbers.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return numbers[0]?.textContent ?? null;
  });
  t.check(`코드 뷰어 첫 줄 번호가 ${span.from}이다`, first === String(span.from), `${first}`);
  const zoom = await zoomOf(page);
  const { free } = await stageOf(page);
  const [at, middle] = [center(await rectOf(page, node(FUNCTION))), center(free)];
  t.check(
    "확대 비율이 누르기 전과 같고 고른 함수의 중심이 패널을 뺀 영역의 중심에서 1px 안에 있다",
    near(zoom, before, 0.001) && near(at.x, middle.x) && near(at.y, middle.y),
    `확대 비율 ${before.toFixed(3)} → ${zoom.toFixed(3)}, 중심 차이 (${(at.x - middle.x).toFixed(1)}, ${(at.y - middle.y).toFixed(1)})`,
  );
  const local = await page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node > .node-face[data-local]:not([data-flow])")].map((root) => ({
      opacity: Number(getComputedStyle(root.closest(".react-flow__node")).opacity),
      label: getComputedStyle(root.querySelector(".node-label")).visibility,
    })),
  );
  t.check(
    "arbiter.py 상자 안의 흐름 밖 함수 이름표가 불투명도 0.2로 보인다",
    local.length > 0 && local.every((n) => n.opacity === DIM && n.label === "visible"),
    `흐름 밖 노드 ${local.length}개, 불투명도 ${[...new Set(local.map((n) => n.opacity))].join("·")}, 이름표 ${[...new Set(local.map((n) => n.label))].join("·")}`,
  );
}

async function functionScenario(t, page) {
  await load(page);
  await focused(t, page);
}

async function body(t, page) {
  await load(page);
  await pick(page, FILE);
  await pick(page, FUNCTION);
  // 펼친 상자 안에서 함수 노드, 선, 머리 줄, 정보 패널이 덮지 않는 곳을 찾는다.
  const spot = await page.evaluate((selector) => {
    const wrapper = document.querySelector(selector);
    const box = wrapper.getBoundingClientRect();
    const area = document.querySelector(".graph").getBoundingClientRect();
    for (let y = Math.max(box.top, area.top) + 6; y < Math.min(box.bottom, area.bottom); y += 12) {
      for (let x = Math.max(box.left, area.left) + 6; x < Math.min(box.right, area.right); x += 12) {
        const hit = document.elementFromPoint(x, y);
        if (hit !== null && wrapper.contains(hit) && hit.closest(".node-module-head") === null) {
          return { x, y };
        }
      }
    }
    return null;
  }, node(FILE));
  if (spot === null) {
    t.check("펼친 arbiter.py 상자에 누를 빈 곳이 있다", false);
    return;
  }
  const before = { selected: await selectedOf(page), head: await headOf(page), functions: await count(page, ".node-function") };
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(1500);
  await settle(page);
  const after = { selected: await selectedOf(page), head: await headOf(page), functions: await count(page, ".node-function") };
  t.check("선택이 바뀌지 않는다", before.selected === FUNCTION && same(after, before), `누른 곳 (${spot.x}, ${spot.y}), 선택 ${after.selected}`);
}

async function panel(t, page) {
  await load(page);
  const start = await rectOf(page, ".info-panel");
  await page.setViewportSize({ width: VIEW.width, height: VIEW.height - 200 });
  await page.waitForFunction((height) => document.querySelector(".info-panel").getBoundingClientRect().height !== height, start.height, { timeout: 5_000 }).catch(() => {});
  await settle(page);
  const short = await rectOf(page, ".info-panel");
  t.check(
    "창 높이를 200px 줄이면 기본 패널의 높이가 200px 줄고 위치와 폭은 그대로다",
    sameRect(short, { ...start, height: start.height - 200 }),
    `${rectText(start)} → ${rectText(short)}`,
  );
  await page.setViewportSize(VIEW);
  await page.waitForFunction((height) => document.querySelector(".info-panel").getBoundingClientRect().height === height, start.height, { timeout: 5_000 }).catch(() => {});
  await settle(page);
  await drag(page, center(await rectOf(page, ".info-panel-head")), -300, 40);
  await drag(page, center(await rectOf(page, '.info-panel-resize[data-dir="nw"]')), -60, 80);
  const moved = await rectOf(page, ".info-panel");
  const want = { x: start.x - 360, y: start.y + 120, width: start.width + 60, height: start.height - 80 };
  t.check("머리 줄을 끌면 패널이 옮겨지고 왼쪽 위 모서리를 끌면 크기가 바뀐다", sameRect(moved, want), `${rectText(start)} → ${rectText(moved)}, 기대 ${rectText(want)}`);
  await page.reload();
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  const kept = await rectOf(page, ".info-panel");
  t.check("새로고침 뒤 위치와 크기가 유지된다", sameRect(kept, moved), rectText(kept));
  await pick(page, FILE);
  const picked = await rectOf(page, ".info-panel");
  t.check("파일 상자를 골라도 사용자가 정한 사각형이 유지된다", sameRect(picked, moved), rectText(picked));
  await page.dblclick(".info-panel-head");
  await settle(page);
  const reset = await rectOf(page, ".info-panel");
  t.check("머리 줄을 더블클릭하면 기본 사각형으로 돌아간다", sameRect(reset, start), `${rectText(moved)} → ${rectText(reset)}`);
  await page.reload();
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  const again = await rectOf(page, ".info-panel");
  t.check("새로고침 뒤에도 기본 사각형이다", sameRect(again, start), rectText(again));
}

/** 코드 뷰어에서 word가 처음 나오는 곳의 화면 사각형 */
const wordRect = (page, word) =>
  page.evaluate((text) => {
    const lines = document.querySelector(".info-panel .monaco-editor .view-lines");
    const walker = document.createTreeWalker(lines, NodeFilter.SHOW_TEXT);
    for (let leaf = walker.nextNode(); leaf !== null; leaf = walker.nextNode()) {
      const index = leaf.data.search(new RegExp(`(?<![A-Za-z0-9_])${text}(?![A-Za-z0-9_])`));
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(leaf, index);
        range.setEnd(leaf, index + text.length);
        const rect = range.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      }
    }
    return null;
  }, word);

async function hover(t, page) {
  await load(page);
  await pick(page, FILE);
  await pick(page, FUNCTION);
  await page.waitForSelector(".info-panel .monaco-editor .view-line", { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector(".info-panel .monaco-editor .view-lines")?.textContent.includes("extract_today_items"));

  const code = await rectOf(page, ".info-panel .code");
  await page.mouse.click(code.x + code.width / 2, code.y + code.height / 2);
  const focused = await page.evaluate(() => document.activeElement?.closest(".monaco-editor") != null);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  t.check(
    "코드 뷰어 안을 눌러 포커스를 준 뒤의 Esc는 선택을 풀지 않는다",
    focused && (await selectedOf(page)) === FUNCTION && (await count(page, ".info-panel .code")) === 1,
    `코드 뷰어 포커스 ${focused}, 선택 ${await selectedOf(page)}`,
  );

  const word = await wordRect(page, "extract_today_items");
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/hover", { timeout: 15_000 });
  await page.mouse.move(word.x + word.width / 2 - 8, word.y + word.height / 2);
  await page.mouse.move(word.x + word.width / 2, word.y + word.height / 2, { steps: 4 });
  const response = await answered;
  const reply = await response.json();
  const widget = page.locator(".monaco-hover:not(.hidden) .hover-contents").first();
  await widget.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  const shown = (await widget.isVisible()) ? await widget.innerText() : "";
  t.check("hover 상자가 서버가 돌려준 내용으로 뜬다", response.status() === 200 && shown.includes("extract_today_items"), shown.replaceAll("\n", " ").slice(0, 90));
  const marked = await rectOf(page, ".info-panel .monaco-editor .hoverHighlight");
  t.check(
    "hover 응답의 range가 코드 뷰어에서 그 이름의 범위로 바뀐다",
    reply.range !== null && marked !== null && near(marked.x, word.x, 2) && near(marked.y, word.y, 4) && near(marked.width, word.width, 2),
    `range ${JSON.stringify(reply.range)}, 강조 ${marked === null ? "없음" : `x ${marked.x.toFixed(1)} 폭 ${marked.width.toFixed(1)}`}, 이름 x ${word.x.toFixed(1)} 폭 ${word.width.toFixed(1)}`,
  );
  await t.shot();

  // 표준 라이브러리 이름은 정의가 레포 밖에 있으므로 외부 모듈 이름 말풍선이 뜬다.
  const outside = await wordRect(page, "Path");
  await page.keyboard.down(MOD);
  await page.mouse.click(outside.x + outside.width / 2, outside.y + outside.height / 2);
  await page.keyboard.up(MOD);
  const note = page.locator(".code-note");
  await note.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  const noted = (await note.isVisible()) ? await note.innerText() : "";
  t.check("표준 라이브러리 이름 Path를 Mod+클릭하면 외부 모듈 이름 말풍선이 뜬다", noted === "외부 모듈 pathlib" && (await selectedOf(page)) === FUNCTION, noted);

  // Mod를 누른 채 올리면 레포 안에 정의가 있는 이름에만 밑줄이 그어진다.
  const linked = async (word) => {
    await page.mouse.move(word.x + word.width / 2 - 6, word.y + word.height / 2);
    await page.mouse.move(word.x + word.width / 2, word.y + word.height / 2, { steps: 3 });
    await page.waitForSelector(".info-panel .code-link", { timeout: 3_000 }).catch(() => {});
    return page.evaluate(() => [...document.querySelectorAll(".info-panel .code-link")].map((element) => element.textContent).join(""));
  };
  const inside = await wordRect(page, "extract_today_items");
  await page.keyboard.down(MOD);
  const outer = await linked(await wordRect(page, "Path"));
  const inner = await linked(inside);
  t.check(
    "Mod를 누른 채 올리면 레포 안의 extract_today_items에는 밑줄이 그어지고 표준 라이브러리 Path에는 그어지지 않는다",
    inner === "extract_today_items" && outer === "",
    `extract_today_items "${inner}", Path "${outer}"`,
  );
  await page.mouse.click(inside.x + inside.width / 2, inside.y + inside.height / 2);
  await page.keyboard.up(MOD);
  await waitSelected(page, "note_common:extract_today_items").catch(() => {});
  t.check("Mod+클릭 뒤 선택이 note_common:extract_today_items로 바뀐다", (await selectedOf(page)) === "note_common:extract_today_items", `${await selectedOf(page)}`);
  await page.waitForFunction(() => document.querySelector(".info-panel .monaco-editor .view-lines")?.textContent.includes("def extract_today_items"), null, { timeout: 10_000 }).catch(() => {});
  const shownCode = await page.evaluate(() => document.querySelector(".info-panel .monaco-editor .view-lines")?.textContent.replaceAll("\u00a0", " ") ?? "");
  const opened = (await boxes(page)).find((b) => b.id === "note_common")?.open === true;
  t.check(
    "그래프가 note_common.py를 펼쳐 그 함수를 보이고 정보 패널의 코드가 그 함수로 바뀐다",
    opened && shownCode.includes("def extract_today_items") && (await headOf(page)).includes("extract_today_items"),
    `note_common.py 펼침 ${opened}`,
  );
  await page.keyboard.press("Alt+ArrowLeft");
  await waitSelected(page, FUNCTION).catch(() => {});
  t.check("Alt+←로 Mod+클릭하기 전의 함수로 돌아온다", (await selectedOf(page)) === FUNCTION, `${await selectedOf(page)}`);
}

async function edge(t, page) {
  await load(page);
  const graph = await api("/api/graph");
  const entries = new Set(graph.nodes.filter((n) => n.entry && n.kind === "module" && !n.test).map((n) => n.id));
  const [lines, at] = [await linesOf(page), await flowBoxes(page)];
  const ends = (line) => {
    const parts = line.key.split("|");
    return parts[0] === "agg" ? [parts[1], parts[2]] : [parts[0], parts[1]];
  };
  const leaving = lines.filter((line) => entries.has(ends(line)[0]));
  const onRight = leaving.filter((line) => near(line.start.x, at[ends(line)[0]].x + at[ends(line)[0]].width));
  t.check(
    `진입점 파일 ${entries.size}개에서 나가는 선이 모두 그 상자의 오른쪽 변에서 나온다`,
    leaving.length > 0 && onRight.length === leaving.length,
    `나가는 선 ${leaving.length}개 가운데 오른쪽 변 ${onRight.length}개`,
  );
  const forward = lines.filter((line) => {
    const [source, target] = ends(line).map((id) => at[id]);
    return source.x + source.width < target.x;
  });
  const sided = forward.filter((line) => {
    const [source, target] = ends(line).map((id) => at[id]);
    return near(line.start.x, source.x + source.width) && near(line.end.x, target.x);
  });
  t.check(
    "도착 상자가 오른쪽 열에 있는 선은 출발 상자의 오른쪽 변에서 나와 도착 상자의 왼쪽 변으로 들어간다",
    forward.length > 0 && sided.length === forward.length,
    `오른쪽 열로 가는 선 ${forward.length}개 가운데 ${sided.length}개`,
  );
  const weights = await page.evaluate((texts) => {
    const touching = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const letters = [...document.querySelectorAll(`.node-face :is(${texts})`)].map((element) => element.getBoundingClientRect());
    const all = [...document.querySelectorAll(".edge-weight")].map((element) => element.getBoundingClientRect());
    return { all: all.length, covered: all.filter((rect) => letters.some((letter) => touching(rect, letter))).length };
  }, TEXTS);
  t.check("집계 선의 숫자가 노드의 글자·배지와 겹치지 않는다", weights.all > 0 && weights.covered === 0, `숫자 ${weights.all}개 가운데 겹친 숫자 ${weights.covered}개`);

  // 마우스를 올린 선
  const { line: first, at: spot } = await hittable(page, [...leaving.filter((line) => !entries.has(ends(line)[1])), ...lines]);
  await page.mouse.move(spot.x, spot.y);
  await page.waitForSelector(".edge[data-pointed]", { timeout: 5_000 }).catch(() => {});
  const over = (await linesOf(page)).find((line) => line.key === first.key);
  const rest = (await linesOf(page)).filter((line) => line.key !== first.key);
  t.check(
    "선에 마우스를 올리면 그 선만 굵어지고 빛을 두르며 본문 잉크로 다른 선 위의 층에 그려진다",
    over.pointed && over.width > first.width && over.glow && over.tone === "strong" && over.opacity === 1 && over.layer === "5" &&
      rest.every((line) => !line.pointed && line.layer === "4" && !line.glow),
    `굵기 ${first.width} → ${over.width}, 층 ${first.layer} → ${over.layer}, 진하기 ${first.tone} → ${over.tone}`,
  );
  await t.shot();
  await page.mouse.move(spot.x, spot.y - 40);
  await page.waitForFunction(() => document.querySelector(".edge[data-pointed]") === null, null, { timeout: 5_000 }).catch(() => {});
  const back = (await linesOf(page)).find((line) => line.key === first.key);
  t.check("마우스를 떼면 굵기와 층이 돌아온다", !back.pointed && back.width === first.width && back.layer === "4", `굵기 ${back.width}, 층 ${back.layer}`);

  // 선 클릭
  const target = ends(first)[1];
  await page.mouse.click(spot.x, spot.y);
  await waitSelected(page, target).catch(() => {});
  t.check("선을 누르면 도착 노드가 선택되고 정보 패널이 그 노드를 적는다", (await selectedOf(page)) === target && (await count(page, ".info-panel-sites")) === 0, `선택 ${await selectedOf(page)}`);
  const again = await hittable(page, (await linesOf(page)).filter((line) => ends(line)[1] === target));
  if (again === null) {
    t.skip("고른 노드로 들어오는 선을 눌러도 선택이 풀리지 않는다", "화면에 누를 선이 없다");
  } else {
    await page.mouse.click(again.at.x, again.at.y);
    await settle(page);
    t.check("고른 노드로 들어오는 선을 눌러도 선택이 풀리지 않는다", (await selectedOf(page)) === target, `선택 ${await selectedOf(page)}`);
  }
  const { at: where } = await hittable(page, (await linesOf(page)).filter((line) => line.key.startsWith("agg|")));
  const chosen = await selectedOf(page);
  await page.keyboard.down("Shift");
  await page.mouse.click(where.x, where.y);
  await page.keyboard.up("Shift");
  await page.waitForSelector(".info-panel-sites", { timeout: 10_000 }).catch(() => {});
  const head = await headOf(page);
  t.check(
    "Shift를 누른 채 선을 누르면 정보 패널이 그 선의 코드 줄 목록을 열고 고른 노드의 초점은 그대로다",
    (await count(page, ".info-panel-site")) > 0 && head.includes("→") && (await selectedOf(page)) === chosen,
    `${head.replaceAll("\n", " / ").slice(0, 80)}, 코드 줄 ${await count(page, ".info-panel-site")}개`,
  );

  // 함수 시점 뷰
  await page.click(`.tree-row.tree-file[data-node="${FILE}"]`);
  await waitSelected(page, FILE);
  await clickNode(page, FUNCTION, 2);
  await page.waitForSelector(".node-call", { timeout: 30_000 });
  await settle(page);
  const calls = await linesOf(page);
  const { line: call, at: point } = await hittable(page, [...calls.filter((line) => ends(line)[0] === FUNCTION), ...calls]);
  await page.mouse.move(point.x, point.y);
  await page.waitForSelector(".edge[data-pointed]", { timeout: 5_000 }).catch(() => {});
  const pointedCall = (await linesOf(page)).find((line) => line.key === call.key);
  t.check(
    "함수 시점 뷰에서도 마우스를 올린 선이 굵어지고 다른 선 위의 층에 그려진다",
    pointedCall.pointed && pointedCall.width > call.width && pointedCall.layer === "5",
    `굵기 ${call.width} → ${pointedCall.width}, 층 ${pointedCall.layer}`,
  );
  await page.mouse.click(point.x, point.y);
  await waitSelected(page, ends(call)[1]).catch(() => {});
  t.check(
    "함수 시점 뷰에서 선을 누르면 도착 함수가 선택되고 가운데 함수는 그대로다",
    (await selectedOf(page)) === ends(call)[1] &&
      (await page.evaluate(() => document.querySelector('.node-call[data-side="center"]')?.closest(".react-flow__node")?.dataset.id)) === FUNCTION,
    `선택 ${await selectedOf(page)}`,
  );
}

async function minimap(t, page) {
  await load(page);
  const viewport = () => page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform);
  const files = (await boxes(page)).length + (await count(page, ".react-flow__node > .node-body.node-region"));
  const drawn = () => page.evaluate(() => [...document.querySelectorAll(".react-flow__minimap-node")].filter((n) => getComputedStyle(n).display !== "none").length);
  t.check(
    "레포를 열면 왼쪽 아래에 미니맵이 펼쳐져 있고 파일 상자와 폴더 영역마다 사각형 하나와 화면 영역 사각형을 그린다",
    (await count(page, ".graph-minimap")) === 1 && (await drawn()) === files && (await count(page, ".react-flow__minimap-mask")) === 1,
    `미니맵 노드 ${await drawn()}개, 파일 상자와 폴더 영역 ${files}개`,
  );
  await page.click(".legend-button");
  const [map, legend, buttons] = [await rectOf(page, ".graph-minimap"), await rectOf(page, ".legend"), await rectOf(page, ".dock-buttons")];
  const apart = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  const { panel } = await stageOf(page);
  t.check(
    "미니맵, 범례, 버튼 줄, 정보 패널이 서로 겹치지 않는다",
    apart(map, legend) && apart(map, buttons) && apart(legend, buttons) && apart(map, panel) && apart(legend, panel),
    `미니맵 ${rectText(map)}, 범례 ${rectText(legend)}, 버튼 줄 ${rectText(buttons)}`,
  );
  await page.click(".legend-button");

  await pick(page, FILE);
  const tones = await page.evaluate(() => {
    const of = (name) => document.querySelectorAll(`.react-flow__minimap-node.minimap-${name}`).length;
    return { selected: of("selected"), full: of("full"), half: of("half"), dim: of("dim") };
  });
  const dims = await page.evaluate(
    (dim) => [...document.querySelectorAll(".react-flow__node")].filter((w) => !w.dataset.id.endsWith("#face") && Number(getComputedStyle(w).opacity) <= dim).length,
    DIM,
  );
  t.check(
    "파일을 고르면 미니맵이 고른 노드 하나를 본문 잉크로, 흐린 노드를 연하게 그린다",
    tones.selected === 1 && tones.dim === dims && tones.dim > 0 && tones.full > 0,
    `고른 노드 ${tones.selected}개, 진한 노드 ${tones.full}개, 절반 ${tones.half}개, 연한 노드 ${tones.dim}개(구조 뷰의 흐린 노드 ${dims}개)`,
  );
  await t.shot();

  const [zoom, before] = [await zoomOf(page), await viewport()];
  const area = await rectOf(page, ".graph-minimap");
  await page.mouse.click(area.x + area.width * 0.8, area.y + area.height * 0.5);
  await page.waitForTimeout(700);
  await settle(page);
  t.check(
    "미니맵을 누르면 확대 비율은 그대로 두고 화면이 그 위치로 옮겨 간다",
    (await viewport()) !== before && near(await zoomOf(page), zoom, 0.001) && (await selectedOf(page)) === FILE,
    `${before} → ${await viewport()}`,
  );
  const moved = await viewport();
  await drag(page, { x: area.x + area.width * 0.5, y: area.y + area.height * 0.5 }, -30, 10);
  await settle(page);
  t.check("미니맵을 끌면 확대 비율은 그대로 두고 화면이 옮겨 간다", (await viewport()) !== moved && near(await zoomOf(page), zoom, 0.001), `${moved} → ${await viewport()}`);

  await page.click(".minimap-button");
  const closed = (await count(page, ".graph-minimap")) === 0 && (await page.getAttribute(".minimap-button", "aria-expanded")) === "false";
  await page.reload();
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  const kept = (await count(page, ".graph-minimap")) === 0;
  await page.click(".minimap-button");
  t.check(
    "미니맵 버튼으로 접고 펴며, 접은 상태를 다시 열어도 유지한다",
    closed && kept && (await count(page, ".graph-minimap")) === 1,
    `접음 ${closed}, 새로 연 뒤 접힘 ${kept}`,
  );

  await pick(page, FILE);
  await clickNode(page, FUNCTION, 2);
  await page.waitForSelector(".node-call", { timeout: 30_000 });
  await settle(page);
  t.check(
    "함수 시점 뷰에도 미니맵이 있고 가운데 함수와 양옆 함수를 그린다",
    (await count(page, ".graph-minimap")) === 1 && (await drawn()) === (await count(page, ".react-flow__node > .node-body.node-call")),
    `미니맵 노드 ${await drawn()}개, 함수 노드 ${await count(page, ".react-flow__node > .node-body.node-call")}개`,
  );
}

async function region(t, page) {
  await load(page);
  const folderId = "parser";
  const inside = (id) => id.startsWith(`${folderId}.`);
  const area = `${node(folderId)} > .node-region`;
  const members = (await boxes(page)).filter((b) => inside(b.id));
  const [outer, at] = [await rectOf(page, area), await flowBoxes(page)];
  const wraps = members.every((b) => {
    const [box, around] = [at[b.id], at[folderId]];
    return box.x >= around.x && box.y >= around.y && box.x + box.width <= around.x + around.width && box.y + box.height <= around.y + around.height;
  });
  const title = await page.evaluate((sel) => {
    const label = document.querySelector(`${sel} .node-label`);
    const [rect, around] = [label.getBoundingClientRect(), document.querySelector(sel).getBoundingClientRect()];
    // 머리 줄의 폴더 경로
    return { text: label.textContent, dx: rect.left - around.left, dy: rect.top - around.top };
  }, face(folderId));
  t.check(
    "펼친 parser/ 폴더가 안의 파일 상자를 모두 감싸는 영역을 그리고 왼쪽 위에 폴더 경로를 적는다",
    outer !== null && members.length > 0 && wraps && title.text === "parser/" && title.dx < 40 && title.dy < 40,
    `파일 상자 ${members.length}개, 이름표 "${title.text}"`,
  );
  const layer = await page.evaluate((sel) => {
    const of = (element) => Number(getComputedStyle(element.closest(".react-flow__node, svg")).zIndex);
    const others = [...document.querySelectorAll(".react-flow__node > .node-body:not(.node-region), .react-flow__edges .edge")].map(of);
    return { region: of(document.querySelector(sel)), lowest: Math.min(...others) };
  }, area);
  t.check("폴더 영역의 층이 다른 모든 노드와 선의 층보다 아래다", layer.region === 1 && layer.lowest > layer.region, `영역 ${layer.region}, 그 밖의 가장 아래층 ${layer.lowest}`);

  // 영역 위의 선은 영역이 없을 때처럼 눌린다.
  const crossing = await page.evaluate((sel) => {
    const around = document.querySelector(sel).getBoundingClientRect();
    for (const edge of document.querySelectorAll(".react-flow__edge .edge[data-key]")) {
      const line = edge.querySelector(".edge-line");
      const matrix = line.getScreenCTM();
      for (let length = 0, total = line.getTotalLength(); length <= total; length += 8) {
        const point = new DOMPoint(line.getPointAtLength(length).x, line.getPointAtLength(length).y).matrixTransform(matrix);
        const within = point.x > around.left && point.x < around.right && point.y > around.top && point.y < around.bottom;
        if (within && document.elementFromPoint(point.x, point.y)?.closest(".edge") === edge) {
          return edge.dataset.key;
        }
      }
    }
    return null;
  }, area);
  t.check("영역 위를 지나는 선의 점에서 맨 위 요소가 영역이 아니라 그 선이다", crossing !== null, `${crossing}`);

  // 영역의 빈 곳은 그래프 바탕처럼 눌리고, 머리 줄만 폴더를 접는다.
  const blank = await page.evaluate((sel) => {
    const around = document.querySelector(sel).getBoundingClientRect();
    for (let y = around.top + 40; y < around.bottom; y += 6) {
      for (let x = around.left + 6; x < around.right; x += 6) {
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) {
          return { x, y };
        }
      }
    }
    return null;
  }, area);
  const before = columnsOf(await boxes(page), inside);
  await pick(page, FILE);
  const view = await page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform);
  const spot = await page.evaluate((sel) => {
    const around = document.querySelector(sel).getBoundingClientRect();
    for (let y = around.bottom - 6; y > around.top + 40; y -= 6) {
      for (let x = around.right - 6; x > around.left; x -= 6) {
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) {
          return { x, y };
        }
      }
    }
    return null;
  }, area);
  if (spot === null) {
    t.skip("영역의 빈 곳을 누르면 폴더는 펼친 채로 선택만 풀린다", "화면에 보이는 영역에 빈 곳이 없다");
  } else {
    await page.mouse.click(spot.x, spot.y);
    await page.waitForFunction(() => document.querySelector(".react-flow__node .node-selected") === null, null, { timeout: 5_000 }).catch(() => {});
    await settle(page);
    t.check(
      "영역의 빈 곳을 누르면 폴더는 펼친 채로 선택만 풀린다",
      blank !== null && (await selectedOf(page)) === null && (await count(page, area)) === 1,
      `선택 ${await selectedOf(page)}, 영역 ${await count(page, area)}개`,
    );
    const from = await page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform);
    await drag(page, spot, 40, 30);
    await settle(page);
    t.check("영역의 빈 곳을 끌면 화면이 옮겨 간다", (await page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform)) !== from && view !== "", `${from}`);
  }
  const head = await page.evaluate((sel) => {
    const strip = document.querySelector(`${sel} .node-region-head`);
    const [rect, around] = [strip.getBoundingClientRect(), document.querySelector(sel).getBoundingClientRect()];
    // 머리 줄에서 폴더 경로 글자가 아닌 곳 가운데 화면에 보이는 가장 오른쪽 점
    const y = rect.top + rect.height / 2;
    let x = rect.right - 12;
    while (x > rect.left && document.elementFromPoint(x, y) !== strip) {
      x -= 12;
    }
    return { x, y, wide: rect.width / around.width, cursor: getComputedStyle(strip).cursor };
  }, face(folderId));
  await page.mouse.move(head.x, head.y);
  const lit = await page.evaluate((sel) => getComputedStyle(document.querySelector(`${sel} .node-region-head`)).backgroundColor, face(folderId));
  t.check(
    "폴더 영역의 머리 줄은 영역의 폭 전체이고 마우스를 올리면 손 모양 커서와 바탕색으로 누를 수 있음을 알린다",
    head.wide > 0.98 && head.cursor === "pointer" && lit !== "rgba(0, 0, 0, 0)",
    `폭 비율 ${head.wide.toFixed(2)}, 커서 ${head.cursor}, 바탕 ${lit}`,
  );
  await t.shot();
  await page.mouse.click(head.x, head.y);
  await page.waitForSelector(`${node(folderId)} > .node-package`, { timeout: 30_000 }).catch(() => {});
  await settle(page);
  const folded = await boxes(page);
  t.check(
    "폴더 영역의 머리 줄을 폴더 경로에서 떨어진 오른쪽 끝에서 눌러도 폴더가 접혀 parser/ 상자 하나가 되고 선택은 생기지 않는다",
    (await count(page, `${node(folderId)} > .node-body.node-package`)) === 1 && folded.every((b) => !inside(b.id)) && (await selectedOf(page)) === null,
    `남은 파일 상자 ${folded.length}개, 선택 ${await selectedOf(page)}`,
  );
  t.check("다른 상자의 열 순서와 열 안 순서가 같다", same(columnsOf(folded, inside), before), JSON.stringify(columnsOf(folded, inside)));
  t.check(
    "파일트리의 parser/ 행도 접힌다",
    (await count(page, '.tree-row.tree-file[data-node^="parser."]')) === 0,
    `parser/ 아래 파일 행 ${await count(page, '.tree-row.tree-file[data-node^="parser."]')}개`,
  );

  await clickNode(page, folderId);
  await page.waitForSelector(area, { timeout: 30_000 }).catch(() => {});
  await settle(page);
  t.check(
    "접힌 폴더 상자를 한 번 누르면 펼쳐져 영역과 파일 상자가 다시 나온다",
    (await count(page, area)) === 1 && (await boxes(page)).filter((b) => inside(b.id)).length === members.length && (await selectedOf(page)) === null,
    `parser/ 안 파일 상자 ${(await boxes(page)).filter((b) => inside(b.id)).length}개`,
  );
  // 정보 패널에 가리지 않은 파일 상자를 누른다.
  let file = null;
  for (const member of members) {
    if (await clickNode(page, member.id).then(() => true, () => false)) {
      file = member.id;
      break;
    }
  }
  await waitSelected(page, file);
  t.check("영역 안의 파일 상자를 누르면 그 파일이 선택되고 폴더는 펼친 채다", (await selectedOf(page)) === file && (await count(page, area)) === 1, `선택 ${await selectedOf(page)}`);
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForSelector(`${node(folderId)} > .node-body.node-package`, { timeout: 30_000 }).catch(() => {});
  t.check("Alt+← 두 번에 폴더를 접은 단계로 돌아간다", (await count(page, `${node(folderId)} > .node-body.node-package`)) === 1 && (await selectedOf(page)) === null);
}

async function folder(t, page) {
  await load(page);
  const inside = (id) => id === "parser" || id.startsWith("parser.");
  const opened = await boxes(page);
  const [before, members] = [columnsOf(opened, inside), opened.filter((b) => inside(b.id)).length];
  await page.click('.tree-row.tree-dir[data-node="parser"]');
  await page.waitForSelector(`${node("parser")} > .node-package`, { timeout: 30_000 });
  await settle(page);
  const all = await boxes(page);
  const left = all.filter((b) => inside(b.id)).map((b) => b.id);
  t.check(`parser/ 안의 파일 상자 ${members}개가 parser/ 상자 하나로 바뀐다`, members > 0 && left.length === 0 && all.length === opened.length - members, `남은 파일 상자 ${all.length}개`);
  t.check("다른 상자의 열 순서와 열 안 순서가 같다", same(columnsOf(all, inside), before), JSON.stringify(columnsOf(all, inside)));
}

async function callview(t, page) {
  await load(page);
  await pick(page, FILE);
  await clickNode(page, FUNCTION, 2);
  await page.waitForSelector(".node-call", { timeout: 30_000 });
  await settle(page);
  const centered = () => page.evaluate(() => document.querySelector('.node-call[data-side="center"]')?.closest(".react-flow__node")?.dataset.id ?? null);
  const entered = await count(page, ".node-call");
  t.check(
    "함수 노드를 더블클릭하면 그 함수를 가운데 둔 함수 시점 뷰에 들어간다",
    (await centered()) === FUNCTION && (await count(page, ".trail-view")) === 1 && (await count(page, ".node-module")) === 0,
    `노드 ${entered}개`,
  );
  await page.locator(".node-call .call-more").first().click();
  await page.waitForFunction((n) => document.querySelectorAll(".node-call").length > n, entered, { timeout: 30_000 });
  await settle(page);
  const expanded = await count(page, ".node-call");
  t.check("+를 누르면 한 단계 더 펼친다", expanded > entered, `노드 ${entered}개 → ${expanded}개`);
  const texts = await coveredTexts(page);
  t.check(
    "함수 시점 뷰의 글자와 배지 가운데 점에서 맨 위 요소가 그 노드의 글자 요소다",
    texts.seen > 0 && texts.covered.length === 0,
    `글자 ${texts.seen}개, 덮인 글자 ${texts.covered.length}개${texts.covered.length > 0 ? `: ${texts.covered.slice(0, 3).join(", ")}` : ""}`,
  );
  await t.shot();
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForFunction((n) => document.querySelectorAll(".node-call").length === n, entered, { timeout: 30_000 }).catch(() => {});
  await settle(page);
  t.check("Alt+← 한 번에 펼치기 전의 함수 시점 뷰로 돌아간다", (await count(page, ".node-call")) === entered && (await count(page, ".trail-view")) === 1, `노드 ${await count(page, ".node-call")}개`);
  await page.keyboard.press("Alt+ArrowLeft");
  await waitSelected(page, FILE).catch(() => {});
  t.check(
    "Alt+← 두 번에 더블클릭하기 전의 구조 뷰(arbiter.py 선택)로 돌아온다",
    (await selectedOf(page)) === FILE && (await count(page, ".trail-view")) === 0 && (await count(page, ".node-call")) === 0,
    `선택 ${await selectedOf(page)}`,
  );

  // 이미 고른 함수를 더블클릭한 뒤 뒤로 가면 그 함수를 고른 구조 뷰로 돌아온다.
  await pick(page, FUNCTION);
  await clickNode(page, FUNCTION, 2);
  await page.waitForSelector(".node-call", { timeout: 30_000 });
  await settle(page);
  await page.getByRole("button", { name: "뒤로" }).click();
  await waitSelected(page, FUNCTION).catch(() => {});
  t.check(
    "고른 함수를 더블클릭해 들어간 함수 시점 뷰에서 뒤로 한 번에 그 함수를 고른 구조 뷰로 돌아온다",
    (await selectedOf(page)) === FUNCTION && (await count(page, ".node-call")) === 0,
    `선택 ${await selectedOf(page)}`,
  );
}

async function search(t, page) {
  await load(page);
  await page.keyboard.press(`${MOD}+p`);
  await page.waitForSelector(".palette-input", { timeout: 5_000 });
  await page.keyboard.type("rns");
  await page.waitForSelector(".palette-option");
  const first = await page.evaluate(() => document.querySelector(".palette-option")?.dataset.node ?? null);
  await t.shot();
  await page.keyboard.press("Enter");
  await waitSelected(page, FUNCTION).catch(() => {});
  const pressed = await page.evaluate(() => window.__shotsKeys.find((key) => key.key.toLowerCase() === "p" && key.mod));
  t.check("Mod+P의 keydown이 preventDefault되어 인쇄 창이 뜨지 않는다", pressed?.prevented === true, JSON.stringify(pressed ?? null));
  t.check(
    "_rebuild_note_sections가 선택되고 팔레트가 닫힌다",
    first === FUNCTION && (await selectedOf(page)) === FUNCTION && (await count(page, ".palette")) === 0,
    `첫 결과 ${first}, 선택 ${await selectedOf(page)}`,
  );
}

async function zoom(t, page) {
  await load(page);
  await page.click('.tree-row.tree-file[data-node="parser.plan"]');
  await waitSelected(page, "parser.plan");
  const seen = [];
  for (const target of [0.3, 0.6, 1.0]) {
    const got = await zoomTo(page, target);
    seen.push({
      target,
      got,
      ...(await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".node-table-row")];
        return {
          band: document.querySelector(".graph").dataset.zoom,
          rows: rows.length,
          visible: rows.filter((row) => getComputedStyle(row).visibility === "visible").length,
        };
      })),
    });
  }
  const text = seen.map((s) => `${s.got.toFixed(2)}에서 ${s.visible}/${s.rows}칸`).join(", ");
  t.check(
    "데이터 클래스 필드 칸이 0.3과 0.6에서 숨고 1.0에서 보인다",
    seen.every((s) => near(s.got, s.target, 0.01) && s.rows > 0) && seen[0].visible === 0 && seen[1].visible === 0 && seen[2].visible === seen[2].rows,
    text,
  );
  t.check("확대 비율 구간 data-zoom이 0, 1, 2로 바뀐다", same(seen.map((s) => s.band), ["0", "1", "2"]), seen.map((s) => s.band).join(", "));
}

/** 테스트 코드를 켜고 파일을 하나씩 펼쳐, 화면에 보이는 모든 글자와 배지의 가운데 점에서 그 노드가 눌리는지 센다. */
async function labels(t, page) {
  await load(page);
  const graph = await api("/api/graph");
  const files = graph.nodes.filter((n) => n.kind === "module").map((n) => n.id);
  const classes = new Set(graph.nodes.filter((n) => n.kind === "class").map((n) => n.id));
  await page.getByLabel("테스트 코드").check();
  await settle(page);
  // 레포를 열 때 접혀 있는 폴더를 파일트리에서 모두 펼쳐 파일 행을 낸다.
  for (let closed = page.locator('.tree-row.tree-dir[aria-expanded="false"]'); (await closed.count()) > 0; ) {
    await closed.first().click();
    await settle(page);
  }
  const total = { files: 0, seen: 0, classes: 0, covered: [], blocked: [] };
  let layers = null;
  for (const id of files) {
    const row = `.tree-row.tree-file[data-node="${id}"]`;
    if ((await count(page, row)) === 0) {
      continue;
    }
    await page.click(row);
    await waitSelected(page, id);
    const found = await coveredTexts(page);
    total.files += 1;
    total.seen += found.seen;
    total.covered.push(...found.covered);
    if (found.covered.length > 0) {
      total.blocked.push(id);
    }
    // 클래스가 든 파일 가운데 처음 만난 파일의 화면을 남긴다.
    const shown = await page.evaluate(() => [...document.querySelectorAll(".node-body.node-class")].map((root) => root.closest(".react-flow__node").dataset.id));
    if (total.classes === 0 && shown.some((shownId) => classes.has(shownId))) {
      await t.shot();
      layers = await page.evaluate(() => {
        const of = (selector) =>
          [...new Set([...document.querySelectorAll(selector)].map((element) => getComputedStyle(element.closest(".react-flow__node, svg")).zIndex))].sort().join("·");
        return [
          of(".react-flow__node > .node-body:is(.node-module, .node-package)"),
          of(".react-flow__node > .node-body:is(.node-class, .node-dataclass)"),
          of(".react-flow__edges .edge"),
          of(".react-flow__node > .node-body:is(.node-function, .node-external)"),
          of(".react-flow__node > .node-face"),
        ];
      });
    }
    total.classes += shown.length;
  }
  t.check(
    `파일 ${files.length}개를 차례로 펼쳤을 때 글자와 배지 가운데 점의 맨 위 요소가 모두 그 노드의 글자 요소다`,
    total.files === files.length && total.seen > 0 && total.covered.length === 0,
    `펼친 파일 ${total.files}개, 글자 ${total.seen}개, 덮인 글자 ${total.covered.length}개(파일 ${total.blocked.length}개)${total.covered.length > 0 ? `: ${total.covered.slice(0, 3).join(", ")}` : ""}`,
  );
  t.check("클래스 노드가 든 화면을 하나 이상 확인했다", total.classes > 0, `클래스 노드 ${total.classes}개`);
  t.check(
    "상자, 클래스, 선, 함수 원, 글자의 z-index가 2, 3, 4, 6, 7이다",
    same(layers, ["2", "3", "4", "6", "7"]),
    JSON.stringify(layers),
  );
}

async function external(t, page) {
  await load(page);
  await page.getByLabel("외부 노드").check();
  await page.waitForSelector(".node-external", { timeout: 30_000 }).catch(() => {});
  await settle(page);
  const pills = await page.evaluate(() =>
    [...document.querySelectorAll(".node-external")].map((pill) => ({
      radius: parseFloat(getComputedStyle(pill).borderTopLeftRadius),
      height: pill.offsetHeight,
    })),
  );
  t.check("알약 모양 노드가 나타난다", pills.length > 0 && pills.every((p) => p.radius * 2 >= p.height), `${pills.length}개, 모서리 반지름 ${pills[0]?.radius}px, 높이 ${pills[0]?.height}px`);
}

async function dark(t, page) {
  await load(page);
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const [surface, ink] = [await colorOf(page, "--surface"), await colorOf(page, "--ink")];
  const background = await page.evaluate(() => getComputedStyle(document.querySelector(".graph")).backgroundColor);
  t.check(
    "어두운 화면 색 값으로 그려진다",
    surface.value === DARK.surface && ink.value === DARK.ink && [surface.rgb, "rgba(0, 0, 0, 0)"].includes(background),
    `--surface ${surface.value}, --ink ${ink.value}, 그래프 바탕 ${background}`,
  );
  await focused(t, page);
}

async function tree(t, page) {
  await load(page);
  await page.click(`.tree-row.tree-file[data-node="${FILE}"]`);
  await page.waitForSelector(".tree-row.tree-symbol", { timeout: 10_000 });
  await waitSelected(page, FILE);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll(".tree .tree-row")].map((row) => {
      const indent = row.querySelector(".tree-indent");
      return {
        kind: ["dir", "file", "symbol"].find((kind) => row.classList.contains(`tree-${kind}`)),
        node: row.dataset.node ?? null,
        expandable: row.hasAttribute("aria-expanded"),
        icon: row.querySelector("svg.tree-icon") !== null,
        chevron: row.querySelector(".tree-toggle svg.tree-chevron") !== null,
        toggle: row.querySelector(".tree-toggle")?.getBoundingClientRect().width ?? 0,
        indent: indent?.getBoundingClientRect().width ?? 0,
        guide: indent === null ? "" : getComputedStyle(indent).backgroundImage,
      };
    }),
  );
  const kinds = (kind) => rows.filter((row) => row.kind === kind);
  t.check(
    "폴더·파일·함수 행에 종류 기호가 있다",
    kinds("dir").length > 0 && kinds("file").length > 0 && kinds("symbol").length > 0 && rows.every((row) => row.icon),
    `폴더 ${kinds("dir").length}행, 파일 ${kinds("file").length}행, 함수 ${kinds("symbol").length}행`,
  );
  t.check(
    "펼 수 있는 행(폴더, 클래스·함수가 있는 파일)에만 펼침 화살표가 있고 그 밖의 행은 같은 폭을 비운다",
    rows.every((row) => row.chevron === row.expandable && near(row.toggle, rows[0].toggle, 0.5)) && kinds("dir").every((row) => row.chevron),
    `화살표 ${rows.filter((row) => row.chevron).length}행, 화살표 칸 폭 ${rows[0].toggle}px`,
  );
  const at = rows.findIndex((row) => row.kind === "file" && row.node === FILE);
  const below = rows.slice(at + 1, at + 1 + kinds("symbol").length);
  const defined = definedIn(await api("/api/graph"), FILE).length;
  t.check(
    `함수 행 ${defined}개가 arbiter.py 행 바로 아래에서 한 단계 더 들여쓴 안내선 아래에 있다`,
    defined > 0 && below.length === defined && below.every((row) => row.kind === "symbol" && near(row.indent, rows[at].indent + 14, 0.5) && row.guide.includes("gradient")),
    `함수 행 ${below.length}개, 들여쓰기 ${rows[at].indent}px → ${below[0]?.indent}px`,
  );
}

async function treeSearch(t, page) {
  await load(page);
  await page.fill(".tree-search-input", "rebuild");
  await page.waitForSelector(".tree-result", { timeout: 10_000 });
  const found = await page.evaluate(() => [...document.querySelectorAll(".tree-result")].map((row) => row.dataset.node));
  t.check("결과 목록이 파일트리 대신 나온다", found.length > 0 && (await count(page, "ul.tree")) === 0, `결과 ${found.length}행, 첫 결과 ${found[0]}`);
  await page.click(".tree-result");
  await waitSelected(page, found[0]).catch(() => {});
  t.check("첫 결과를 누르면 그래프가 그 노드를 선택하고 결과 목록이 남는다", (await selectedOf(page)) === found[0] && (await count(page, ".tree-result")) === found.length, `선택 ${await selectedOf(page)}`);
  await t.shot();
  await page.keyboard.press("Escape");
  await page.waitForSelector("ul.tree", { timeout: 10_000 }).catch(() => {});
  await settle(page);
  const active = await page.evaluate(() => document.querySelector(".tree .tree-row.active")?.dataset.node ?? null);
  t.check(
    "결과 행을 누른 뒤의 Esc에 질의가 비워져 파일트리가 돌아오고 선택은 그대로다",
    (await page.inputValue(".tree-search-input")) === "" && (await count(page, "ul.tree")) === 1 && (await selectedOf(page)) === found[0] && active === found[0],
    `선택 ${await selectedOf(page)}, 파일트리의 고른 행 ${active}`,
  );
}

/** `git status --porcelain`의 두 글자를 서버와 같은 규칙으로 상태로 바꾼다. 커밋에도 디스크에도 없는 파일은 null이다. */
function stateOf(index, worktree) {
  if (worktree === "D") {
    return index === "A" ? null : "deleted";
  }
  if (index === "D") {
    return "deleted";
  }
  return index === "A" || index === "?" ? "added" : "modified";
}

async function changes(t, page) {
  const [repo, reply, graph] = [await api("/api/repo"), await api("/api/changes"), await api("/api/graph")];
  // 대상 레포의 인덱스를 다시 쓰지 않는 읽기 전용 호출만 한다.
  const git = (...args) =>
    execFileSync("git", ["-C", repo.root, "-c", "core.quotepath=false", "-c", "diff.autoRefreshIndex=false", ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8",
    });
  const prefix = git("rev-parse", "--show-prefix").trim();
  const modified = git("status", "--porcelain", "--untracked-files=all", "--no-renames", "--", ".")
    .split("\n")
    .filter((line) => line.endsWith(".py") && stateOf(line[0], line[1]) === "modified")
    .map((line) => line.slice(3).slice(prefix.length))
    .sort();
  const served = reply.files.filter((f) => f.status === "modified").map((f) => f.path).sort();
  if (modified.length === 0) {
    for (const label of [
      "/api/changes의 수정 파일이 git status --porcelain의 수정 .py 파일과 같다",
      'git이 수정으로 내는 .py 파일과 같은 수의 파일 상자에 [data-change="modified"]와 M이 있다',
      "파일트리의 같은 행에 수정 색 점과 M이 있다",
      "수정 파일을 펼치면 git diff -U0 HEAD의 바뀐 줄과 겹치는 함수만 표시된다",
    ]) {
      t.skip(label, "대상 레포에 수정한 .py 파일이 없다");
    }
    t.check("수정 파일이 없으면 /api/changes도 수정 파일을 내지 않는다", served.length === 0, `서버 ${served.length}개`);
    return;
  }
  t.check(
    "/api/changes의 수정 파일이 git status --porcelain의 수정 .py 파일과 같다",
    same(served, modified),
    `git ${modified.length}개, 서버 ${served.length}개`,
  );

  await load(page);
  const pathOf = new Map(graph.nodes.map((n) => [n.id, n.path]));
  const boxed = (await boxes(page)).filter((b) => b.change === "modified");
  t.check(
    `git이 수정으로 내는 .py 파일과 같은 수(${modified.length}개)의 파일 상자에 [data-change="modified"]와 M이 있다`,
    same(boxed.map((b) => pathOf.get(b.id)).sort(), modified) && boxed.every((b) => b.mark === "M"),
    boxed.map((b) => b.label).join(", "),
  );
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.tree .tree-row.tree-file .tree-change[data-change="modified"]')].map((mark) => ({
      node: mark.closest(".tree-row").dataset.node,
      letter: mark.textContent,
      dot: getComputedStyle(mark, "::before").backgroundColor,
    })),
  );
  const changed = (await colorOf(page, "--changed")).rgb;
  t.check(
    "파일트리의 같은 행에 수정 색 점과 M이 있다",
    same(rows.map((row) => pathOf.get(row.node)).sort(), modified) && rows.every((row) => row.letter === "M" && row.dot === changed),
    `${rows.length}행, 점 색 ${[...new Set(rows.map((row) => row.dot))].join("·")}`,
  );

  // 수정 파일 가운데 바뀐 줄이 함수·클래스의 줄 범위와 겹치는 파일을 펼쳐 그 노드만 표시되는지 본다.
  let target = null;
  for (const box of boxed) {
    const path = pathOf.get(box.id);
    const hunks = [...git("diff", "-U0", "--relative", "--no-renames", "HEAD", "--", path).matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)].map(
      ([, start, length]) => [Number(start), Number(start) + Math.max(Number(length ?? 1), 1) - 1],
    );
    const want = graph.nodes
      .filter((n) => n.path === path && ["function", "method", "class", "dataclass"].includes(n.kind) && n.range !== null)
      .filter((n) => hunks.some(([from, to]) => n.range[0] <= to && from <= n.range[1]))
      .map((n) => n.id)
      .sort();
    if (want.length > 0 && (target === null || box.id === FILE)) {
      target = { id: box.id, path, hunks, want };
    }
  }
  if (target === null) {
    t.check("바뀐 줄이 함수·클래스와 겹치는 수정 파일이 있다", false, `수정 파일 ${boxed.length}개`);
    return;
  }
  await pick(page, target.id);
  const marked = await page.evaluate(
    (file) =>
      [...document.querySelectorAll(".react-flow__node > .node-body[data-change]")]
        .map((root) => root.closest(".react-flow__node").dataset.id)
        .filter((id) => id.startsWith(`${file}:`))
        .sort(),
    target.id,
  );
  t.check(
    `${target.path} 상자를 펼치면 git diff -U0 HEAD의 바뀐 줄과 겹치는 함수만 표시된다`,
    same(marked, target.want),
    `바뀐 줄 ${target.hunks.map(([from, to]) => `${from}~${to}`).join(", ")}, 표시 ${marked.join(", ") || "없음"}`,
  );
}

async function zoomKeep(t, page) {
  await load(page);
  await pick(page, FILE);
  const small = await zoomTo(page, 0.5);
  await pick(page, "arbiter:_html_report");
  const raised = await zoomOf(page);
  t.check("휠로 0.5까지 줄인 뒤 함수를 고르면 확대 비율이 0.8이 된다", near(small, 0.5, 0.01) && near(raised, NAMED_ZOOM, 0.001), `${small.toFixed(3)} → ${raised.toFixed(3)}`);
  const large = await zoomTo(page, 1.2);
  // 이름표 가운데가 화면에 보이는 다른 함수를 고른다.
  const other = await page.evaluate(() => {
    for (const label of document.querySelectorAll(".node-face.node-function .node-label")) {
      const wrapper = label.closest(".react-flow__node");
      const rect = label.getBoundingClientRect();
      if (wrapper.querySelector(".node-selected") === null && wrapper.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))) {
        return wrapper.dataset.id.replace(/#face$/, "");
      }
    }
    return null;
  });
  await pick(page, other);
  const kept = await zoomOf(page);
  t.check("1.2로 키운 뒤 다른 함수를 고르면 확대 비율이 그대로다", near(large, 1.2, 0.01) && near(kept, large, 0.001), `${large.toFixed(3)} → ${kept.toFixed(3)}`);
}

/** GET은 캐시만 읽으므로 요약을 만들지 않고 캐시에 요약이 없는 함수를 want개까지 찾는다. */
async function uncached(want) {
  const graph = await api("/api/graph");
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const found = [];
  let status = null;
  for (const candidate of graph.nodes.filter((n) => n.kind === "function" && !n.test)) {
    status = await api(`/api/summary?node=${encodeURIComponent(candidate.id)}`);
    if (status.summary === null) {
      let owner = candidate;
      while (owner.kind !== "module" && owner.parent !== null) {
        owner = nodes.get(owner.parent);
      }
      found.push({ id: candidate.id, owner: owner.id });
      if (found.length === want) {
        break;
      }
    }
  }
  return { found, available: status?.available === true, reason: status?.reason ?? null };
}

/** 이 페이지가 보낸 POST /api/summary의 노드 id를 차례로 담는 배열 */
function summaryPosts(page) {
  const posts = [];
  page.on("request", (request) => {
    const at = new URL(request.url());
    if (at.pathname === "/api/summary" && request.method() === "POST") {
      posts.push(at.searchParams.get("node"));
    }
  });
  return posts;
}

/** 이 페이지가 끊은 POST /api/summary의 노드 id를 차례로 담는 배열 */
function summaryAborts(page) {
  const aborted = [];
  page.on("requestfailed", (request) => {
    const at = new URL(request.url());
    if (at.pathname === "/api/summary" && request.method() === "POST") {
      aborted.push(at.searchParams.get("node"));
    }
  });
  return aborted;
}

/** 파일트리에서 파일을 펼친 뒤 그 안의 함수 행을 눌러 고른다. */
async function pickInTree(page, target) {
  await page.click(`.tree-row.tree-file[data-node="${target.owner}"]`);
  await page.waitForSelector(`.tree-row.tree-symbol[data-node="${target.id}"]`, { timeout: 10_000 });
  await page.click(`.tree-row.tree-symbol[data-node="${target.id}"]`);
  await waitSelected(page, target.id);
}

const summaryHint = (page) => page.evaluate(() => document.querySelector(".info-panel-summary .info-panel-hint")?.textContent ?? "");

/** 요약 세 부분을 문단 count개씩으로 채운 글 */
function longSummary(count) {
  const paragraph = "주문 목록을 받아 품목마다 수량을 더하고, 수량이 0인 품목을 뺀 뒤 품목 이름순으로 정렬한 표를 만든다. ".repeat(3).trim();
  const body = Array.from({ length: count }, () => paragraph).join("\n");
  return `주문 목록을 받아 품목별 수량을 더한 표를 돌려준다.\n\n하는 일\n${body}\n\n앞뒤 흐름\n${body}`;
}

/** GET /api/summary에 서버 대신 답한다. reply는 노드 id를 받아 응답 본문을 돌려준다. */
async function answerSummaryReads(page, reply) {
  await page.route(
    (at) => at.pathname === "/api/summary",
    (route) => {
      const request = route.request();
      if (request.method() !== "GET") {
        return route.fallback();
      }
      return route.fulfill({ json: reply(new URL(request.url()).searchParams.get("node")) });
    },
  );
}

/** 요약을 만들지 않고 서버 대신 답해 요약 칸의 크기를 본다. */
async function summaryPanel(t, page) {
  await answerSummaryReads(page, () => ({ summary: longSummary(6), stale: false, available: true, reason: null }));
  await load(page);
  await pick(page, FILE);
  await pick(page, FUNCTION);
  await page.waitForSelector(".info-panel .monaco-editor .line-numbers", { timeout: 30_000 });
  await page.waitForSelector(".info-panel-summary .summary-text", { timeout: 10_000 });
  const [panel, summary, code] = [await rectOf(page, ".info-panel"), await rectOf(page, ".info-panel-summary"), await rectOf(page, ".info-panel .code")];
  const scrolls = await page.evaluate(() => {
    const box = document.querySelector(".info-panel-summary");
    return box.scrollHeight > box.clientHeight + 1 && getComputedStyle(box).overflowY === "auto";
  });
  t.check(
    "긴 요약이 있어도 LLM 요약 칸의 높이가 패널 높이의 4분의 1이고 넘치는 글은 칸 안에서 스크롤한다",
    near(summary.height, panel.height / 4, 1.5) && scrolls && near(code.y + code.height, panel.y + panel.height - 1),
    `패널 ${panel.height.toFixed(0)}, 요약 칸 ${summary.height.toFixed(1)}, 코드 뷰어 ${code.height.toFixed(0)}`,
  );
  await drag(page, center(await rectOf(page, '.info-panel-resize[data-dir="s"]')), 0, -300);
  await page.waitForTimeout(300);
  const [smaller, shrunk] = [await rectOf(page, ".info-panel"), await rectOf(page, ".info-panel-summary")];
  t.check(
    "패널의 높이를 줄이면 요약 칸의 높이도 패널 높이의 4분의 1로 줄어든다",
    smaller.height < panel.height - 100 && near(shrunk.height, smaller.height / 4, 1.5),
    `패널 ${smaller.height.toFixed(0)}, 요약 칸 ${shrunk.height.toFixed(1)}`,
  );
}

/**
 * POST /api/summary를 서버로 보내지 않고 붙잡아 둔다. 돌려준 배열의 항목마다 노드 id와, 요약으로 답하는 answer가 있다.
 */
async function holdSummaryPosts(page) {
  const held = [];
  await page.route(
    (at) => at.pathname === "/api/summary",
    (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        return route.fallback();
      }
      held.push({ node: new URL(request.url()).searchParams.get("node"), answer: (summary) => route.fulfill({ json: { summary } }) });
    },
  );
  return held;
}

/** 요약을 만들지 않고 서버 대신 답해, 요약을 만드는 동안 다른 노드를 고르고 폴더를 접어도 요청이 끝까지 가는지 본다. */
async function summaryBusy(t, page) {
  // 폴더 안에 있는 파일의 함수 하나와 미확인 호출이 있는 파일의 함수 하나를 고른다.
  const graph = await api("/api/graph");
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ownerOf = (n) => (n.kind === "module" || n.parent === null ? n : ownerOf(byId.get(n.parent)));
  const functions = graph.nodes.filter((n) => n.kind === "function" && !n.test && n.id !== FUNCTION && ownerOf(n).id !== FILE);
  const unresolved = new Set(graph.nodes.filter((n) => n.unresolved > 0).map((n) => ownerOf(n).id));
  const chosen = functions.find((n) => ownerOf(n).parent !== null) ?? functions[0];
  const target = { id: chosen.id, owner: ownerOf(chosen).id };
  const folderId = ownerOf(chosen).parent;
  const counted = functions.find((n) => unresolved.has(ownerOf(n).id) && ownerOf(n).id !== target.owner);
  const extra = counted === undefined ? null : { id: counted.id, owner: ownerOf(counted).id };
  await answerSummaryReads(page, () => ({ summary: null, stale: false, available: true, reason: null }));
  const held = await holdSummaryPosts(page);
  const aborted = summaryAborts(page);
  const busy = (id) => count(page, `${face(id)} .badge-busy`);
  await load(page);
  await pickInTree(page, target);
  await page.waitForSelector(".info-panel-summary .summary-make", { timeout: 10_000 });
  await page.click(".info-panel-summary .summary-make");
  await page.waitForSelector(`${face(target.id)} .badge-busy`, { timeout: 5_000 }).catch(() => {});
  const spinning = await page.evaluate((sel) => {
    const badge = document.querySelector(sel);
    const [rect, circle] = [badge.getBoundingClientRect(), badge.closest(".node-circle").getBoundingClientRect()];
    return { animated: getComputedStyle(badge).animationName !== "none", right: rect.right - circle.right, above: circle.top - rect.top };
  }, `${face(target.id)} .badge-busy`);
  t.check(
    '"요약 생성"을 누르면 그 함수의 원 오른쪽 위 모서리에 도는 원이 붙는다',
    held.length === 1 && (await busy(target.id)) === 1 && spinning.animated && spinning.right > 0 && spinning.above > 0,
    `POST ${held.length}번, 원 오른쪽으로 ${spinning.right.toFixed(1)}px, 위로 ${spinning.above.toFixed(1)}px`,
  );
  await t.shot();

  // 다른 파일의 함수를 고르면 요약을 만들던 함수가 화면에서 사라지고 그 함수가 든 파일 상자가 배지를 단다.
  await pickInTree(page, { id: FUNCTION, owner: FILE });
  await page.waitForSelector(`${face(target.owner)} .badge-busy`, { timeout: 5_000 }).catch(() => {});
  t.check(
    "다른 파일의 함수를 골라도 요청을 끊지 않고, 접힌 파일 상자의 오른쪽 위에 도는 원이 붙는다",
    aborted.length === 0 && (await count(page, node(target.id))) === 0 && (await busy(target.owner)) === 1,
    `끊은 POST ${aborted.length}번, ${target.owner} 상자의 도는 원 ${await busy(target.owner)}개`,
  );
  if (folderId === null) {
    t.skip("그 파일이 든 폴더를 접으면 접힌 폴더 상자의 오른쪽 위에 도는 원이 붙는다", `${target.owner}가 폴더 안에 있지 않다`);
  } else {
    const row = `.tree-row.tree-dir[data-node="${folderId}"]`;
    await page.click(row);
    await page.waitForSelector(`${node(folderId)} > .node-body.node-package`, { timeout: 30_000 });
    await settle(page);
    t.check("그 파일이 든 폴더를 접으면 접힌 폴더 상자의 오른쪽 위에 도는 원이 붙는다", (await busy(folderId)) === 1 && aborted.length === 0, `${folderId}/ 상자의 도는 원 ${await busy(folderId)}개`);
    await page.click(row);
    await page.waitForSelector(`.tree-row.tree-file[data-node="${target.owner}"]`, { timeout: 10_000 });
  }

  if (extra === null) {
    t.skip("도는 원이 미확인 호출 수 배지의 왼쪽에 3px 띄워 나란히 놓인다", "미확인 호출이 있는 파일이 없다");
  } else {
    await pickInTree(page, extra);
    await page.click(".info-panel-summary .summary-make");
    await pickInTree(page, { id: FUNCTION, owner: FILE });
    await page.waitForSelector(`${face(extra.owner)} .badge-busy`, { timeout: 5_000 }).catch(() => {});
    const beside = await page.evaluate((sel) => {
      const row = document.querySelector(sel)?.closest(".badges");
      const [spin, mark] = [row?.querySelector(".badge-busy"), row?.querySelector(".badge-unresolved")];
      return spin == null || mark == null ? null : { gap: mark.offsetLeft - spin.offsetLeft - spin.offsetWidth, level: mark.offsetTop - spin.offsetTop };
    }, `${face(extra.owner)} .badge-busy`);
    t.check(
      "도는 원이 미확인 호출 수 배지의 왼쪽에 3px 띄워 나란히 놓인다",
      beside !== null && beside.gap === 3 && beside.level === 0 && (await count(page, ".badge-busy")) === 2,
      beside === null ? "배지가 없다" : `사이 ${beside.gap}px, 도는 원 ${await count(page, ".badge-busy")}개`,
    );
    held[1].answer(longSummary(1));
  }
  held[0].answer(longSummary(1));
  await page.waitForFunction(() => document.querySelector(".badge-busy") === null, null, { timeout: 5_000 }).catch(() => {});
  t.check("요약이 다 만들어지면 도는 원이 사라진다", (await count(page, ".badge-busy")) === 0);
  await pickInTree(page, target);
  await page.waitForSelector(".info-panel-summary .summary-text", { timeout: 5_000 }).catch(() => {});
  t.check(
    "그 함수를 다시 고르면 POST를 다시 보내지 않고 만들어 둔 요약을 보인다",
    held.length === (extra === null ? 1 : 2) && (await count(page, ".info-panel-summary .summary-text")) === 1,
    `POST ${held.length}번`,
  );
}

/**
 * 코드 범위 설명의 세 엔드포인트에 서버 대신 답한다. 만든 설명은 saved에 두어 페이지를 새로 열어도 남고,
 * POST는 held에 붙잡아 두었다가 answer를 부르면 답한다.
 */
async function answerExplanations(page) {
  const state = { saved: [], held: [] };
  const same = (a, b) => a.path === b.path && a.start === b.start && a.end === b.end;
  await page.route(
    (at) => at.pathname === "/api/explanations" || at.pathname === "/api/explanation",
    (route) => {
      const request = route.request();
      const query = new URL(request.url()).searchParams;
      const span = { path: query.get("path"), start: Number(query.get("start")), end: Number(query.get("end")) };
      if (request.method() === "GET") {
        return route.fulfill({ json: { explanations: state.saved.filter((e) => e.path === span.path).map(({ path, ...rest }) => rest) } });
      }
      if (request.method() === "DELETE") {
        state.saved = state.saved.filter((e) => !same(e, span));
        return route.fulfill({ json: { deleted: true } });
      }
      state.held.push({
        ...span,
        answer: (text) => {
          state.saved = [...state.saved.filter((e) => !same(e, span)), { ...span, text, stale: false }];
          return route.fulfill({ json: { start: span.start, end: span.end, text, stale: false } });
        },
      });
    },
  );
  return state;
}

/** 코드 뷰어의 n번째 줄(1부터)의 화면 사각형 */
const codeLine = (page, n) =>
  page.evaluate((index) => {
    const lines = [...document.querySelectorAll(".info-panel .monaco-editor .view-line")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const rect = lines[index - 1]?.getBoundingClientRect();
    return rect === undefined ? null : { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, n);

/** 설명을 만들지 않고 서버 대신 답해, 고른 코드 범위의 설명 창과 말풍선 표지를 본다. */
async function explain(t, page) {
  const notes = await answerExplanations(page);
  const text = "오늘 날짜의 할 일을 `note_common.py::extract_today_items`로 모은다.\n모은 항목을 줄마다 하나씩 적는다.";
  const open = async () => {
    await pickInTree(page, { id: FUNCTION, owner: FILE });
    await page.waitForSelector(".info-panel .monaco-editor .view-line", { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll(".info-panel .monaco-editor .view-line").length > 8);
  };
  await load(page);
  await open();
  const from = spanOf(await api("/api/graph"), FUNCTION).from;
  t.check("범위를 고르기 전에는 버튼, 창, 표지가 없다", (await count(page, ".code-explain, .code-note-window, .code-note-glyph")) === 0);

  // 코드 뷰어의 3번째 줄 머리부터 5번째 줄 끝까지 끌어 고른다.
  const [third, fifth] = [await codeLine(page, 3), await codeLine(page, 5)];
  await page.mouse.move(third.x + 2, third.y + third.height / 2);
  await page.mouse.down();
  await page.mouse.move(fifth.x + 200, fifth.y + fifth.height / 2, { steps: 6 });
  t.check("끄는 동안에는 버튼이 뜨지 않는다", (await count(page, ".code-explain")) === 0);
  await page.mouse.up();
  await page.waitForSelector(".code-explain", { timeout: 5_000 }).catch(() => {});
  const button = await rectOf(page, ".code-explain");
  t.check(
    '범위를 끌어 고르면 고른 끝 아래에 "요약 생성" 버튼이 뜬다',
    button !== null && (await page.textContent(".code-explain")) === "요약 생성" && button.y >= fifth.y + fifth.height - 2 && button.y < fifth.y + 3 * fifth.height,
    button === null ? "버튼 없음" : `버튼 위 ${button.y.toFixed(0)}, 5번째 줄 아래 ${(fifth.y + fifth.height).toFixed(0)}`,
  );
  await page.click(".code-explain");
  await page.waitForSelector(".code-note-window", { timeout: 5_000 }).catch(() => {});
  await page.waitForSelector(".code-note-glyph", { timeout: 5_000 }).catch(() => {});
  const asked = notes.held[0];
  t.check(
    `버튼을 누르면 ${from + 2}~${from + 4}줄의 POST를 한 번 보내고 범위 아래 창에 "설명을 만드는 중"을 보이며 버튼은 사라진다`,
    notes.held.length === 1 && asked.start === from + 2 && asked.end === from + 4 &&
      (await page.textContent(".code-note-window .info-panel-hint")) === "설명을 만드는 중" &&
      (await page.textContent(".code-note-window .info-panel-label")).replace(/\s/g, "") === `${from + 2}~${from + 4}줄설명` &&
      (await count(page, ".code-explain")) === 0 && (await count(page, ".code-note-glyph.code-note-making")) === 1,
    `POST ${notes.held.map((h) => `${h.start}~${h.end}`).join(", ")}`,
  );
  const [box, code] = [await rectOf(page, ".code-note-window"), await rectOf(page, ".info-panel .code")];
  t.check(
    "창이 고른 범위의 끝 줄 아래에 뜨고 코드 뷰어 안에 든다",
    box.y >= fifth.y + fifth.height - 2 && box.x >= code.x && box.x + box.width <= code.x + code.width && box.y + box.height <= code.y + code.height,
    `창 ${rectText(box)}, 코드 뷰어 ${rectText(code)}`,
  );

  // 다른 함수로 나갔다 와도 요청은 이어진다.
  await pickInTree(page, { id: "arbiter:_html_report", owner: FILE });
  await asked.answer(text);
  await open();
  await page.waitForSelector(".code-note-glyph:not(.code-note-making)", { timeout: 5_000 }).catch(() => {});
  t.check(
    "다른 함수를 골랐다 돌아오면 창은 접혀 있고 범위 시작 줄에 말풍선 표지가 있다",
    (await count(page, ".code-note-window")) === 0 && (await count(page, ".code-note-glyph")) === 1 && notes.held.length === 1,
    `표지 ${await count(page, ".code-note-glyph")}개`,
  );
  const glyph = await rectOf(page, ".code-note-glyph");
  const startLine = await codeLine(page, 3);
  await page.mouse.click(glyph.x + glyph.width / 2, glyph.y + glyph.height / 2);
  await page.waitForSelector(".code-note-window .summary-text", { timeout: 5_000 }).catch(() => {});
  const shownText = await page.evaluate(() => [...document.querySelectorAll(".code-note-window .summary-text p")].map((p) => p.textContent).join("\n"));
  t.check(
    "표지가 범위 시작 줄에 있고, 누르면 만든 설명이 문단 둘로 뜨며 정의 표기는 누를 수 있다",
    near(glyph.y + glyph.height / 2, startLine.y + startLine.height / 2, 3) && shownText === text.replaceAll("`", "") &&
      (await count(page, '.code-note-window .summary-ref[data-node="note_common:extract_today_items"]')) === 1,
    shownText.replaceAll("\n", " / "),
  );
  await t.shot();
  await page.click(".code-note-fold");
  const folded = (await count(page, ".code-note-window")) === 0 && (await count(page, ".code-note-glyph")) === 1;
  await page.mouse.click(glyph.x + glyph.width / 2, glyph.y + glyph.height / 2);
  await page.waitForSelector(".code-note-window .summary-text", { timeout: 5_000 }).catch(() => {});
  t.check("접기를 누르면 창이 표지로 접히고, 표지를 다시 누르면 같은 설명이 뜬다", folded && (await page.evaluate(() => document.querySelector(".code-note-window .summary-text")?.textContent ?? "")).includes("모은 항목"));

  // 새로 연 뒤에도 표지가 남고, 코드가 바뀐 범위는 흐리게 보인다.
  notes.saved = notes.saved.map((e) => ({ ...e, stale: true }));
  await page.reload();
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  await open();
  await page.waitForSelector(".code-note-glyph", { timeout: 5_000 }).catch(() => {});
  const kept = await rectOf(page, ".code-note-glyph");
  const dim = kept === null ? null : await page.evaluate(() => Number(getComputedStyle(document.querySelector(".code-note-glyph")).opacity));
  if (kept !== null) {
    await page.mouse.click(kept.x + kept.width / 2, kept.y + kept.height / 2);
    await page.waitForSelector(".code-note-window .stale-note", { timeout: 5_000 }).catch(() => {});
  }
  const stale = await page.evaluate(() => ({
    note: document.querySelector(".code-note-window .stale-note")?.textContent ?? "",
    opacity: Number(getComputedStyle(document.querySelector(".code-note-window .summary-text") ?? document.body).opacity),
  }));
  t.check(
    "페이지를 새로 열어도 표지가 남고, 코드가 바뀐 범위는 표지와 본문을 흐리게 그리고 그 사실을 적는다",
    kept !== null && dim < 1 && stale.note === "코드가 바뀌기 전에 만든 설명" && stale.opacity < 1 && notes.held.length === 1,
    `표지 불투명도 ${dim}, 문구 "${stale.note}", 본문 불투명도 ${stale.opacity}`,
  );
  await page.click(".code-note-window .summary-action:text('지우기')");
  await page.waitForFunction(() => document.querySelector(".code-note-glyph") === null, null, { timeout: 5_000 }).catch(() => {});
  t.check("지우기를 누르면 창과 표지가 사라지고 저장한 설명도 지워진다", (await count(page, ".code-note-window, .code-note-glyph")) === 0 && notes.saved.length === 0, `저장된 설명 ${notes.saved.length}개`);
}

/** 요약을 만들지 않고 서버 대신 답해, 코드가 바뀌기 전에 만든 요약을 흐리게 보이고 다시 만드는지 본다. */
async function summaryStale(t, page) {
  const target = { id: FUNCTION, owner: FILE };
  await answerSummaryReads(page, (id) => ({ summary: id === target.id ? longSummary(1) : null, stale: id === target.id, available: true, reason: null }));
  const held = await holdSummaryPosts(page);
  await load(page);
  await pickInTree(page, target);
  await page.waitForSelector(".info-panel-summary .summary-text", { timeout: 10_000 }).catch(() => {});
  const shown = await page.evaluate(() => ({
    note: document.querySelector(".info-panel-summary .stale-note")?.textContent ?? "",
    opacity: Number(getComputedStyle(document.querySelector(".info-panel-summary .summary-text") ?? document.body).opacity),
    button: [...document.querySelectorAll(".info-panel-summary .summary-action")].map((b) => b.textContent).join(","),
  }));
  t.check(
    '바뀌기 전에 만든 요약은 본문을 흐리게 그리고 위에 그 사실을 적으며 "다시 생성" 버튼을 보인다',
    shown.note === "코드나 앞뒤 흐름이 바뀌기 전에 만든 요약" && shown.opacity < 1 && shown.button === "다시 생성" && held.length === 0,
    `문구 "${shown.note}", 본문 불투명도 ${shown.opacity}, 버튼 ${shown.button}, POST ${held.length}번`,
  );
  await t.shot();
  await page.click(".info-panel-summary .summary-action");
  await page.waitForFunction(() => document.querySelector(".info-panel-summary .info-panel-hint")?.textContent === "요약을 만드는 중", null, { timeout: 5_000 }).catch(() => {});
  held[0]?.answer(longSummary(2));
  await page.waitForFunction(() => document.querySelector(".info-panel-summary .summary-text:not(.stale-text)") !== null, null, { timeout: 5_000 }).catch(() => {});
  t.check(
    '"다시 생성"을 누르면 POST를 한 번 보내고, 새 요약은 흐리지 않게 그리며 문구가 사라진다',
    held.length === 1 && held[0].node === target.id && (await count(page, ".info-panel-summary .stale-note")) === 0 && (await count(page, ".info-panel-summary .summary-text:not(.stale-text)")) === 1,
    `POST ${held.length}번`,
  );

  // "자동 요약"이 켜져 있으면 바뀌기 전에 만든 요약을 누르지 않아도 다시 만든다.
  await page.getByLabel("자동 요약").check();
  await page.reload();
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  await pickInTree(page, target);
  await page.waitForFunction(() => document.querySelector(".info-panel-summary .info-panel-hint")?.textContent === "요약을 만드는 중", null, { timeout: 5_000 }).catch(() => {});
  t.check('"자동 요약"을 켜 두면 바뀌기 전에 만든 요약을 고른 채 머물 때 POST를 보낸다', held.length === 2 && held[1].node === target.id, `POST ${held.length}번`);
}

/** 요약을 실제로 만들지 않고 "요약 생성" 버튼과 "자동 요약" 토글이 POST를 언제 보내는지만 본다. 보낸 POST는 붙잡혀 서버에 닿지 않는다. */
async function summaryAsk(t, page) {
  const { found, available, reason } = await uncached(2);
  if (found.length < 2 || !available) {
    t.check("캐시에 요약이 없는 함수가 두 개 있고 Claude Code CLI를 부를 수 있다", false, found.length < 2 ? `캐시에 없는 함수 ${found.length}개` : `${reason}`);
    return;
  }
  const [first, second] = found;
  const posts = summaryPosts(page);
  const aborted = summaryAborts(page);
  await load(page);
  t.check('상단 줄의 "자동 요약" 토글이 꺼진 채로 열린다', !(await page.getByLabel("자동 요약").isChecked()));
  await pickInTree(page, first);
  await page.waitForSelector(".info-panel-summary .summary-make", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1_500);
  t.check(
    `캐시에 없는 함수 ${first.id}를 고르면 "요약 생성" 버튼이 보이고 POST를 보내지 않는다`,
    (await count(page, ".info-panel-summary .summary-make")) === 1 && posts.length === 0,
    `POST ${posts.length}번`,
  );
  await page.click(".info-panel-summary .summary-make");
  await page.waitForFunction(() => document.querySelector(".info-panel-summary .info-panel-hint")?.textContent === "요약을 만드는 중", null, { timeout: 5_000 }).catch(() => {});
  t.check(
    '"요약 생성"을 누르면 그 함수의 POST를 한 번 보내고 "요약을 만드는 중"을 보인다',
    same(posts, [first.id]) && (await summaryHint(page)) === "요약을 만드는 중",
    `POST ${posts.join(", ") || "없음"}, 문구 ${await summaryHint(page)}`,
  );
  await t.shot();

  await page.getByLabel("자동 요약").check();
  await pickInTree(page, second);
  await page.waitForFunction(() => document.querySelector(".info-panel-summary .info-panel-hint")?.textContent === "요약을 만드는 중", null, { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(500);
  t.check(
    `"자동 요약"을 켜고 ${second.id}를 고르면 버튼을 누르지 않아도 그 함수의 POST를 한 번 보낸다`,
    same(posts, [first.id, second.id]),
    `POST ${posts.join(", ") || "없음"}`,
  );
  t.check(`${first.id}를 떠나도 만들고 있던 그 함수의 POST를 끊지 않는다`, aborted.length === 0, `끊은 POST ${aborted.join(", ") || "없음"}`);
  await page.getByLabel("자동 요약").uncheck();
  await page.waitForTimeout(500);
  t.check(
    '"자동 요약"을 꺼도 만들고 있던 POST를 끊지 않고 "요약을 만드는 중"을 그대로 보인다',
    aborted.length === 0 && (await summaryHint(page)) === "요약을 만드는 중",
    `끊은 POST ${aborted.join(", ") || "없음"}, 문구 ${await summaryHint(page)}`,
  );
  await page.getByLabel("자동 요약").check();
  await page.reload();
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  t.check('새로고침 뒤에도 "자동 요약" 토글이 켜져 있다', await page.getByLabel("자동 요약").isChecked());
}

/** 캐시에서 읽은 설명을 가짜 설명으로 바꿔, 정의 표기가 누를 수 있는 등폭 글자로 그려지고 누르면 그 노드를 고르는지 본다. 요약을 만들지 않는다. */
async function summaryRef(t, page) {
  const graph = await api("/api/graph");
  const callee = graph.edges.find((e) => e.source === FUNCTION && e.kind === "call" && graph.nodes.some((n) => n.id === e.target && n.kind === "function" && !n.test));
  const caller = graph.edges.find((e) => e.target === FUNCTION && e.kind === "call");
  if (callee === undefined || caller === undefined) {
    t.check(`${FUNCTION}을 호출하는 함수와 그 함수가 호출하는 함수가 있다`, false);
    return;
  }
  /** 노드 id를 `파일 상자 이름표::정의 이름`으로 적는다. */
  const refOf = (id) => {
    const [file, name] = id.split(":");
    return `${file.replaceAll(".", "/")}.py::${name}`;
  };
  const [first, second, missing] = [refOf(callee.target), refOf(caller.source), `${refOf(FUNCTION).split("::")[0]}::no_such_function`];
  const fake = `리마인더에서 오늘 노트의 구획을 다시 만든다.\n\n하는 일\n\`${first}\`로 오늘 항목을 모으고 \`note.todos\`를 바꾼다. \`${missing}\`는 그래프에 없다.\n\n앞뒤 흐름\n${second}가 노트가 있을 때 부른다.\n\`re.sub\`만 쓴다.`;
  await page.route(
    (at) => at.pathname === "/api/summary" && at.searchParams.get("node") === FUNCTION,
    (route) => (route.request().method() === "GET" ? route.fulfill({ json: { summary: fake, stale: false, available: true, reason: null } }) : route.fallback()),
  );
  await load(page);
  await pick(page, FILE);
  await pick(page, FUNCTION);
  await page.waitForSelector(".info-panel-summary .summary-text", { timeout: 10_000 });
  const drawn = await page.evaluate(() => ({
    refs: [...document.querySelectorAll(".summary-text .summary-ref")].map((button) => ({
      text: button.textContent,
      node: button.dataset.node,
      font: getComputedStyle(button.querySelector("code")).fontFamily,
      tag: button.tagName,
    })),
    codes: [...document.querySelectorAll(".summary-text code")].filter((code) => code.closest(".summary-ref") === null).map((code) => code.textContent),
    body: getComputedStyle(document.querySelector(".summary-text")).fontFamily,
  }));
  t.check(
    "백틱으로 감싼 정의 표기와 감싸지 않은 정의 표기가 그래프 노드를 가리키는 등폭 글꼴 버튼으로 그려진다",
    same(drawn.refs.map((ref) => [ref.text, ref.node, ref.tag]), [[first, callee.target, "BUTTON"], [second, caller.source, "BUTTON"]]) &&
      drawn.refs.every((ref) => ref.font !== drawn.body && /mono/i.test(ref.font)),
    drawn.refs.map((ref) => `${ref.text} → ${ref.node}`).join(", "),
  );
  t.check(
    "그래프에 없는 정의 표기와 그 밖의 백틱 식별자는 누를 수 없는 등폭 글자다",
    same(drawn.codes, ["note.todos", missing, "re.sub"]),
    drawn.codes.join(", "),
  );
  await t.shot();
  await page.click(`.summary-text .summary-ref[data-node="${callee.target}"]`);
  await waitSelected(page, callee.target).catch(() => {});
  t.check("정의 표기를 누르면 그래프가 그 노드를 고른다", (await selectedOf(page)) === callee.target, `선택 ${await selectedOf(page)}`);
}

async function summary(t, page) {
  const { found, available, reason } = await uncached(1);
  if (found.length === 0 || !available) {
    t.check("캐시에 없는 함수가 있고 Claude Code CLI를 부를 수 있다", false, found.length === 0 ? "모든 함수의 요약이 캐시에 있다" : `${reason}`);
    return;
  }
  const [target] = found;
  t.summaries.add(target.id);
  const posts = summaryPosts(page);
  const sent = () => posts.filter((id) => id === target.id).length;

  await load(page);
  await pickInTree(page, target);
  await page.waitForSelector(".info-panel-summary .summary-make", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1_500);
  t.check(`캐시에 없는 함수 ${target.id}를 고르면 "요약 생성" 버튼이 보이고 POST를 보내지 않는다`, (await count(page, ".info-panel-summary .summary-make")) === 1 && sent() === 0, `POST ${sent()}번`);
  await page.click(".info-panel-summary .summary-make");
  const started = Date.now();
  await page.waitForFunction(() => document.querySelector(".info-panel-summary .info-panel-hint")?.textContent === "요약을 만드는 중", null, { timeout: 5_000 }).catch(() => {});
  const making = await summaryHint(page);
  await page.waitForSelector(".info-panel-summary .summary-text", { timeout: 130_000 }).catch(() => {});
  const seconds = (Date.now() - started) / 1000;
  const made = await page.evaluate(() => document.querySelector(".info-panel-summary .summary-text")?.textContent ?? null);
  t.check(
    '"요약 생성"을 누르면 "요약을 만드는 중" 뒤에 한국어 요약이 나온다',
    making === "요약을 만드는 중" && made !== null && /[가-힣]/.test(made) && sent() === 1,
    made === null ? `${seconds.toFixed(1)}초 동안 요약이 나오지 않았다: ${await summaryHint(page)}` : `${seconds.toFixed(1)}초, ${made.length}자`,
  );
  await settle(page);
  await t.shot();

  await page.click(`.tree-row.tree-file[data-node="${target.owner}"]`);
  await waitSelected(page, target.owner);
  await page.click(`.tree-row.tree-symbol[data-node="${target.id}"]`);
  const returned = Date.now();
  await page.waitForSelector(".info-panel-summary .summary-text", { timeout: 5_000 }).catch(() => {});
  const again = await page.evaluate(() => document.querySelector(".info-panel-summary .summary-text")?.textContent ?? null);
  await page.waitForTimeout(1_000);
  t.check("다른 노드를 거쳐 돌아오면 POST 없이 바로 나온다", again === made && made !== null && sent() === 1, `${Date.now() - returned - 1_000}ms 안, 그 함수의 POST ${sent()}번`);
}

/** 폴더 안의 함수를 고른 뒤 탐색 경로의 폴더 단계를 누른다. */
async function folderSelect(t, page) {
  await load(page);
  await page.click('.tree-row.tree-file[data-node="parser.plan"]');
  await waitSelected(page, "parser.plan");
  await page.click('.trail-step[data-node="parser"]');
  await waitSelected(page, "parser");
  const all = await boxes(page);
  const functions = await count(page, ".react-flow__node .node-body.node-function");
  t.check(
    "parser/ 안의 파일 상자가 parser/ 상자 하나로 접히고 그 상자가 선택되며 펼친 파일 상자가 없다",
    (await count(page, `${node("parser")} > .node-package.node-selected`)) === 1 &&
      all.every((b) => !b.id.startsWith("parser.") && !b.open) &&
      functions === 0,
    `파일 상자 ${all.length}개, 함수 노드 ${functions}개`,
  );
  const edges = await edgesOf(page);
  const strong = edges.filter((e) => e.tone === "strong");
  t.check(
    "본문 잉크 선은 parser/ 상자에서 나가고 들어오는 집계 선뿐이다",
    strong.length > 0 && strong.every((e) => e.key.startsWith("agg|") && (e.source === "parser" || e.target === "parser") && e.opacity === 1),
    `그린 선 ${edges.length}개: ${toneLevels(edges)}`,
  );
  const dims = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll(".react-flow__node")].map((wrapper) => [wrapper.dataset.id, Number(getComputedStyle(wrapper).opacity)])),
  );
  const users = [...new Set(strong.filter((e) => e.target === "parser").map((e) => e.source))];
  const used = [...new Set(strong.filter((e) => e.source === "parser").map((e) => e.target))];
  t.check(
    "이 폴더를 쓰는 파일 상자와 이 폴더가 쓰는 파일 상자가 접힌 채 불투명도 1로 보인다",
    users.length > 0 && [...users, ...used].every((id) => dims[id] === 1),
    `쓰는 파일 ${users.length}개, 쓰이는 파일 ${used.length}개`,
  );
  const head = await headOf(page);
  t.check("정보 패널 머리 줄이 parser/ 폴더를 적는다", head.includes("parser/") && head.includes("폴더"), head.replaceAll("\n", " / "));
  t.check(
    "머리 줄의 상대 상자 수가 본문 잉크 집계 선의 수와 같다",
    head.includes(`쓰는 파일 ${used.length} · 이 폴더를 쓰는 파일 ${users.length}`),
    head.replaceAll("\n", " / "),
  );
}

/** 파일트리에서 그래프 노드가 없는 __init__.py 행을 누른다. */
async function initFile(t, page) {
  await load(page);
  await pick(page, FILE);
  const row = '.tree-row.tree-file[title$="parser/__init__.py"]';
  const before = { selected: await selectedOf(page), functions: await count(page, ".node-function"), packages: await count(page, ".node-package") };
  await page.click(row);
  await page.waitForSelector(".info-panel .monaco-editor .view-line", { timeout: 30_000 }).catch(() => {});
  await settle(page);
  const after = { selected: await selectedOf(page), functions: await count(page, ".node-function"), packages: await count(page, ".node-package") };
  t.check("__init__.py 행을 눌러도 그래프 선택과 펼친 상자가 바뀌지 않는다", before.selected === FILE && same(after, before), JSON.stringify(after));
  const head = await headOf(page);
  const first = await page.evaluate(() => {
    const numbers = [...document.querySelectorAll(".info-panel .monaco-editor .line-numbers")];
    numbers.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return numbers[0]?.textContent ?? null;
  });
  t.check(
    "정보 패널이 그 파일의 경로와 1번 줄부터의 코드만 보인다",
    head.includes("__init__.py") && head.includes("parser/__init__.py") && first === "1" && (await count(page, ".info-panel-summary")) === 0,
    `${head.replaceAll("\n", " / ")}, 첫 줄 번호 ${first}`,
  );
  t.check("그 행이 고른 행으로 표시되고 그래프 노드와 잇지 않는다", await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    return element.classList.contains("active") && element.dataset.node === undefined;
  }, row));
  await t.shot();
  await page.keyboard.press("Escape");
  await page.waitForSelector(".info-panel-summary", { timeout: 10_000 }).catch(() => {});
  t.check("Esc에 연 파일만 닫히고 선택은 그대로다", (await selectedOf(page)) === FILE && (await count(page, ".info-panel .code")) === 0 && (await headOf(page)).includes("arbiter.py"), `선택 ${await selectedOf(page)}`);
  await page.click(row);
  await page.waitForSelector(".info-panel .code", { timeout: 10_000 }).catch(() => {});
  await page.click(`.tree-row.tree-symbol[data-node="${FUNCTION}"]`);
  await waitSelected(page, FUNCTION);
  t.check("그래프에서 다른 노드를 고르면 연 파일이 닫히고 그 노드의 코드를 보인다", (await headOf(page)).includes(spanOf(await api("/api/graph"), FUNCTION).text), (await headOf(page)).replaceAll("\n", " / "));

  // 선택 없이 연 파일은 그래프 바탕을 누르거나 그 파일이 든 폴더를 접으면 닫힌다.
  await page.keyboard.press("Escape");
  await settle(page);
  const blank = async () => {
    const { free } = await stageOf(page);
    return page.evaluate(
      ({ x, y, width, height }) => {
        for (let dy = 8; dy < height; dy += 16) {
          for (let dx = 8; dx < width; dx += 16) {
            if (document.elementFromPoint(x + dx, y + dy)?.classList.contains("react-flow__pane")) {
              return { x: x + dx, y: y + dy };
            }
          }
        }
        return null;
      },
      free,
    );
  };
  await page.click(row);
  await page.waitForSelector(".info-panel .code", { timeout: 10_000 }).catch(() => {});
  const opened = (await count(page, ".info-panel .code")) === 1 && (await selectedOf(page)) === null;
  const at = await blank();
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector(".info-panel .code", { state: "detached", timeout: 5_000 }).catch(() => {});
  t.check("선택 없이 연 파일은 그래프 바탕을 누르면 닫힌다", opened && (await count(page, ".info-panel .code")) === 0, (await headOf(page)).replaceAll("\n", " / "));
  await page.click(row);
  await page.waitForSelector(".info-panel .code", { timeout: 10_000 }).catch(() => {});
  await page.click('.tree-row.tree-dir[data-node="parser"]');
  await page.waitForSelector(".info-panel .code", { state: "detached", timeout: 5_000 }).catch(() => {});
  t.check("연 파일이 든 폴더를 접으면 닫힌다", (await count(page, row)) === 0 && (await count(page, ".info-panel .code")) === 0, (await headOf(page)).replaceAll("\n", " / "));

  // 소스 루트의 __init__.py는 모듈 노드가 있으므로 그 행이 그래프의 상자를 고른다.
  const root = '.tree-row.tree-file[title="src/__init__.py"]';
  await page.click(root);
  await waitSelected(page, "__init__").catch(() => {});
  t.check(
    "소스 루트의 __init__.py 행을 누르면 그래프의 __init__.py 상자가 선택되고 그 행이 고른 행이 된다",
    (await selectedOf(page)) === "__init__" && (await page.evaluate((sel) => document.querySelector(sel)?.classList.contains("active") === true, root)),
    `선택 ${await selectedOf(page)}`,
  );
}

/** 상단 줄의 진입점 목록과 git 브랜치 이름, 좁은 창 폭의 상단 줄 */
async function toolbar(t, page) {
  const [graph, reply] = [await api("/api/graph"), await api("/api/changes")];
  const entries = graph.nodes.filter((n) => n.entry && !n.test).map((n) => n.id);
  await load(page);
  const branch = await page.evaluate(() => document.querySelector(".toolbar-branch")?.textContent ?? null);
  t.check(
    "상단 줄이 현재 git 브랜치 이름을 적는다",
    reply.git && reply.branch !== null ? branch === `브랜치 ${reply.branch}` : branch === null,
    `화면 ${branch}, 서버 ${reply.branch}`,
  );
  t.check("하단 상태 줄이 없고 진입점 목록이 접힌 채로 열린다", (await count(page, ".toolbar-menu")) === 0 && (await count(page, ".statusbar, .status-bar")) === 0);
  await page.click(".toolbar-entries > .toolbar-button");
  await page.waitForSelector(".toolbar-menu-item", { timeout: 5_000 }).catch(() => {});
  const listed = await page.evaluate(() => [...document.querySelectorAll(".toolbar-menu-item")].map((item) => item.dataset.node));
  t.check(`진입점 목록을 누르면 진입점 ${entries.length}개의 이름이 펼쳐진다`, entries.length > 0 && same([...listed].sort(), [...entries].sort()), listed.join(", "));
  await t.shot();
  await page.click(`.toolbar-menu-item[data-node="${entries.at(-1)}"]`);
  await waitSelected(page, entries.at(-1)).catch(() => {});
  t.check("이름을 고르면 그래프가 그 노드를 선택하고 목록이 접힌다", (await selectedOf(page)) === entries.at(-1) && (await count(page, ".toolbar-menu")) === 0, `선택 ${await selectedOf(page)}`);
  const fits = await page.evaluate(() => {
    const bar = document.querySelector(".toolbar");
    return bar.scrollWidth <= bar.clientWidth;
  });
  t.check("상단 줄의 요소가 줄 폭 안에 들어간다", fits);

  // 목록이 접힌 뒤에는 포커스가 진입점 버튼에 남아 있어도 Esc가 선택을 푼다.
  await page.click(".toolbar-entries > .toolbar-button");
  await page.waitForSelector(".toolbar-menu", { timeout: 5_000 }).catch(() => {});
  await page.keyboard.press("Escape");
  const folded = (await count(page, ".toolbar-menu")) === 0 && (await selectedOf(page)) === entries.at(-1);
  const focused = await page.evaluate(() => document.activeElement?.closest(".toolbar-entries") !== null);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".react-flow__node .node-selected") === null, null, { timeout: 5_000 }).catch(() => {});
  t.check(
    "Esc 한 번에 진입점 목록만 접히고, 포커스가 진입점 버튼에 남은 채 한 번 더 누르면 선택이 풀린다",
    folded && focused && (await selectedOf(page)) === null,
    `목록 접힘 ${folded}, 버튼 포커스 ${focused}, 선택 ${await selectedOf(page)}`,
  );

  // 창 폭마다 파일트리 폭이 기본값인 새 화면을 열어 상단 줄의 모든 버튼과 입력이 창 안에서 눌리는지 본다.
  // "분석 뒤 바뀐 파일 N개"는 /api/changes 응답에 분석 뒤 바뀐 파일 하나를 더해 띄운다.
  const extra = { path: graph.nodes.find((n) => n.kind === "module" && !n.test).path, status: "unchanged", stale: true, test: false };
  let stale = false;
  await page.route(
    (at) => at.pathname === "/api/changes",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: stale ? { ...body, files: [...body.files, extra] } : body });
    },
  );
  for (const width of NARROW.widths.flatMap((w) => [w, -w])) {
    stale = width < 0;
    const name = `창 폭 ${Math.abs(width)}px${stale ? ', "분석 뒤 바뀐 파일" 표시' : ""}`;
    await page.setViewportSize({ width: Math.abs(width), height: 900 });
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
    await page.click(`.tree-row.tree-file[data-node="${NARROW.owner}"]`);
    await page.waitForSelector(`.tree-row.tree-symbol[data-node="${NARROW.id}"]`, { timeout: 10_000 });
    await page.click(`.tree-row.tree-symbol[data-node="${NARROW.id}"]`);
    await waitSelected(page, NARROW.id);
    if (stale) {
      await page.waitForSelector(".toolbar-stale", { timeout: 10_000 }).catch(() => {});
    }
    /** 상단 줄 안에 보이는 버튼과 입력 가운데 창이나 상단 줄 밖에 있거나 가운데 점에서 눌리지 않는 것 */
    const read = () =>
      page.evaluate(() => {
        const shown = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const title = (control) => control.textContent.trim() || control.closest("label")?.textContent.trim() || control.type;
        const toolbar = document.querySelector(".toolbar");
        const area = toolbar.getBoundingClientRect();
        const controls = [...toolbar.querySelectorAll("button, input")].filter(shown);
        const missed = controls.filter((control) => {
          const rect = control.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return rect.left < area.left || rect.right > Math.min(area.right, window.innerWidth) || rect.top < area.top || hit === null || !control.contains(hit);
        });
        const last = document.querySelector(".trail-last");
        const stats = [...document.querySelectorAll(".toolbar-stats > span")].find(shown);
        const [stage, panel] = [document.querySelector(".stage").getBoundingClientRect(), document.querySelector(".info-panel").getBoundingClientRect()];
        return {
          fit: toolbar.dataset.fit,
          width: Math.round(area.width),
          height: Math.round(area.height),
          controls: controls.map(title),
          missed: missed.map(title),
          last: last === null ? null : { text: last.textContent, whole: shown(last) && last.scrollWidth <= last.clientWidth && last.getBoundingClientRect().right <= area.right },
          cut: document.querySelector(".trail-cut")?.title ?? null,
          stats: stats === undefined ? null : { text: stats.textContent, inside: stats.getBoundingClientRect().right <= area.right },
          stale: document.querySelector(".toolbar-stale")?.textContent ?? null,
          gaps: [panel.top - stage.top, stage.bottom - panel.bottom, stage.top - area.bottom],
        };
      });
    const bar = await read();
    const menu = bar.controls.includes("설정");
    const depth = await page.evaluate(() => document.querySelector('.toolbar input[type="range"]').closest("label").textContent.trim());
    const wanted = ["←", "→", `진입점 ${entries.length}`, depth, "화면 맞춤", "어두운 화면", ...(menu ? ["설정"] : ["테스트 코드", "외부 노드", "자동 요약"])];
    t.check(
      `${name}: 상단 줄의 버튼·슬라이더·토글이 모두 창 안에 있고 가운데 점에서 눌린다`,
      bar.missed.length === 0 && wanted.every((title) => bar.controls.includes(title)) && (!stale || bar.stale !== null),
      `단계 ${bar.fit}, 상단 줄 ${bar.width}×${bar.height}, 눌리지 않는 요소 ${bar.missed.join("·") || "없음"}, 요소 ${bar.controls.join("·")}`,
    );
    t.check(
      `${name}: 통계 문구와 탐색 경로의 마지막 단계가 잘리지 않고, 탐색 경로를 줄였으면 통계 문구가 짧은 형태다`,
      bar.stats?.inside === true && bar.stats.text.includes("호출 확인") && bar.last?.whole === true && bar.last.text === NARROW.label && (bar.cut === null || bar.fit !== "full"),
      `통계 문구 "${bar.stats?.text}", 마지막 단계 "${bar.last?.text}", 줄인 단계 "${bar.cut ?? "없음"}"`,
    );
    t.check(
      `${name}: 관계 그래프 영역이 상단 줄 바로 아래에서 시작하고 정보 패널의 위아래 여백이 같다`,
      near(bar.gaps[2], 0) && bar.gaps[0] > 0 && near(bar.gaps[0], bar.gaps[1]),
      `패널 위 ${bar.gaps[0]}, 아래 ${bar.gaps[1]}, 상단 줄과 영역 사이 ${bar.gaps[2]}`,
    );
    if (width === NARROW.widths[0]) {
      t.check(`${name}: 통계 문구 전체와 토글 세 개를 한 줄에 그린다`, bar.fit === "full" && bar.height < 40 && !menu, `단계 ${bar.fit}`);
    }
    if (menu) {
      await page.click(".toolbar-toggles-button");
      const listed = await page.evaluate(() =>
        [...document.querySelectorAll(".toolbar-toggles-list[data-open] .toolbar-toggle")].map((label) => label.textContent.trim()),
      );
      const opened = await read();
      if (!stale) {
        await page.screenshot({ path: join(OUT, `s2-toolbar-${width}.png`) });
      }
      await page.keyboard.press("Escape");
      t.check(
        `${name}: 토글 세 개가 "설정" 버튼 아래 목록에서 눌리고 Esc에 목록만 접힌다`,
        same(listed, ["테스트 코드", "외부 노드", "자동 요약"]) &&
          listed.every((title) => opened.controls.includes(title)) &&
          opened.missed.length === 0 &&
          (await count(page, ".toolbar-toggles-list[data-open]")) === 0 &&
          (await selectedOf(page)) === NARROW.id,
        `목록 ${listed.join("·") || "없음"}, 눌리지 않는 요소 ${opened.missed.join("·") || "없음"}, 선택 ${await selectedOf(page)}`,
      );
    } else if (!stale) {
      await page.screenshot({ path: join(OUT, `s2-toolbar-${width}.png`) });
    }
  }
}

const SCENARIOS = [
  ["open", open],
  ["file", file],
  ["function", functionScenario],
  ["body", body],
  ["panel", panel],
  ["hover", hover],
  ["edge", edge],
  ["minimap", minimap],
  ["region", region],
  ["folder", folder],
  ["folder-select", folderSelect],
  ["init-file", initFile],
  ["toolbar", toolbar],
  ["callview", callview],
  ["search", search],
  ["zoom", zoom],
  ["labels", labels],
  ["external", external],
  ["dark", dark],
  ["tree", tree],
  ["tree-search", treeSearch],
  ["changes", changes],
  ["zoom-keep", zoomKeep],
  ["summary-panel", summaryPanel],
  ["summary-busy", summaryBusy],
  ["summary-stale", summaryStale],
  ["explain", explain],
  ["summary-ask", summaryAsk],
  ["summary-ref", summaryRef],
  ["summary", summary],
];

// ── 실행 ─────────────────────────────────────────────────────────

async function run(browser, name, scenario) {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2, colorScheme: "light" });
  // 화면의 단축키 처리(window의 capture 단계)가 끝난 뒤에 keydown의 defaultPrevented를 적어 둔다.
  await context.addInitScript(() => {
    window.__shotsKeys = [];
    window.addEventListener("keydown", (event) =>
      window.__shotsKeys.push({ key: event.key, mod: event.ctrlKey || event.metaKey, prevented: event.defaultPrevented }),
    );
  });
  const results = [];
  const errors = [];
  const path = join(OUT, `s2-${name}.png`);
  const page = await context.newPage();
  let shot = false;
  const t = {
    /** 이 시나리오가 서버로 보내도 되는 POST /api/summary의 노드 id */
    summaries: new Set(),
    check: (label, ok, actual = "") => results.push({ label, ok: Boolean(ok), actual }),
    /** 대상 레포에 입력이 없어 볼 수 없는 확인 항목을 적는다. 통과로도 실패로도 세지 않는다. */
    skip: (label, reason) => results.push({ label, ok: null, actual: reason }),
    /** 조작 도중의 화면을 남긴다. 부르지 않으면 시나리오가 끝난 화면을 찍는다. */
    shot: async () => {
      shot = true;
      await page.screenshot({ path });
    },
  };
  // 요약을 만드는 POST는 구독 사용량을 쓴다. 시나리오가 허락한 노드가 아니면 서버로 보내지 않고 붙잡아 두어
  // 요약 칸이 "요약을 만드는 중"에 머물게 하고, 시나리오가 끝나면 버린다. 붙잡은 채로 컨텍스트를 닫으면
  // 브라우저가 그 요청을 서버로 보낸다.
  const held = [];
  await context.route(
    (at) => at.pathname === "/api/summary",
    (route) => {
      const request = route.request();
      if (request.method() === "POST" && !t.summaries.has(new URL(request.url()).searchParams.get("node"))) {
        held.push(route);
        return;
      }
      return route.continue();
    },
  );
  page.on("pageerror", (error) => errors.push(`페이지 오류: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`콘솔 오류: ${message.text()}`);
    }
  });
  try {
    await scenario(t, page);
    if (!shot) {
      await t.shot();
    }
  } catch (error) {
    await page.screenshot({ path }).catch(() => {});
    t.check("시나리오를 끝까지 조작한다", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
  }
  t.check("페이지 오류와 콘솔 오류가 없다", errors.length === 0, errors.join(" / "));
  page.removeAllListeners("console");
  await Promise.all(held.map((route) => route.abort().catch(() => {})));
  await context.close();

  console.log(`[${name}]`);
  for (const { label, ok, actual } of results) {
    console.log(`  ${ok === null ? "건너뜀" : ok ? "통과" : "실패"}  ${label}${actual === "" ? "" : ` — ${actual}`}`);
  }
  console.log(`  스크린샷  ${path}`);
  return results;
}

const names = SCENARIOS.map(([name]) => name);
const unknown = (only ?? []).filter((name) => !names.includes(name));
if (unknown.length > 0) {
  console.error(`모르는 시나리오: ${unknown.join(", ")}. 고를 이름: ${names.join(", ")}`);
  process.exit(2);
}
const chosen = SCENARIOS.filter(([name]) => (only === null ? name !== "summary" || withSummary : only.includes(name)));

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const all = [];
for (const [name, scenario] of chosen) {
  all.push(...(await run(browser, name, scenario)));
}
await browser.close();

const failed = all.filter((result) => result.ok === false).length;
const skipped = all.filter((result) => result.ok === null).length;
console.log(
  `시나리오 ${chosen.length}개, 확인 항목 ${all.length}개 가운데 통과 ${all.length - failed - skipped}개, 실패 ${failed}개, 건너뜀 ${skipped}개`,
);
process.exit(failed === 0 ? 0 : 1);
