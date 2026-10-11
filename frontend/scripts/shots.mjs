// 화면을 시나리오마다 조작해 확인 항목의 통과 여부를 한 줄씩 출력하고 스크린샷을 남긴다.
// 사용: node scripts/shots.mjs [주소] [--cycle-url 주소] [--reload-url 주소] [--wide-url 주소] [--only 이름,이름] [--with-summary]
// 떠 있는 서버의 주소를 받고(기본 http://127.0.0.1:8766) 서버를 띄우지 않는다. 노드 이름은 sync-engine을 연 서버가 기준이고 노드 수·선 수·줄 범위,
// 경로와 미사용 후보는 서버 응답에서 읽는다. 순환 시나리오(cycles, cycles-change, cycles-pin)는 tests/fixtures/cycle_repo를 연 서버의 주소를
// --cycle-url로 받았을 때만 돌고, 받지 않으면 건너뜀으로 출력한다. 새로고침 시나리오(reload, stale)는 대상 레포의 파일을 고쳤다가 되돌리므로
// tests/fixtures/sample_repo를 임시 폴더로 복사해 연 서버의 주소를 --reload-url로 받았을 때만 돈다.
// lanes 시나리오는 폴더가 여러 겹인 레포(modern-deeplearning-pipeline)를 연 서버의 주소를 --wide-url로 받으면 그 화면도 본다.
// 시나리오마다 localStorage가 빈 새 브라우저 컨텍스트에서 시작한다. 실패한 확인 항목이 있으면 종료 코드 1로 끝난다.
// 대상 레포에 입력이 없어 볼 수 없는 확인 항목은 "건너뜀"으로 출력하고 실패로 세지 않는다.
// summary 시나리오는 Claude Code 구독 사용량을 쓰므로 --only로 지정하거나 --with-summary를 줬을 때만 돈다.
// 다른 시나리오가 보내는 POST /api/summary는 서버로 보내지 않고 붙잡아 두었다가 버린다.
// changes 시나리오는 /api/repo의 root에서 git status와 git diff를 읽기 전용으로 부르므로 서버와 같은 기계에서 돌린다.
// 수정한 .py 파일이 없는 레포에서는 changes의 확인 항목을 건너뛴다.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** 정보 패널의 기본 폭을 관계 그래프 영역의 폭으로 나눈 값과 패널의 최소 폭 */
const PANEL_SHARE = 0.3;
const PANEL_MIN = 260;
/** 큰 상자를 패널을 뺀 영역의 시작 끝에서 띄우는 폭 */
const INSET = 20;
const DARK = { surface: "#1a1a19", ink: "#ffffff" };
/** 상단 줄 오른쪽 칸의 버튼. 왼쪽부터다. */
const TOOLS = ["필터", "화면 맞춤", "어두운 화면", "새로고침"];
/** 좁은 창에서 상단 줄을 확인할 때 고르는 함수와 창 폭 */
const NARROW = { owner: "parser.plan", id: "parser.plan:_parse_week_header", label: "_parse_week_header()", widths: [1700, 1440, 1280, 1160, 980, 900, 720] };
/** 글자 요소가 그리는 글자와 배지. 이 요소의 가운데 점에서는 늘 그 노드가 눌린다. */
const TEXTS = ".node-label, .loc, .change-mark, .badge, .node-aside, .node-below, .node-field, .call-file";

let url = "http://127.0.0.1:8766";
/** 순환이 있는 고정 레포를 연 서버의 주소. 주지 않으면 순환 시나리오를 건너뛴다. */
let cycleUrl = null;
/** 고정 레포 sample_repo의 임시 복사본을 연 서버의 주소. 주지 않으면 새로고침 시나리오를 건너뛴다. */
let reloadUrl = null;
/** 폴더가 여러 겹인 레포를 연 서버의 주소. 주지 않으면 그 화면의 확인 항목을 건너뛴다. */
let wideUrl = null;
let only = null;
let withSummary = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--only") {
    only = (process.argv[++i] ?? "").split(",").filter((name) => name !== "");
  } else if (arg === "--cycle-url") {
    cycleUrl = process.argv[++i] ?? null;
  } else if (arg === "--wide-url") {
    wideUrl = process.argv[++i] ?? null;
  } else if (arg === "--reload-url") {
    reloadUrl = process.argv[++i] ?? null;
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
const api = async (path, base = url) => (await fetch(new URL(path, base))).json();

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

/**
 * 관계 그래프 영역 area, 정보 패널 panel, 패널이 가리지 않는 가장 넓은 사각형 free, 패널과 왼쪽 아래 칸(펼친 칸과 버튼 줄)이
 * 모두 가리지 않는 가장 넓은 사각형 clear(frontend/src/graph/viewport.ts의 freeRect와 같은 계산)
 */
const stageOf = (page) =>
  page.evaluate(() => {
    const plain = (r) => ({ x: r.left, y: r.top, width: r.width, height: r.height });
    const area = plain(document.querySelector(".graph").getBoundingClientRect());
    const panel = plain(document.querySelector(".info-panel").getBoundingClientRect());
    const dock = [...document.querySelectorAll(".dock-panels > *, .dock-buttons")].map((element) => plain(element.getBoundingClientRect()));
    const [right, bottom] = [area.x + area.width, area.y + area.height];
    const clampX = (x) => Math.max(area.x, Math.min(x, right));
    const clampY = (y) => Math.max(area.y, Math.min(y, bottom));
    const freeRect = (covers) => {
      const inside = covers
        .map((c) => ({ left: clampX(c.x), right: clampX(c.x + c.width), top: clampY(c.y), bottom: clampY(c.y + c.height) }))
        .filter((c) => c.left < c.right && c.top < c.bottom);
      const cuts = (values) => [...new Set(values)].sort((a, b) => a - b);
      const xs = cuts([area.x, right, ...inside.flatMap((c) => [c.left, c.right])]);
      const ys = cuts([area.y, bottom, ...inside.flatMap((c) => [c.top, c.bottom])]);
      let best = inside.length === 0 ? area : null;
      for (const [i, x] of xs.entries()) {
        for (const far of xs.slice(i + 1)) {
          for (const [j, y] of ys.entries()) {
            for (const low of ys.slice(j + 1)) {
              const size = (far - x) * (low - y);
              if ((best === null || size > best.width * best.height) && inside.every((c) => c.right <= x || c.left >= far || c.bottom <= y || c.top >= low)) {
                best = { x, y, width: far - x, height: low - y };
              }
            }
          }
        }
      }
      return best ?? area;
    };
    return { area, panel, free: freeRect([panel]), clear: freeRect([panel, ...dock]) };
  });

/** 그린 선마다 양 끝, 진하기, 불투명도, 선 색 */
const edgesOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge .edge[data-key]:not(.edge-trunk)")].map((edge) => {
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

/**
 * 선마다 경로의 시작점·끝점(그래프 좌표), 선 굵기, 층, 마우스를 올린 선인지. 줄기는 세지 않는다. 줄기에 든 선은 가지만 그리므로
 * 끝점은 그 줄기가 도착 노드에 닿는 점이다.
 */
const linesOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge .edge[data-key]:not(.edge-trunk)")].map((edge) => {
      const line = edge.querySelector(".edge-line");
      const total = line.getTotalLength();
      const stem = edge.dataset.branch === undefined || edge.hasAttribute("data-whole") ? null : document.querySelector(`.edge-trunk[data-key="${CSS.escape(edge.dataset.branch)}"] .edge-line`);
      const [start, end] = [line.getPointAtLength(0), stem === null ? line.getPointAtLength(total) : stem.getPointAtLength(stem.getTotalLength())];
      return {
        key: edge.dataset.key,
        trunk: edge.dataset.branch ?? null,
        start: { x: start.x, y: start.y },
        end: { x: end.x, y: end.y },
        width: parseFloat(getComputedStyle(line).strokeWidth),
        glow: getComputedStyle(line).filter !== "none",
        layer: getComputedStyle(edge.closest("svg")).zIndex,
        pointed: edge.hasAttribute("data-pointed"),
        tone: edge.classList.contains("tone-strong") ? "strong" : "muted",
        opacity: Number(getComputedStyle(edge).opacity),
        stroke: getComputedStyle(line).stroke,
        // 선 가운데 숫자의 글자색. 숫자가 없는 선은 null이다.
        digits: edge.querySelector(".edge-weight") === null ? null : getComputedStyle(edge.querySelector(".edge-weight")).fill,
      };
    }),
  );

/** 숫자가 있는 선마다 숫자의 글자색이 선의 색과 같은지. 숫자는 선과 같은 요소 안에 있어 불투명도를 함께 받는다. */
const digitsMatch = (lines) => lines.filter((line) => line.digits !== null).every((line) => line.digits === line.stroke);

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
    const edge = [...document.querySelectorAll(".react-flow__edge .edge[data-key]:not(.edge-trunk)")].find((e) => e.dataset.key === want);
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

/** 접힌 폴더를 파일트리의 폴더 행으로 펼친다. 이미 펼친 폴더는 그대로 둔다. */
async function openFolder(page, id) {
  if ((await count(page, `${node(id)} > .node-package`)) === 0) {
    return;
  }
  await page.click(`.tree-row.tree-dir[data-node="${id}"]`);
  await page.waitForSelector(`${node(id)} > .node-region`, { timeout: 30_000 });
  await settle(page);
}

/**
 * 화면을 연다. 레포는 폴더를 접은 채로 열리므로, unfold가 참이면 소스 루트 바로 아래의 접힌 폴더를 파일트리의 폴더 행으로 차례로
 * 펼치고 "화면 맞춤"으로 그래프 전체를 맞춘다. 폴더 안의 파일 상자를 보는 시나리오는 이 화면에서 시작한다.
 */
async function load(page, at = url, unfold = true) {
  await page.goto(at);
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  if (!unfold) {
    return;
  }
  const graph = await api("/api/graph", at);
  for (const folder of graph.nodes.filter((n) => n.kind === "package" && n.parent === null && !n.test)) {
    if ((await count(page, `${node(folder.id)} > .node-package`)) === 0) {
      continue;
    }
    await openFolder(page, folder.id);
    await page.getByRole("button", { name: "화면 맞춤" }).click();
    await page.mouse.move(1, 1);
    await settle(page);
  }
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
/** 필터 창을 열고 fn을 부른 뒤 닫는다. 이미 열려 있으면 열고 닫지 않는다. */
async function inFilters(page, fn) {
  const opened = (await count(page, ".filter-panel")) > 0;
  if (!opened) {
    await page.click(".filter-button");
    await page.waitForSelector(".filter-panel", { timeout: 5_000 });
  }
  try {
    return await fn();
  } finally {
    if (!opened && (await count(page, ".filter-panel")) > 0) {
      await page.click(".filter-button");
    }
  }
}

/** 필터 창의 토글 name을 켜거나 끈다. */
const setToggle = (page, name, on) => inFilters(page, () => page.locator(".filter-panel").getByLabel(name).setChecked(on));
/** 필터 창의 토글 name이 켜져 있는지 */
const toggled = (page, name) => inFilters(page, () => page.locator(".filter-panel").getByLabel(name).isChecked());

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
/** 두 사각형이 겹치지 않는지, inner가 outer 안에 있는지 */
const apart = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
const within = (inner, outer) =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;

const tipText = (page) => page.evaluate(() => document.querySelector(".tooltip")?.textContent ?? "");

/** 요소 가운데에 마우스를 올리고 말풍선 글을 읽는다. */
async function tipOver(page, selector) {
  const rect = await rectOf(page, selector);
  await page.mouse.move(rect.x + rect.width / 2 - 1, rect.y + rect.height / 2);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.waitForSelector(".tooltip", { timeout: 3_000 }).catch(() => {});
  return tipText(page);
}

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
    "정보 패널이 관계 그래프 영역의 오른쪽 끝에 붙어 영역 폭의 30%를 차지하고 위에서 아래까지 빈틈없이 찬다",
    near(gaps.top, 0) && near(gaps.bottom, 0) && near(gaps.right, 0) && near(panel.width, area.width * PANEL_SHARE),
    `여백 위 ${gaps.top}, 오른쪽 ${gaps.right}, 아래 ${gaps.bottom}, 패널 ${panel.width}×${panel.height}, 영역 높이 ${area.height}`,
  );
  const badges = await page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node .node-module > .badge-inside")].map((badge) => ({
      id: badge.closest(".react-flow__node").dataset.id.replace(/#face$/, ""),
      count: Number(badge.textContent),
    })),
  );
  const inside = (id) => graph.nodes.filter((n) => n.parent === id && !n.test).length;
  t.check(
    "접힌 파일 상자의 배지가 그 파일에 든 함수·클래스 수이고 미확인 호출 수 배지는 없다",
    badges.length > 0 && badges.every((badge) => badge.count === inside(badge.id)) && (await count(page, ".badge-unresolved")) === 0,
    `배지 ${badges.length}개의 합 ${badges.reduce((sum, badge) => sum + badge.count, 0)}`,
  );
}

async function file(t, page) {
  await load(page);
  const before = { columns: columnsOf(await boxes(page)), zoom: await zoomOf(page), panel: await rectOf(page, ".info-panel") };
  await pick(page, FILE);
  const graph = await api("/api/graph");
  const all = await boxes(page);
  const [functions, defined] = [await count(page, ".react-flow__node .node-body.node-function"), definedIn(graph, FILE).filter((n) => n.kind === "function" || n.kind === "method").length];
  const stages = stagesOf(graph, FILE);
  const outer = definedIn(graph, FILE).filter((n) => (n.kind === "function" || n.kind === "method") && (stages.outer.includes(n.id) || stages.outer.includes(n.parent))).length;
  t.check(
    `파일 밖과 이어진 함수 노드 ${outer}개가 나타나고 나머지는 "안쪽 ${stages.inner.length}개" 손잡이에 든다`,
    outer > 0 && functions === outer && (await packOf(page, FILE))?.text.startsWith(`안쪽 ${stages.inner.length}개`),
    `${functions}개, 손잡이 "${(await packOf(page, FILE))?.text ?? "없음"}"`,
  );
  const opened = all.filter((b) => b.open).map((b) => b.id);
  t.check("다른 파일 상자는 접혀 있다", same(opened, [FILE]), `펼친 상자 ${opened.join(", ")}`);
  t.check("누르기 전과 후에 파일 상자의 열 순서와 열 안 순서가 같다", same(columnsOf(all), before.columns), JSON.stringify(columnsOf(all)));
  await page.waitForSelector(".info-panel .monaco-editor .line-numbers", { timeout: 30_000 });
  const [panel, summary, code] = [await rectOf(page, ".info-panel"), await rectOf(page, ".info-panel-summary"), await rectOf(page, ".info-panel .code")];
  t.check(
    "패널의 사각형이 고르기 전과 같고, LLM 요약 칸이 패널 높이의 4분의 1을 넘지 않으며 코드 뷰어가 나머지 높이를 쓴다",
    sameRect(panel, before.panel) && summary.height <= panel.height / 4 + 1 && near(code.y + code.height, panel.y + panel.height - 1),
    `패널 ${rectText(before.panel)} → ${rectText(panel)}, 요약 칸 ${summary.height}, 코드 뷰어 ${code.height}`,
  );
  const rows = await codeRows(page);
  t.check(
    "코드 뷰어가 파일의 1번 줄부터 보이고 흐린 줄이 없다",
    rows[0]?.line === 1 && rows.every((row) => !row.dim),
    `첫 줄 번호 ${rows[0]?.line}, 흐린 줄 ${rows.filter((row) => row.dim).length}개`,
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
  t.check(
    "펼친 arbiter.py 상자와 안의 함수는 배지가 없고, 머리 줄이 안에 든 함수의 미확인 호출 수 합을 적는다",
    unresolved > 0 && (await count(page, `${face(FILE)} .badge-inside`)) === 0 && (await count(page, ".badge-unresolved")) === 0 && title.includes(`미확인 호출 ${unresolved}곳`),
    `그래프 ${unresolved}, 머리 줄 ${title.replaceAll("\n", " / ")}`,
  );
  const { clear } = await stageOf(page);
  const box = await rectOf(page, node(FILE));
  const placed = (start, length, from, room) =>
    length > room ? near(start, from + INSET) : near(start + length / 2, from + room / 2);
  t.check(
    "arbiter.py 상자의 중심이 패널과 왼쪽 아래 칸을 뺀 영역의 중심에 있거나, 상자가 영역보다 긴 축에서는 시작 끝이 20px 안쪽에 있다",
    placed(box.x, box.width, clear.x, clear.width) && placed(box.y, box.height, clear.y, clear.height),
    `상자 (${box.x.toFixed(1)}, ${box.y.toFixed(1)}) ${box.width.toFixed(0)}×${box.height.toFixed(0)}, 영역 (${clear.x.toFixed(1)}, ${clear.y.toFixed(1)}) ${clear.width.toFixed(0)}×${clear.height.toFixed(0)}`,
  );
  await clickPack(page, FILE);
  const whole = await count(page, ".react-flow__node .node-body.node-function");
  t.check(`손잡이를 누르면 함수 노드 ${defined}개가 모두 나타난다`, defined > 0 && whole === defined, `${whole}개`);
}

/** 파일 상자를 펼치고 함수를 고른 뒤 function 시나리오의 확인 항목을 본다. dark 시나리오가 함께 쓴다. */
async function focused(t, page) {
  const opened = await rectOf(page, ".info-panel");
  await pick(page, FILE);
  const before = await zoomOf(page);
  await pick(page, FUNCTION);
  // 화면이 옮겨져 마우스 아래에 온 선이 굵어지지 않도록 마우스를 그래프 밖에 두고 선의 불투명도가 돌아오기를 기다린다.
  await page.mouse.move(5, 5);
  await settle(page);
  await page.waitForTimeout(300);
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
  const { clear } = await stageOf(page);
  const [at, middle] = [center(await rectOf(page, node(FUNCTION))), center(clear)];
  t.check(
    "확대 비율이 누르기 전과 같고 고른 함수의 중심이 패널과 왼쪽 아래 칸을 뺀 영역의 중심에서 1px 안에 있다",
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
  /** 기본 사각형이 지금의 관계 그래프 영역에서 오른쪽 끝에 붙어 폭의 30%(최소 폭보다 좁으면 최소 폭)와 높이 전체를 차지하는지 */
  const docked = async () => {
    const { area, panel: box } = await stageOf(page);
    const width = Math.max(PANEL_MIN, Math.round(area.width * PANEL_SHARE));
    const ok = near(box.width, width) && near(box.x + box.width, area.x + area.width) && near(box.y, area.y) && near(box.height, area.height);
    return { ok, text: `영역 ${Math.round(area.width)}×${Math.round(area.height)}, 패널 ${rectText(box)}, 기대 폭 ${width}` };
  };
  /** 창 크기를 바꾼 뒤 기본 패널이 새 영역에 다시 놓일 때까지 기다린다. */
  const redocked = async () => {
    await page
      .waitForFunction(
        ([share, least]) => {
          const [box, stage] = [document.querySelector(".info-panel").getBoundingClientRect(), document.querySelector(".stage").getBoundingClientRect()];
          return Math.abs(box.width - Math.max(least, Math.round(stage.width * share))) <= 1 && Math.abs(box.right - stage.right) <= 1 && Math.abs(box.height - stage.height) <= 1;
        },
        [PANEL_SHARE, PANEL_MIN],
        { timeout: 5_000 },
      )
      .catch(() => {});
    await settle(page);
  };
  for (const width of [1280, 720]) {
    await page.setViewportSize({ width, height: VIEW.height });
    await redocked();
    const narrow = await docked();
    t.check(`창 폭을 ${width}px로 바꾸면 기본 패널이 영역 폭의 30%를 따라 다시 놓인다`, narrow.ok, narrow.text);
  }
  await page.setViewportSize(VIEW);
  await redocked();
  const wide = await docked();
  t.check("기본 패널은 영역의 오른쪽 끝에 붙어 영역 폭의 30%와 상단 줄 아래의 높이 전체를 차지한다", wide.ok && sameRect(await rectOf(page, ".info-panel"), start), wide.text);
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

/** 코드 뷰어에 보이는 줄마다 줄 번호와 흐린 글자가 있는지, 코드 뷰어 위 끝에서 잰 높이. 위에서 아래 순서다. */
const codeRows = (page) =>
  page.evaluate(() => {
    const editor = document.querySelector(".info-panel .monaco-editor");
    const top = document.querySelector(".info-panel .code").getBoundingClientRect().top;
    const at = (element) => Math.round(element.getBoundingClientRect().top - top);
    const numbers = new Map([...editor.querySelectorAll(".line-numbers")].map((element) => [at(element), Number(element.textContent)]));
    return [...editor.querySelectorAll(".view-line")]
      .map((element) => ({ line: numbers.get(at(element)) ?? null, dim: element.querySelector(".code-dim") !== null, blank: element.textContent.trim() === "", y: at(element) }))
      .filter((row) => row.line !== null)
      .sort((a, b) => a.y - b.y);
  });

/** 파일을 고르면 파일 전체가, 함수를 고르면 파일 전체에서 그 함수 밖의 줄만 흐리게 보이는지 본다. */
async function codeScope(t, page) {
  const asked = [];
  page.on("request", (request) => {
    const at = new URL(request.url());
    if (at.pathname === "/api/file") {
      asked.push(at.searchParams.get("path"));
    }
  });
  await load(page);
  const graph = await api("/api/graph");
  const find = (id) => graph.nodes.find((n) => n.id === id);
  const [target, path] = [find(FUNCTION), find(FUNCTION).path];
  const total = (await api(`/api/file?path=${encodeURIComponent(path)}`)).text.split("\n").length;
  /** 같은 파일에서 고른 함수보다 뒤에 정의된 함수 */
  const later = graph.nodes.find((n) => n.kind === "function" && n.path === path && n.range[0] > target.range[1]);
  /** 줄 번호가 range 밖인 줄만, 그리고 빈 줄이 아니면 모두 흐린가 */
  const dimmedOutside = (rows, range) => rows.every((row) => (row.line < range[0] || row.line > range[1] ? row.dim || row.blank : !row.dim));

  /** 코드 뷰어에 line번 줄 번호가 보일 때까지 기다린다. */
  const waitLine = (line) =>
    page.waitForFunction((n) => [...document.querySelectorAll(".info-panel .monaco-editor .line-numbers")].some((e) => e.textContent === String(n)), line, { timeout: 30_000 }).catch(() => {});

  await pickInTree(page, { id: FUNCTION, owner: FILE });
  await waitLine(target.range[0]);
  await page.waitForTimeout(300);
  const code = await rectOf(page, ".info-panel .code");
  const opened = await codeRows(page);
  t.check(
    `함수를 고르면 정의의 첫 줄 ${target.range[0]}번이 코드 뷰어 맨 위에 있고 그 줄부터 흐리지 않다`,
    opened[0]?.line === target.range[0] && near(opened[0].y, 0, 2) && dimmedOutside(opened, target.range),
    `첫 줄 번호 ${opened[0]?.line}, 높이 ${opened[0]?.y}`,
  );
  await page.mouse.move(code.x + code.width / 2, code.y + code.height / 2);
  for (let i = 0; i < 10; i += 1) {
    await page.mouse.wheel(0, -40);
  }
  await page.waitForTimeout(300);
  const above = await codeRows(page);
  t.check(
    "위로 스크롤하면 정의 앞의 줄이 흐린 글자로 보이고 정의의 줄은 문법 색 그대로다",
    above[0]?.line < target.range[0] && above.some((row) => row.dim) && above.some((row) => row.line >= target.range[0]) && dimmedOutside(above, target.range),
    `보이는 줄 ${above[0]?.line}~${above.at(-1)?.line}, 흐린 줄 ${above.filter((row) => row.dim).length}개`,
  );
  const colors = await page.evaluate(() => {
    const editor = document.querySelector(".info-panel .monaco-editor");
    const dim = getComputedStyle(editor.querySelector(".code-dim")).color;
    /** 줄 번호와 코드 사이 칸에서 테두리를 그리는 장식 수 */
    const marks = [...editor.querySelectorAll(".margin-view-overlays .cldr")].filter((mark) => parseFloat(getComputedStyle(mark).borderLeftWidth) > 0).length;
    return { dim, marks };
  });
  const muted = await colorOf(page, "--muted");
  t.check("흐린 글자의 색이 --muted이고 줄 번호 옆에 세로 줄이 없다", colors.dim === muted.rgb && colors.marks === 0, `${colors.dim}, 세로 줄 ${colors.marks}개`);
  await t.shot();
  await drag(page, center(await rectOf(page, ".info-panel .monaco-editor .scrollbar.vertical .slider")), 0, code.height);
  await page.waitForTimeout(300);
  const bottom = await codeRows(page);
  t.check(
    `맨 아래로 스크롤하면 마지막 줄 번호가 파일의 줄 수 ${total}이고 정의 뒤의 줄이 흐리다`,
    bottom.at(-1)?.line === total && dimmedOutside(bottom, target.range),
    `마지막 줄 번호 ${bottom.at(-1)?.line}`,
  );

  await page.click(`.tree-row.tree-symbol[data-node="${later.id}"]`);
  await waitSelected(page, later.id);
  await waitLine(later.range[0]);
  await page.waitForTimeout(300);
  const moved = await codeRows(page);
  t.check(
    `같은 파일의 다른 함수를 고르면 그 정의의 첫 줄 ${later.range[0]}번이 맨 위로 오고 흐린 범위가 바뀐다`,
    moved[0]?.line === later.range[0] && dimmedOutside(moved, later.range),
    `첫 줄 번호 ${moved[0]?.line}`,
  );
  await page.click(`.tree-row.tree-file[data-node="${FILE}"]`);
  await waitSelected(page, FILE);
  await waitLine(1);
  await page.waitForTimeout(300);
  const whole = await codeRows(page);
  t.check(
    "그 파일을 고르면 1번 줄부터 보이고 흐린 줄이 없다",
    whole[0]?.line === 1 && whole.every((row) => !row.dim),
    `첫 줄 번호 ${whole[0]?.line}, 흐린 줄 ${whole.filter((row) => row.dim).length}개`,
  );
  t.check(`함수 둘과 파일을 차례로 고르는 동안 /api/file 요청이 ${path} 한 번뿐이다`, same(asked, [path]), asked.join(", "));
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
  // Path에 올리면 뜨는 hover 상자가 아래 줄의 extract_today_items를 덮으므로, 상자가 사라진 뒤에 그 이름으로 옮긴다.
  const inside = await wordRect(page, "extract_today_items");
  await page.keyboard.down(MOD);
  const outer = await linked(await wordRect(page, "Path"));
  await page.keyboard.up(MOD);
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => [...document.querySelectorAll(".monaco-hover")].every((box) => box.classList.contains("hidden") || box.getClientRects().length === 0), null, { timeout: 5_000 }).catch(() => {});
  await page.keyboard.down(MOD);
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

  const muted = (await colorOf(page, "--muted")).rgb;
  const border = await page.evaluate(() => getComputedStyle(document.querySelector(".react-flow__node > .node-body.node-module")).borderTopColor);
  t.check(
    "고른 노드가 없으면 모든 선이 muted 잉크에 불투명도 0.5여서 불투명도 1인 상자 테두리보다 연하다",
    lines.length > 0 && lines.every((line) => line.tone === "muted" && line.opacity === 0.5 && line.stroke === muted) && border === muted,
    `선 ${lines.length}개, 불투명도 ${[...new Set(lines.map((line) => line.opacity))].join("·")}, 상자 테두리 ${border}`,
  );
  t.check("고른 노드가 없을 때 선 가운데 숫자의 색이 선의 색과 같다", digitsMatch(lines) && lines.some((line) => line.digits !== null), `숫자 ${lines.filter((line) => line.digits !== null).length}개`);

  // 마우스를 올린 선
  const { line: first, at: spot } = await hittable(page, [...leaving.filter((line) => !entries.has(ends(line)[1])), ...lines]);
  await page.mouse.move(spot.x, spot.y);
  await page.waitForSelector(".edge[data-pointed]", { timeout: 5_000 }).catch(() => {});
  // 불투명도가 바뀌는 200ms가 지난 뒤에 읽는다.
  await page.waitForTimeout(300);
  const over = (await linesOf(page)).find((line) => line.key === first.key);
  const rest = (await linesOf(page)).filter((line) => line.key !== first.key);
  t.check(
    "선에 마우스를 올리면 그 선만 굵어지고 빛을 두르며 본문 잉크로 다른 선 위의 층에 그려진다",
    over.pointed && over.width > first.width && over.glow && over.tone === "strong" && over.opacity === 1 && over.layer === "5" &&
      rest.every((line) => !line.pointed && line.layer === "4" && !line.glow),
    `굵기 ${first.width} → ${over.width}, 층 ${first.layer} → ${over.layer}, 진하기 ${first.tone} → ${over.tone}`,
  );
  t.check(
    "마우스를 올린 선의 숫자도 본문 잉크로 바뀐다",
    over.digits === null ? digitsMatch(rest) : over.digits === over.stroke && over.stroke === (await colorOf(page, "--ink")).rgb,
    `선 ${over.stroke}, 숫자 ${over.digits ?? "없음"}`,
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
  const focusedLines = await linesOf(page);
  const levels = [...new Set(focusedLines.map((line) => `${line.tone} ${line.opacity}`))].sort();
  t.check(
    "노드를 고르면 닿는 선은 본문 잉크 1, 그 밖의 선은 muted 1이나 0.2이고, 세 단계 모두 숫자의 색이 선의 색과 같다",
    levels.includes("strong 1") && levels.includes("muted 0.2") && levels.every((level) => ["strong 1", "muted 1", "muted 0.2"].includes(level)) && digitsMatch(focusedLines),
    levels.join(", "),
  );
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
  // 앞의 클릭과 같은 선의 같은 점일 수 있으므로 더블클릭으로 세지 않게 띄운다.
  await page.waitForTimeout(600);
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
  const site = Number((await page.textContent(".info-panel-site .info-panel-hint")).trim().split(":").at(-1));
  await page.click(".info-panel-site");
  await page.waitForSelector(".info-panel .monaco-editor .code-range", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const [painted, viewer] = [await rectOf(page, ".info-panel .monaco-editor .code-range"), await rectOf(page, ".info-panel .code")];
  const shownRows = await codeRows(page);
  const row = painted === null ? undefined : shownRows.find((r) => near(r.y, painted.y - viewer.y, 2));
  t.check(
    `코드 줄 목록의 첫 줄을 누르면 코드 뷰어가 파일 전체에서 ${site}번 줄을 칠해 보인다`,
    row?.line === site && !row.dim && painted.y >= viewer.y && painted.y + painted.height <= viewer.y + viewer.height,
    `칠한 줄 ${row?.line}, 보이는 줄 ${shownRows[0]?.line}~${shownRows.at(-1)?.line}`,
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

async function badgeTip(t, page) {
  await load(page);
  const over = (selector) => tipOver(page, selector);
  const counted = await page.evaluate(() => {
    const badge = document.querySelector(".node-face.node-module .badge-inside");
    return { id: badge.closest(".react-flow__node").dataset.id, count: badge.textContent };
  });
  const id = counted.id.replace(/#face$/, "");
  const inside = await over(`${face(id)} .badge-inside`);
  t.check(
    "접힌 파일 상자의 배지에 올리면 말풍선이 안에 든 함수·클래스 수와 보는 방법을 적는다",
    inside === `안에 든 함수·클래스 ${counted.count}개 · 고르면 보인다`,
    inside.replaceAll("\n", " / "),
  );
  await t.shot();
  const name = await over(`${face(id)} .node-label`);
  t.check("같은 상자의 이름표로 옮기면 말풍선이 그 파일의 이름과 종류로 바뀐다", name.endsWith(" · 파일") && !name.includes("안에 든"), name);
  const loc = await over(`${face(id)} .loc`);
  t.check("이름표 옆 숫자에 올리면 줄 수임을 적는다", /^줄 수 \d+줄 · 빈 줄을 뺀 수$/.test(loc), loc);
  const entry = await over(`${face(FILE)} .node-entry`);
  t.check("진입점 표시에 올리면 진입점임을 적는다", entry.startsWith("진입점"), entry);
  t.check("배지와 표시가 브라우저 기본 말풍선(title)을 쓰지 않는다", (await count(page, ".react-flow__node [title]")) === 0, `title 속성 ${await count(page, ".react-flow__node [title]")}개`);
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => document.querySelector(".tooltip") === null, null, { timeout: 3_000 }).catch(() => {});
  t.check("노드 밖으로 나가면 말풍선이 사라진다", (await count(page, ".tooltip")) === 0);
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
    for (const edge of document.querySelectorAll(".react-flow__edge .edge[data-key]:not(.edge-trunk)")) {
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
    t.skip("영역의 빈 곳을 누르면 폴더가 접히지 않는다", "화면에 보이는 영역에 빈 곳이 없다");
  } else {
    await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(600);
    await settle(page);
    t.check(
      "영역의 빈 곳을 누르면 폴더가 접히지 않는다",
      blank !== null && (await selectedOf(page)) === null && (await count(page, area)) === 1 && same(columnsOf(await boxes(page), inside), before),
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
  for (const target of [0.2, 0.3, 0.6, 1.0]) {
    const got = await zoomTo(page, target);
    seen.push({
      target,
      got,
      ...(await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".node-table-row")];
        const fields = [...document.querySelectorAll(".node-face .node-field")];
        const shown = (element) => getComputedStyle(element).visibility === "visible" && element.getBoundingClientRect().height > 0;
        return {
          band: document.querySelector(".graph").dataset.zoom,
          rows: rows.length,
          visible: rows.filter(shown).length,
          fields: fields.length,
          written: fields.filter((field) => shown(field) && field.textContent !== "").length,
        };
      })),
    });
  }
  const text = seen.map((s) => `${s.got.toFixed(2)}에서 ${s.visible}/${s.rows}칸, 글자 ${s.written}/${s.fields}개`).join(", ");
  t.check(
    "축소해도 데이터 클래스 필드 칸의 경계선과 글자가 그려진다. 0.2, 0.3, 0.6, 1.0에서 모두 보인다",
    seen.every((s) => near(s.got, s.target, 0.01) && s.rows > 0 && s.visible === s.rows && s.fields > 0 && s.written === s.fields),
    text,
  );
  t.check("확대 비율 구간 data-zoom이 0, 0, 1, 2로 바뀐다", same(seen.map((s) => s.band), ["0", "0", "1", "2"]), seen.map((s) => s.band).join(", "));
}

/** 테스트 코드를 켜고 파일을 하나씩 펼쳐, 화면에 보이는 모든 글자와 배지의 가운데 점에서 그 노드가 눌리는지 센다. */
async function labels(t, page) {
  await load(page);
  const graph = await api("/api/graph");
  const files = graph.nodes.filter((n) => n.kind === "module").map((n) => n.id);
  const classes = new Set(graph.nodes.filter((n) => n.kind === "class").map((n) => n.id));
  await setToggle(page, "테스트 코드", true);
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
  await setToggle(page, "외부 노드", true);
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
  // 파일을 고른 펼침 단계에서 보이는 함수(파일 밖과 이어진 함수)를 고른다.
  const graph = await api("/api/graph");
  const shownFunction = stagesOf(graph, FILE).outer.find((id) => graph.nodes.find((n) => n.id === id).kind === "function");
  await pick(page, shownFunction);
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

/** LLM 요약 칸과 코드 뷰어 사이의 경계선을 끌어 두 영역의 높이를 바꾼다. */
async function split(t, page) {
  await answerSummaryReads(page, () => ({ summary: null, stale: false, available: true, reason: null }));
  const open = async () => {
    await pick(page, FILE);
    await pick(page, FUNCTION);
    await page.waitForSelector(".info-panel .monaco-editor .line-numbers", { timeout: 30_000 });
    await page.waitForSelector(".info-panel-summary .summary-make", { timeout: 10_000 });
  };
  const sizes = async () => ({
    panel: await rectOf(page, ".info-panel"),
    summary: (await rectOf(page, ".info-panel-summary")).height,
    code: (await rectOf(page, ".info-panel .code")).height,
    editor: (await rectOf(page, ".info-panel .monaco-editor")).height,
  });
  const pull = async (dy) => {
    await drag(page, center(await rectOf(page, ".info-panel-divide")), 0, dy);
    await page.waitForTimeout(300);
    return sizes();
  };
  const text = (s) => `요약 칸 ${s.summary.toFixed(1)}, 코드 뷰어 ${s.code.toFixed(1)}`;
  await load(page);
  t.check("노드를 고르지 않았으면 경계선이 없다", (await count(page, ".info-panel-divide")) === 0);
  await open();
  const start = await sizes();
  const cursor = await page.evaluate(() => getComputedStyle(document.querySelector(".info-panel-divide")).cursor);
  t.check("요약이 없는 함수에서도 요약 칸과 코드 뷰어 사이에 row-resize 커서의 경계선이 있다", cursor === "row-resize" && start.summary < start.panel.height / 4, `커서 ${cursor}, ${text(start)}`);
  const lower = await pull(140);
  t.check(
    "경계선을 아래로 140px 끌면 요약 칸이 140px 늘고 코드 뷰어가 140px 줄며 Monaco가 코드 뷰어의 높이를 따른다",
    near(lower.summary, start.summary + 140, 1.5) && near(lower.code, start.code - 140, 1.5) && sameRect(lower.panel, start.panel) && near(lower.editor, lower.code, 2),
    `${text(start)} → ${text(lower)}, Monaco ${lower.editor.toFixed(1)}`,
  );
  await t.shot();
  await page.reload();
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  await open();
  const kept = await sizes();
  t.check("새로 고친 뒤에도 요약 칸의 높이가 유지된다", near(kept.summary, lower.summary, 1.5) && near(kept.code, lower.code, 1.5), text(kept));
  await drag(page, center(await rectOf(page, '.info-panel-resize[data-dir="s"]')), 0, -300);
  await page.waitForTimeout(300);
  const shorter = await sizes();
  t.check(
    "패널의 높이를 줄이면 요약 칸이 패널 높이에 대한 비율을 유지한다",
    shorter.panel.height < kept.panel.height - 100 && near(shorter.summary / shorter.panel.height, kept.summary / kept.panel.height, 0.005),
    `패널 ${kept.panel.height.toFixed(0)} → ${shorter.panel.height.toFixed(0)}, ${text(shorter)}`,
  );
  const [top, bottom] = [await pull(-2000), await pull(2000)];
  t.check("끝까지 끌어도 요약 칸은 56px, 코드 뷰어는 96px 아래로 줄지 않는다", near(top.summary, 56, 1.5) && near(bottom.code, 96, 1.5), `위로 ${text(top)}, 아래로 ${text(bottom)}`);
  await page.dblclick(".info-panel-divide");
  await page.waitForTimeout(300);
  const again = await sizes();
  t.check("경계선을 더블클릭하면 요약 칸이 끌기 전의 높이로 돌아간다", near(again.summary, start.summary, 1) && sameRect(again.panel, shorter.panel), text(again));
  await pull(140);
  await page.dblclick(".info-panel-head");
  await settle(page);
  const reset = await sizes();
  t.check(
    "머리 줄을 더블클릭하면 패널의 사각형과 요약 칸의 높이가 처음 값으로 돌아간다",
    sameRect(reset.panel, start.panel) && near(reset.summary, start.summary, 1) && near(reset.code, start.code, 1),
    `패널 ${rectText(reset.panel)}, ${text(reset)}`,
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
/**
 * id 노드가 단 도는 원이 shape 모양의 왼쪽 위 모서리에서 왼쪽과 위로 나간 폭(확대 비율로 나눈 값)과, 도는 원이 그 노드의
 * 이름표와 겹치는지. 도는 원은 돌면서 화면 사각형이 바뀌므로 돌리기 전의 위치(offsetLeft, offsetTop)로 잰다.
 */
const busyAt = (page, id, shape) =>
  page.evaluate(
    ([faceSel, shapeSel]) => {
      const badge = document.querySelector(`${faceSel} .badge-busy`);
      const outline = document.querySelector(shapeSel);
      if (badge === null || outline === null) {
        return null;
      }
      const parent = badge.offsetParent;
      const [from, box] = [parent.getBoundingClientRect(), outline.getBoundingClientRect()];
      const scale = from.width / parent.offsetWidth;
      const [x, y, size] = [from.left + (parent.clientLeft + badge.offsetLeft) * scale, from.top + (parent.clientTop + badge.offsetTop) * scale, badge.offsetWidth * scale];
      const covers = [...document.querySelectorAll(`${faceSel} .node-label`)].some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.left < x + size && x < rect.right && rect.top < y + size && y < rect.bottom;
      });
      return { left: (box.left - x) / scale, above: (box.top - y) / scale, covers, animated: getComputedStyle(badge).animationName !== "none" };
    },
    [face(id), shape],
  );
/** 도는 원이 모양의 왼쪽 위 모서리에 세로 가운데를 맞추고 왼쪽으로 6px 나갔으며 이름표를 덮지 않는가 */
const atCorner = (at) => at !== null && near(at.left, 6, 0.5) && near(at.above, 7, 0.5) && !at.covers;
const cornerText = (at) => (at === null ? "도는 원 없음" : `왼쪽으로 ${at.left.toFixed(1)}px, 위로 ${at.above.toFixed(1)}px${at.covers ? ", 이름표와 겹침" : ""}`);

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
  const spinning = await busyAt(page, target.id, `${face(target.id)} .node-circle`);
  t.check(
    '"요약 생성"을 누르면 그 함수의 원 왼쪽 위 모서리에 도는 원이 붙는다',
    held.length === 1 && (await busy(target.id)) === 1 && spinning?.animated === true && atCorner(spinning),
    `POST ${held.length}번, ${cornerText(spinning)}`,
  );
  await t.shot();

  // 함수 시점 뷰에서도 그 함수의 원이 같은 곳에 도는 원을 단다.
  await clickNode(page, target.id, 2);
  await page.waitForSelector(`${face(target.id)} .node-call .badge-busy`, { timeout: 30_000 }).catch(() => {});
  await settle(page);
  const called = await busyAt(page, target.id, `${face(target.id)} .node-circle`);
  t.check("함수 시점 뷰에서도 그 함수의 원 왼쪽 위 모서리에 도는 원이 붙는다", (await count(page, ".node-call .badge-busy")) === 1 && atCorner(called), cornerText(called));
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForSelector(`${face(target.id)} .node-function .badge-busy`, { timeout: 30_000 }).catch(() => {});
  await settle(page);

  // 다른 파일의 함수를 고르면 요약을 만들던 함수가 화면에서 사라지고 그 함수가 든 파일 상자가 배지를 단다.
  await pickInTree(page, { id: FUNCTION, owner: FILE });
  await page.waitForSelector(`${face(target.owner)} .badge-busy`, { timeout: 5_000 }).catch(() => {});
  await settle(page);
  const boxed = await busyAt(page, target.owner, node(target.owner));
  t.check(
    "다른 파일의 함수를 골라도 요청을 끊지 않고, 접힌 파일 상자의 왼쪽 위 모서리에 도는 원이 붙는다",
    aborted.length === 0 && (await count(page, node(target.id))) === 0 && (await busy(target.owner)) === 1 && atCorner(boxed),
    `끊은 POST ${aborted.length}번, ${target.owner} 상자의 도는 원 ${await busy(target.owner)}개, ${cornerText(boxed)}`,
  );
  if (folderId === null) {
    t.skip("그 파일이 든 폴더를 접으면 접힌 폴더 상자의 왼쪽 위 모서리에 도는 원이 붙는다", `${target.owner}가 폴더 안에 있지 않다`);
  } else {
    const row = `.tree-row.tree-dir[data-node="${folderId}"]`;
    await page.click(row);
    await page.waitForSelector(`${node(folderId)} > .node-body.node-package`, { timeout: 30_000 });
    await settle(page);
    const folded = await busyAt(page, folderId, node(folderId));
    t.check(
      "그 파일이 든 폴더를 접으면 접힌 폴더 상자의 왼쪽 위 모서리에 도는 원이 붙는다",
      (await busy(folderId)) === 1 && aborted.length === 0 && atCorner(folded),
      `${folderId}/ 상자의 도는 원 ${await busy(folderId)}개, ${cornerText(folded)}`,
    );
    await page.click(row);
    await page.waitForSelector(`.tree-row.tree-file[data-node="${target.owner}"]`, { timeout: 10_000 });
  }

  // 진입점 파일의 함수 요약을 만드는 중에 그 파일 상자를 접으면 도는 원이 이름표 앞의 진입점 표지를 덮지 않는다.
  await page.click(".info-panel-summary .summary-make");
  await pickInTree(page, target);
  await page.waitForSelector(`${face(FILE)} .badge-busy`, { timeout: 5_000 }).catch(() => {});
  await settle(page);
  const entry = await busyAt(page, FILE, node(FILE));
  t.check(
    "진입점 파일 상자의 도는 원도 왼쪽 위 모서리에 있고 진입점 표지와 이름표를 덮지 않는다",
    (await count(page, `${face(FILE)} .node-entry`)) === 1 && atCorner(entry),
    cornerText(entry),
  );
  held[1].answer(longSummary(1));
  await page.waitForFunction(() => document.querySelectorAll(".badge-busy").length === 1, null, { timeout: 5_000 }).catch(() => {});

  if (extra === null) {
    t.skip("배지가 있는 접힌 상자는 도는 원을 왼쪽 위에, 안에 든 것의 수 배지를 오른쪽 위에 단다", "미확인 호출이 있는 파일이 없다");
  } else {
    await pickInTree(page, extra);
    await page.click(".info-panel-summary .summary-make");
    await pickInTree(page, { id: FUNCTION, owner: FILE });
    await page.waitForSelector(`${face(extra.owner)} .badge-busy`, { timeout: 5_000 }).catch(() => {});
    await settle(page);
    const both = await busyAt(page, extra.owner, node(extra.owner));
    /** 안에 든 것의 수 배지가 상자의 오른쪽과 위로 나간 폭 */
    const mark = await page.evaluate((sel) => {
      const badge = document.querySelector(sel);
      const parent = badge?.offsetParent;
      return badge == null ? null : { right: badge.offsetLeft + badge.offsetWidth - parent.clientWidth, above: -badge.offsetTop };
    }, `${face(extra.owner)} .badge-inside`);
    t.check(
      "배지가 있는 접힌 상자는 도는 원을 왼쪽 위에, 안에 든 것의 수 배지를 오른쪽 위에 단다",
      atCorner(both) && mark !== null && near(mark.right, 6, 0.5) && near(mark.above, 7, 0.5) && (await count(page, ".badge-busy")) === 2,
      `도는 원 ${cornerText(both)}, 배지 ${mark === null ? "없음" : `오른쪽으로 ${mark.right.toFixed(1)}px, 위로 ${mark.above.toFixed(1)}px`}, 도는 원 ${await count(page, ".badge-busy")}개`,
    );
    held[2].answer(longSummary(1));
  }
  held[0].answer(longSummary(1));
  await page.waitForFunction(() => document.querySelector(".badge-busy") === null, null, { timeout: 5_000 }).catch(() => {});
  t.check("요약이 다 만들어지면 도는 원이 사라진다", (await count(page, ".badge-busy")) === 0);
  await pickInTree(page, target);
  await page.waitForSelector(".info-panel-summary .summary-text", { timeout: 5_000 }).catch(() => {});
  t.check(
    "그 함수를 다시 고르면 POST를 다시 보내지 않고 만들어 둔 요약을 보인다",
    held.length === (extra === null ? 2 : 3) && (await count(page, ".info-panel-summary .summary-text")) === 1,
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
  await setToggle(page, "자동 요약", true);
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
  t.check('필터 창의 "자동 요약" 토글이 꺼진 채로 열린다', !(await toggled(page, "자동 요약")));
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

  await setToggle(page, "자동 요약", true);
  await pickInTree(page, second);
  await page.waitForFunction(() => document.querySelector(".info-panel-summary .info-panel-hint")?.textContent === "요약을 만드는 중", null, { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(500);
  t.check(
    `"자동 요약"을 켜고 ${second.id}를 고르면 버튼을 누르지 않아도 그 함수의 POST를 한 번 보낸다`,
    same(posts, [first.id, second.id]),
    `POST ${posts.join(", ") || "없음"}`,
  );
  t.check(`${first.id}를 떠나도 만들고 있던 그 함수의 POST를 끊지 않는다`, aborted.length === 0, `끊은 POST ${aborted.join(", ") || "없음"}`);
  await setToggle(page, "자동 요약", false);
  await page.waitForTimeout(500);
  t.check(
    '"자동 요약"을 꺼도 만들고 있던 POST를 끊지 않고 "요약을 만드는 중"을 그대로 보인다',
    aborted.length === 0 && (await summaryHint(page)) === "요약을 만드는 중",
    `끊은 POST ${aborted.join(", ") || "없음"}, 문구 ${await summaryHint(page)}`,
  );
  await setToggle(page, "자동 요약", true);
  await page.reload();
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  t.check('새로고침 뒤에도 "자동 요약" 토글이 켜져 있다', await toggled(page, "자동 요약"));
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
  const fake = `리마인더에서 오늘 노트의 구획을 다시 만든다.\n\n하는 일\n\`${first}\`로 오늘 항목을 모으고 \`note.todos\`를 바꾼다. \`${missing}\`는 그래프에 없다.\n- **먼저** 오늘 항목을 모은다\n- 모은 항목을 적는다\n\`\`\`\nkey = item.key\n    return key\n\`\`\`\n\n앞뒤 흐름\n${second}가 노트가 있을 때 부른다.\n\`re.sub\`만 쓴다.`;
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
  const styled = await page.evaluate(() => {
    const text = document.querySelector(".summary-text");
    const style = (element) => getComputedStyle(element);
    const [chip, link] = [[...text.querySelectorAll("code")].find((code) => code.closest(".summary-ref") === null), text.querySelector(".summary-ref code")];
    const [lead, title, body] = [text.querySelector(".summary-lead"), text.querySelector(".summary-title"), text.querySelector(".summary-part p")];
    return {
      titles: [...text.querySelectorAll(".summary-title")].map((element) => element.textContent),
      sizes: [lead, title, body].map((element) => parseFloat(style(element).fontSize)),
      weights: [lead, title, body].map((element) => Number(style(element).fontWeight)),
      chip: { filled: style(chip).backgroundColor !== "rgba(0, 0, 0, 0)", line: style(chip).textDecorationLine, cursor: style(chip).cursor, color: style(chip).color },
      link: { filled: style(link).backgroundColor !== "rgba(0, 0, 0, 0)", line: style(link).textDecorationLine, cursor: style(link).cursor, color: style(link).color },
      ink: style(text).color,
      path: [link.querySelector(".ref-path").textContent, style(link.querySelector(".ref-path")).color !== style(link).color],
      items: [...text.querySelectorAll("ul.summary-list > li")].map((item) => item.textContent),
      strong: [...text.querySelectorAll("strong")].map((element) => element.textContent),
      code: text.querySelector("pre.summary-code")?.textContent ?? null,
    };
  });
  t.check(
    "구역 제목이 본문보다 굵고, 요지가 본문보다 크고 굵다",
    same(styled.titles, ["하는 일", "앞뒤 흐름"]) && styled.weights[1] >= 600 && styled.weights[0] >= 600 && styled.weights[2] < 600 && styled.sizes[0] > styled.sizes[2] && styled.sizes[1] >= styled.sizes[2],
    `크기 ${styled.sizes.join("·")}, 굵기 ${styled.weights.join("·")}`,
  );
  const linkColor = await colorOf(page, "--link");
  t.check(
    "코드 칩은 바탕을 칠하고 본문 잉크로 적으며, 누를 수 있는 정의 표기 칩만 --link 색 글자와 손 모양 커서를 쓰고 밑줄 없이 파일 경로를 옅게 적는다",
    styled.chip.filled && styled.link.filled && styled.chip.color === styled.ink && styled.link.color !== styled.ink && styled.link.color === linkColor.rgb && styled.chip.line === "none" && styled.link.line === "none" && styled.link.cursor === "pointer" && styled.chip.cursor !== "pointer" && styled.path[0] === `${first.split("::")[0]}::` && styled.path[1],
    JSON.stringify({ chip: styled.chip, link: styled.link, 색: linkColor }),
  );
  t.check(
    "목록 기호로 시작하는 줄은 목록으로, `**`로 감싼 글은 굵게, 코드 울타리 사이의 줄은 들여쓰기를 둔 코드 블록으로 그린다",
    same(styled.items, ["먼저 오늘 항목을 모은다", "모은 항목을 적는다"]) && same(styled.strong, ["먼저"]) && styled.code === "key = item.key\n    return key",
    `목록 ${styled.items.join(" / ")}, 굵은 글씨 ${styled.strong.join(", ")}, 코드 블록 ${JSON.stringify(styled.code)}`,
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
  t.check("Esc에 연 파일만 닫히고 선택은 그대로다", (await selectedOf(page)) === FILE && (await count(page, ".info-panel-summary")) === 1 && (await headOf(page)).includes("arbiter.py"), `선택 ${await selectedOf(page)}`);
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

/** 상단 줄 오른쪽 칸에 그린 요소의 이름. 버튼은 접근성 이름이나 글자다. */
const toolsOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".toolbar-tools > *")].map((element) => {
      const button = element.matches("button") ? element : element.querySelector("button");
      return button?.getAttribute("aria-label") ?? element.textContent.trim();
    }),
  );

/** 필터 버튼에 마우스를 올렸을 때 뜨는 말풍선의 줄 */
async function filterTipOf(page) {
  await page.mouse.move(0, 0);
  await page.hover(".filter-button");
  await page.waitForSelector(".tooltip", { timeout: 5_000 }).catch(() => {});
  const lines = await page.evaluate(() => document.querySelector(".tooltip")?.innerText.split("\n") ?? []);
  await page.mouse.move(0, 0);
  return lines;
}

/** 상단 줄의 필터 버튼과 필터 창, 좁은 창 폭의 상단 줄 */
async function toolbar(t, page) {
  const [graph, reply, repo] = [await api("/api/graph"), await api("/api/changes"), await api("/api/repo")];
  const entries = graph.nodes.filter((n) => n.entry && !n.test).map((n) => n.id);
  const groups = cyclesOf(graph, hiddenOf(graph)).groups.length;
  await load(page);
  t.check(
    `상단 줄 오른쪽에 ${TOOLS.join(", ")} 버튼만 이 순서로 있고 하단 상태 줄이 없다`,
    same(await toolsOf(page), TOOLS) && (await count(page, ".statusbar, .status-bar")) === 0,
    (await toolsOf(page)).join(", "),
  );
  const idle = await filterTipOf(page);
  t.check(
    "필터 창이 닫힌 채로 열리고, 보기 설정이 모두 기본값이면 필터 버튼에 수가 없고 말풍선이 그 사실을 적는다",
    (await count(page, ".filter-panel")) === 0 && (groups > 0 || ((await count(page, ".filter-count")) === 0 && same(idle, ["필터 · 보기 설정이 모두 기본값이다"]))),
    idle.join(" / "),
  );

  await page.click(".filter-button");
  await page.waitForSelector(".filter-panel", { timeout: 5_000 }).catch(() => {});
  const panel = await page.evaluate(() => {
    const root = document.querySelector(".filter-panel");
    const section = (name) => root.querySelector(`.filter-section[aria-label="${name}"]`);
    return {
      titles: [...root.querySelectorAll(".filter-title")].map((title) => title.textContent),
      view: [...section("보기 설정").querySelectorAll(".toolbar-toggle, .filter-overlays > .filter-label")].map((item) => item.textContent.trim()),
      options: [...section("보기 설정").querySelectorAll(".overlay-option")].map((option) => option.dataset.kind),
      stats: [...section("레포 정보").querySelectorAll(".filter-stats")].map((line) => line.textContent),
      branch: section("레포 정보").querySelector(".filter-branch")?.textContent ?? null,
      entries: [...section("레포 정보").querySelectorAll(".filter-entry")].map((item) => item.dataset.node),
    };
  });
  t.check(
    "필터 버튼을 누르면 보기 설정 구역에 흐름 단계, 분석 덮개, 토글 세 개가 있는 창이 열린다",
    same(panel.titles, ["보기 설정", "레포 정보"]) && same(panel.view, ["흐름 단계2", "분석 덮개", "테스트 코드", "외부 노드", "자동 요약"]) && same(panel.options, ["none", "cycles", "unused"]),
    `${panel.titles.join(" / ")}: ${panel.view.join(", ")}`,
  );
  const { stats } = repo;
  const rate = stats.call_sites === 0 ? "-" : `${Math.round((stats.resolved / stats.call_sites) * 1000) / 10}%`;
  t.check(
    "레포 정보 구역이 파일·노드·선 수, 호출 확인 비율, 현재 git 브랜치 이름을 적는다",
    panel.stats[0] === `파일 ${stats.files} · 노드 ${stats.nodes} · 선 ${stats.edges}` &&
      panel.stats[1].startsWith(`호출 확인 ${rate}`) &&
      (reply.git && reply.branch !== null ? panel.branch === `브랜치 ${reply.branch}` : panel.branch === null),
    `${panel.stats.join(" / ")} / ${panel.branch}`,
  );
  t.check(`레포 정보 구역이 진입점 ${entries.length}개의 이름을 적는다`, entries.length > 0 && same([...panel.entries].sort(), [...entries].sort()), panel.entries.join(", "));
  await t.shot();

  // 보기 설정을 바꿔도 창이 닫히지 않고 필터 버튼이 바꾼 설정의 수를 적는다.
  const filters = page.locator(".filter-panel");
  await filters.getByLabel("테스트 코드").check();
  await filters.getByLabel("자동 요약").check();
  await filters.locator('input[type="range"]').fill("3");
  await page.click('.overlay-option[data-kind="unused"]');
  await rest(page);
  const changed = ["흐름 단계 3", "덮개 미사용 후보", "테스트 코드", "자동 요약"];
  t.check(
    "보기 설정 네 개를 바꿔도 창이 열려 있고 필터 버튼이 4를 적는다",
    (await count(page, ".filter-panel")) === 1 && (await page.evaluate(() => document.querySelector(".filter-count")?.textContent)) === "4" && (await page.evaluate(() => document.querySelector(".graph").dataset.overlay)) === "unused",
    `필터 버튼의 수 ${await page.evaluate(() => document.querySelector(".filter-count")?.textContent ?? "없음")}`,
  );
  await page.click(".filter-button");
  const closed = (await count(page, ".filter-panel")) === 0;
  const tip = await filterTipOf(page);
  t.check("필터 버튼을 다시 누르면 창이 닫히고, 말풍선이 기본값과 다른 보기 설정의 이름을 적는다", closed && same(tip, ["필터 · 기본값과 다른 보기 설정", ...changed]), tip.join(" / "));
  await inFilters(page, async () => {
    await filters.getByLabel("테스트 코드").uncheck();
    await filters.getByLabel("자동 요약").uncheck();
    await filters.locator('input[type="range"]').fill("2");
    await page.click(`.overlay-option[data-kind="${groups > 0 ? "cycles" : "none"}"]`);
  });
  await rest(page);

  // 진입점 이름을 고르면 그 노드로 가고 창이 닫힌다. 창 밖을 누르거나 Esc를 눌러도 창만 닫힌다.
  await page.click(".filter-button");
  await page.click(`.filter-entry[data-node="${entries.at(-1)}"]`);
  await waitSelected(page, entries.at(-1)).catch(() => {});
  t.check("진입점 이름을 고르면 그래프가 그 노드를 선택하고 창이 닫힌다", (await selectedOf(page)) === entries.at(-1) && (await count(page, ".filter-panel")) === 0, `선택 ${await selectedOf(page)}`);
  await page.click(".filter-button");
  await page.waitForSelector(".filter-panel", { timeout: 5_000 }).catch(() => {});
  await page.keyboard.press("Escape");
  const folded = (await count(page, ".filter-panel")) === 0 && (await selectedOf(page)) === entries.at(-1);
  await page.click(".filter-button");
  await page.click(".toolbar-trail");
  const outside = (await count(page, ".filter-panel")) === 0;
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".react-flow__node .node-selected") === null, null, { timeout: 5_000 }).catch(() => {});
  t.check(
    "Esc 한 번에 필터 창만 닫히고, 창 밖을 눌러도 닫히며, 창이 닫힌 뒤의 Esc는 선택을 푼다",
    folded && outside && (await selectedOf(page)) === null,
    `Esc에 창만 닫힘 ${folded}, 밖을 눌러 닫힘 ${outside}, 선택 ${await selectedOf(page)}`,
  );

  // 창 폭마다 파일트리 폭이 기본값인 새 화면을 열어 상단 줄과 필터 창의 모든 버튼과 입력이 창 안에서 눌리는지 본다.
  // "분석 뒤 바뀐 파일 N개"는 /api/status 응답에 분석 뒤 바뀐 파일 하나를 넣어 띄운다.
  const extra = graph.nodes.find((n) => n.kind === "module" && !n.test).path;
  let stale = false;
  await page.route(
    (at) => at.pathname === "/api/status",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: stale ? { ...body, stale: { count: 1, paths: [extra] } } : body });
    },
  );
  for (const width of NARROW.widths.flatMap((w) => [w, -w])) {
    stale = width < 0;
    const name = `창 폭 ${Math.abs(width)}px${stale ? ', "분석 뒤 바뀐 파일" 표시' : ""}`;
    await page.setViewportSize({ width: Math.abs(width), height: 900 });
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
    await openFolder(page, NARROW.owner.split(".")[0]);
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
        const title = (control) => control.getAttribute("aria-label") || control.textContent.trim() || control.closest("label")?.textContent.trim() || control.type;
        const toolbar = document.querySelector(".toolbar");
        const area = toolbar.getBoundingClientRect();
        const controls = [...toolbar.querySelectorAll("button, input")].filter(shown);
        const missed = controls.filter((control) => {
          const rect = control.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return rect.left < area.left || rect.right > Math.min(area.right, window.innerWidth) || rect.top < area.top || hit === null || !control.contains(hit);
        });
        const last = document.querySelector(".trail-last");
        const [stage, panel] = [document.querySelector(".stage").getBoundingClientRect(), document.querySelector(".info-panel").getBoundingClientRect()];
        const filters = document.querySelector(".filter-panel")?.getBoundingClientRect();
        return {
          width: Math.round(area.width),
          height: Math.round(area.height),
          fits: toolbar.scrollWidth <= toolbar.clientWidth,
          controls: controls.map(title),
          missed: missed.map(title),
          last: last === null ? null : { text: last.textContent, width: Math.round(last.getBoundingClientRect().width), whole: last.scrollWidth <= last.clientWidth, inside: last.getBoundingClientRect().right <= area.right },
          cut: document.querySelector(".trail-cut")?.title ?? null,
          stale: document.querySelector(".toolbar-stale")?.textContent ?? null,
          gaps: [panel.top - stage.top, stage.bottom - panel.bottom, stage.top - area.bottom],
          filters: filters === undefined ? null : { inside: filters.left >= area.left && filters.right <= Math.min(area.right, window.innerWidth) && filters.bottom <= window.innerHeight },
        };
      });
    const bar = await read();
    t.check(
      `${name}: 상단 줄이 한 줄이고 ${["뒤로", "앞으로", ...TOOLS].join("·")} 버튼이 모두 창 안에서 가운데 점으로 눌린다`,
      bar.height < 40 && bar.fits && bar.missed.length === 0 && ["뒤로", "앞으로", ...TOOLS].every((title) => bar.controls.includes(title)) && (!stale || bar.stale === "1"),
      `상단 줄 ${bar.width}×${bar.height}, 눌리지 않는 요소 ${bar.missed.join("·") || "없음"}, 요소 ${bar.controls.join("·")}`,
    );
    t.check(
      `${name}: 탐색 경로의 마지막 단계가 상단 줄 안에 보이고, 폭이 모자라면 앞 단계부터 줄인다`,
      bar.last !== null && bar.last.text === NARROW.label && bar.last.inside && (bar.last.whole || bar.cut !== null || bar.last.width > 0),
      `마지막 단계 "${bar.last?.text}" ${bar.last?.width}px${bar.last?.whole ? "" : "(말줄임)"}, 줄인 단계 "${bar.cut ?? "없음"}"`,
    );
    t.check(
      `${name}: 관계 그래프 영역이 상단 줄 바로 아래에서 시작하고 정보 패널이 영역의 위 끝부터 아래 끝까지 찬다`,
      near(bar.gaps[2], 0) && near(bar.gaps[0], 0) && near(bar.gaps[1], 0),
      `패널 위 ${bar.gaps[0]}, 아래 ${bar.gaps[1]}, 상단 줄과 영역 사이 ${bar.gaps[2]}`,
    );
    await page.click(".filter-button");
    await page.waitForSelector(".filter-panel", { timeout: 5_000 }).catch(() => {});
    const opened = await read();
    if (!stale) {
      await page.screenshot({ path: join(OUT, `s2-toolbar-${width}.png`) });
    }
    await page.keyboard.press("Escape");
    t.check(
      `${name}: 필터 창이 상단 줄의 폭과 창 안에 열리고 그 안의 입력이 모두 눌리며 Esc에 창만 닫힌다`,
      opened.filters?.inside === true &&
        ["테스트 코드", "외부 노드", "자동 요약"].every((title) => opened.controls.includes(title)) &&
        opened.missed.length === 0 &&
        (await count(page, ".filter-panel")) === 0 &&
        (await selectedOf(page)) === NARROW.id,
      `창 안 ${opened.filters?.inside}, 눌리지 않는 요소 ${opened.missed.join("·") || "없음"}, 선택 ${await selectedOf(page)}`,
    );
  }
}

/**
 * 새로고침. 고정 레포의 임시 복사본에서 보기 설정과 선택을 바꾸고 파일에 함수를 더한 뒤 새로고침을 눌러, 분석하는 동안의 표시와
 * 끝난 뒤의 그래프·화면 상태를 본다. 더한 함수는 시나리오가 끝날 때 지운다.
 */
async function reloadScenario(t, page) {
  const repo = await api("/api/repo", reloadUrl);
  if (repo.root.includes("/tests/fixtures/")) {
    t.check("--reload-url의 서버가 고정 레포의 임시 복사본을 열었다", false, repo.root);
    return;
  }
  const core = join(repo.root, "src", "app", "core.py");
  const source = readFileSync(core, "utf8");
  const [file, target, added] = ["app.core", "app.core:helper", "app.core:added"];
  const buttonOf = () =>
    page.evaluate(() => {
      const button = document.querySelector(".reload-button");
      return { text: button.textContent, busy: button.getAttribute("aria-busy"), spin: button.querySelector(".reload-spin") !== null, stale: button.querySelector(".toolbar-stale")?.textContent ?? null };
    });
  const viewport = () => page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform);
  const numbers = (transform) => (transform.match(/-?[\d.]+/g) ?? []).map(Number);
  /** 다시 분석하는 요청. 붙잡아 두었다가 release를 부르면 서버로 보낸다. */
  const posts = [];
  let failing = false;
  await page.route(
    (at) => at.pathname === "/api/reload",
    (route) => (failing ? route.fulfill({ status: 500, json: { error: "다시 분석하지 못했다: 분석이 멈췄다" } }) : void posts.push(route)),
  );
  try {
    await load(page, reloadUrl);
    const home = await viewport();
    const boxed = Object.keys(await flowBoxes(page)).length;

    // 보기 설정, 화면 색, 범례, 선택, 파일트리 검색어를 바꾼다.
    await page.getByRole("button", { name: "어두운 화면" }).click();
    await page.click(".legend-button");
    await inFilters(page, async () => {
      const filters = page.locator(".filter-panel");
      await filters.getByLabel("테스트 코드").check();
      await filters.getByLabel("자동 요약").check();
      await filters.locator('input[type="range"]').fill("3");
      await page.click('.overlay-option[data-kind="unused"]');
    });
    await settle(page);
    await pickInTree(page, { id: target, owner: file });
    await page.mouse.move(600, 500);
    await page.mouse.wheel(0, -300);
    await page.fill(".tree-search-input", "help");
    appendFileSync(core, "\n\ndef added():\n    return helper(1)\n");
    await page.waitForSelector(".reload-button .toolbar-stale", { timeout: 10_000 }).catch(() => {});
    await page.mouse.move(0, 0);
    await page.hover(".reload-button");
    await page.waitForSelector(".tooltip", { timeout: 5_000 }).catch(() => {});
    const tip = await page.evaluate(() => document.querySelector(".tooltip")?.textContent.split("\n") ?? []);
    const idle = await buttonOf();
    t.check(
      "파일을 고치면 새로고침 버튼이 분석 뒤 바뀐 파일 수 1을 적고 말풍선이 그 뜻과 파일 경로를 적는다",
      idle.text === "새로고침1" && idle.stale === "1" && idle.busy === "false" && tip.at(-2) === "분석 뒤 바뀐 파일 1개" && tip.at(-1) === "  src/app/core.py" && tip[0].startsWith("새로고침"),
      `버튼 "${idle.text}", 말풍선 ${tip.join(" / ")}`,
    );

    await page.click(".reload-button");
    await page.waitForFunction(() => document.querySelector(".reload-button").getAttribute("aria-busy") === "true", null, { timeout: 5_000 }).catch(() => {});
    const busy = await buttonOf();
    await page.click(".reload-button", { force: true });
    await page.waitForTimeout(300);
    t.check(
      "새로고침을 누르면 버튼이 도는 원과 \"분석 중\"으로 바뀌고, 그동안 다시 눌러도 요청을 한 번만 보낸다",
      busy.text === "분석 중" && busy.spin && busy.busy === "true" && posts.length === 1,
      `버튼 "${busy.text}", POST ${posts.length}번`,
    );
    await page.fill(".tree-search-input", "");
    await page.click(`.tree-row.tree-file[data-node="app.models"]`);
    await waitSelected(page, "app.models").catch(() => {});
    t.check("분석하는 동안 앞의 그래프에서 다른 노드를 고를 수 있다", (await selectedOf(page)) === "app.models" && (await count(page, `.tree-row[data-node="${added}"]`)) === 0, `선택 ${await selectedOf(page)}`);
    await page.fill(".tree-search-input", "help");
    await t.shot();

    await posts[0].continue();
    await page.waitForFunction(() => document.querySelector(".reload-button").getAttribute("aria-busy") === "false", null, { timeout: 120_000 });
    await page.waitForSelector(".react-flow__node", { timeout: 60_000 });
    await settle(page);
    const done = await buttonOf();
    const state = await inFilters(page, async () => {
      const filters = page.locator(".filter-panel");
      return {
        tests: await filters.getByLabel("테스트 코드").isChecked(),
        auto: await filters.getByLabel("자동 요약").isChecked(),
        depth: await filters.locator('input[type="range"]').inputValue(),
        overlay: (await overlayOptions(page)).find((option) => option.checked)?.kind,
        nodes: await page.evaluate(() => document.querySelector(".filter-stats").textContent),
      };
    });
    const fresh = await api("/api/repo", reloadUrl);
    t.check(
      "분석이 끝나면 버튼이 \"새로고침\"으로 돌아오고 바뀐 파일 수가 사라지며 레포 정보가 새 분석 결과의 수를 적는다",
      done.text === "새로고침" && done.stale === null && fresh.stats.nodes === repo.stats.nodes + 1 && state.nodes.includes(`노드 ${fresh.stats.nodes} `),
      `버튼 "${done.text}", ${state.nodes}`,
    );
    const groups = cyclesOf(await api("/api/graph", reloadUrl), hiddenOf(await api("/api/graph", reloadUrl))).groups.length;
    t.check(
      "보기 설정이 기본값으로 돌아온다. 흐름 단계 2, 테스트 코드와 자동 요약 꺼짐, 덮개는 레포를 처음 열 때의 규칙이다",
      !state.tests && !state.auto && state.depth === "2" && state.overlay === (groups > 0 ? "cycles" : "none") && (await count(page, ".filter-count")) === (groups > 0 ? 1 : 0),
      JSON.stringify(state),
    );
    const now = numbers(await viewport());
    const first = numbers(home);
    t.check(
      "선택, 탐색 경로, 탐색 이력, 파일트리 검색어가 비고 폴더와 파일 상자가 처음 연 상태로 접히며 화면이 그래프 전체에 맞춰진다",
      (await selectedOf(page)) === null &&
        (await count(page, ".trail-step")) === 0 &&
        (await page.getByRole("button", { name: "뒤로" }).isDisabled()) &&
        (await page.inputValue(".tree-search-input")) === "" &&
        (await count(page, ".react-flow__node .node-body.node-function")) === 0 &&
        Object.keys(await flowBoxes(page)).length === boxed &&
        now.length === 3 && now.every((n, i) => near(n, first[i], 1)),
      `선택 ${await selectedOf(page)}, 상자 ${Object.keys(await flowBoxes(page)).length}개(처음 ${boxed}개), 화면 ${now.join(", ")}(처음 ${first.join(", ")})`,
    );
    t.check(
      "화면 색과 범례의 펼침은 그대로다",
      (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark" && (await count(page, ".legend")) === 1,
      `화면 색 ${await page.evaluate(() => document.documentElement.dataset.theme)}, 범례 ${await count(page, ".legend")}개`,
    );
    await page.click(`.tree-row.tree-file[data-node="${file}"]`);
    await page.waitForSelector(`.tree-row.tree-symbol[data-node="${added}"]`, { timeout: 10_000 }).catch(() => {});
    await page.click(`.tree-row.tree-symbol[data-node="${added}"]`).catch(() => {});
    await waitSelected(page, added).catch(() => {});
    await page.waitForSelector(".info-panel .monaco-editor .view-line", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(500);
    const shownCode = await page.evaluate(() => [...document.querySelectorAll(".info-panel .monaco-editor .view-line")].map((line) => line.textContent.replaceAll("\u00a0", " ")).join("\n"));
    t.check(
      "새 그래프에 더한 함수 added()가 있고 코드 뷰어가 고친 파일의 본문을 보인다",
      (await selectedOf(page)) === added && shownCode.includes("def added():") && (await count(page, `${node(added)}`)) === 1,
      `선택 ${await selectedOf(page)}`,
    );

    // 다시 분석하지 못하면 화면을 바꾸지 않고 까닭을 적는다.
    failing = true;
    t.expected.push("status of 500");
    await page.click(".reload-button");
    await page.waitForSelector(".reload-error", { timeout: 10_000 }).catch(() => {});
    const error = await page.evaluate(() => document.querySelector(".reload-error")?.textContent ?? null);
    const kept = (await selectedOf(page)) === added && (await buttonOf()).text === "새로고침";
    await page.click(".reload-error").catch(() => {});
    t.check(
      "다시 분석하지 못하면 선택과 그래프를 그대로 두고 까닭을 적으며, 그 글을 누르면 닫힌다",
      error === "다시 분석하지 못했다: 분석이 멈췄다" && kept && (await count(page, ".reload-error")) === 0,
      `${error}`,
    );
  } finally {
    writeFileSync(core, source);
    await fetch(new URL("/api/reload", reloadUrl), { method: "POST" }).catch(() => {});
  }
}

// ── 4단계: 분석 상태 ─────────────────────────────────────────────

/** `/api/status` 응답을 바꾼다. 돌려준 상자의 patch가 null이 아니면 서버 응답에 그 필드를 덮어 준다. */
async function fakeStatus(page) {
  const box = { patch: null };
  await page.route(
    (at) => at.pathname === "/api/status",
    async (route) => {
      if (box.patch === null) {
        return route.continue();
      }
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), ...box.patch } });
    },
  );
  return box;
}

/** 분석 결과가 없는 화면. 진행 표시와 상단 줄, 파일트리, 새로고침 버튼을 읽는다. */
const waitingOf = (page) =>
  page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
    const [stage, phase, bar, fill, toolbar] = [rect(".stage"), rect(".progress-phase"), rect(".progress-bar"), rect(".progress-fill"), rect(".toolbar")];
    const button = document.querySelector(".reload-button");
    return {
      alert: document.querySelector(".progress")?.getAttribute("role") === "alert",
      phase: document.querySelector(".progress-phase")?.textContent ?? null,
      error: document.querySelector(".progress-error")?.textContent ?? null,
      retry: document.querySelector(".progress-retry")?.textContent ?? null,
      tone: document.querySelector(".progress-phase") === null ? null : getComputedStyle(document.querySelector(".progress-phase")).color,
      share: document.querySelector(".progress-bar")?.dataset.share ?? null,
      filled: bar === null || fill === null ? null : fill.width / bar.width,
      centered: stage !== null && phase !== null && Math.abs(phase.left + phase.width / 2 - (stage.left + stage.width / 2)) <= 1 && Math.abs((phase.top + (bar ?? phase).bottom) / 2 - (stage.top + stage.height / 2)) <= 40,
      nodes: document.querySelectorAll(".react-flow__node").length,
      rows: document.querySelectorAll(".tree-row").length,
      explorer: document.querySelector(".explorer-body").textContent,
      panels: document.querySelectorAll(".info-panel").length,
      bar: { height: Math.round(toolbar.height), fits: document.querySelector(".toolbar").scrollWidth <= document.querySelector(".toolbar").clientWidth },
      button: { text: button.textContent, busy: button.getAttribute("aria-busy"), spin: button.querySelector(".reload-spin") !== null, mark: button.querySelector(".reload-mark") !== null },
    };
  });

const phaseIs = (page, text) => page.waitForFunction((want) => document.querySelector(".progress-phase")?.textContent === want, text, { timeout: 10_000 }).catch(() => {});

/**
 * 분석 중의 화면. `/api/status`를 판 번호 0인 분석 중으로 바꿔 진행 표시를 보고, 서버 응답을 그대로 주면 그래프가 그려지는지 본다.
 */
async function progress(t, page) {
  const fake = await fakeStatus(page);
  const busy = (phase, done = 0, total = 0) => ({ phase, done, total, revision: 0, draft: false, lsp: "starting", stale: { count: 0, paths: [] } });
  const reads = [];
  const posts = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/graph") {
      reads.push(path);
    } else if (path === "/api/reload") {
      posts.push(path);
    }
  });
  fake.patch = busy("collect");
  await page.goto(url);
  await phaseIs(page, "파일 수집");
  const collect = await waitingOf(page);
  t.check(
    "분석 결과가 없는 동안 관계 그래프 영역 가운데에 단계 이름과 가로 막대를 muted 잉크로 그린다",
    collect.phase === "파일 수집" && collect.share === null && collect.centered && collect.nodes === 0 && collect.tone === (await colorOf(page, "--muted")).rgb,
    `"${collect.phase}", 가운데 ${collect.centered}, 글자 색 ${collect.tone}`,
  );
  t.check(
    "그동안 파일트리는 행이 없고 정보 패널을 그리지 않으며 상단 줄이 한 줄이다",
    collect.rows === 0 && collect.explorer === "" && collect.panels === 0 && collect.bar.height < 40 && collect.bar.fits && same(await toolsOf(page), TOOLS),
    `행 ${collect.rows}개, 파일트리 글 "${collect.explorer}", 정보 패널 ${collect.panels}개, 상단 줄 높이 ${collect.bar.height}`,
  );

  fake.patch = busy("extract", 3, 33);
  await phaseIs(page, "구조 추출 3 / 33");
  const extract = await waitingOf(page);
  fake.patch = busy("resolve", 12_000, 19_292);
  await phaseIs(page, "호출 대상 확인 12,000 / 19,292");
  await page.waitForTimeout(300);
  const resolve = await waitingOf(page);
  t.check(
    "수를 세는 단계는 이름 뒤에 진행 수를 적고 막대를 그 비율만큼 채운다",
    extract.phase === "구조 추출 3 / 33" && resolve.phase === "호출 대상 확인 12,000 / 19,292" && near(resolve.filled, 12_000 / 19_292, 0.01),
    `"${extract.phase}", "${resolve.phase}", 채운 비율 ${resolve.filled?.toFixed(3)}`,
  );
  await page.click(".reload-button", { force: true });
  await page.mouse.move(0, 0);
  await page.hover(".reload-button");
  await page.waitForSelector(".tooltip", { timeout: 5_000 }).catch(() => {});
  const tip = await tipText(page);
  t.check(
    "새로고침 버튼이 도는 원과 단계 이름을 그리고 말풍선이 진행 수를 적으며, 눌러도 요청을 보내지 않는다",
    resolve.button.text === "호출 대상 확인" && resolve.button.spin && !resolve.button.mark && resolve.button.busy === "true" && tip === "레포를 분석하는 중 · 끝나면 그래프를 그린다\n호출 대상 확인 12,000 / 19,292" && posts.length === 0,
    `버튼 "${resolve.button.text}", 말풍선 ${tip.replaceAll("\n", " / ")}, POST ${posts.length}번`,
  );
  await page.mouse.move(0, 0);
  await t.shot();
  await page.screenshot({ path: join(OUT, "s4-u5-progress.png") });

  fake.patch = busy("resolve", 12_400, 20_100);
  await phaseIs(page, "호출 대상 확인 12,400 / 20,100");
  t.check("보낼 요청의 전체 수가 도중에 커지면 그 수를 적는다", (await waitingOf(page)).phase === "호출 대상 확인 12,400 / 20,100", (await waitingOf(page)).phase);

  await page.getByRole("button", { name: "어두운 화면" }).click();
  const dark = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, surface: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() }));
  t.check("분석하는 동안 화면 색을 바꿀 수 있다", dark.theme === "dark" && dark.surface === DARK.surface, JSON.stringify(dark));
  await page.screenshot({ path: join(OUT, "s4-u5-progress-dark.png") });
  await page.setViewportSize({ width: 720, height: 900 });
  await page.waitForTimeout(200);
  const narrow = await waitingOf(page);
  t.check("창 폭 720px에서 상단 줄이 한 줄이고 진행 표시가 영역 가운데에 있다", narrow.bar.height < 40 && narrow.bar.fits && narrow.centered, `상단 줄 높이 ${narrow.bar.height}`);
  await page.screenshot({ path: join(OUT, "s4-u5-progress-720.png") });
  await page.setViewportSize(VIEW);
  await page.getByRole("button", { name: "밝은 화면" }).click();

  fake.patch = busy("build");
  await phaseIs(page, "그래프 조립");
  const build = await waitingOf(page);
  t.check("수를 세지 않는 단계는 이름만 적는다", build.phase === "그래프 조립" && build.share === null && reads.length === 0, `"${build.phase}", /api/graph ${reads.length}번`);

  fake.patch = null;
  await page.waitForSelector(".react-flow__node", { timeout: 60_000 });
  await settle(page);
  await page.waitForTimeout(2_500);
  const done = await waitingOf(page);
  t.check(
    "분석이 끝나면 진행 표시가 사라지고 그래프와 파일트리, 정보 패널이 나타나며 분석 결과를 한 번만 받는다",
    done.phase === null && done.nodes > 0 && done.rows > 0 && done.panels === 1 && reads.length === 1 && done.button.text === "새로고침" && done.button.mark && done.button.busy === "false",
    `상자 ${done.nodes}개, 행 ${done.rows}개, /api/graph ${reads.length}번, 버튼 "${done.button.text}"`,
  );
}

/** 첫 분석을 하지 못한 화면. 까닭과 다시 분석하는 버튼을 보고, 버튼을 누르면 분석을 다시 해 그래프가 그려지는지 본다. */
async function progressFailed(t, page) {
  const fake = await fakeStatus(page);
  const reason = "/repo에서 가상환경을 찾지 못했다. --python으로 인터프리터 경로를 지정한다.";
  /** 다시 분석하는 요청. 붙잡아 두었다가 서버로 보낸다. */
  const posts = [];
  await page.route((at) => at.pathname === "/api/reload", (route) => void posts.push(route));
  fake.patch = { phase: "failed", done: 0, total: 0, revision: 0, draft: false, lsp: "starting", error: reason, stale: { count: 0, paths: [] } };
  await page.goto(url);
  await page.waitForSelector(".progress-retry", { timeout: 10_000 }).catch(() => {});
  const failed = await waitingOf(page);
  t.check(
    "첫 분석을 하지 못하면 진행 표시 대신 까닭과 \"다시 분석\" 버튼을 그린다",
    failed.alert && failed.phase === "분석하지 못했다" && failed.error === reason && failed.retry === "다시 분석" && failed.share === null && failed.filled === null,
    `"${failed.phase}", "${failed.error}", 버튼 "${failed.retry}"`,
  );
  t.check(
    "그동안 파일트리는 비어 있고 새로고침 버튼은 평소 모습이다",
    failed.rows === 0 && failed.explorer === "" && failed.panels === 0 && failed.button.text === "새로고침" && failed.button.busy === "false",
    `파일트리 글 "${failed.explorer}", 버튼 "${failed.button.text}"`,
  );
  await t.shot();
  await page.screenshot({ path: join(OUT, "s4-u5-failed.png") });
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await page.screenshot({ path: join(OUT, "s4-u5-failed-dark.png") });
  await page.getByRole("button", { name: "밝은 화면" }).click();

  await page.click(".progress-retry");
  await page.waitForFunction(() => document.querySelector(".reload-button").getAttribute("aria-busy") === "true", null, { timeout: 5_000 }).catch(() => {});
  const retrying = await waitingOf(page);
  t.check(
    "\"다시 분석\"을 누르면 요청을 한 번 보내고 까닭 대신 진행 표시를 그린다",
    posts.length === 1 && !retrying.alert && retrying.retry === null && retrying.button.busy === "true" && retrying.button.spin,
    `POST ${posts.length}번, "${retrying.phase}", 버튼 "${retrying.button.text}"`,
  );
  fake.patch = null;
  await posts[0]?.continue();
  await page.waitForSelector(".react-flow__node", { timeout: 60_000 });
  await settle(page);
  const done = await waitingOf(page);
  t.check("분석이 끝나면 그래프가 그려진다", done.phase === null && done.nodes > 0 && done.rows > 0 && done.button.text === "새로고침", `상자 ${done.nodes}개, 버튼 "${done.button.text}"`);
}

/**
 * 변경 감지. 고정 레포의 임시 복사본에서 파일을 내용이 같게 저장하고, 고치고, 새 파일을 만들면서 새로고침 버튼의 기호와 수,
 * 말풍선을 본다. 다시 분석은 버튼을 누를 때만 한다. 고친 파일과 만든 파일은 시나리오가 끝날 때 되돌린다.
 */
async function staleScenario(t, page) {
  const repo = await api("/api/repo", reloadUrl);
  if (repo.root.includes("/tests/fixtures/")) {
    t.check("--reload-url의 서버가 고정 레포의 임시 복사본을 열었다", false, repo.root);
    return;
  }
  /** 상태를 2초마다 받고 서버가 센 값을 1초 기억하므로 저장한 뒤 3초 안에 표시가 바뀐다. 요청과 그리기에 0.5초를 더 준다. */
  const WITHIN = 3_500;
  const core = join(repo.root, "src", "app", "core.py");
  const source = readFileSync(core, "utf8");
  const extras = [1, 2, 3, 4, 5, 6].map((n) => join(repo.root, "src", "app", `fresh_${n}.py`));
  const markOf = () =>
    page.evaluate(() => {
      const button = document.querySelector(".reload-button");
      const mark = button.querySelector(".reload-mark");
      return {
        text: button.textContent,
        stale: button.hasAttribute("data-stale"),
        count: button.querySelector(".toolbar-stale")?.textContent ?? null,
        stroke: mark === null ? null : getComputedStyle(mark).stroke,
        ink: getComputedStyle(button).color,
        busy: button.getAttribute("aria-busy"),
      };
    });
  const tipLines = async () => {
    await page.mouse.move(0, 0);
    await page.hover(".reload-button");
    await page.waitForSelector(".tooltip", { timeout: 5_000 }).catch(() => {});
    return (await tipText(page)).split("\n");
  };
  const revisionOf = async () => (await api("/api/status", reloadUrl)).revision;
  try {
    await load(page, reloadUrl, false);
    const revision = await revisionOf();
    const calm = await markOf();
    t.check(
      "바뀐 파일이 없으면 새로고침 기호가 버튼 글자와 같은 색이고 수가 없다",
      calm.text === "새로고침" && !calm.stale && calm.count === null && calm.stroke === calm.ink,
      `버튼 "${calm.text}", 기호 색 ${calm.stroke}`,
    );

    // 내용이 같은 저장은 표시하지 않는다.
    writeFileSync(core, source);
    await page.waitForTimeout(WITHIN + 1_000);
    const saved = await markOf();
    t.check("내용이 같게 저장한 파일은 표시하지 않는다", !saved.stale && saved.count === null, `버튼 "${saved.text}"`);

    appendFileSync(core, "\n\ndef added():\n    return helper(1)\n");
    const wrote = Date.now();
    await page.waitForSelector(".reload-button[data-stale]", { timeout: 15_000 }).catch(() => {});
    const took = Date.now() - wrote;
    const one = await markOf();
    const changed = (await colorOf(page, "--changed")).rgb;
    t.check(
      `파일을 고치면 ${WITHIN / 1000}초 안에 새로고침 기호가 수정 표시의 색이 되고 바뀐 파일 수 1이 붙는다`,
      one.stale && one.count === "1" && one.text === "새로고침1" && one.stroke === changed && one.stroke !== one.ink && took <= WITHIN,
      `${(took / 1000).toFixed(2)}초 뒤, 버튼 "${one.text}", 기호 색 ${one.stroke}`,
    );
    const first = await tipLines();
    t.check(
      "말풍선이 새로고침의 뜻 아래에 바뀐 파일 수와 경로를 적는다",
      first[0].startsWith("새로고침") && first.at(-2) === "분석 뒤 바뀐 파일 1개" && first.at(-1) === "  src/app/core.py",
      first.join(" / "),
    );
    await t.shot();
    await page.screenshot({ path: join(OUT, "s4-u5-stale.png") });

    extras.forEach((path, index) => writeFileSync(path, `def fresh_${index + 1}():\n    return ${index + 1}\n`));
    await page.waitForFunction(() => document.querySelector(".reload-button .toolbar-stale")?.textContent === "7", null, { timeout: 15_000 }).catch(() => {});
    const many = await tipLines();
    const listed = many.slice(many.indexOf("분석 뒤 바뀐 파일 7개") + 1);
    t.check(
      "바뀐 파일이 일곱 개면 수 7을 적고 말풍선이 경로 다섯 개와 \"외 2개\"를 적는다",
      (await markOf()).count === "7" && listed.length === 6 && listed.slice(0, 5).every((line) => line.startsWith("  src/app/")) && listed[5] === "  외 2개",
      many.join(" / "),
    );
    await page.getByRole("button", { name: "어두운 화면" }).click();
    await tipLines();
    const night = await markOf();
    t.check("어두운 화면에서도 기호가 수정 표시의 색이다", night.stroke === (await colorOf(page, "--changed")).rgb && night.stroke !== night.ink, `기호 색 ${night.stroke}`);
    await page.screenshot({ path: join(OUT, "s4-u5-stale-dark.png") });
    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForTimeout(300);
    await tipLines();
    const narrow = await page.evaluate(() => {
      const toolbar = document.querySelector(".toolbar");
      const area = toolbar.getBoundingClientRect();
      const missed = [...toolbar.querySelectorAll("button")].filter((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return rect.width > 0 && (rect.right > Math.min(area.right, window.innerWidth) || hit === null || !button.contains(hit));
      });
      return { height: Math.round(area.height), fits: toolbar.scrollWidth <= toolbar.clientWidth, missed: missed.map((button) => button.getAttribute("aria-label") ?? button.textContent) };
    });
    t.check(
      "창 폭 720px에서 수를 붙인 채로 상단 줄이 한 줄이고 버튼이 모두 창 안에서 눌린다",
      narrow.height < 40 && narrow.fits && narrow.missed.length === 0 && (await markOf()).count === "7",
      `상단 줄 높이 ${narrow.height}, 눌리지 않는 버튼 ${narrow.missed.join("·") || "없음"}`,
    );
    await page.screenshot({ path: join(OUT, "s4-u5-stale-720.png") });
    await page.setViewportSize(VIEW);
    await page.getByRole("button", { name: "밝은 화면" }).click();
    await page.mouse.move(0, 0);
    t.check(
      "버튼을 누르기 전에는 다시 분석하지 않는다. 판 번호와 그래프가 그대로다",
      (await revisionOf()) === revision && (await count(page, `.tree-row[data-node="app.fresh_1"]`)) === 0,
      `판 번호 ${await revisionOf()}(처음 ${revision})`,
    );

    await page.click(".reload-button");
    await page.waitForFunction(() => document.querySelector(".reload-button").getAttribute("aria-busy") === "true", null, { timeout: 5_000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector(".reload-button").getAttribute("aria-busy") === "false", null, { timeout: 120_000 });
    await page.waitForSelector(".react-flow__node", { timeout: 60_000 });
    await settle(page);
    const done = await markOf();
    const fresh = await api("/api/repo", reloadUrl);
    t.check(
      "새로고침이 끝나면 기호와 수가 평소 모습으로 돌아가고 판 번호가 1 늘며 그래프에 새 파일과 함수가 있다",
      done.text === "새로고침" && !done.stale && done.count === null && done.stroke === done.ink && (await revisionOf()) === revision + 1 && fresh.stats.nodes === repo.stats.nodes + 13 && (await count(page, node("app.fresh_1"))) === 1,
      `버튼 "${done.text}", 판 번호 ${await revisionOf()}, 노드 ${fresh.stats.nodes}개(처음 ${repo.stats.nodes}개)`,
    );
    await page.waitForTimeout(WITHIN);
    t.check("그 뒤로 파일을 고치지 않으면 표시가 다시 뜨지 않는다", !(await markOf()).stale, `버튼 "${(await markOf()).text}"`);
    await page.screenshot({ path: join(OUT, "s4-u5-reloaded.png") });
  } finally {
    writeFileSync(core, source);
    extras.forEach((path) => rmSync(path, { force: true }));
    await fetch(new URL("/api/reload", reloadUrl), { method: "POST" }).catch(() => {});
  }
}

// ── 3단계: 경로와 순환 묶음의 기대값 ─────────────────────────────

/** 경로 시나리오가 고르는 출발과 도착. text는 검색 칸에 넣는 글자다. */
const TRIP = {
  from: { id: "arbiter:arbiter_batch", text: "arbiter_batch" },
  to: { id: "date_engine:parse_plan_date", text: "parse_plan_date" },
};
/** 경로 탐색 창이 나열하는 경로 수 */
const PATH_LIMIT = 5;
/** 단계 목록이 스크롤 없이 그리는 행 수와 행의 높이(px) */
const STEP_ROWS = 6.5;
const STEP_HEIGHT = 24;
/** 단계 목록이 목록 안에서 스크롤되는지 보는 창 높이(px) */
const LOW_HEIGHT = 560;
/** 경로의 걸음과 그 밖의 선의 굵기(px), 마우스를 올린 걸음의 굵기 */
const LINE = { step: 3, rest: 1.5, pointed: 4 };
/** 미사용 덮개가 표시하는 후보의 불투명도 상한 */
const UNUSED_OPACITY = 0.4;

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** 토글이 꺼진 화면에서 숨긴 노드. 테스트 코드와 외부 노드다. */
const hiddenOf = (graph) => new Set(graph.nodes.filter((n) => n.kind === "external" || n.test).map((n) => n.id));

/** 노드마다 나가는 걸음의 도착 노드와 종류(frontend/src/graph/route.ts의 steps와 같은 규칙) */
function stepsOf(graph, hidden) {
  const order = ["call", "construct", "init", "overridden"];
  const out = new Map();
  const add = (source, target, kind) => {
    if (source === target || hidden.has(source) || hidden.has(target)) {
      return;
    }
    const targets = out.get(source) ?? new Map();
    const before = targets.get(target);
    if (before === undefined || order.indexOf(kind) < order.indexOf(before)) {
      targets.set(target, kind);
    }
    out.set(source, targets);
  };
  const kinds = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  for (const edge of graph.edges) {
    if (edge.kind === "call" || edge.kind === "construct") {
      add(edge.source, edge.target, edge.kind);
    } else if (edge.kind === "override") {
      add(edge.target, edge.source, "overridden");
    }
  }
  for (const n of graph.nodes) {
    if (n.kind === "method" && n.parent !== null && ["__init__", "__post_init__", "__new__"].includes(n.name) && ["class", "dataclass"].includes(kinds.get(n.parent))) {
      add(n.parent, n.id, "init");
    }
  }
  return out;
}

/** 끝점 노드와 안에 든 노드 */
function endpointsOf(graph, id, hidden) {
  const found = new Set(hidden.has(id) ? [] : [id]);
  for (const at of found) {
    graph.nodes.filter((n) => n.parent === at && !hidden.has(n.id)).forEach((n) => found.add(n.id));
  }
  return found;
}

/**
 * 출발 끝점에서 도착 끝점까지 같은 노드를 두 번 지나지 않는 경로를 길이, 노드 id 배열 순서로 limit개까지 낸다.
 * 가장 짧은 길이에서 시작해 길이 상한을 하나씩 늘리며 상한 안의 경로를 모두 모은다.
 */
function simplePaths(out, sources, targets, limit) {
  const next = (id) => (targets.has(id) ? [] : [...(out.get(id)?.keys() ?? [])].filter((target) => !sources.has(target)).sort(byId));
  const into = new Map();
  for (const id of out.keys()) {
    next(id).forEach((target) => into.set(target, [...(into.get(target) ?? []), id]));
  }
  /** 노드마다 도착 끝점까지 남은 걸음 수 */
  const left = new Map([...targets].map((id) => [id, 0]));
  for (const id of left.keys()) {
    (into.get(id) ?? []).filter((source) => !left.has(source)).forEach((source) => left.set(source, left.get(id) + 1));
  }
  const starts = [...sources].filter((id) => left.has(id)).sort(byId);
  if (starts.length === 0) {
    return [];
  }
  const shortest = Math.min(...starts.map((id) => left.get(id)));
  let found = [];
  for (let bound = shortest; bound <= shortest + 8 && found.length < limit; bound += 1) {
    found = [];
    const walk = (path) => {
      const at = path.at(-1);
      if (targets.has(at)) {
        found.push([...path]);
        return;
      }
      for (const target of next(at)) {
        if (!path.includes(target) && left.has(target) && path.length + left.get(target) <= bound) {
          path.push(target);
          walk(path);
          path.pop();
        }
      }
    };
    starts.forEach((id) => walk([id]));
  }
  const order = (a, b) => a.length - b.length || byId(a.join("\u0001"), b.join("\u0001"));
  return found.sort(order).slice(0, limit);
}

/**
 * 출발 from에서 도착 to로 가는 경로와 경로 탐색 창이 적는 값(frontend/src/graph/route.ts의 route와 같은 규칙).
 * paths는 PATH_LIMIT개까지, more는 그다음 경로가 있는지, reach와 unresolved는 출발에서 닿는 함수·메서드 수와 그 안의 미확인 호출 수다.
 */
function routeOf(graph, from, to) {
  const hidden = hiddenOf(graph);
  const out = stepsOf(graph, hidden);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const [sources, targets] = [endpointsOf(graph, from, hidden), endpointsOf(graph, to, hidden)];
  const reached = new Set(sources);
  for (const id of reached) {
    [...(out.get(id)?.keys() ?? [])].forEach((target) => reached.add(target));
  }
  const callable = [...reached].map((id) => nodes.get(id)).filter((n) => n.kind === "function" || n.kind === "method");
  const overlap = [...sources].some((id) => targets.has(id));
  const found = overlap ? [] : simplePaths(out, sources, targets, PATH_LIMIT + 1);
  return {
    paths: found.slice(0, PATH_LIMIT),
    more: found.length > PATH_LIMIT,
    reach: callable.length,
    unresolved: callable.reduce((sum, n) => sum + n.unresolved, 0),
    kindOf: (source, target) => out.get(source)?.get(target),
    /** 경로가 거치는 파일 수 */
    files: (path) => new Set(path.map((id) => nodes.get(id).path)).size,
  };
}

/** 순환 묶음(frontend/src/graph/cycles.ts의 cycles와 같은 규칙). 묶음마다 든 모듈 id와, 양 끝이 같은 묶음에 든 import 선 수를 낸다. */
function cyclesOf(graph, hidden) {
  const units = new Set(graph.nodes.filter((n) => (n.kind === "module" || n.kind === "package") && !hidden.has(n.id)).map((n) => n.id));
  const imports = graph.edges.filter((e) => e.kind === "import" && !e.deferred && e.source !== e.target && units.has(e.source) && units.has(e.target));
  const reach = new Map([...units].map((id) => [id, new Set([id])]));
  for (const [id, seen] of reach) {
    for (const at of seen) {
      imports.filter((e) => e.source === at).forEach((e) => seen.add(e.target));
    }
    reach.set(id, seen);
  }
  const groups = [];
  const member = new Map();
  for (const id of [...units].sort(byId)) {
    if (member.has(id)) {
      continue;
    }
    const group = [...reach.get(id)].filter((other) => reach.get(other).has(id)).sort(byId);
    if (group.length > 1) {
      group.forEach((each) => member.set(each, groups.length));
      groups.push(group);
    }
  }
  const lines = imports.filter((e) => member.has(e.source) && member.get(e.source) === member.get(e.target));
  return { groups, member, lines: new Set(lines.map((e) => `${e.source}|${e.target}`)) };
}

// ── 3단계: 화면에서 읽는 값과 조작 ────────────────────────────────

/** 경로의 걸음을 그린 선마다 키, 걸음 종류, 굵기, 색, 점선인지, 불투명도 */
const routeLinesOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge .edge[data-route]")].map((edge) => {
      const style = getComputedStyle(edge.querySelector(".edge-line"));
      return {
        key: edge.dataset.key,
        kind: edge.dataset.route,
        width: parseFloat(style.strokeWidth),
        stroke: style.stroke,
        dashed: style.strokeDasharray !== "none",
        opacity: Number(getComputedStyle(edge).opacity),
      };
    }),
  );

/** 노드마다 바탕 요소의 불투명도 */
const opacitiesOf = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll(".react-flow__node")]
        .filter((wrapper) => !wrapper.dataset.id.endsWith("#face"))
        .map((wrapper) => [wrapper.dataset.id, Number(getComputedStyle(wrapper).opacity)]),
    ),
  );

const pinnedOf = (page) => page.evaluate(() => document.querySelector(".graph").hasAttribute("data-pinned"));

/** 경로 탐색 창의 숫자 버튼마다 숫자, 아래 글자, 말풍선 글, 눌린 상태 */
const picksOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".finder-pick")].map((button) => ({
      number: button.querySelector("b").textContent,
      steps: button.querySelector("span").textContent,
      tip: button.title,
      pressed: button.getAttribute("aria-pressed") === "true",
    })),
  );

/** 미니맵 위에 그린 경로의 꼭짓점 수. 경로를 그리지 않았으면 0이다. */
const minimapRoute = (page) =>
  page.evaluate(() => {
    const line = document.querySelector(".graph-minimap svg .minimap-route-line");
    const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
    const probe = document.createElement("i");
    probe.style.color = ink;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return {
      points: line?.getAttribute("points").split(" ").length ?? 0,
      ink: line !== null && getComputedStyle(line).stroke === rgb,
      ends: document.querySelector(".minimap-route-end")?.getAttribute("d").split("M").length - 1 || 0,
    };
  });

/** 단계 목록의 지금 단계 행의 노드 id와, 그 행이 단계 목록의 보이는 영역 안에 있는지 */
const currentStep = (page) =>
  page.evaluate(() => {
    const list = document.querySelector(".finder-steps")?.getBoundingClientRect();
    const row = document.querySelector('.finder-step[aria-current="true"]');
    const rect = row?.getBoundingClientRect();
    return {
      id: row?.dataset.node ?? null,
      shown: list !== undefined && rect !== undefined && rect.top >= list.top - 1 && rect.bottom <= list.bottom + 1,
    };
  });

/** Mod+P 팔레트에 text를 넣고 id의 행을 고른다. */
async function palettePick(page, text, id) {
  await page.keyboard.press(`${MOD}+p`);
  await page.waitForSelector(".palette-input", { timeout: 5_000 });
  await page.keyboard.type(text);
  await page.waitForSelector(`.palette-option[data-node="${id}"]`, { timeout: 5_000 });
  await page.click(`.palette-option[data-node="${id}"]`);
  await page.waitForSelector(".palette", { state: "detached", timeout: 3_000 }).catch(() => {});
}

/** 단계 목록의 행마다 노드 id와 이음 표시 */
const stepsShown = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".finder-step")].map((row) => ({ id: row.dataset.node, mark: row.querySelector(".finder-step-mark")?.textContent ?? null })),
  );

/** 화면 좌표 point의 맨 위 요소가 받는 커서 */
const cursorAt = (page, point) => page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)).cursor, point);

/** 노드의 이름표가 패널과 왼쪽 아래 칸이 가리지 않는 영역 안에 있고 가운데 점에서 그 노드가 눌리는지 */
async function reachable(page, id) {
  const { clear } = await stageOf(page);
  return page.evaluate(
    ([text, body, free]) => {
      const label = document.querySelector(`${text} .node-label`);
      if (label === null) {
        return { ok: false, at: "없음" };
      }
      const rect = label.getBoundingClientRect();
      const [x, y] = [rect.left + rect.width / 2, rect.top + rect.height / 2];
      const inside = x >= free.x && x <= free.x + free.width && y >= free.y && y <= free.y + free.height;
      const hit = document.elementFromPoint(x, y);
      const own = hit !== null && [text, body].some((selector) => document.querySelector(selector)?.contains(hit) === true);
      return { ok: inside && own, at: `(${Math.round(x)}, ${Math.round(y)})` };
    },
    [face(id), node(id), clear],
  );
}

/** 선택자가 고른 요소마다 가운데 점에서 그 요소가 눌리는지. 눌리지 않는 요소의 글자를 낸다. */
const unhittable = (page, selector) =>
  page.evaluate((sel) => {
    const missed = [];
    for (const element of document.querySelectorAll(sel)) {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (rect.width === 0 || hit === null || !element.contains(hit)) {
        missed.push(element.textContent.trim());
      }
    }
    return missed;
  }, selector);

async function openFinder(page) {
  if ((await page.getAttribute(".finder-button", "aria-expanded")) !== "true") {
    await page.click(".finder-button");
  }
  await page.waitForSelector(".finder", { timeout: 5_000 });
}

/** 경로 탐색 창의 칸에 text를 넣고 결과 행에서 id를 고른다. */
async function fillEnd(page, end, { id, text }) {
  const field = `.finder-field[data-end="${end}"]`;
  if ((await count(page, `${field} .finder-input`)) === 0) {
    await page.click(`${field} .finder-value`);
  }
  await page.click(`${field} .finder-input`);
  await page.keyboard.type(text);
  await page.waitForSelector(`.finder-hit[data-node="${id}"]`, { timeout: 5_000 });
  await page.click(`.finder-hit[data-node="${id}"]`);
}

/** 선의 불투명도와 노드의 불투명도가 바뀌는 200ms를 더 기다린다. */
async function rest(page) {
  await settle(page);
  await page.waitForTimeout(300);
}

/** 창을 펴고 출발과 도착을 골라 경로 고정에 들어간다. */
async function pin(page, from = TRIP.from, to = TRIP.to) {
  await openFinder(page);
  await fillEnd(page, "from", from);
  await fillEnd(page, "to", to);
  await page.waitForSelector(".graph[data-pinned]", { timeout: 10_000 });
  await page.waitForSelector(".edge[data-route]", { state: "attached", timeout: 10_000 });
  await rest(page);
}

/** 숫자 버튼 index(0부터)를 누르고 새 배치로 옮겨 가는 움직임이 시작됐다가 끝나 걸음 steps개가 그려질 때까지 기다린다. */
async function pickPath(page, index, steps) {
  await page.click(`.finder-pick >> nth=${index}`);
  await page.waitForSelector(".graph[data-moving]", { timeout: 1_500 }).catch(() => {});
  await page.waitForFunction((want) => document.querySelectorAll(".edge[data-route]").length === want, steps, { timeout: 10_000 }).catch(() => {});
  await rest(page);
}

/** 고정 안내 줄이 뒤집힌 횟수를 세기 시작한다. 뒤집히지 않은 줄이 뒤집힌 줄로 바뀔 때마다 하나를 센다. */
const watchFlashes = (page) =>
  page.evaluate(() => {
    window.__shotsFlashes = 0;
    let on = false;
    new MutationObserver(() => {
      const now = document.querySelector(".finder-pinned[data-flash]") !== null;
      if (now && !on) {
        window.__shotsFlashes += 1;
      }
      on = now;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-flash"] });
  });

const flashesOf = (page) => page.evaluate(() => window.__shotsFlashes);

/** 필터 창에서 덮개 kind("none"·"cycles"·"unused")를 고른다. */
async function setOverlay(page, kind) {
  await inFilters(page, () => page.click(`.overlay-option[data-kind="${kind}"]`));
  await page.waitForFunction((want) => (document.querySelector(".graph").dataset.overlay ?? "none") === want, kind, { timeout: 5_000 });
  await rest(page);
}

// ── 3단계 시나리오: 경로 찾기와 경로 고정 ─────────────────────────

async function finderOpen(t, page) {
  await load(page);
  t.check("경로 탐색 창이 접힌 채로 열리고 왼쪽 아래 버튼 줄이 미니맵, 범례, 경로 찾기 순서다", (await count(page, ".finder")) === 0 &&
    same(await page.evaluate(() => [...document.querySelectorAll(".dock-buttons > *")].map((b) => b.getAttribute("aria-label") ?? b.title)), ["미니맵", "범례", "경로 찾기"]),
    (await page.evaluate(() => [...document.querySelectorAll(".dock-buttons > *")].map((b) => b.getAttribute("aria-label") ?? b.title))).join("·"));
  await page.click(".finder-button");
  await page.waitForSelector(".finder", { timeout: 5_000 });
  await page.click(".legend-button");
  await page.waitForSelector(".legend", { timeout: 5_000 });
  /** 펼친 세 칸의 사각형이 서로 겹치지 않고 관계 그래프 영역 안에 있는지 */
  const laid = async () => {
    const [map, legend, finder, buttons] = [await rectOf(page, ".graph-minimap"), await rectOf(page, ".legend"), await rectOf(page, ".finder"), await rectOf(page, ".dock-buttons")];
    const { area } = await stageOf(page);
    const boxes = [map, legend, finder, buttons];
    const separate = boxes.every((a, i) => boxes.slice(i + 1).every((b) => apart(a, b)));
    return { map, legend, finder, buttons, area, ok: separate && boxes.every((box) => within(box, area)) };
  };
  const wide = await laid();
  t.check(
    "경로 찾기 버튼을 누르면 창이 버튼 줄 위에 펼쳐지고 미니맵·범례·창이 왼쪽부터 아래 끝을 맞춰 놓이며 서로 겹치지 않고 관계 그래프 영역 안에 있다",
    wide.ok &&
      wide.finder.y > wide.area.y + wide.area.height / 2 &&
      near(wide.finder.y + wide.finder.height, wide.map.y + wide.map.height) &&
      near(wide.legend.y + wide.legend.height, wide.map.y + wide.map.height) &&
      wide.map.x < wide.legend.x &&
      wide.legend.x < wide.finder.x &&
      wide.finder.y + wide.finder.height < wide.buttons.y,
    `미니맵 ${rectText(wide.map)}, 범례 ${rectText(wide.legend)}, 창 ${rectText(wide.finder)}`,
  );
  const empty = await page.evaluate(() => ({
    fields: [...document.querySelectorAll(".finder-field .finder-input")].map((input) => input.placeholder),
    picks: document.querySelectorAll(".finder-pick").length,
    clear: document.querySelectorAll(".finder-clear").length,
  }));
  t.check(
    "빈 창은 출발 칸과 도착 칸, 맞바꾸기 버튼만 그리고 숫자 버튼과 끄기 버튼은 그리지 않는다",
    empty.fields.length === 2 && empty.fields[0].startsWith("출발") && empty.fields[1].startsWith("도착") && empty.picks === 0 && empty.clear === 0 && (await count(page, ".finder-swap")) === 1,
    empty.fields.join(" / "),
  );
  await t.shot();
  await page.click(".finder-button");
  t.check("버튼을 다시 누르면 창이 접힌다", (await count(page, ".finder")) === 0 && (await page.getAttribute(".finder-button", "aria-expanded")) === "false");

  // 창 폭마다 세 칸을 모두 펴고 경로를 고정해 숫자 버튼과 끄기 버튼이 눌리는지 본다.
  for (const width of [1700, 1280, 980, 720]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
    await settle(page);
    await page.click(".legend-button");
    await pin(page);
    const at = await laid();
    const missed = [...(await unhittable(page, ".finder-pick")), ...(await unhittable(page, ".finder-clear")), ...(await unhittable(page, ".finder-button"))];
    t.check(
      `창 폭 ${width}px: 펼친 세 칸이 서로 겹치지 않고 영역 안에 있으며, 경로 고정 중에 숫자 버튼 ${PATH_LIMIT}개와 끄기 버튼, 경로 찾기 버튼이 가운데 점에서 눌린다`,
      at.ok && (await count(page, ".finder-pick")) === PATH_LIMIT && missed.length === 0,
      `창 ${rectText(at.finder)}, 영역 ${rectText(at.area)}, 눌리지 않는 버튼 ${missed.join("·") || "없음"}`,
    );
    await page.screenshot({ path: join(OUT, `s3-finder-open-${width}.png`) });
    await pickPath(page, 1, 3);
    const second = (await picksOf(page))[1]?.pressed === true;
    await page.click(".finder-clear");
    await rest(page);
    t.check(
      `창 폭 ${width}px: 2번 버튼을 누르면 2번 경로가 눌린 상태가 되고 끄기를 누르면 고정이 풀린다`,
      second && !(await pinnedOf(page)) && (await count(page, ".edge[data-route]")) === 0,
      `2번 눌림 ${second}, 고정 ${await pinnedOf(page)}`,
    );
  }
}

async function finderSearch(t, page) {
  const graph = await api("/api/graph");
  const route = routeOf(graph, TRIP.from.id, TRIP.to.id);
  await load(page);
  await openFinder(page);
  const typed = async (end, { id, text }) => {
    await page.click(`.finder-field[data-end="${end}"] .finder-input`);
    await page.keyboard.type(text);
    await page.waitForSelector(".finder-hit", { timeout: 5_000 });
    const hits = await page.evaluate(() => [...document.querySelectorAll(".finder-hit")].map((row) => ({ id: row.dataset.node, text: row.innerText.replaceAll("\n", " ") })));
    if (end === "from") {
      await t.shot();
    }
    await page.keyboard.press("Enter");
    await page.waitForSelector(`.finder-field[data-end="${end}"] .finder-value`, { timeout: 5_000 }).catch(() => {});
    const value = await page.evaluate((sel) => document.querySelector(sel)?.innerText.replaceAll("\n", " ") ?? "", `.finder-field[data-end="${end}"] .finder-value`);
    return { first: hits[0], count: hits.length, value, ok: hits[0]?.id === id && value.includes(`${text}()`) };
  };
  const from = await typed("from", TRIP.from);
  t.check(`출발 칸에 ${TRIP.from.text}를 넣으면 결과 행이 나오고 Enter로 그 이름이 칸에 적힌다`, from.ok, `첫 결과 "${from.first?.text}", 칸 "${from.value}"`);
  t.check("출발만 고른 동안에는 경로 고정이 아니고 숫자 버튼이 없다", !(await pinnedOf(page)) && (await count(page, ".finder-pick")) === 0);
  const to = await typed("to", TRIP.to);
  t.check(`도착 칸에 ${TRIP.to.text}를 넣으면 결과 행이 나오고 Enter로 그 이름이 칸에 적힌다`, to.ok, `첫 결과 "${to.first?.text}", 칸 "${to.value}"`);
  await page.waitForSelector(".graph[data-pinned]", { timeout: 10_000 }).catch(() => {});
  await rest(page);
  const picks = await picksOf(page);
  const lengths = route.paths.map((path) => path.length - 1);
  t.check(
    `두 칸이 차면 숫자 버튼 ${route.paths.length}개가 1부터 차례로 나오고 1번이 눌린 상태다`,
    route.paths.length === PATH_LIMIT && same(picks.map((p) => p.number), route.paths.map((_, i) => String(i + 1))) && same(picks.map((p) => p.pressed), route.paths.map((_, i) => i === 0)),
    picks.map((p) => `${p.number}${p.pressed ? "(눌림)" : ""}`).join(" "),
  );
  t.check(
    `숫자 아래 단계 수가 /api/graph로 계산한 ${lengths.join("·")}이고 말풍선이 단계 수와 거치는 파일 수를 적는다`,
    same(picks.map((p) => p.steps), lengths.map((n) => `${n}단계`)) && same(picks.map((p) => p.tip), route.paths.map((path) => `${path.length - 1}단계 · 파일 ${route.files(path)}개`)),
    picks.map((p) => `${p.steps}(${p.tip})`).join(", "),
  );
  const more = await page.evaluate(() => document.querySelector(".finder-more")?.textContent ?? "");
  t.check('여섯째 경로가 있으면 "경로가 더 있다"를 적는다', route.more === more.includes("경로가 더 있다") && route.more, more);
  const notice = await page.evaluate(() => document.querySelector(".finder-pinned")?.innerText.replaceAll("\n", " ") ?? "");
  t.check('결과 아래에 "경로 고정 중 · 경로 밖은 눌리지 않는다"와 끄기 버튼이 있다', notice.includes("경로 고정 중 · 경로 밖은 눌리지 않는다") && notice.includes("끄기"), notice);
  await page.screenshot({ path: join(OUT, "s3-finder-search-result.png") });

  // 칸 안의 Esc는 입력만 닫고 창과 고정을 그대로 둔다.
  await page.click('.finder-field[data-end="to"] .finder-value');
  await page.keyboard.type("parse");
  await page.waitForSelector(".finder-hit", { timeout: 5_000 }).catch(() => {});
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  t.check(
    "검색 칸 안의 Esc는 입력만 닫고 창과 경로 고정을 그대로 둔다",
    (await count(page, ".finder-hit")) === 0 && (await count(page, ".finder")) === 1 && (await pinnedOf(page)) && (await count(page, ".finder-pick")) === PATH_LIMIT,
    `결과 행 ${await count(page, ".finder-hit")}개, 고정 ${await pinnedOf(page)}`,
  );
}

async function finderPath(t, page) {
  const graph = await api("/api/graph");
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const route = routeOf(graph, TRIP.from.id, TRIP.to.id);
  const fileOf = (id) => graph.nodes.find((n) => n.kind === "module" && n.path === nodes.get(id).path).id;
  await load(page);
  // 뒤로 갈 단계가 있는 이력에서 고정에 들어가 번호를 바꿔도 이력이 그대로인지 본다.
  await pick(page, FILE);
  await pick(page, FUNCTION);
  await pin(page);
  const ink = await colorOf(page, "--ink");
  const zooms = [];
  let shotAt = null;
  for (const [index, path] of route.paths.entries()) {
    if (index > 0) {
      await pickPath(page, index, path.length - 1);
    }
    zooms.push(await zoomOf(page));
    const lines = await routeLinesOf(page);
    const keys = new Set(path.slice(1).map((id, i) => `${path[i]}|${id}`));
    t.check(
      `${index + 1}번: data-route 선이 그 경로의 걸음 ${path.length - 1}개이고 굵기 ${LINE.step}px, 색 --ink, 불투명도 1이다`,
      lines.length === path.length - 1 &&
        lines.every((line) => keys.has(line.key.split("|").slice(0, 2).join("|")) || line.key.startsWith("step|")) &&
        lines.every((line) => near(line.width, LINE.step, 0.01) && line.stroke === ink.rgb && line.opacity === 1),
      lines.map((line) => `${line.key} ${line.width}px`).join(", "),
    );
    const edges = await edgesOf(page);
    const others = edges.filter((e) => !lines.some((line) => line.key === e.key));
    t.check(
      `${index + 1}번: 그 밖의 선은 모두 muted 잉크에 불투명도 ${DIM}이다`,
      others.length > 0 && others.every((e) => e.tone === "muted" && e.opacity === DIM),
      toneLevels(edges),
    );
    const opacity = await opacitiesOf(page);
    const files = new Set(path.map(fileOf));
    const boxed = (await boxes(page)).map((b) => b.id);
    t.check(
      `${index + 1}번: 경로 위 노드와 그 파일 상자는 불투명도 1, 그 밖의 파일 상자는 ${DIM}이다`,
      path.every((id) => opacity[id] === 1) && boxed.every((id) => opacity[id] === (files.has(id) ? 1 : DIM)) && boxed.some((id) => !files.has(id)),
      `경로 위 ${path.map((id) => opacity[id]).join("·")}, 파일 상자 ${boxed.filter((id) => opacity[id] === 1).join("·")}`,
    );
    const ends = await page.evaluate(() =>
      [...document.querySelectorAll(".route-end")].map((mark) => `${mark.closest(".react-flow__node").dataset.id.replace(/#face$/, "")} ${mark.textContent}`),
    );
    const listed = (await stepsShown(page)).map((row) => row.id);
    t.check(
      `${index + 1}번: 출발·도착 표지가 하나씩 보이고 단계 목록이 경로의 노드 순서와 같다`,
      same(ends.sort(), [`${path[0]} 출발`, `${path.at(-1)} 도착`].sort()) && same(listed, path),
      `표지 ${ends.join(", ")}, 목록 ${listed.length}행`,
    );
    const [seen, next] = [await reachable(page, path[0]), await reachable(page, path[1])];
    t.check(
      `${index + 1}번: 정보 패널과 단계 목록의 지금 단계가 출발 노드이고, 출발 노드와 다음 걸음의 노드가 패널과 왼쪽 아래 칸이 가리지 않는 영역 안에서 눌린다`,
      (await headOf(page)).includes(spanOf(graph, path[0]).text) && (await selectedOf(page)) === path[0] && (await currentStep(page)).id === path[0] && seen.ok && next.ok,
      `선택 고리 ${await selectedOf(page)}, 출발 이름표 ${seen.at}, 다음 노드 이름표 ${next.at}`,
    );
    const drawnOn = await minimapRoute(page);
    t.check(
      `${index + 1}번: 미니맵이 경로의 노드 ${path.length}개를 본문 잉크 선으로 잇고 출발과 도착에 원을 그린다`,
      drawnOn.points === path.length && drawnOn.ink && drawnOn.ends === 2,
      `꼭짓점 ${drawnOn.points}개, 원 ${drawnOn.ends}개`,
    );
    if (path.includes("note_common:build_upcoming")) {
      const inside = Object.keys(opacity).filter((id) => id.startsWith("note_common:"));
      t.check(
        `${index + 1}번: note_common.py가 펼쳐져 경로 위의 build_upcoming()만 보인다`,
        (await boxes(page)).find((b) => b.id === "note_common")?.open === true && same(inside, ["note_common:build_upcoming"]),
        inside.join(", "),
      );
      shotAt = index + 1;
      await page.screenshot({ path: join(OUT, "s3-finder-path-via.png") });
    }
    if (index === 0) {
      await t.shot();
    }
  }
  t.check("경로 가운데 note_common.py의 build_upcoming()을 지나는 경로가 있다", shotAt !== null, `${shotAt}번`);
  t.check(
    `번호를 바꾸는 동안 확대 비율이 ${NAMED_ZOOM} 그대로다`,
    zooms.every((zoom) => near(zoom, zooms[0], 0.001)) && zooms[0] >= NAMED_ZOOM - 0.001,
    zooms.map((zoom) => zoom.toFixed(3)).join(" → "),
  );

  // 1번 경로로 돌아가 경로 전체를 보이게 한 뒤 경로 밖 선을 본다.
  await pickPath(page, 0, route.paths[0].length - 1);
  const transformOf = () => page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform);
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await page.waitForTimeout(600);
  await rest(page);
  const fitted = { transform: await transformOf(), zoom: await zoomOf(page), seen: [] };
  for (const id of route.paths[0]) {
    fitted.seen.push((await reachable(page, id)).ok);
  }
  t.check(
    "고정 중의 화면 맞춤은 경로 위 노드가 모두 패널과 왼쪽 아래 칸이 가리지 않는 영역에 보이게 맞추고 확대 비율을 100%보다 키우지 않는다",
    fitted.seen.every(Boolean) && fitted.zoom <= 1.001 && (await pinnedOf(page)),
    `보이는 노드 ${fitted.seen.filter(Boolean).length}/${fitted.seen.length}, 확대 비율 ${fitted.zoom.toFixed(3)}`,
  );
  await page.screenshot({ path: join(OUT, "s3-finder-path-fit.png") });
  await page.click(".finder-step >> nth=-1");
  await page.waitForTimeout(600);
  await rest(page);
  const stepped = await transformOf();
  await page.click(".finder-fit");
  await page.waitForTimeout(600);
  await rest(page);
  t.check(
    "경로 탐색 창의 경로 전체 보기 버튼이 화면 맞춤과 같은 화면으로 맞춘다",
    stepped !== fitted.transform && (await transformOf()) === fitted.transform,
    `${stepped} → ${await transformOf()}`,
  );
  await page.click(".finder-step >> nth=0");
  await page.click(".finder-fit");
  await page.waitForTimeout(600);
  await rest(page);
  const first = { lines: (await routeLinesOf(page)).map((line) => line.key).sort(), opacity: await opacitiesOf(page) };
  // 경로 밖 선은 올려도 강조되지 않고 눌러도 강조가 그대로다.
  const aggregate = await hittable(page, (await linesOf(page)).filter((line) => line.key.startsWith("agg|")));
  if (aggregate === null) {
    t.skip("경로 밖 집계 선에 올리기와 클릭", "누를 수 있는 집계 선이 화면에 없다");
  } else {
    await watchFlashes(page);
    await page.mouse.move(aggregate.at.x - 1, aggregate.at.y);
    await page.mouse.move(aggregate.at.x, aggregate.at.y);
    await page.waitForSelector(".tooltip", { timeout: 3_000 }).catch(() => {});
    const hovered = (await linesOf(page)).find((line) => line.key === aggregate.line.key);
    t.check(
      "경로 밖 집계 선에 올리면 선이 굵어지거나 진해지지 않고 말풍선만 뜨며 커서가 not-allowed다",
      !hovered.pointed && near(hovered.width, LINE.rest, 0.01) && hovered.tone === "muted" && hovered.opacity === DIM && (await tipText(page)) !== "" && (await cursorAt(page, aggregate.at)) === "not-allowed",
      `굵기 ${hovered.width}px, 불투명도 ${hovered.opacity}, 말풍선 "${(await tipText(page)).replaceAll("\n", " / ")}"`,
    );
    await page.mouse.click(aggregate.at.x, aggregate.at.y);
    await page.waitForTimeout(250);
    await page.mouse.move(5, 5);
    await page.waitForSelector(".finder-pinned[data-flash]", { state: "detached", timeout: 3_000 }).catch(() => {});
    await rest(page);
    const after = (await routeLinesOf(page)).map((line) => line.key).sort();
    t.check(
      "경로 밖 집계 선을 누르면 강조와 보이는 노드가 그대로이고 안내 줄이 한 번 뒤집힌다",
      same(after, first.lines) && (await selectedOf(page)) === route.paths[0][0] && (await flashesOf(page)) === 1 && same(await opacitiesOf(page), first.opacity),
      `걸음 ${after.length}개, 보이는 노드 ${await selectedOf(page)}, 뒤집힘 ${await flashesOf(page)}번`,
    );
  }
  await page.click(".finder-clear");
  await rest(page);
  t.check("끄면 미니맵의 경로가 사라진다", (await minimapRoute(page)).points === 0);
  const back = await selectedOf(page);
  await page.keyboard.press("Alt+ArrowLeft");
  await waitSelected(page, FILE).catch(() => {});
  t.check(
    "끄면 고정 전에 고른 함수로 돌아오고, 뒤로 가기가 고정 전 이력의 직전 단계로 간다",
    back === FUNCTION && (await selectedOf(page)) === FILE,
    `끈 뒤 선택 ${back}, 뒤로 간 뒤 ${await selectedOf(page)}`,
  );
}

async function finderFolder(t, page) {
  const ends = { from: { id: "doc_update:execute_all_ready", text: "execute_all_ready" }, to: { id: "parser.plan:parse_plan", text: "parse_plan" } };
  await load(page);
  await page.click('.tree-row.tree-dir[data-node="parser"]');
  await page.waitForSelector(`${node("parser")} > .node-package`, { timeout: 30_000 });
  await settle(page);
  const before = await flowBoxes(page);
  await pin(page, ends.from, ends.to);
  const during = await flowBoxes(page);
  t.check(
    "접은 parser/ 안의 도착 노드로 경로를 고정하면 parser/plan.py 상자가 보이고 parse_plan()이 그려진다",
    during["parser.plan"] !== undefined && during[ends.to.id] !== undefined && (await count(page, `${node("parser")} > .node-package`)) === 0,
    `parser/plan.py ${during["parser.plan"] !== undefined}, parse_plan() ${during[ends.to.id] !== undefined}`,
  );
  const treeFolded = (await page.getAttribute('.tree-row.tree-dir[data-node="parser"]', "aria-expanded")) === "false";
  t.check("고정 중에도 파일트리의 parser/ 행은 접힌 채다", treeFolded);
  await t.shot();
  await page.click(".finder-clear");
  await page.waitForSelector(`${node("parser")} > .node-package`, { timeout: 30_000 }).catch(() => {});
  await rest(page);
  const after = await flowBoxes(page);
  t.check(
    "끄면 parser/가 다시 접힌 상자 하나이고 모든 상자의 위치와 크기가 고정 전과 같다",
    (await count(page, `${node("parser")} > .node-package`)) === 1 && same(Object.keys(after).sort(), Object.keys(before).sort()) && Object.keys(before).every((id) => sameRect(after[id], before[id])),
    `상자 ${Object.keys(before).length}개 → ${Object.keys(after).length}개`,
  );
}

async function finderStep(t, page) {
  const graph = await api("/api/graph");
  const route = routeOf(graph, TRIP.from.id, TRIP.to.id);
  const index = route.paths.findIndex((path) => path.includes("note_batch:create_note") && path.length >= 4);
  if (index < 0) {
    t.check("create_note()를 지나는 세 단계 이상의 경로가 있다", false);
    return;
  }
  const path = route.paths[index];
  const initRow = '.tree-row.tree-file[title$="parser/__init__.py"]';
  await load(page);
  // 노드 없는 __init__.py를 정보 패널에 연 채 고정에 들어간다.
  await page.click(initRow);
  await page.waitForFunction(() => document.querySelector(".info-panel-head")?.innerText.includes("__init__.py"), null, { timeout: 10_000 }).catch(() => {});
  const opened = (await headOf(page)).includes("__init__.py");
  await pin(page);
  t.check(
    "정보 패널에 연 __init__.py는 고정에 들어가면 닫히고 정보 패널이 출발 노드를 보인다",
    opened && (await headOf(page)).includes(spanOf(graph, TRIP.from.id).text) && (await count(page, `${initRow}.active`)) === 0,
    (await headOf(page)).split("\n")[0],
  );
  await pickPath(page, index, path.length - 1);
  const state = async () => ({ lines: (await routeLinesOf(page)).map((line) => line.key).sort(), opacity: await opacitiesOf(page) });
  const before = await state();
  /** 경로 위 노드 id가 정보 패널, 탐색 경로 표시, 선택 고리, 코드 뷰어에 보이고 강조가 그대로인지 */
  const focusedOn = async (id) => {
    const want = graph.nodes.find((n) => n.id === id);
    await page.waitForFunction((text) => document.querySelector(".info-panel-head")?.innerText.includes(text), spanOf(graph, id).text, { timeout: 10_000 }).catch(() => {});
    await page.waitForFunction((name) => document.querySelector(".info-panel .monaco-editor .view-lines")?.textContent.replaceAll(" ", " ").includes(`def ${name}`), want.name, { timeout: 10_000 }).catch(() => {});
    await rest(page);
    const now = await state();
    const trail = await page.evaluate(() => document.querySelector(".trail-last")?.textContent ?? "");
    const code = await page.evaluate(() => document.querySelector(".info-panel .monaco-editor .view-lines")?.textContent.replaceAll(" ", " ") ?? "");
    const current = await currentStep(page);
    const row = await page.evaluate(() => [...document.querySelectorAll(".tree-row.active")].map((element) => element.dataset.node ?? null));
    return {
      ok:
        (await headOf(page)).includes(spanOf(graph, id).text) &&
        trail === `${want.name}()` &&
        code.includes(`def ${want.name}`) &&
        (await selectedOf(page)) === id &&
        current.id === id &&
        current.shown &&
        same(row, [id]) &&
        same(now.lines, before.lines) &&
        same(now.opacity, before.opacity),
      text: `머리 줄 ${(await headOf(page)).split("\n")[0]}, 탐색 경로 ${trail}, 선택 고리 ${await selectedOf(page)}, 파일트리의 고른 행 ${row.join("·")}, 걸음 ${now.lines.length}개`,
    };
  };
  await page.click(".finder-step >> nth=2");
  const third = await focusedOn(path[2]);
  const seen = await reachable(page, path[2]);
  t.check(
    `${index + 1}번 경로의 셋째 단계를 누르면 정보 패널·탐색 경로 표시·코드 뷰어·선택 고리·파일트리의 고른 행이 그 노드로 바뀌고 강조는 그대로다`,
    third.ok,
    third.text,
  );
  t.check("단계를 누르면 그 노드가 패널과 왼쪽 아래 칸이 가리지 않는 영역 안으로 와서 눌린다", seen.ok, `이름표 ${seen.at}`);
  await t.shot();
  // 단계를 차례로 눌러 출발부터 도착까지 따라간다.
  const walked = [];
  for (const [at, id] of path.entries()) {
    await page.click(`.finder-step >> nth=${at}`);
    await page.waitForTimeout(600);
    await rest(page);
    walked.push((await reachable(page, id)).ok && (await currentStep(page)).id === id);
  }
  t.check("단계를 1행부터 차례로 누르면 단계마다 그 노드가 가리지 않는 영역에 보인다", walked.every(Boolean), walked.map((ok) => (ok ? "보임" : "안 보임")).join(" → "));
  // 도착 노드를 보이는 화면에서 Mod+P로 출발 노드를 고른다.
  const away = await reachable(page, path[0]);
  await palettePick(page, TRIP.from.text, path[0]);
  const paletted = await focusedOn(path[0]);
  const arrived = await reachable(page, path[0]);
  t.check(
    "Mod+P로 경로 위 노드를 고르면 정보 패널이 그 노드를 보이고 화면이 그 노드로 옮겨진다",
    !away.ok && paletted.ok && arrived.ok,
    `고르기 전 ${away.at}, 고른 뒤 ${arrived.at}, ${paletted.text}`,
  );
  // 경로 전체를 보이게 줄인 화면에서 지금 단계의 행을 다시 누른다.
  await page.click(".finder-fit");
  await page.waitForTimeout(600);
  await rest(page);
  const wide = await zoomOf(page);
  await page.click(".finder-step >> nth=0");
  await page.waitForTimeout(600);
  await rest(page);
  t.check(
    `경로 전체 보기 뒤에 지금 단계의 행을 다시 누르면 확대 비율이 ${NAMED_ZOOM}로 돌아오고 그 노드가 가리지 않는 영역에 보인다`,
    wide < NAMED_ZOOM && near(await zoomOf(page), NAMED_ZOOM, 0.001) && (await reachable(page, path[0])).ok && (await currentStep(page)).id === path[0],
    `${wide.toFixed(3)} → ${(await zoomOf(page)).toFixed(3)}`,
  );
  // 고정 중에는 노드 없는 __init__.py 행이 정보 패널을 바꾸지 않는다.
  await watchFlashes(page);
  const headBefore = await headOf(page);
  await page.click(initRow);
  await page.waitForTimeout(250);
  const flashed = await flashesOf(page);
  await page.waitForSelector(".finder-pinned[data-flash]", { state: "detached", timeout: 3_000 }).catch(() => {});
  t.check(
    "고정 중에 파일트리의 노드 없는 __init__.py 행을 누르면 정보 패널이 그대로이고 안내 줄이 한 번 뒤집힌다",
    (await headOf(page)) === headBefore && flashed === 1 && (await count(page, `${initRow}.active`)) === 0 && (await pinnedOf(page)),
    `머리 줄 ${(await headOf(page)).split("\n")[0]}, 뒤집힘 ${flashed}번`,
  );
  // 다른 단계를 보이는 화면 가운데 create_note()가 가리지 않는 영역에 있는 화면에서 그래프의 그 노드를 누른다.
  for (const [at, id] of path.entries()) {
    if (id !== "note_batch:create_note") {
      await page.click(`.finder-step >> nth=${at}`);
      await focusedOn(id);
      if ((await reachable(page, "note_batch:create_note")).ok) {
        break;
      }
    }
  }
  await clickNode(page, "note_batch:create_note");
  const clicked = await focusedOn("note_batch:create_note");
  t.check("그래프에서 경로 위 노드 create_note()를 누르면 그 노드가 정보 패널에 보이고 강조는 그대로다", clicked.ok, clicked.text);
  const strong = (await edgesOf(page)).filter((e) => e.tone === "strong").map((e) => e.key).sort();
  t.check("본문 잉크 선이 경로의 걸음뿐이다", same(strong, before.lines), `본문 잉크 ${strong.length}개, 걸음 ${before.lines.length}개`);
  // 도착 노드가 지금 보이는 노드가 아닌 걸음을 누른다.
  const steps = (await routeLinesOf(page)).filter((line) => line.key.split("|")[1] !== "note_batch:create_note");
  const found = await hittable(page, steps);
  if (found === null) {
    t.check("경로 위의 선 가운데 누를 수 있는 선이 있다", false);
    return;
  }
  const target = found.line.key.split("|")[1];
  t.check("경로 위의 선에 올리면 커서가 pointer다", (await cursorAt(page, found.at)) === "pointer", await cursorAt(page, found.at));
  await page.mouse.click(found.at.x, found.at.y);
  await page.mouse.move(5, 5);
  const lined = await focusedOn(target);
  t.check("경로 위의 선을 누르면 그 선의 도착 노드가 정보 패널에 보이고 강조는 그대로다", lined.ok, lined.text);

  // 낮은 창에서 단계 목록이 목록 안에서 스크롤되고 지금 단계의 행이 목록 안에 보인다.
  await page.setViewportSize({ width: VIEW.width, height: LOW_HEIGHT });
  await page.waitForTimeout(400);
  await rest(page);
  const sizes = () =>
    page.evaluate(() => {
      const list = document.querySelector(".finder-steps");
      return {
        finder: document.querySelector(".finder").getBoundingClientRect().height,
        area: document.querySelector(".graph").getBoundingClientRect().height,
        shown: list.clientHeight,
        whole: list.scrollHeight,
        limit: getComputedStyle(list).maxHeight,
      };
    });
  const low = await sizes();
  const kept = [];
  for (const id of [path.at(-1), path[0]]) {
    await palettePick(page, graph.nodes.find((n) => n.id === id).name, id);
    await page.waitForTimeout(600);
    await rest(page);
    const current = await currentStep(page);
    kept.push(current.id === id && current.shown);
  }
  t.check(
    `창 높이 ${LOW_HEIGHT}px에서 경로 탐색 창이 그래프 영역 높이의 절반을 넘지 않고 단계 목록이 목록 안에서 스크롤된다`,
    low.finder <= low.area * 0.5 + 1 && low.whole > low.shown && low.limit === `${STEP_ROWS * STEP_HEIGHT}px`,
    `창 ${Math.round(low.finder)}px / 영역 ${Math.round(low.area)}px, 목록 ${low.shown}px / 내용 ${low.whole}px, 상한 ${low.limit}`,
  );
  t.check("도착 노드와 출발 노드를 차례로 고르면 지금 단계의 행이 단계 목록 안에 보인다", kept.every(Boolean), kept.join(" · "));
  await page.screenshot({ path: join(OUT, "s3-finder-step-low.png") });
  await page.setViewportSize(VIEW);
}

async function finderNone(t, page) {
  const graph = await api("/api/graph");
  const route = routeOf(graph, TRIP.to.id, TRIP.from.id);
  const reverse = routeOf(graph, TRIP.from.id, TRIP.to.id);
  await load(page);
  await openFinder(page);
  await fillEnd(page, "from", TRIP.to);
  await fillEnd(page, "to", TRIP.from);
  await page.waitForSelector(".finder-empty", { timeout: 10_000 });
  await rest(page);
  const lines = await page.evaluate(() => [...document.querySelectorAll(".finder-empty p")].map((p) => p.textContent));
  const reach = route.unresolved === 0
    ? `출발에서 닿는 함수는 ${route.reach}개이고 그 안에 대상을 확인하지 못한 호출(?)은 없다`
    : `출발에서 닿는 함수 ${route.reach}개 안에 대상을 확인하지 못한 호출(?)이 ${route.unresolved}곳 있다. 그 호출을 거쳐 실제로는 닿을 수 있다`;
  t.check(
    "경로가 없으면 그 사실과 출발에서 닿는 함수 수·미확인 호출 수, 반대 방향에 경로가 있음을 적는다",
    route.paths.length === 0 && same(lines, ["실행 선으로 이어지는 경로가 없다", reach, "반대 방향에는 경로가 있다"]),
    lines.join(" / "),
  );
  t.check(
    "경로가 없으면 고정이 아니어서 data-route 선과 숫자 버튼, 끄기 버튼이 없다",
    !(await pinnedOf(page)) && (await count(page, ".edge[data-route]")) === 0 && (await count(page, ".finder-pick")) === 0 && (await count(page, ".finder-clear")) === 0,
  );
  await pick(page, FILE);
  t.check("경로가 없는 동안에는 노드를 눌러 고를 수 있다", (await selectedOf(page)) === FILE, `선택 ${await selectedOf(page)}`);
  await t.shot();
  await page.click(".finder-reverse");
  await page.waitForSelector(".graph[data-pinned]", { timeout: 10_000 }).catch(() => {});
  await rest(page);
  t.check(
    `맞바꾸기 버튼을 누르면 숫자 버튼 ${reverse.paths.length}개가 나오고 경로 고정에 들어간다`,
    (await pinnedOf(page)) && (await count(page, ".finder-pick")) === reverse.paths.length && (await count(page, ".finder-empty")) === 0,
    `숫자 버튼 ${await count(page, ".finder-pick")}개`,
  );
  // 출발과 도착이 같은 곳이면 한 줄만 적는다.
  await fillEnd(page, "to", { id: "arbiter", text: "arbiter.py" });
  await page.waitForSelector(".finder-empty", { timeout: 10_000 }).catch(() => {});
  await page.waitForSelector(".graph:not([data-pinned])", { timeout: 10_000 }).catch(() => {});
  const inside = await page.evaluate(() => [...document.querySelectorAll(".finder-empty p")].map((p) => p.textContent));
  t.check("도착이 출발을 품은 파일이면 \"출발과 도착이 같은 곳이다\"만 적는다", same(inside, ["출발과 도착이 같은 곳이다"]) && !(await pinnedOf(page)), inside.join(" / "));
}

async function finderPin(t, page) {
  const graph = await api("/api/graph");
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const route = routeOf(graph, TRIP.from.id, TRIP.to.id);
  const path = route.paths[0];
  const fileOf = (id) => graph.nodes.find((n) => n.kind === "module" && n.path === nodes.get(id).path).id;
  const onPath = new Set(path.map(fileOf));
  /** 경로 밖 파일 상자, 경로 밖 함수, 요약에 적을 경로 밖 정의 표기 */
  const outside = { file: "doc_update", ref: `${FILE}.py::${FUNCTION.split(":")[1]}` };
  if (onPath.has(outside.file) || onPath.has("parser.plan") || path.includes(FUNCTION)) {
    t.check("1번 경로가 doc_update.py, parser/, _rebuild_note_sections()를 지나지 않는다", false, path.join(" → "));
    return;
  }
  // 도착 노드의 요약을 경로 밖 정의 표기를 담은 글로 대신 답한다.
  const fake = `계획 날짜 문자열을 날짜로 바꾼다.\n\n하는 일\n\`${outside.ref}\`와 같은 형식을 읽는다.\n\n앞뒤 흐름\n계획 파서가 부른다.`;
  await page.route(
    (at) => at.pathname === "/api/summary" && at.searchParams.get("node") === TRIP.to.id,
    (routed) => (routed.request().method() === "GET" ? routed.fulfill({ json: { summary: fake, stale: false, available: true, reason: null } }) : routed.fallback()),
  );
  await load(page);
  await pick(page, FILE);
  await pick(page, FUNCTION);
  await page.click('.tree-row.tree-dir[data-node="parser"]');
  await page.waitForSelector(`${node("parser")} > .node-package`, { timeout: 30_000 });
  await settle(page);
  const settings = async () => ({
    tests: await toggled(page, "테스트 코드"),
    external: await toggled(page, "외부 노드"),
    depth: await inFilters(page, () => page.locator('.filter-panel input[type="range"]').inputValue()),
  });
  const free = await settings();
  await pin(page);
  await watchFlashes(page);

  const state = async () => ({
    lines: (await routeLinesOf(page)).map((line) => line.key).sort(),
    open: (await boxes(page)).filter((b) => b.open).map((b) => b.id).sort(),
    folded: await page.evaluate(() => [...document.querySelectorAll(".react-flow__node > .node-body.node-package")].map((e) => e.closest(".react-flow__node").dataset.id).sort()),
    calls: await count(page, ".node-call"),
    pinned: await pinnedOf(page),
    focus: await selectedOf(page),
    settings: await settings(),
  });
  const pinnedState = await state();
  /** 조작 act 뒤에 강조와 펼친 상자, 뷰, 토글이 그대로이고 안내 줄이 flashes번 뒤집혔는지 본다. focus는 조작 뒤 정보 패널이 보일 노드다. */
  const blocked = async (label, act, flashes = 1, focus = pinnedState.focus) => {
    const seen = await flashesOf(page);
    await act();
    await page.waitForTimeout(250);
    const added = (await flashesOf(page)) - seen;
    await page.waitForSelector(".finder-pinned[data-flash]", { state: "detached", timeout: 3_000 }).catch(() => {});
    await rest(page);
    const now = await state();
    t.check(
      `${label}: 강조·펼친 상자·뷰·토글이 그대로이고 안내 줄이 ${flashes === 0 ? "뒤집히지 않는다" : "한 번 뒤집혔다 돌아온다"}`,
      same({ ...now, focus: null }, { ...pinnedState, focus: null }) && now.focus === focus && added === flashes && (await count(page, ".finder-pinned[data-flash]")) === 0,
      `걸음 ${now.lines.length}개, 펼친 상자 ${now.open.join("·")}, 보이는 노드 ${now.focus}, 뒤집힘 ${added}번`,
    );
  };

  t.check(
    "고정 중에 뒤로·앞으로 버튼, 필터 창의 흐름 단계 슬라이더, 테스트 코드·외부 노드 토글이 disabled이고 자동 요약 토글은 아니다",
    (await page.getByRole("button", { name: "뒤로" }).isDisabled()) &&
      (await page.getByRole("button", { name: "앞으로" }).isDisabled()) &&
      (await inFilters(page, async () => {
        const panel = page.locator(".filter-panel");
        return (
          (await panel.locator('input[type="range"]').isDisabled()) &&
          (await panel.getByLabel("테스트 코드").isDisabled()) &&
          (await panel.getByLabel("외부 노드").isDisabled()) &&
          !(await panel.getByLabel("자동 요약").isDisabled())
        );
      })),
  );
  // 고정 중에도 화면 맞춤은 동작한다. 경로 전체를 보이게 한 뒤 경로 밖 요소를 누른다.
  const viewport = () => page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform);
  const fitted = await viewport();
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await page.waitForTimeout(600);
  await rest(page);
  t.check("고정 중에도 화면 맞춤이 화면을 옮기고 고정은 그대로다", (await viewport()) !== fitted && same((await state()).lines, pinnedState.lines), `${fitted} → ${await viewport()}`);
  const boxAt = center(await rectOf(page, `${face(outside.file)} .node-label`));
  const folderAt = center(await rectOf(page, `${face("parser")} .node-label`));
  const stepAt = center(await rectOf(page, `${face(path[0])} .node-label`));
  t.check(
    "경로 밖 파일 상자와 접힌 폴더 상자의 커서가 not-allowed이고 경로 위 노드의 커서는 pointer다",
    (await cursorAt(page, boxAt)) === "not-allowed" && (await cursorAt(page, folderAt)) === "not-allowed" && (await cursorAt(page, stepAt)) === "pointer",
    `파일 상자 ${await cursorAt(page, boxAt)}, 폴더 상자 ${await cursorAt(page, folderAt)}, 경로 위 노드 ${await cursorAt(page, stepAt)}`,
  );

  await blocked("경로 밖 파일 상자 클릭", () => clickNode(page, outside.file));
  await t.shot();
  await blocked("접힌 폴더 상자 클릭", () => clickNode(page, "parser"));
  const step = await hittable(page, (await linesOf(page)).filter((line) => pinnedState.lines.includes(line.key)));
  if (step !== null) {
    await page.mouse.move(step.at.x - 1, step.at.y);
    await page.mouse.move(step.at.x, step.at.y);
    await page.waitForTimeout(200);
    const hovered = (await linesOf(page)).find((line) => line.key === step.line.key);
    t.check(`경로의 걸음에 올리면 ${LINE.pointed}px로 굵어진다`, hovered.pointed && near(hovered.width, LINE.pointed, 0.01), `굵기 ${hovered.width}px`);
    await page.mouse.move(5, 5);
  }
  const { clear } = await stageOf(page);
  const blank = await page.evaluate(({ x, y, width, height }) => {
    for (let dy = 8; dy < height; dy += 16) {
      for (let dx = 8; dx < width; dx += 16) {
        if (document.elementFromPoint(x + dx, y + dy)?.classList.contains("react-flow__pane")) {
          return { x: x + dx, y: y + dy };
        }
      }
    }
    return null;
  }, clear);
  await blocked("그래프 바탕 클릭", () => page.mouse.click(blank.x, blank.y), 0);
  await blocked("Esc 두 번", async () => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }, 0);
  // 출발 노드를 가리지 않는 영역으로 옮긴 뒤 더블클릭한다. 첫 클릭은 이미 보이는 노드를 다시 고르고 둘째 클릭의 함수 시점 뷰 진입이 막힌다.
  await page.click(".finder-step >> nth=0");
  await rest(page);
  await blocked("경로 위 함수 더블클릭", () => clickNode(page, path[0], 2), 1, path[0]);
  await blocked("파일트리의 경로 밖 파일 클릭", () => page.click(`.tree-row.tree-file[data-node="${outside.file}"]`), 1, path[0]);
  await blocked("파일트리의 접은 폴더 행 클릭", () => page.click('.tree-row.tree-dir[data-node="parser"]'), 1, path[0]);
  await blocked("Mod+P로 경로 밖 함수 고르기", async () => {
    await page.keyboard.press(`${MOD}+p`);
    await page.waitForSelector(".palette-input", { timeout: 5_000 });
    await page.keyboard.type("rns");
    await page.waitForSelector(`.palette-option[data-node="${FUNCTION}"]`, { timeout: 5_000 });
    await page.keyboard.press("Enter");
    await page.waitForSelector(".palette", { state: "detached", timeout: 3_000 }).catch(() => {});
  }, 1, path[0]);
  t.check("Mod+P 팔레트는 고른 뒤 닫힌다", (await count(page, ".palette")) === 0);

  // 코드 뷰어가 보이는 경로 위 함수의 코드에서, 그 함수가 부르는 경로 밖 함수의 이름을 Mod+클릭한다.
  await page.waitForFunction(() => document.querySelector(".info-panel .monaco-editor .view-lines") !== null, null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(500);
  const callees = graph.edges
    .filter((e) => e.source === path[0] && e.kind === "call" && !path.includes(e.target))
    .map((e) => nodes.get(e.target))
    .filter((n) => n.kind === "function" && !n.test);
  let word = null;
  for (const callee of callees) {
    const rect = await wordRect(page, callee.name);
    const code = await rectOf(page, ".info-panel .code");
    if (rect !== null && rect.y > code.y && rect.y + rect.height < code.y + code.height) {
      word = { rect, name: callee.name };
      break;
    }
  }
  if (word === null) {
    t.skip("코드 뷰어에서 경로 밖 이름 Mod+클릭", "코드 뷰어에 보이는 줄에 경로 밖 함수의 호출이 없다");
  } else {
    await blocked(`코드 뷰어에서 경로 밖 이름 ${word.name} Mod+클릭`, async () => {
      const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/definition", { timeout: 15_000 }).catch(() => null);
      await page.keyboard.down(MOD);
      await page.mouse.click(word.rect.x + word.rect.width / 2, word.rect.y + word.rect.height / 2);
      await page.keyboard.up(MOD);
      await answered;
      await page.mouse.move(5, 5);
    }, 1, path[0]);
  }

  // 도착 노드를 다시 보이게 한 뒤 요약의 경로 밖 정의 표기를 누른다.
  await page.click(`.finder-step[data-node="${TRIP.to.id}"]`);
  await page.waitForSelector(`.summary-text .summary-ref[data-node="${FUNCTION}"]`, { timeout: 10_000 }).catch(() => {});
  await rest(page);
  await blocked("요약의 경로 밖 정의 표기 클릭", () => page.click(`.summary-text .summary-ref[data-node="${FUNCTION}"]`), 1, TRIP.to.id);
  await blocked("Alt+←", () => page.keyboard.press("Alt+ArrowLeft"), 1, TRIP.to.id);
  await blocked("disabled인 테스트 코드 토글과 흐름 단계 슬라이더 누르기", async () => {
    await inFilters(page, async () => {
      await page.locator(".filter-panel").getByLabel("테스트 코드").click({ force: true });
      const slider = await rectOf(page, '.filter-panel input[type="range"]');
      await page.mouse.click(slider.x + 2, slider.y + slider.height / 2);
    });
  }, 0, TRIP.to.id);

  // 창을 접어도 고정은 유지되고, 접은 채 막힌 조작을 하면 창이 펴진다.
  await page.click(".finder-button");
  await page.waitForSelector(".finder", { state: "detached", timeout: 5_000 }).catch(() => {});
  const button = await page.evaluate(() => {
    const element = document.querySelector(".finder-button");
    return { pinned: element.hasAttribute("data-pinned"), background: getComputedStyle(element).backgroundColor, title: element.title };
  });
  const ink = await colorOf(page, "--ink");
  t.check(
    "창을 접어도 강조가 남고 경로 찾기 버튼이 본문 잉크로 채워진다",
    (await count(page, ".finder")) === 0 && same((await state()).lines, pinnedState.lines) && button.pinned && button.background === ink.rgb && button.title.includes("경로 고정 중"),
    `창 ${await count(page, ".finder")}개, 버튼 바탕 ${button.background}, 말풍선 "${button.title}"`,
  );
  await page.screenshot({ path: join(OUT, "s3-finder-pin-folded.png") });
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await page.waitForTimeout(600);
  await rest(page);
  await blocked("창을 접은 채 경로 밖 파일 상자 클릭", () => clickNode(page, outside.file), 1, TRIP.to.id);
  t.check("접은 채 막힌 조작을 하면 창이 펴진다", (await count(page, ".finder")) === 1);

  await page.click(".finder-clear");
  await rest(page);
  const cleared = await state();
  t.check(
    "끄기를 누르면 data-route 선이 없고 고정 전에 고른 함수와 토글, 접은 parser/로 돌아온다",
    !cleared.pinned && cleared.lines.length === 0 && cleared.focus === FUNCTION && same(cleared.settings, free) && cleared.folded.includes("parser") && (await count(page, ".finder-pick")) === 0,
    `선택 ${cleared.focus}, 접힌 폴더 ${cleared.folded.join("·")}`,
  );
  await page.click(`.tree-row.tree-file[data-node="${outside.file}"]`);
  await waitSelected(page, outside.file).catch(() => {});
  const picked = (await selectedOf(page)) === outside.file && (await boxes(page)).find((b) => b.id === outside.file)?.open === true;
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await page.waitForTimeout(600);
  await rest(page);
  await clickNode(page, "parser");
  await page.waitForSelector(`${node("parser")} > .node-package`, { state: "detached", timeout: 30_000 }).catch(() => {});
  await settle(page);
  const unfolded = (await count(page, `${node("parser")} > .node-package`)) === 0;
  await page.keyboard.press("Alt+ArrowLeft");
  await rest(page);
  const stepped = (await count(page, `${node("parser")} > .node-package`)) === 1 || (await selectedOf(page)) !== outside.file;
  await setToggle(page, "테스트 코드", true);
  await rest(page);
  t.check(
    "끈 뒤에는 파일트리의 파일 클릭, 접힌 폴더 상자 클릭, Alt+←, 테스트 코드 토글이 평소대로 동작한다",
    picked && unfolded && stepped && (await toggled(page, "테스트 코드")),
    `파일 선택 ${picked}, 폴더 펼침 ${unfolded}, 뒤로 ${stepped}`,
  );
}

async function finderChange(t, page) {
  const graph = await api("/api/graph");
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const path = routeOf(graph, TRIP.from.id, TRIP.to.id).paths[0];
  const files = [...new Set(path.map((id) => graph.nodes.find((n) => n.kind === "module" && n.path === nodes.get(id).path)))];
  await page.route(
    (at) => at.pathname === "/api/changes",
    (routed) =>
      routed.fulfill({
        json: {
          git: true,
          branch: "main",
          files: files.map((file) => ({ path: file.path, status: "modified", stale: false, test: false })),
          nodes: Object.fromEntries(files.map((file) => [file.id, "modified"])),
        },
      }),
  );
  await load(page);
  await pin(page);
  await page.waitForSelector(`${face(files[0].id)} .change-mark`, { timeout: 20_000 }).catch(() => {});
  await rest(page);
  const heads = await page.evaluate(
    (selectors) =>
      selectors.map((selector) => {
        const head = document.querySelector(`${selector} .node-module-head`);
        const label = head?.querySelector(".node-label");
        const aside = head?.querySelector(".node-aside");
        const box = head?.closest(".react-flow__node").getBoundingClientRect();
        return {
          text: label?.textContent ?? null,
          mark: head?.querySelector(".change-mark")?.textContent ?? null,
          cut: label == null || label.scrollWidth > label.clientWidth,
          over: aside == null || box === undefined || aside.getBoundingClientRect().right > box.right - 1,
        };
      }),
    files.map((file) => face(file.id)),
  );
  t.check(
    `변경 표시가 붙은 경로 위 파일 상자 ${files.length}개의 머리 줄에서 이름표가 잘리지 않고 함수 수 글자가 상자 안에 있다`,
    heads.length > 0 && heads.every((head) => head.mark === "M" && !head.cut && !head.over),
    heads.map((head) => `${head.text} ${head.mark}${head.cut ? " 잘림" : ""}${head.over ? " 넘침" : ""}`).join(", "),
  );
}

async function finderEnds(t, page) {
  const graph = await api("/api/graph");
  const route = routeOf(graph, "arbiter", "date_engine");
  await load(page);
  await pick(page, FILE);
  t.check("창을 펴기 전에는 정보 패널 머리 줄에 출발로·도착으로 버튼이 없다", (await count(page, ".info-panel-end")) === 0);
  await openFinder(page);
  await page.waitForSelector('.info-panel-end[data-end="from"]', { timeout: 5_000 }).catch(() => {});
  await page.click('.info-panel-end[data-end="from"]');
  await page.click('.tree-row.tree-file[data-node="date_engine"]');
  await waitSelected(page, "date_engine");
  await t.shot();
  await page.click('.info-panel-end[data-end="to"]');
  await page.waitForSelector(".graph[data-pinned]", { timeout: 10_000 }).catch(() => {});
  await rest(page);
  const values = await page.evaluate(() => [...document.querySelectorAll(".finder-field .finder-value")].map((value) => value.innerText.replaceAll("\n", " ")));
  t.check(
    "arbiter.py를 고르고 출발로, date_engine.py를 고르고 도착으로를 누르면 두 칸이 채워지고 경로 고정에 들어간다",
    (await pinnedOf(page)) && values.length === 2 && values[0].includes("arbiter.py") && values[1].includes("date_engine.py") && (await count(page, ".finder-pick")) === route.paths.length,
    `${values.join(" / ")}, 숫자 버튼 ${await count(page, ".finder-pick")}개`,
  );
  t.check(
    "파일을 끝점으로 주면 그 파일의 어느 함수에서든 출발한 경로를 짧은 것부터 적는다",
    same((await stepsShown(page)).map((row) => row.id), route.paths[0]) && same((await picksOf(page)).map((p) => p.steps), route.paths.map((p) => `${p.length - 1}단계`)),
    (await stepsShown(page)).map((row) => row.id).join(" → "),
  );
  await pickPath(page, 1, route.paths[1].length - 1);
  const lines = (await routeLinesOf(page)).map((line) => line.key.split("|").slice(0, 2).join("|")).sort();
  const want = route.paths[1].slice(1).map((id, i) => `${route.paths[1][i]}|${id}`).sort();
  t.check(
    "2번 버튼을 누르면 고정이 유지된 채 강조가 2번 경로로 바뀐다",
    (await pinnedOf(page)) && (await picksOf(page))[1].pressed && same(lines, want) && same((await stepsShown(page)).map((row) => row.id), route.paths[1]),
    lines.join(", "),
  );
  await page.click(".finder-swap");
  await page.waitForSelector(".finder-empty", { timeout: 10_000 }).catch(() => {});
  await rest(page);
  const swapped = routeOf(graph, "date_engine", "arbiter");
  t.check(
    "맞바꾸면 경로가 없어 고정이 풀리고 경로 없음 문구가 보인다",
    swapped.paths.length === 0 && !(await pinnedOf(page)) && (await count(page, ".edge[data-route]")) === 0 && (await page.evaluate(() => document.querySelector(".finder-empty-title")?.textContent)) === "실행 선으로 이어지는 경로가 없다",
    await page.evaluate(() => document.querySelector(".finder-empty")?.innerText.replaceAll("\n", " / ") ?? ""),
  );
  await page.click(".finder-button");
  t.check("창을 접으면 출발로·도착으로 버튼이 없어진다", (await count(page, ".info-panel-end")) === 0);
}

// ── 3단계 시나리오: 분석 덮개 ─────────────────────────────────────

/** 필터 창의 덮개 행마다 종류, 글자, 고른 상태 */
const overlayOptions = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".filter-panel .overlay-option")].map((option) => ({
      kind: option.dataset.kind,
      text: option.innerText.replaceAll("\n", " "),
      checked: option.getAttribute("aria-checked") === "true",
      inside: option.getBoundingClientRect().right <= window.innerWidth && option.getBoundingClientRect().left >= 0,
    })),
  );

/** 테스트 코드를 뺀 미사용 후보 */
function candidatesOf(graph, unused) {
  const hidden = hiddenOf(graph);
  return unused.candidates.filter((id) => !hidden.has(id));
}

async function overlayMenu(t, page) {
  const [graph, unused] = [await api("/api/graph"), await api("/api/unused")];
  const groups = cyclesOf(graph, hiddenOf(graph)).groups.length;
  const candidates = candidatesOf(graph, unused);
  for (const width of [1700, 1280, 980, 720]) {
    await page.setViewportSize({ width, height: 900 });
    await load(page);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
    await settle(page);
    if (width === 1700) {
      t.check(
        groups === 0 ? "순환 묶음이 없는 레포는 덮개 없이 열린다" : "순환 묶음이 있는 레포는 순환 덮개를 켠 채로 열린다",
        (await page.evaluate(() => document.querySelector(".graph").dataset.overlay ?? "none")) === (groups === 0 ? "none" : "cycles"),
        `필터 버튼의 수 ${await page.evaluate(() => document.querySelector(".filter-count")?.textContent ?? "없음")}`,
      );
    }
    const before = await flowBoxes(page);
    await page.click(".filter-button");
    await page.waitForSelector(".filter-panel .overlay-option", { timeout: 5_000 }).catch(() => {});
    const options = await overlayOptions(page);
    t.check(
      `창 폭 ${width}px: 필터 창의 덮개 행이 없음, 순환 의존 묶음 ${groups}, 미사용 후보 ${candidates.length}개를 적고 창 안에 있다`,
      same(options.map((o) => o.text), ["없음", `순환 의존 묶음 ${groups}`, `미사용 후보 ${candidates.length}개`]) && options.every((o) => o.inside),
      options.map((o) => o.text).join(" / "),
    );
    await page.screenshot({ path: join(OUT, `s3-overlay-menu-${width}.png`) });
    await page.click('.overlay-option[data-kind="unused"]');
    await rest(page);
    const picked = (await overlayOptions(page)).find((o) => o.checked)?.kind;
    await page.click(".filter-button");
    const after = await flowBoxes(page);
    t.check(
      `창 폭 ${width}px: 미사용 후보를 고르면 덮개가 켜지고 그 행이 고른 행이 되며 상자의 위치와 크기가 그대로다`,
      (await page.evaluate(() => document.querySelector(".graph").dataset.overlay)) === "unused" &&
        picked === "unused" &&
        (await count(page, ".filter-panel")) === 0 &&
        Object.keys(before).every((id) => after[id] !== undefined && sameRect(after[id], before[id])),
      `덮개 ${await page.evaluate(() => document.querySelector(".graph").dataset.overlay)}`,
    );
  }
}

/** 미사용 덮개가 표시한 노드마다 id, 테두리가 점선인지, 불투명도 */
const unusedShown = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node > .node-body[data-unused]")].map((body) => {
      const shape = body.querySelector(".node-circle, .node-hexagon polygon, .call-shape") ?? body;
      const style = getComputedStyle(shape);
      return {
        id: body.closest(".react-flow__node").dataset.id,
        dashed: style.borderStyle === "dashed" || (style.strokeDasharray !== "none" && style.strokeDasharray !== ""),
        opacity: Number(getComputedStyle(body.closest(".react-flow__node")).opacity),
      };
    }),
  );

const belowOf = (page, id) => page.evaluate((sel) => document.querySelector(`${sel} .node-below`)?.textContent ?? "", face(id));

async function unusedScenario(t, page) {
  const [graph, unused] = [await api("/api/graph"), await api("/api/unused")];
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const candidates = candidatesOf(graph, unused);
  const file = "date_engine";
  const inFile = candidates.filter((id) => nodes.get(id).path === nodes.get(file).path);
  if (inFile.length === 0) {
    t.skip("date_engine.py의 미사용 후보 표시", "서버 응답에 date_engine.py의 미사용 후보가 없다");
    return;
  }
  await load(page);
  const plain = await belowOf(page, file);
  await setOverlay(page, "unused");
  const caption = await belowOf(page, file);
  t.check(
    `미사용 덮개를 켜면 접힌 date_engine.py 아래 글자가 "미사용 후보 ${inFile.length}"을 담고, 후보가 없는 arbiter.py 아래 글자는 그대로다`,
    plain === "" && caption === `미사용 후보 ${inFile.length}` && (await belowOf(page, FILE)) === "",
    `${plain} → ${caption}, arbiter.py "${await belowOf(page, FILE)}"`,
  );
  const tip = await tipOver(page, `${face(file)} .node-below`);
  t.check("아래 글자에 올리면 미사용 후보 수와 뜻을 말풍선에 적는다", tip.startsWith(`미사용 후보 ${inFile.length}개 · 이 파일 안의 정의에서 합친 수`) && tip.includes("동적 호출이면 실제로는 쓰일 수 있다"), tip.replaceAll("\n", " / "));
  await page.mouse.move(5, 5);
  const overview = await page.evaluate(() => ({
    count: document.querySelector(".overview .overview-count")?.textContent ?? "",
    rows: [...document.querySelectorAll(".overview .overview-row")].map((row) => row.dataset.node),
  }));
  t.check(
    `아무것도 고르지 않은 정보 패널이 미사용 후보 ${candidates.length}개를 /api/unused의 순서대로 적는다`,
    overview.count === `미사용 후보 ${candidates.length}개 · 정의 ${unused.definitions}개 가운데` && same(overview.rows, candidates),
    `${overview.count}, 행 ${overview.rows.length}개`,
  );
  const legend = async () => {
    await page.click(".legend-button");
    const text = await page.evaluate(() => document.querySelector(".legend-overlay")?.textContent ?? "");
    await page.click(".legend-button");
    return text;
  };
  t.check("범례 끝에 미사용 후보 줄이 붙는다", (await legend()).includes("미사용 후보"), await legend());
  await page.screenshot({ path: join(OUT, "s3-unused-overview.png") });

  await pick(page, file);
  await page.mouse.move(5, 5);
  await rest(page);
  const shown = await unusedShown(page);
  t.check(
    `date_engine.py를 고르면 data-unused 노드가 그 파일의 후보 ${inFile.length}개이고 테두리가 점선, 불투명도가 ${UNUSED_OPACITY} 이하다`,
    same(shown.map((n) => n.id).sort(), [...inFile].sort()) && shown.every((n) => n.dashed && n.opacity <= UNUSED_OPACITY + 0.001),
    shown.map((n) => `${n.id} ${n.dashed ? "점선" : "실선"} ${n.opacity}`).join(", "),
  );
  const edges = await edgesOf(page);
  const [ink, muted] = [await colorOf(page, "--ink"), await colorOf(page, "--muted")];
  const borders = await page.evaluate(() => [...new Set([...document.querySelectorAll(".react-flow__node > .node-body[data-unused] .node-circle")].map((circle) => getComputedStyle(circle).borderTopColor))]);
  t.check(
    "선과 후보 테두리의 색이 --ink와 --muted 두 값뿐이다",
    [...new Set(edges.map((e) => e.stroke))].every((stroke) => [ink.rgb, muted.rgb].includes(stroke)) && borders.every((color) => [ink.rgb, muted.rgb].includes(color)),
    `선 ${[...new Set(edges.map((e) => e.stroke))].join(", ")}, 테두리 ${borders.join(", ")}`,
  );
  const hovered = await tipOver(page, `${face(inFile[0])} .node-label`);
  t.check("후보 노드에 올리면 말풍선 둘째 줄에 미사용 후보의 뜻을 적는다", hovered.split("\n").length === 2 && hovered.split("\n")[1].startsWith("미사용 후보"), hovered.replaceAll("\n", " / "));
  await t.shot();
  await page.mouse.move(5, 5);

  await page.keyboard.press("Escape");
  await page.waitForSelector(".overview .overview-row", { timeout: 10_000 }).catch(() => {});
  await rest(page);
  const last = candidates.at(-1);
  await page.click(`.overview-row[data-node="${last}"]`);
  await waitSelected(page, last).catch(() => {});
  t.check("선택을 풀면 목록이 다시 보이고 행을 누르면 그 노드가 선택된다", (await selectedOf(page)) === last, `선택 ${await selectedOf(page)}`);

  // 함수 시점 뷰도 같은 노드 컴포넌트로 후보를 점선으로 그린다.
  await clickNode(page, last, 2);
  await page.waitForSelector(".node-call", { timeout: 30_000 }).catch(() => {});
  await rest(page);
  const calls = await unusedShown(page);
  t.check("함수 시점 뷰에서도 후보의 테두리가 점선이다", calls.some((n) => n.id === last && n.dashed), calls.map((n) => `${n.id} ${n.dashed ? "점선" : "실선"}`).join(", "));
  await page.keyboard.press("Alt+ArrowLeft");
  await rest(page);

  await setOverlay(page, "none");
  t.check("덮개를 끄면 data-unused 노드와 아래 글자의 후보 수가 없다", (await count(page, "[data-unused]")) === 0 && !(await page.evaluate(() => [...document.querySelectorAll(".node-below")].some((below) => below.textContent.includes("미사용")))));
}

/** 경로 고정과 미사용 덮개가 함께 켜졌을 때 경로가 먼저 읽히는지 본다. */
async function finderOverlay(t, page) {
  const [graph, unused] = [await api("/api/graph"), await api("/api/unused")];
  const ends = { from: { id: "date_engine:tomorrow", text: "tomorrow" }, to: { id: "date_engine:today", text: "today" } };
  const candidates = candidatesOf(graph, unused);
  const route = routeOf(graph, ends.from.id, ends.to.id);
  if (!candidates.includes(ends.from.id) || route.paths.length === 0) {
    t.skip("미사용 후보에서 출발하는 경로", "tomorrow()가 미사용 후보가 아니거나 today()로 가는 경로가 없다");
    return;
  }
  const other = candidates.find((id) => !id.startsWith("date_engine:"));
  await load(page);
  await setOverlay(page, "unused");
  await pin(page, ends.from, ends.to);
  await watchFlashes(page);
  const shown = await unusedShown(page);
  const start = shown.find((n) => n.id === ends.from.id);
  const lines = await routeLinesOf(page);
  const ink = await colorOf(page, "--ink");
  t.check(
    "미사용 덮개를 켠 채 후보에서 출발하는 경로를 고정하면 출발 노드가 점선 테두리에 불투명도 1이고 걸음은 본문 잉크 3px다",
    start !== undefined && start.dashed && start.opacity === 1 && lines.length === route.paths[0].length - 1 && lines.every((line) => near(line.width, LINE.step, 0.01) && line.stroke === ink.rgb),
    `출발 ${start?.dashed ? "점선" : "실선"} ${start?.opacity}, 걸음 ${lines.length}개`,
  );
  t.check(
    "경로 밖의 후보는 경로 밖 노드의 불투명도이고, 경로 밖 파일의 아래 글자는 후보 수를 그대로 적는다",
    shown.filter((n) => !route.paths[0].includes(n.id)).every((n) => n.opacity === DIM) && (other === undefined || (await belowOf(page, other.split(":")[0])).includes("미사용 후보")),
    shown.map((n) => `${n.id} ${n.opacity}`).join(", "),
  );
  await t.shot();
  await setOverlay(page, "none");
  const off = { pinned: await pinnedOf(page), lines: (await routeLinesOf(page)).length, unused: await count(page, "[data-unused]") };
  await setOverlay(page, "unused");
  t.check(
    "고정 중에 덮개를 껐다 켜도 고정과 걸음이 그대로이고 안내 줄이 뒤집히지 않는다",
    off.pinned && off.lines === lines.length && off.unused === 0 && (await pinnedOf(page)) && (await count(page, ".react-flow__node > .node-body[data-unused]")) === shown.length && (await flashesOf(page)) === 0,
    `끈 동안 걸음 ${off.lines}개·표시 ${off.unused}개, 뒤집힘 ${await flashesOf(page)}번`,
  );
  await page.click(".finder-clear");
  await rest(page);
  t.check("끄기를 누르면 덮개만 남는다", !(await pinnedOf(page)) && (await page.evaluate(() => document.querySelector(".graph").dataset.overlay)) === "unused");
}

async function overlayDark(t, page) {
  const [graph, unused] = [await api("/api/graph"), await api("/api/unused")];
  const route = routeOf(graph, TRIP.from.id, TRIP.to.id);
  await load(page);
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const [surface, ink] = [await colorOf(page, "--surface"), await colorOf(page, "--ink")];
  await pin(page);
  const lines = await routeLinesOf(page);
  t.check(
    "어두운 화면에서 경로의 걸음이 어두운 화면의 --ink 3px로 그려진다",
    surface.value === DARK.surface && ink.value === DARK.ink && lines.length === route.paths[0].length - 1 && lines.every((line) => line.stroke === ink.rgb && near(line.width, LINE.step, 0.01)),
    `--ink ${ink.value}, 걸음 ${lines.map((line) => line.stroke).join(", ")}`,
  );
  const pinned = await coveredTexts(page);
  t.check("경로를 강조한 화면에서 덮인 글자가 없다", pinned.seen > 0 && pinned.covered.length === 0, `글자 ${pinned.seen}개, 덮인 글자 ${pinned.covered.slice(0, 3).join(", ") || "없음"}`);
  const end = await page.evaluate(() => {
    const mark = document.querySelector(".route-end");
    return { color: getComputedStyle(mark).color, background: getComputedStyle(mark).backgroundColor };
  });
  t.check("출발·도착 표지가 본문 잉크 바탕에 바탕색 글자다", end.background === ink.rgb && end.color === surface.rgb, `바탕 ${end.background}, 글자 ${end.color}`);
  await t.shot();
  await page.click(".finder-clear");
  await page.click(".finder-button");
  await rest(page);

  const candidates = candidatesOf(graph, unused).filter((id) => id.startsWith("date_engine:"));
  if (candidates.length === 0) {
    t.skip("어두운 화면의 미사용 후보", "서버 응답에 date_engine.py의 미사용 후보가 없다");
    return;
  }
  await setOverlay(page, "unused");
  await page.click('.tree-row.tree-file[data-node="date_engine"]');
  await waitSelected(page, "date_engine");
  await rest(page);
  const shown = await unusedShown(page);
  const muted = await colorOf(page, "--muted");
  const strokes = [...new Set((await edgesOf(page)).map((e) => e.stroke))];
  t.check(
    "어두운 화면에서 미사용 후보가 점선 테두리이고 선의 색이 --ink와 --muted뿐이다",
    same(shown.map((n) => n.id).sort(), [...candidates].sort()) && shown.every((n) => n.dashed) && strokes.every((stroke) => [ink.rgb, muted.rgb].includes(stroke)),
    `${shown.length}개, 선 ${strokes.join(", ")}`,
  );
  const covered = await coveredTexts(page);
  t.check("미사용 후보를 표시한 화면에서 덮인 글자가 없다", covered.seen > 0 && covered.covered.length === 0, `글자 ${covered.seen}개, 덮인 글자 ${covered.covered.slice(0, 3).join(", ") || "없음"}`);
  await page.screenshot({ path: join(OUT, "s3-overlay-dark-unused.png") });
}

// ── 3단계 시나리오: 순환이 있는 고정 레포 ─────────────────────────

/** 선마다 키, 순환 선 표시, 선 색, 불투명도, 화살촉 색 */
const cycleLinesOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge .edge[data-key]:not(.edge-trunk)")].map((edge) => ({
      key: edge.dataset.key,
      cycle: edge.hasAttribute("data-cycle"),
      stroke: getComputedStyle(edge.querySelector(".edge-line")).stroke,
      opacity: Number(getComputedStyle(edge).opacity),
    })),
  );

const cycleMarksOf = (page) =>
  page.evaluate(() => [...document.querySelectorAll(".react-flow__node .cycle-mark")].map((mark) => mark.closest(".react-flow__node").dataset.id.replace(/#face$/, "")).sort());

async function cyclesScenario(t, page) {
  const graph = await api("/api/graph", cycleUrl);
  const found = cyclesOf(graph, hiddenOf(graph));
  const members = [...found.member.keys()].sort();
  await load(page, cycleUrl);
  const critical = await colorOf(page, "--critical");
  t.check(
    `순환 묶음 ${found.groups.length}개가 있는 레포는 순환 덮개를 켠 채로 열린다`,
    found.groups.length === 2 && (await page.evaluate(() => document.querySelector(".graph").dataset.overlay)) === "cycles" && (await page.evaluate(() => document.querySelector(".filter-count")?.textContent)) === "1",
    `필터 버튼의 수 ${await page.evaluate(() => document.querySelector(".filter-count")?.textContent ?? "없음")}`,
  );
  t.check("순환 아이콘은 묶음에 든 파일 상자에만 있다", same(await cycleMarksOf(page), members), (await cycleMarksOf(page)).join(", "));
  const lines = await cycleLinesOf(page);
  const marked = lines.filter((line) => line.cycle);
  const pairs = marked.map((line) => (line.key.startsWith("agg|") ? line.key.split("|").slice(1, 3) : line.key.split("|").slice(0, 2)).join("|")).sort();
  t.check(
    `순환 선 ${found.lines.size}개만 --critical 색이고 불투명도가 1이다`,
    same(pairs, [...found.lines].sort()) && marked.every((line) => line.stroke === critical.rgb && line.opacity === 1) && lines.filter((line) => !line.cycle).every((line) => line.stroke !== critical.rgb),
    `순환 선 ${pairs.join(", ")}`,
  );
  const lazy = lines.filter((line) => line.key.includes("b.lazy") && line.key.includes("c.far"));
  t.check("함수 안 import로만 돌아오는 b/lazy.py와 c/far.py 사이의 선은 순환 선이 아니다", lazy.length > 0 && lazy.every((line) => !line.cycle) && !members.includes("b.lazy"), lazy.map((line) => line.key).join(", "));
  const placed = await flowBoxes(page);
  const inside = (inner, outer) => placed[inner] !== undefined && placed[outer] !== undefined && within(placed[inner], placed[outer]);
  t.check(
    "폴더 두 개에 걸친 묶음의 파일이 제 폴더 영역 안에 있다",
    inside("a.bridge", "a") && inside("b.gate", "b") && !inside("a.bridge", "b") && !inside("b.gate", "a"),
    `a/bridge.py ${rectText(placed["a.bridge"])}, b/gate.py ${rectText(placed["b.gate"])}`,
  );
  const overview = await page.evaluate(() => ({
    count: document.querySelector(".overview .overview-count")?.textContent ?? "",
    rows: [...document.querySelectorAll(".overview .overview-row")].map((row) => row.dataset.node),
  }));
  t.check(
    "정보 패널이 묶음 두 개와 그 안의 파일을 적는다",
    overview.count === `순환 묶음 ${found.groups.length}개` && same(overview.rows, found.groups.flat()),
    `${overview.count}: ${overview.rows.join(", ")}`,
  );
  const tip = await tipOver(page, `${face("a.one")} .cycle-mark`);
  t.check("순환 아이콘에 올리면 묶음의 파일 수와 이름을 적는다", tip.startsWith("순환 묶음: 파일 3개가 서로를 import해 돌아온다") && tip.includes("one.py"), tip.replaceAll("\n", " / "));
  await page.mouse.move(5, 5);
  await page.click(".legend-button");
  const legend = await page.evaluate(() => document.querySelector(".legend-overlay")?.textContent ?? "");
  await page.click(".legend-button");
  t.check("범례 끝에 순환 의존 줄이 붙는다", legend.includes("순환"), legend);
  await t.shot();

  // 덮개를 껐다 켜도 상자가 움직이지 않고, 끈 동안에는 critical 색이 없고 아이콘은 남는다.
  await setOverlay(page, "none");
  const off = await cycleLinesOf(page);
  const offBoxes = await flowBoxes(page);
  t.check(
    "덮개를 끄면 critical 색 선이 없고 순환 아이콘은 남으며 모든 상자의 위치가 같다",
    off.every((line) => !line.cycle && line.stroke !== critical.rgb) && same(await cycleMarksOf(page), members) && Object.keys(placed).every((id) => offBoxes[id] !== undefined && sameRect(offBoxes[id], placed[id])),
    `선 ${off.length}개, 아이콘 ${(await cycleMarksOf(page)).length}개`,
  );
  await page.screenshot({ path: join(OUT, "s3-cycles-off.png") });
  await setOverlay(page, "cycles");
  const onBoxes = await flowBoxes(page);
  t.check("다시 켜도 모든 상자의 위치가 같다", Object.keys(placed).every((id) => onBoxes[id] !== undefined && sameRect(onBoxes[id], placed[id])));

  // a/를 접으면 폴더 상자가 아이콘을 받고 그 폴더로 가는 집계 선은 순환 선이 아니다.
  await page.click('.tree-row.tree-dir[data-node="a"]');
  await page.waitForSelector(`${node("a")} > .node-package`, { timeout: 30_000 });
  await rest(page);
  const folded = await cycleLinesOf(page);
  const touching = folded.filter((line) => line.key.split("|").includes("a"));
  t.check(
    "a/를 접으면 접힌 폴더 상자와 b/gate.py에 순환 아이콘이 있고, 그 폴더로 가는 집계 선은 critical이 아니다",
    same(await cycleMarksOf(page), ["a", "b.gate"]) && touching.length > 0 && folded.every((line) => !line.cycle && line.stroke !== critical.rgb),
    `아이콘 ${(await cycleMarksOf(page)).join(", ")}, a/에 닿는 선 ${touching.length}개`,
  );
  const folderTip = await tipOver(page, `${face("a")} .cycle-mark`);
  t.check("접힌 폴더의 순환 아이콘은 묶음 두 개를 한 줄씩 적는다", folderTip.startsWith("순환 묶음 2개 · 이 폴더 안의 파일이 든 묶음") && folderTip.split("\n").length === 3, folderTip.replaceAll("\n", " / "));
  await page.screenshot({ path: join(OUT, "s3-cycles-folded.png") });
}

async function cyclesChange(t, page) {
  const graph = await api("/api/graph", cycleUrl);
  const changed = graph.nodes.find((n) => n.id === "a.one");
  await page.route(
    (at) => at.pathname === "/api/changes",
    (routed) =>
      routed.fulfill({
        json: { git: true, branch: "main", files: [{ path: changed.path, status: "modified", stale: false, test: false }], nodes: { [changed.id]: "modified" } },
      }),
  );
  await load(page, cycleUrl);
  await page.waitForSelector(`${face("a.one")} .change-mark`, { timeout: 20_000 }).catch(() => {});
  await rest(page);
  const read = () =>
    page.evaluate((sel) => {
      const body = document.querySelector(`${sel.body} > .node-body`);
      const style = getComputedStyle(body);
      return { mark: document.querySelector(`${sel.face} .change-mark`)?.textContent ?? null, bar: style.boxShadow, border: style.borderLeftColor };
    }, { body: node("a.one"), face: face("a.one") });
  const [changedColor, muted, critical] = [await colorOf(page, "--changed"), await colorOf(page, "--muted"), await colorOf(page, "--critical")];
  const on = await read();
  t.check(
    "순환 덮개를 켠 동안 수정한 파일 상자는 색 막대와 테두리 색이 없고 M 글자는 있다",
    on.mark === "M" && on.bar === "none" && on.border === muted.rgb && (await cycleLinesOf(page)).some((line) => line.stroke === critical.rgb),
    `글자 ${on.mark}, 막대 ${on.bar}, 왼쪽 테두리 ${on.border}`,
  );
  await t.shot();
  await setOverlay(page, "none");
  const off = await read();
  t.check(
    "덮개를 끄면 수정 표시의 색 막대와 테두리 색이 돌아온다",
    off.mark === "M" && off.bar !== "none" && off.border !== muted.rgb && off.border !== on.border,
    `글자 ${off.mark}, 막대 ${off.bar}, 왼쪽 테두리 ${off.border} (--changed ${changedColor.value})`,
  );
}

/** 순환 덮개와 경로 고정이 함께 켜졌을 때와, 접힌 폴더 상자 아래의 미사용 후보 수를 본다. */
async function cyclesPin(t, page) {
  const [graph, unused] = [await api("/api/graph", cycleUrl), await api("/api/unused", cycleUrl)];
  const ends = { from: { id: "main:run", text: "run" }, to: { id: "a.three:third", text: "third" } };
  const route = routeOf(graph, ends.from.id, ends.to.id);
  await load(page, cycleUrl);
  const [critical, ink] = [await colorOf(page, "--critical"), await colorOf(page, "--ink")];
  await pin(page, ends.from, ends.to);
  await watchFlashes(page);
  const steps = await routeLinesOf(page);
  const lines = await cycleLinesOf(page);
  const marked = lines.filter((line) => line.cycle);
  t.check(
    `순환 덮개를 켠 채 경로를 고정하면 걸음 ${route.paths[0].length - 1}개가 본문 잉크 3px, 불투명도 1이다`,
    steps.length === route.paths[0].length - 1 && steps.every((line) => line.stroke === ink.rgb && near(line.width, LINE.step, 0.01) && line.opacity === 1),
    steps.map((line) => line.key).join(", "),
  );
  t.check(
    `고정 중의 순환 선은 critical 색을 남긴 채 경로 밖 선의 불투명도 ${DIM}이고 걸음과 겹치지 않는다`,
    marked.length > 0 && marked.every((line) => line.stroke === critical.rgb && line.opacity === DIM && !steps.some((step) => step.key === line.key)),
    marked.map((line) => `${line.key} ${line.opacity}`).join(", "),
  );
  await t.shot();
  await setOverlay(page, "none");
  const off = await cycleLinesOf(page);
  t.check(
    "고정 중에 덮개를 끄면 critical 색이 없고 걸음과 고정은 그대로이며 안내 줄이 뒤집히지 않는다",
    off.every((line) => line.stroke !== critical.rgb) && (await routeLinesOf(page)).length === steps.length && (await pinnedOf(page)) && (await flashesOf(page)) === 0,
    `걸음 ${(await routeLinesOf(page)).length}개, 뒤집힘 ${await flashesOf(page)}번`,
  );
  await page.click(".finder-clear");
  await page.click(".finder-button");
  await rest(page);

  // 미사용 후보가 든 파일을 품은 폴더를 접으면 폴더 상자 아래에 후보 수를 적는다.
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const inFolder = candidatesOf(graph, unused).filter((id) => nodes.get(id).path.startsWith("a/"));
  if (inFolder.length === 0) {
    t.skip("접힌 폴더 상자 아래의 미사용 후보 수", "서버 응답에 a/ 안의 미사용 후보가 없다");
    return;
  }
  await setOverlay(page, "unused");
  const fileCaption = await belowOf(page, "a.two");
  await page.click('.tree-row.tree-dir[data-node="a"]');
  await page.waitForSelector(`${node("a")} > .node-package`, { timeout: 30_000 });
  await rest(page);
  const caption = await belowOf(page, "a");
  t.check(
    `미사용 덮개를 켜면 접힌 a/two.py 아래 글자와 접힌 a/ 폴더 상자 아래 글자가 안에 든 후보 수 ${inFolder.length}을 적는다`,
    fileCaption.endsWith(`미사용 후보 ${inFolder.length}`) && caption === `미사용 후보 ${inFolder.length}` && (await belowOf(page, "b")) === "",
    `a/two.py "${fileCaption}", a/ "${caption}"`,
  );
  const tip = await tipOver(page, `${face("a")} .node-below`);
  t.check("폴더 상자 아래 글자에 올리면 폴더 안에서 합친 수임을 적는다", tip.startsWith(`미사용 후보 ${inFolder.length}개 · 이 폴더 안의 정의에서 합친 수`), tip.replaceAll("\n", " / "));
  const covered = await coveredTexts(page);
  t.check("아래 글자가 다른 상자나 선에 덮이지 않는다", covered.covered.length === 0, covered.covered.slice(0, 3).join(", ") || `글자 ${covered.seen}개`);
  await page.screenshot({ path: join(OUT, "s3-cycles-pin-folder-unused.png") });
  await page.mouse.move(5, 5);
  await setOverlay(page, "none");
  t.check("덮개를 끄면 폴더 상자 아래 글자가 없다", (await belowOf(page, "a")) === "");
}

/** 화면에 그린 파일 상자와 폴더 상자(접힌 상자와 펼친 영역)의 노드 id를 정렬한 목록 */
const boxIds = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node")]
      .filter((wrapper) => wrapper.querySelector(":scope > .node-body:is(.node-module, .node-package, .node-region)") !== null)
      .map((wrapper) => wrapper.dataset.id)
      .sort(),
  );

/**
 * 레포를 연 화면. 모든 폴더를 접어 열고, 그 층에 보이는 상자가 폴더 하나뿐인 폴더만 펼친다. 그 폴더가 있는 화면은
 * --reload-url의 고정 레포(`src/app/` 하나와 숨은 `tests/`)에서 본다.
 */
async function start(t, page) {
  const expected = async (base) => {
    const graph = await api("/api/graph", base);
    const boxes = graph.nodes.filter((n) => (n.kind === "module" || n.kind === "package") && !n.test);
    const under = (parent) => boxes.filter((n) => n.parent === parent);
    const opened = [];
    let layer = under(null);
    while (layer.length === 1 && layer[0].kind === "package") {
      opened.push(layer[0].id);
      layer = under(layer[0].id);
    }
    return { graph, opened, shown: [...opened, ...layer.map((n) => n.id)].sort() };
  };
  const folded = (id) => count(page, `${node(id)} > .node-package`);

  await load(page, url, false);
  const sync = await expected(url);
  const shown = await boxIds(page);
  const files = sync.graph.nodes.filter((n) => n.kind === "module" && !n.test && n.parent === null).length;
  t.check(
    `레포를 열면 parser/가 접힌 폴더 상자이고 소스 루트 바로 아래의 파일 상자 ${files}개가 보인다`,
    sync.opened.length === 0 && same(shown, sync.shown) && (await folded("parser")) === 1 && (await boxes(page)).length === files,
    shown.join(", "),
  );
  t.check('"뒤로" 버튼을 누를 수 없다', await page.getByRole("button", { name: "뒤로" }).isDisabled());
  const { free } = await stageOf(page);
  const rects = await Promise.all(shown.map((id) => rectOf(page, node(id))));
  const zoom = await zoomOf(page);
  t.check(
    "그래프 전체가 정보 패널이 가리지 않는 영역에 들어오고 확대 비율이 100%를 넘지 않는다",
    zoom <= 1 && rects.every((r) => r.x >= free.x && r.y >= free.y && r.x + r.width <= free.x + free.width && r.y + r.height <= free.y + free.height),
    `확대 비율 ${zoom.toFixed(3)}`,
  );
  await t.shot();

  await clickNode(page, "parser");
  await page.waitForSelector(`${node("parser")} > .node-region`, { timeout: 30_000 });
  await settle(page);
  const inside = sync.graph.nodes.filter((n) => n.parent === "parser" && n.kind === "module" && !n.test).map((n) => n.id);
  const after = await boxIds(page);
  t.check(`parser/를 누르면 안의 파일 상자 ${inside.length}개가 폴더 영역 안에 나타난다`, inside.length > 0 && inside.every((id) => after.includes(id)), after.join(", "));

  if (reloadUrl === null) {
    t.skip("그 층에 보이는 상자가 폴더 하나뿐이면 그 폴더를 펼쳐 연다", "--reload-url을 주지 않았다");
    return;
  }
  await load(page, reloadUrl, false);
  const sample = await expected(reloadUrl);
  const seen = await boxIds(page);
  const nested = sample.graph.nodes.filter((n) => n.kind === "package" && !n.test && !sample.opened.includes(n.id) && seen.includes(n.id)).map((n) => n.id);
  const closed = await Promise.all(nested.map(folded));
  t.check(
    "그 층에 보이는 상자가 폴더 하나뿐이면 그 폴더를 펼쳐 열고 그 아래의 폴더는 접어 둔다",
    sample.opened.length > 0 &&
      same(seen, sample.shown) &&
      (await count(page, `${node(sample.opened[0])} > .node-region`)) === 1 &&
      nested.length > 0 &&
      closed.every((n) => n === 1),
    `펼친 폴더 ${sample.opened.join(", ")}, 접힌 폴더 ${nested.join(", ")}, 상자 ${seen.join(", ")}`,
  );
}

/**
 * 느린 배치. ELK worker로 가는 배치 요청을 늦춰, 배치가 펼치기·접기의 움직임 시간(300ms)을 넘기면 앞의 그래프를 둔 채
 * 표시가 뜨는지, Esc와 뒤로 가기가 그 조작만 되돌리는지 본다.
 */
async function arranging(t, page) {
  /** 늦추는 시간(ms). 표시가 뜨는 300ms와 확인하는 시각을 넉넉히 넘긴다. */
  const DELAY = 2500;
  await page.addInitScript(() => {
    window.__shotsElkDelay = 0;
    window.__shotsWorkers = 0;
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(address, options) {
        super(address, options);
        window.__shotsWorkers += 1;
        const post = this.postMessage.bind(this);
        this.postMessage = (message, ...rest) => {
          if (message?.cmd === "layout" && window.__shotsElkDelay > 0) {
            setTimeout(() => post(message, ...rest), window.__shotsElkDelay);
          } else {
            post(message, ...rest);
          }
        };
      }
    };
    window.__shotsArranging = 0;
    const watcher = new MutationObserver(() => {
      if (document.querySelector(".arranging") !== null) {
        window.__shotsArranging += 1;
      }
    });
    document.addEventListener("DOMContentLoaded", () => watcher.observe(document.body, { childList: true, subtree: true }));
  });
  const slow = (ms) => page.evaluate((value) => void (window.__shotsElkDelay = value), ms);
  const sign = () => page.evaluate(() => document.querySelector(".arranging")?.textContent ?? null);
  const seen = () => page.evaluate(() => window.__shotsArranging);
  const nav = async () => [await page.getByRole("button", { name: "뒤로" }).isDisabled(), await page.getByRole("button", { name: "앞으로" }).isDisabled()];

  await load(page, url, false);
  const first = await boxIds(page);
  await clickNode(page, "parser");
  await page.waitForSelector(`${node("parser")} > .node-region`, { timeout: 30_000 });
  await settle(page);
  const opened = await boxIds(page);
  t.check("움직임 시간 안에 끝나는 배치에는 표시가 뜨지 않는다", opened.length > first.length && (await seen()) === 0, `표시가 뜬 횟수 ${await seen()}`);
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForSelector(`${node("parser")} > .node-package`, { timeout: 30_000 });
  await settle(page);

  const before = await nav();
  await slow(DELAY);
  await clickNode(page, "parser");
  await page.waitForTimeout(150);
  const early = await sign();
  await page.waitForSelector(".arranging", { timeout: 5_000 });
  t.check(
    "배치가 300ms를 넘기면 앞의 그래프를 그대로 둔 채 그래프 위쪽에 표시가 뜬다",
    early === null && (await sign()) === "배치 계산 중 · Esc로 취소" && same(await boxIds(page), first),
    `150ms의 표시 ${early}, 뜬 표시 ${await sign()}`,
  );
  const [sized, area] = [await rectOf(page, ".arranging"), (await stageOf(page)).area];
  t.check(
    "표시는 관계 그래프 영역의 위쪽 가운데에 있다",
    near(sized.x + sized.width / 2, area.x + area.width / 2, 1) && sized.y > area.y && sized.y < area.y + area.height / 4,
    `표시 가운데 ${Math.round(sized.x + sized.width / 2)}, 영역 가운데 ${Math.round(area.x + area.width / 2)}, 위 ${Math.round(sized.y)}`,
  );
  await t.shot();
  const workers = await page.evaluate(() => window.__shotsWorkers);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  t.check(
    "Esc를 누르면 표시가 사라지고 폴더를 펼치기 전의 화면과 이력으로 돌아간다",
    (await sign()) === null && same(await boxIds(page), first) && same(await nav(), before) && (await count(page, '.tree-row.tree-dir[data-node="parser"][aria-expanded="true"]')) === 0,
    `표시 ${await sign()}, 뒤로·앞으로 버튼의 누를 수 없음 ${before} → ${await nav()}`,
  );
  await page.waitForTimeout(DELAY + 500);
  t.check("늦게 끝난 배치는 화면을 바꾸지 않는다", same(await boxIds(page), first) && (await sign()) === null);

  await slow(0);
  await clickNode(page, "parser");
  await page.waitForSelector(`${node("parser")} > .node-region`, { timeout: 30_000 });
  await settle(page);
  t.check(
    "취소한 뒤에 다시 펼치면 새 worker가 배치한다",
    same(await boxIds(page), opened) && (await page.evaluate(() => window.__shotsWorkers)) === workers + 1,
    `worker ${workers}개 → ${await page.evaluate(() => window.__shotsWorkers)}개`,
  );

  await slow(DELAY);
  await clickNode(page, FILE);
  await page.waitForSelector(".arranging", { timeout: 5_000 });
  const picked = (await headOf(page)).split("\n")[0];
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForTimeout(100);
  t.check(
    "노드를 고른 배치가 길어질 때 뒤로 가기를 누르면 그 선택만 취소한다",
    picked.includes(`${FILE}.py`) && (await sign()) === null && (await selectedOf(page)) === null && same(await boxIds(page), opened) && same(await nav(), [false, true]),
    `고른 동안의 정보 패널 ${picked}, 표시 ${await sign()}, 뒤로·앞으로 버튼의 누를 수 없음 ${await nav()}`,
  );

  await inFilters(page, async () => {
    await page.locator(".filter-panel").getByLabel("테스트 코드").click();
    await page.waitForSelector(".arranging", { timeout: 5_000 });
    const text = await sign();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    t.check("탐색 이력을 바꾸지 않는 조작의 배치는 취소하는 키 없이 표시만 하고 Esc로 사라지지 않는다", text === "배치 계산 중" && (await sign()) === "배치 계산 중", `표시 ${text} → ${await sign()}`);
  });
  await page.waitForSelector(".arranging", { state: "detached", timeout: 30_000 });
  await slow(0);
  await settle(page);
}

/**
 * 노드의 hover. 마우스를 올린 노드는 선의 hover처럼 가장 진한 단계(불투명도 1)로 그리고 이름표를 굵게, 모양에 옅은 빛을 준다.
 * 이름표와 상자의 위치·폭은 그대로이고, 옆 노드와 부모·자식 상자의 단계는 바뀌지 않는다.
 */
async function nodeHover(t, page) {
  /** 화면에서 이름표의 가운데가 그 노드로 눌리는 노드마다 종류, 불투명도, 이름표 가운데 점 */
  const candidates = () =>
    page.evaluate(() => {
      const area = document.querySelector(".graph").getBoundingClientRect();
      const covers = [...document.querySelectorAll(".info-panel, .dock-panels > *, .dock-buttons")].map((element) => element.getBoundingClientRect());
      const kinds = ["node-region", "node-module-open", "node-module", "node-package", "node-class", "node-dataclass", "node-function"];
      const list = [];
      for (const face of document.querySelectorAll('.react-flow__node[data-id$="#face"]')) {
        const root = face.firstElementChild;
        const label = face.querySelector(".node-label");
        const kind = kinds.find((name) => root?.classList.contains(name));
        if (kind === undefined || label === null || getComputedStyle(label).visibility !== "visible") {
          continue;
        }
        const rect = label.getBoundingClientRect();
        const [x, y] = [rect.left + rect.width / 2, rect.top + rect.height / 2];
        const inside = x > area.left && x < area.right && y > area.top && y < area.bottom && covers.every((c) => x < c.left || x > c.right || y < c.top || y > c.bottom);
        if (inside && face.contains(document.elementFromPoint(x, y))) {
          list.push({ id: face.dataset.id.replace(/#face$/, ""), kind: kind.replace("node-", ""), opacity: Number(face.style.opacity), route: root.dataset.route ?? null, x, y });
        }
      }
      return list;
    });
  /** 노드의 두 요소가 받은 불투명도와 클래스, 이름표의 외곽선·위치·폭, 모양의 빛, 상자의 사각형 */
  const look = (id) =>
    page.evaluate((id) => {
      const body = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      const face = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}#face"]`);
      const label = face.querySelector(".node-label");
      const round = (rect) => [rect.left, rect.top, rect.width, rect.height].map((n) => Math.round(n * 100) / 100).join(",");
      return {
        opacity: [Number(getComputedStyle(body).opacity), Number(getComputedStyle(face).opacity)],
        pointed: [body.classList.contains("pointed"), face.classList.contains("pointed")],
        stroke: parseFloat(getComputedStyle(label).webkitTextStrokeWidth),
        glow: getComputedStyle(body.firstElementChild).filter !== "none",
        shadow: getComputedStyle(label).textShadow !== "none",
        layers: `${body.style.zIndex},${face.style.zIndex}`,
        place: [round(label.getBoundingClientRect()), round(body.getBoundingClientRect()), round((face.querySelector(".loc") ?? label).getBoundingClientRect())].join(" / "),
      };
    }, id);
  const over = async (at) => {
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(500);
  };
  const away = async () => {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(500);
  };

  await load(page);
  await pick(page, FILE);
  await pick(page, FUNCTION);
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await away();
  await settle(page);
  const list = await candidates();
  const leaf = (item) => item.kind !== "region" && item.kind !== "module-open";
  const levels = [
    ["활성 노드", list.find((item) => leaf(item) && item.opacity === 1 && item.id !== FUNCTION)],
    ["불투명도 50%인 흐름 노드", list.find((item) => leaf(item) && item.opacity === 0.5)],
    ["흐린 노드", list.find((item) => leaf(item) && item.opacity === DIM)],
  ];
  for (const [name, at] of levels) {
    if (at === undefined) {
      t.skip(`${name}에 마우스를 올리면 가장 진한 단계로 그린다`, "이 화면에 그 단계의 노드가 없다");
      continue;
    }
    const other = list.find((item) => item.id !== at.id && item.opacity === at.opacity && leaf(item)) ?? list.find((item) => item.id !== at.id);
    const [before, aside] = [await look(at.id), await look(other.id)];
    await over(at);
    const [on, beside] = [await look(at.id), await look(other.id)];
    if (name === "흐린 노드") {
      await t.shot();
    }
    await away();
    const after = await look(at.id);
    t.check(
      `${name}에 마우스를 올리면 불투명도 1, 굵은 이름표, 옅은 빛으로 그리고 떠나면 돌아온다`,
      same(before.opacity, [at.opacity, at.opacity]) && same(on.opacity, [1, 1]) && before.stroke === 0 && on.stroke > 0 && !before.glow && on.glow && same(after, before),
      `${at.id}: 불투명도 ${before.opacity} → ${on.opacity} → ${after.opacity}, 외곽선 ${before.stroke} → ${on.stroke}px, 빛 ${before.glow} → ${on.glow}`,
    );
    t.check(`${name}: 이름표·상자·줄 수 숫자의 위치와 폭, 층이 그대로다`, on.place === before.place && on.layers === before.layers, `${before.place} → ${on.place}, 층 ${on.layers}`);
    t.check(`${name}: 옆 노드의 단계는 그대로다`, same(beside, aside), `${other.id} 불투명도 ${aside.opacity} → ${beside.opacity}`);
  }

  // 펼친 파일 상자는 머리 줄만, 그 안의 함수는 함수만 진해진다.
  const inner = list.find((item) => item.kind === "function" && item.id !== FUNCTION && list.some((box) => box.kind === "module-open" && item.id.startsWith(`${box.id}:`)));
  const opened = list.find((box) => box.kind === "module-open" && inner?.id.startsWith(`${box.id}:`));
  if (opened === undefined) {
    t.skip("펼친 파일 상자의 머리 줄에 올리면 머리 줄의 이름표만 굵어진다", "머리 줄과 안의 함수가 함께 보이는 펼친 파일 상자가 화면에 없다");
  } else {
    await over(opened);
    const [box, child] = [await look(opened.id), await look(inner.id)];
    t.check(
      "펼친 파일 상자의 머리 줄에 올리면 머리 줄의 이름표만 굵어지고 상자의 바탕과 안의 함수는 그대로다",
      same(box.pointed, [false, true]) && box.stroke > 0 && box.shadow && !box.glow && same(child.pointed, [false, false]),
      `${opened.id} ${box.pointed}, 안의 함수 ${inner.id} ${child.pointed}`,
    );
    await over(inner);
    const [boxed, aimed] = [await look(opened.id), await look(inner.id)];
    t.check("그 안의 함수에 올리면 함수만 진해지고 파일 상자는 그대로다", same(aimed.pointed, [true, true]) && same(boxed.pointed, [false, false]), `함수 ${aimed.pointed}, 파일 상자 ${boxed.pointed}`);
  }
  await away();
  t.check("마우스가 떠나면 진해진 노드가 없다", (await count(page, ".react-flow__node.pointed")) === 0);

  // 경로 고정 중에는 경로 위 노드만 진해진다.
  await page.keyboard.press("Escape");
  await pin(page);
  await away();
  const pinned = await candidates();
  const [off, onPath] = [pinned.find((item) => item.route === null && leaf(item)), pinned.find((item) => item.route !== null && leaf(item))];
  await over(off);
  const blocked = await look(off.id);
  await over(onPath);
  const lit = await look(onPath.id);
  await away();
  t.check(
    "경로 고정 중에 경로 밖 노드에 올리면 바뀌지 않고 경로 위 노드에 올리면 진해진다",
    same(blocked.pointed, [false, false]) && blocked.opacity[0] === off.opacity && same(lit.pointed, [true, true]),
    `경로 밖 ${off.id} ${blocked.pointed} 불투명도 ${blocked.opacity}, 경로 위 ${onPath.id} ${lit.pointed}`,
  );
}

// ── 4단계: 선의 합류 ─────────────────────────────────────────────

/** 줄기마다 키, 도착 노드, 가지의 수(count), 적힌 합계(sum), 가지의 sites 수 합(sites), 가지의 키, 합류점 수, 진하기, 도착 노드에 닿는 끝점(그래프 좌표), 누름 영역의 커서 */
const trunksOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge .edge-trunk")].map((trunk) => {
      const line = trunk.querySelector(".edge-line");
      const end = line.getPointAtLength(line.getTotalLength());
      return {
        key: trunk.dataset.key,
        target: trunk.dataset.target,
        count: document.querySelectorAll(`.edge[data-branch="${CSS.escape(trunk.dataset.key)}"]`).length,
        sum: Number(trunk.querySelector(".edge-trunk-count").textContent),
        sites: [...document.querySelectorAll(`.edge[data-branch="${CSS.escape(trunk.dataset.key)}"]`)].reduce((total, edge) => total + Number(edge.dataset.sites), 0),
        branches: [...document.querySelectorAll(`.edge[data-branch="${CSS.escape(trunk.dataset.key)}"]`)].map((edge) => edge.dataset.key),
        joints: trunk.querySelectorAll(".edge-joint").length,
        arrows: trunk.querySelectorAll(".edge-line[marker-end]").length,
        tone: trunk.classList.contains("tone-strong") ? "strong" : "muted",
        opacity: Number(getComputedStyle(trunk).opacity),
        width: parseFloat(getComputedStyle(line).strokeWidth),
        pointed: trunk.hasAttribute("data-pointed"),
        step: trunk.hasAttribute("data-step"),
        layer: getComputedStyle(trunk.closest("svg")).zIndex,
        end: { x: end.x, y: end.y },
        cursor: getComputedStyle(trunk.querySelector(".edge-hit")).cursor,
      };
    }),
  );

/** 줄기 위에서 맨 위 요소가 그 줄기인 화면 좌표. 도착 노드 쪽에서부터 4px마다 찾는다. 없으면 null이다. */
const trunkPoint = (page, key) =>
  page.evaluate((want) => {
    const trunk = [...document.querySelectorAll(".react-flow__edge .edge-trunk")].find((e) => e.dataset.key === want);
    const line = trunk?.querySelector(".edge-line");
    if (line == null) {
      return null;
    }
    const matrix = line.getScreenCTM();
    const total = line.getTotalLength();
    for (let back = 14; back <= total; back += 4) {
      const at = line.getPointAtLength(total - back);
      const point = new DOMPoint(at.x, at.y).matrixTransform(matrix);
      if (document.elementFromPoint(point.x, point.y)?.closest(".edge") === trunk) {
        return { x: point.x, y: point.y };
      }
    }
    return null;
  }, key);

/** 선 키의 양 끝 노드 */
const endsOfKey = (key) => {
  const parts = key.split("|");
  return parts[0] === "agg" || parts[0] === "step" ? [parts[1], parts[2]] : [parts[0], parts[1]];
};

/**
 * 모든 폴더를 접은 화면에서 그리는 선. 선의 양 끝을 소스 루트 바로 아래의 상자로 올려, 올린 선이 하나라도 있는 쌍은 집계 선 하나,
 * 그 밖의 쌍은 원래 선마다 하나다. 테스트 코드와 외부 노드에 닿는 선은 세지 않는다. deferred는 함수 안 import만 합친 선이다.
 */
function foldedLines(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const top = (id) => {
    let at = nodes.get(id);
    while (at.parent !== null) {
      at = nodes.get(at.parent);
    }
    return at.id;
  };
  const off = (id) => nodes.get(id).test || nodes.get(id).kind === "external";
  const pairs = new Map();
  for (const edge of graph.edges) {
    if (off(edge.source) || off(edge.target)) {
      continue;
    }
    const [source, target] = [top(edge.source), top(edge.target)];
    if (source === target) {
      continue;
    }
    const pair = pairs.get(`${source}|${target}`) ?? { source, target, edges: [], lifted: false };
    pair.edges.push(edge);
    pair.lifted ||= source !== edge.source || target !== edge.target;
    pairs.set(`${source}|${target}`, pair);
  }
  return [...pairs.values()].flatMap(({ source, target, edges, lifted }) =>
    lifted ? [{ source, target, deferred: edges.every((e) => e.deferred) }] : edges.map((e) => ({ source, target, deferred: e.deferred })),
  );
}

/** 처음 화면과 폴더를 펼친 화면에서 줄기와 가지의 구성을 본다. */
async function merge(t, page) {
  const graph = await api("/api/graph");
  const expected = foldedLines(graph);
  const entries = new Set(graph.nodes.filter((n) => n.entry && n.kind === "module").map((n) => n.id));
  await load(page, url, false);
  const [lines, trunks] = [await linesOf(page), await trunksOf(page)];
  t.check("편재 노드 배지가 없다", (await count(page, ".node-inflow")) === 0);
  t.check(
    `모든 폴더를 접은 화면이 /api/graph로 센 선 ${expected.length}개를 모두 그린다`,
    lines.length === expected.length,
    `그린 선 ${lines.length}개`,
  );
  const sound = (list, all) =>
    list.every(
      (trunk) =>
        trunk.sum === trunk.sites &&
        trunk.count >= 2 &&
        trunk.joints >= 1 &&
        trunk.arrows === 1 &&
        trunk.branches.every((key) => endsOfKey(key)[1] === trunk.target) &&
        near(trunk.width, 1.5, 0.01) &&
        all.filter((line) => line.trunk === trunk.key).every((line) => near(line.end.x, trunk.end.x) && near(line.end.y, trunk.end.y)),
    );
  t.check(
    "줄기마다 화살촉이 하나이고 적힌 수가 가지의 관계 수를 더한 합계이며, 가지는 모두 그 줄기의 도착 노드로 들어가고 굵기는 선 하나와 같다",
    trunks.length > 0 && sound(trunks, lines),
    trunks.map((trunk) => `${trunk.target} 가지 ${trunk.count}개 합계 ${trunk.sum}`).join(", "),
  );
  // 진입점 단위 사이의 선은 배치 밖 경로로 옆면에 따로 들어가므로, 진입점이 아닌 상자로 들어오는 선을 견준다.
  const into = new Map();
  for (const line of expected.filter((e) => !e.deferred && !entries.has(e.target))) {
    into.set(line.target, (into.get(line.target) ?? 0) + 1);
  }
  const wanted = [...into].filter(([, n]) => n >= 2);
  const missed = wanted.filter(([target, n]) => trunks.filter((trunk) => trunk.target === target && trunk.count === n).length !== 1);
  t.check(
    `들어오는 선이 둘 이상인 상자 ${wanted.length}개마다 줄기가 하나이고 그 수가 들어오는 선의 수와 같다`,
    wanted.length > 0 && missed.length === 0,
    wanted.map(([target, n]) => `${target} ${n}`).join(", ") + (missed.length > 0 ? ` / 어긋남 ${missed.map(([target]) => target).join(", ")}` : ""),
  );
  const alone = lines.filter((line) => line.trunk === null);
  const arrows = await page.evaluate(() => [...document.querySelectorAll(".edge[data-branch]:not([data-whole]) .edge-line[marker-end]")].length);
  t.check("줄기에 든 선은 가지를 화살촉 없이 그리고 줄기에 들지 않은 선은 화살촉을 단다", arrows === 0 && alone.length + lines.filter((line) => line.trunk !== null).length === lines.length, `줄기에 들지 않은 선 ${alone.length}개`);
  await t.shot();

  await openFolder(page, "parser");
  const [openLines, openTrunks] = [await linesOf(page), await trunksOf(page)];
  t.check(
    "parser/를 펼친 화면에서도 줄기마다 수와 가지가 맞고, 자식을 그리는 폴더 영역으로 들어가는 줄기는 없다",
    openTrunks.length > 0 && sound(openTrunks, openLines) && openTrunks.every((trunk) => trunk.target !== "parser"),
    openTrunks.map((trunk) => `${trunk.target} ${trunk.count}`).join(", "),
  );
}

/** 가지와 줄기에 마우스를 올린다. */
async function mergeHover(t, page) {
  await load(page, url, false);
  const ink = (await colorOf(page, "--ink")).rgb;
  const trunk = (await trunksOf(page)).sort((a, b) => b.count - a.count)[0];
  const found = await hittable(page, (await linesOf(page)).filter((line) => line.trunk === trunk.key));
  await page.mouse.move(found.at.x, found.at.y - 1);
  await page.mouse.move(found.at.x, found.at.y);
  await page.waitForSelector(".edge[data-pointed]", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const lines = await linesOf(page);
  const over = lines.find((line) => line.key === found.line.key);
  const whole = await page.evaluate((key) => document.querySelector(`.edge[data-key="${CSS.escape(key)}"]`)?.hasAttribute("data-whole"), found.line.key);
  const branchTip = await tipText(page);
  t.check(
    "가지에 올리면 그 선 하나가 출발부터 도착 노드까지 본문 잉크로 다른 선 위의 층에 그려지고 줄기와 다른 가지는 그대로다",
    over.pointed && whole && over.stroke === ink && over.layer === "5" && near(over.end.x, trunk.end.x) && near(over.end.y, trunk.end.y) &&
      lines.filter((line) => line.key !== over.key).every((line) => !line.pointed) && (await trunksOf(page)).every((each) => !each.pointed),
    `올린 선 ${over.key}, 전체 경로 ${whole}, 층 ${over.layer}`,
  );
  t.check("가지의 말풍선은 그 선의 출발·도착과 분류, 지점 수다", /^.+ → .+ · .+ · \d+곳$/.test(branchTip) && !branchTip.startsWith("노드 "), branchTip);

  const spot = await trunkPoint(page, trunk.key);
  await page.mouse.move(spot.x, spot.y - 1);
  await page.mouse.move(spot.x, spot.y);
  await page.waitForSelector(".edge-trunk[data-pointed]", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const pointed = (await trunksOf(page)).find((each) => each.key === trunk.key);
  const members = (await linesOf(page)).filter((line) => line.trunk === trunk.key);
  const trunkTipText = await tipText(page);
  t.check(
    `줄기에 올리면 줄기와 가지 ${trunk.count}개가 모두 본문 잉크로 다른 선 위의 층에 그려진다`,
    pointed.pointed && pointed.tone === "strong" && pointed.opacity === 1 && pointed.layer === "5" && members.length === trunk.count && members.every((line) => line.pointed && line.stroke === ink),
    `줄기 ${pointed.tone} ${pointed.opacity}, 본문 잉크 가지 ${members.filter((line) => line.pointed).length}개`,
  );
  const sources = new Set(trunk.branches.map((key) => endsOfKey(key)[0])).size;
  const tipRows = trunkTipText.split("\n");
  t.check(
    "도착 노드 앞 줄기의 말풍선은 첫 줄에 선을 내보내는 노드 수와 도착 노드, 지점 수 합을, 그 아래에 그 구간을 지나는 선을 한 줄씩 적는다",
    new RegExp(`^노드 ${sources}개 → .+ · \\d+곳$`).test(tipRows[0]) && tipRows.length === 1 + trunk.count && tipRows.slice(1).every((row) => / → .+ · \d+곳$/.test(row)),
    trunkTipText.replaceAll("\n", " / "),
  );
  await t.shot();
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => document.querySelector(".edge[data-pointed]") === null, null, { timeout: 5_000 }).catch(() => {});
  t.check("마우스를 떼면 줄기와 가지가 돌아온다", (await count(page, ".edge[data-pointed]")) === 0 && (await count(page, ".edge[data-whole]")) === 0);
}

/** Shift를 누른 채 줄기를 누르고, 그냥 누른다. */
async function mergeClick(t, page) {
  await load(page, url, false);
  const trunk = (await trunksOf(page)).filter((each) => each.target !== "parser").sort((a, b) => b.count - a.count)[0];
  const spot = await trunkPoint(page, trunk.key);
  await page.keyboard.down("Shift");
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.up("Shift");
  await page.waitForSelector(".info-panel-sites", { timeout: 10_000 }).catch(() => {});
  const head = await headOf(page);
  const groups = await page.evaluate(() =>
    [...document.querySelectorAll(".info-panel-sites > li")].map((group) => ({
      name: group.querySelector(".info-panel-sites-name")?.textContent ?? "",
      sites: group.querySelectorAll(".info-panel-site").length,
    })),
  );
  const sources = new Set(trunk.branches.map((key) => endsOfKey(key)[0])).size;
  t.check(
    "Shift를 누른 채 줄기를 누르면 정보 패널이 들어오는 선 전체의 코드 줄 목록을 출발 노드마다 묶어 보이고 노드는 선택되지 않는다",
    head.includes(`노드 ${sources}개 →`) && head.includes("합류") && groups.length === trunk.count && groups.every((group) => group.name !== "" && group.sites > 0) && (await selectedOf(page)) === null,
    `${head.replaceAll("\n", " / ").slice(0, 80)} / 묶음 ${groups.map((group) => group.name.trim()).join(", ")}`,
  );
  const total = groups.reduce((sum, group) => sum + group.sites, 0);
  t.check("머리 줄의 지점 수가 목록의 코드 줄 수와 같다", head.includes(`${total}곳`), `코드 줄 ${total}개`);
  await t.shot();
  await page.click(".info-panel-site");
  await page.waitForSelector(".info-panel .monaco-editor .code-range", { timeout: 30_000 }).catch(() => {});
  t.check("목록의 줄을 누르면 코드 뷰어가 그 줄을 칠해 보인다", (await count(page, ".info-panel .monaco-editor .code-range")) > 0);

  await page.waitForTimeout(600);
  await page.mouse.click(spot.x, spot.y);
  await waitSelected(page, trunk.target).catch(() => {});
  t.check("줄기를 누르면 도착 노드가 선택된다", (await selectedOf(page)) === trunk.target, `선택 ${await selectedOf(page)}`);
}

/** 함수를 골랐을 때 고른 노드에 닿는 선이 줄기 위에서 한 줄로 이어지는지 본다. */
async function mergeSelect(t, page) {
  await load(page);
  await pick(page, FILE);
  await pick(page, FUNCTION);
  await rest(page);
  const ink = (await colorOf(page, "--ink")).rgb;
  const [lines, trunks, at] = [await linesOf(page), await trunksOf(page), await flowBoxes(page)];
  const wholes = new Set(await page.evaluate(() => [...document.querySelectorAll(".edge[data-whole]")].map((edge) => edge.dataset.key)));
  const strong = lines.filter((line) => line.tone === "strong");
  const joined = strong.filter((line) => line.trunk !== null);
  t.check(
    `고른 함수에 닿는 선 ${strong.length}개 가운데 줄기에 든 ${joined.length}개가 줄기 위에 전체 경로를 본문 잉크로 그려 도착 노드까지 이어진다`,
    joined.length > 0 && joined.every((line) => wholes.has(line.key) && line.stroke === ink && line.opacity === 1) &&
      [...wholes].every((key) => strong.some((line) => line.key === key)),
    `전체 경로를 그린 선 ${wholes.size}개`,
  );
  const reach = strong.filter((line) => {
    const box = at[endsOfKey(line.key)[1]];
    return box !== undefined && (near(line.end.x, box.x, 1.5) || near(line.end.x, box.x + box.width, 1.5) || near(line.end.y, box.y + box.height, 1.5));
  });
  t.check("고른 함수에 닿는 선의 끝이 모두 도착 노드의 변에 닿는다", reach.length === strong.length, `${reach.length}/${strong.length}`);
  const dim = trunks.filter((trunk) => !trunk.branches.some((key) => strong.some((line) => line.key === key)));
  t.check(
    `고른 함수에 닿는 선이 없는 줄기 ${dim.length}개는 muted 잉크이고 가지 가운데 가장 진한 값을 쓴다`,
    dim.length > 0 && dim.every((trunk) => trunk.tone === "muted" && trunk.opacity === Math.max(...lines.filter((line) => line.trunk === trunk.key).map((line) => line.opacity))) && dim.some((trunk) => trunk.opacity === DIM),
    [...new Set(dim.map((trunk) => trunk.opacity))].join("·"),
  );
  const mixed = trunks.filter((trunk) => !dim.includes(trunk));
  t.check(
    "고른 함수에 닿는 선이 든 줄기는 따로 그린 그 선을 뺀 가지의 진하기를 쓴다",
    mixed.every((trunk) => {
      const others = lines.filter((line) => line.trunk === trunk.key && line.tone !== "strong");
      return others.length === 0 ? trunk.tone === "strong" : trunk.tone === "muted" && trunk.opacity === Math.max(...others.map((line) => line.opacity));
    }),
    `줄기 ${mixed.length}개`,
  );
}

/** 경로 고정과 순환 덮개가 줄기 위에서 그리는 선을 본다. */
async function mergePin(t, page) {
  await load(page);
  await pin(page);
  const ink = (await colorOf(page, "--ink")).rgb;
  const [steps, trunks] = [await routeLinesOf(page), await trunksOf(page)];
  const stepKeys = new Set(steps.map((line) => line.key));
  const joined = await page.evaluate(() =>
    [...document.querySelectorAll(".edge[data-route][data-branch]")].map((edge) => ({ key: edge.dataset.key, whole: edge.hasAttribute("data-whole") })),
  );
  t.check(
    `경로의 걸음 ${steps.length}개가 본문 잉크 3px이고, 줄기에 든 걸음 ${joined.length}개는 줄기 위에 전체 경로를 그린다`,
    steps.length > 0 && steps.every((line) => line.stroke === ink && near(line.width, LINE.step, 0.01) && line.opacity === 1) && joined.every((line) => line.whole),
    steps.map((line) => line.key).join(", "),
  );
  t.check(
    "이음은 점선이고 줄기에 들지 않는다",
    steps.filter((line) => line.key.startsWith("step|")).every((line) => line.dashed && !joined.some((each) => each.key === line.key)),
    `이음 ${steps.filter((line) => line.key.startsWith("step|")).length}개`,
  );
  const offRoute = trunks.filter((trunk) => !trunk.branches.some((key) => stepKeys.has(key)));
  t.check(
    `걸음이 지나지 않는 줄기 ${offRoute.length}개는 누를 수 없음을 커서로 보이고 불투명도 ${DIM}이며, 걸음이 지나는 줄기만 눌린다`,
    offRoute.length > 0 && offRoute.every((trunk) => trunk.cursor === "not-allowed" && !trunk.step && trunk.opacity === DIM) &&
      trunks.filter((trunk) => !offRoute.includes(trunk)).every((trunk) => trunk.step && trunk.cursor === "pointer"),
    `걸음이 지나는 줄기 ${trunks.length - offRoute.length}개`,
  );
  await watchFlashes(page);
  const spot = await trunkPoint(page, offRoute[0].key);
  const before = await page.evaluate(() => document.querySelector(".finder-step[aria-current='true']")?.dataset.node ?? null);
  await page.mouse.click(spot.x, spot.y);
  await rest(page);
  t.check(
    "걸음이 지나지 않는 줄기를 눌러도 고정과 보이는 노드가 그대로이고 안내 줄이 뒤집힌다",
    (await pinnedOf(page)) && (await page.evaluate(() => document.querySelector(".finder-step[aria-current='true']")?.dataset.node ?? null)) === before && (await flashesOf(page)) === 1,
    `뒤집힘 ${await flashesOf(page)}번`,
  );
  await t.shot();

  if (cycleUrl === null) {
    t.skip("순환 선이 줄기 구간에서도 critical 색이다", "--cycle-url을 주지 않았다");
    return;
  }
  await load(page, cycleUrl);
  await rest(page);
  const critical = (await colorOf(page, "--critical")).rgb;
  const cycles = await page.evaluate(() =>
    [...document.querySelectorAll(".edge[data-cycle]")].map((edge) => {
      const line = edge.querySelector(".edge-line");
      return { key: edge.dataset.key, joined: edge.dataset.branch !== undefined, whole: edge.hasAttribute("data-whole"), stroke: getComputedStyle(line).stroke, arrow: line.hasAttribute("marker-end") };
    }),
  );
  const inTrunk = cycles.filter((line) => line.joined);
  t.check(
    `순환 선 ${cycles.length}개 가운데 줄기에 든 ${inTrunk.length}개는 줄기 위에 전체 경로를 critical 색으로 화살촉과 함께 그린다`,
    cycles.length > 0 && cycles.every((line) => line.stroke === critical && line.arrow) && inTrunk.every((line) => line.whole),
    cycles.map((line) => line.key).join(", "),
  );
  const stems = await trunksOf(page);
  const muted = (await colorOf(page, "--muted")).rgb;
  const stemStrokes = await page.evaluate(() => [...document.querySelectorAll(".edge-trunk .edge-line")].map((line) => getComputedStyle(line).stroke));
  t.check("줄기는 critical 색을 쓰지 않는다", stemStrokes.every((stroke) => stroke === muted), `줄기 ${stems.length}개`);
}

// ── 4단계: 상자의 세 단계 펼침과 배지 ────────────────────────────

/** 손잡이마다 단 상자, 글, 전부 펼침 단계인지 */
const packsOf = (page) =>
  page.evaluate(() => [...document.querySelectorAll(".node-pack")].map((pack) => ({ box: pack.dataset.box, text: pack.textContent, open: pack.hasAttribute("data-open") })));

const packOf = async (page, box) => (await packsOf(page)).find((pack) => pack.box === box) ?? null;

/** 상자 box 안에 그린 바로 아래 자식의 id. 그래프의 노드 순서다. */
const drawnIn = (page, graph, box) =>
  page.evaluate(
    (ids) => ids.filter((id) => document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`) !== null),
    graph.nodes.filter((n) => n.parent === box).map((n) => n.id),
  );

/**
 * 상자 box의 바로 아래 자식을 상자 밖과 선을 주고받는 자식(outer)과 그 밖의 자식(inner)으로 가른다. 테스트 코드와의 선은 세지 않고,
 * 외부 노드와의 선은 external이 참일 때만 센다. 진입점은 outer에 넣는다.
 */
function stagesOf(graph, box, external = false) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const off = (id) => nodes.get(id).test || (!external && nodes.get(id).kind === "external");
  const within = (id, ancestor) => {
    for (let at = nodes.get(id); at !== undefined; at = at.parent === null ? undefined : nodes.get(at.parent)) {
      if (at.id === ancestor) {
        return true;
      }
    }
    return false;
  };
  const kids = graph.nodes.filter((n) => n.parent === box && !off(n.id));
  const linked = new Set();
  for (const edge of graph.edges) {
    if (off(edge.source) || off(edge.target) || within(edge.source, box) === within(edge.target, box)) {
      continue;
    }
    const inside = within(edge.source, box) ? edge.source : edge.target;
    linked.add(kids.find((kid) => within(inside, kid.id))?.id);
  }
  const outer = kids.filter((kid) => linked.has(kid.id) || kid.entry).map((kid) => kid.id);
  return { kids: kids.map((kid) => kid.id), outer, inner: kids.filter((kid) => !outer.includes(kid.id)).map((kid) => kid.id) };
}

/** 안쪽 자식이 둘 이상이고 밖과 이어진 자식이 있는 파일 가운데 안쪽 자식이 가장 많은 파일. 손잡이가 생기는 파일이다. */
function packedFile(graph, want = () => true) {
  return graph.nodes
    .filter((n) => n.kind === "module" && !n.test)
    .map((n) => ({ id: n.id, ...stagesOf(graph, n.id) }))
    .filter((file) => file.inner.length >= 2 && file.outer.length >= 1 && want(file))
    .sort((a, b) => b.inner.length - a.inner.length)[0];
}

const pickFile = async (page, id) => {
  await page.click(`.tree-row.tree-file[data-node="${id}"]`);
  await waitSelected(page, id);
  await rest(page);
};

const clickPack = async (page, box) => {
  const rect = await rectOf(page, `.node-pack[data-box="${box}"]`);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.move(5, 5);
  await rest(page);
};

/** 접힌 상자의 배지와 정보 패널의 미확인 호출 수를 본다. */
async function badge(t, page) {
  const graph = await api("/api/graph");
  await load(page, url, false);
  const shownBadges = await page.evaluate(() =>
    [...document.querySelectorAll(".node-face .badge-inside")].map((badge) => ({ id: badge.closest(".react-flow__node").dataset.id.replace(/#face$/, ""), count: Number(badge.textContent) })),
  );
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const filesIn = (folder) => graph.nodes.filter((n) => n.kind === "module" && !n.test && n.id !== folder && n.id.startsWith(`${folder}.`)).length;
  const want = (id) => (nodes.get(id).kind === "package" ? filesIn(id) : graph.nodes.filter((n) => n.parent === id && !n.test).length);
  t.check(
    `접힌 파일 상자 ${shownBadges.filter((b) => nodes.get(b.id).kind === "module").length}개의 배지는 안에 든 함수·클래스 수, 접힌 폴더 상자의 배지는 안에 든 파일 수다`,
    shownBadges.length > 1 && shownBadges.some((b) => nodes.get(b.id).kind === "package") && shownBadges.every((b) => b.count === want(b.id)),
    shownBadges.map((b) => `${b.id} ${b.count}`).join(", "),
  );
  const boxesShown = await count(page, ".react-flow__node > .node-body:is(.node-module, .node-package)");
  const empty = graph.nodes.filter((n) => n.kind === "module" && !n.test && n.parent === null && want(n.id) === 0).length;
  t.check("안에 든 것이 있는 접힌 상자마다 배지가 하나다", shownBadges.length === boxesShown - empty, `상자 ${boxesShown}개, 안이 빈 파일 ${empty}개, 배지 ${shownBadges.length}개`);
  t.check(
    "미확인 호출 수 배지와 접힌 파일 상자 아래의 함수 수 글자가 없다",
    (await count(page, ".badge-unresolved")) === 0 && (await count(page, ".node-below")) === 0 && !(await page.evaluate(() => document.querySelector(".react-flow__viewport").textContent.includes("?"))),
  );
  const tip = await tipOver(page, `${face(FILE)} .badge-inside`);
  t.check("파일 상자의 배지에 올리면 안에 든 함수·클래스 수를 적는다", tip === `안에 든 함수·클래스 ${want(FILE)}개 · 고르면 보인다`, tip);
  const folderTip = await tipOver(page, `${face("parser")} .badge-inside`);
  t.check("폴더 상자의 배지에 올리면 안에 든 파일 수를 적는다", folderTip === `안에 든 파일 ${want("parser")}개 · 펼치면 보인다`, folderTip);
  await t.shot();

  const sum = (id) => graph.nodes.filter((n) => !n.test && (n.id === id || n.id.startsWith(`${id}:`) || n.id.startsWith(`${id}.`))).reduce((total, n) => total + n.unresolved, 0);
  await pickFile(page, FILE);
  t.check(`파일을 고르면 정보 패널 머리 줄이 안의 합계를 "미확인 호출 ${sum(FILE)}곳"으로 적는다`, sum(FILE) > 0 && (await headOf(page)).includes(`미확인 호출 ${sum(FILE)}곳`), (await headOf(page)).replaceAll("\n", " / "));
  t.check("펼친 파일 상자에는 배지가 없다", (await count(page, `${face(FILE)} .badge-inside`)) === 0);
  const fn = graph.nodes.find((n) => n.parent === FILE && n.unresolved > 0);
  await page.click(`.tree-row.tree-symbol[data-node="${fn.id}"]`);
  await waitSelected(page, fn.id);
  t.check(`함수를 고르면 머리 줄이 그 함수의 "미확인 호출 ${fn.unresolved}곳"을 적는다`, (await headOf(page)).includes(`미확인 호출 ${fn.unresolved}곳`), (await headOf(page)).replaceAll("\n", " / "));
}

/** 파일 상자를 골라 펼침, 전부 펼침, 다시 펼침으로 옮긴다. */
async function packFile(t, page) {
  const graph = await api("/api/graph");
  const file = packedFile(graph);
  await load(page, url, false);
  await pickFile(page, file.id);
  const pack = await packOf(page, file.id);
  const first = await drawnIn(page, graph, file.id);
  t.check(
    `${file.id}를 고르면 밖과 이어진 정의 ${file.outer.length}개와 "안쪽 ${file.inner.length}개" 손잡이가 보인다`,
    same(first, file.outer) && pack !== null && !pack.open && pack.text.startsWith(`안쪽 ${file.inner.length}개`),
    `그린 정의 ${first.length}개, 손잡이 "${pack?.text}"`,
  );
  const tip = await tipOver(page, `.node-pack[data-box="${file.id}"]`);
  t.check("손잡이의 말풍선이 안에서만 쓰이는 정의의 수와 이름을 적는다", tip.startsWith(`이 파일 안에서만 쓰이는 정의 ${file.inner.length}개 · `), tip);
  const handle = await rectOf(page, `.node-pack[data-box="${file.id}"]`);
  const drawnBoxes = await flowBoxes(page);
  const lowest = Math.max(...first.map((id) => drawnBoxes[id].y));
  const leftmost = Math.min(...first.map((id) => drawnBoxes[id].x));
  t.check(
    "손잡이는 첫 열의 맨 아래에 놓인다",
    near(drawnBoxes[`${file.id}#pack`].x, leftmost) && drawnBoxes[`${file.id}#pack`].y > lowest,
    `손잡이 (${Math.round(drawnBoxes[`${file.id}#pack`].x)}, ${Math.round(drawnBoxes[`${file.id}#pack`].y)})`,
  );
  await t.shot();

  const before = { zoom: await zoomOf(page), corner: await rectOf(page, node(file.id)), selected: await selectedOf(page), history: await count(page, ".trail-step") };
  const order = (boxes, ids) => [...ids].sort((a, b) => boxes[a].x - boxes[b].x || boxes[a].y - boxes[b].y);
  await clickPack(page, file.id);
  const opened = await packOf(page, file.id);
  const all = await drawnIn(page, graph, file.id);
  const fullBoxes = await flowBoxes(page);
  const corner = await rectOf(page, node(file.id));
  t.check(
    `손잡이를 누르면 정의 ${file.kids.length}개가 모두 보이고 손잡이가 "안쪽 ${file.inner.length}개 접기"로 바뀌며 선택과 확대 비율이 그대로다`,
    same(all, file.kids) && opened?.open === true && opened.text === `안쪽 ${file.inner.length}개 접기` && (await selectedOf(page)) === before.selected && near(await zoomOf(page), before.zoom, 0.001),
    `그린 정의 ${all.length}개, 손잡이 "${opened?.text}"`,
  );
  t.check(
    "누른 상자의 왼쪽 위 모서리가 화면의 같은 좌표에 있다",
    near(corner.y, before.corner.y, 1.5) && near(corner.x, before.corner.x, 1.5),
    `(${Math.round(before.corner.x)}, ${Math.round(before.corner.y)}) → (${Math.round(corner.x)}, ${Math.round(corner.y)})`,
  );
  t.check("전부 펼쳐도 이미 보이던 정의 사이의 순서가 같다", same(order(fullBoxes, first), order(drawnBoxes, first)), order(fullBoxes, first).join(", "));
  const columnsNow = [...new Set(all.map((id) => fullBoxes[id].x))];
  t.check(
    "같은 열의 정의는 소스 정의 순서대로 위에서 아래로 놓인다",
    columnsNow.every((x) => {
      const column = all.filter((id) => fullBoxes[id].x === x);
      return same([...column].sort((a, b) => fullBoxes[a].y - fullBoxes[b].y), column);
    }),
    `열 ${columnsNow.length}개`,
  );

  await clickPack(page, file.id);
  // 접는 배치가 화면에 그려진 뒤에 위치를 읽는다.
  await page.waitForFunction((box) => document.querySelector(`.node-pack[data-box="${box}"]:not([data-open])`) !== null, file.id, { timeout: 10_000 }).catch(() => {});
  await rest(page);
  const closed = await flowBoxes(page);
  const back = await rectOf(page, node(file.id));
  t.check(
    "접으면 처음 보이던 정의만 남고 상자 안에서의 위치가 누르기 전과 같다",
    same(await drawnIn(page, graph, file.id), file.outer) && (await packOf(page, file.id))?.open === false &&
      first.every((id) => near(closed[id].x - closed[file.id].x, drawnBoxes[id].x - drawnBoxes[file.id].x) && near(closed[id].y - closed[file.id].y, drawnBoxes[id].y - drawnBoxes[file.id].y)),
    `상자 (${Math.round(back.x)}, ${Math.round(back.y)})`,
  );
  t.check("손잡이의 위치는 선택과 무관하다", handle !== null);
}

/** 함수를 고르고 흐름 단계를 바꿨을 때 꺼낸 자식과 손잡이의 수를 본다. */
async function packFlow(t, page) {
  const graph = await api("/api/graph");
  const stages = stagesOf(graph, FILE);
  // 같은 파일의 안쪽 자식을 부르는 함수를 고른다.
  const calls = (id) => graph.edges.filter((e) => e.source === id && stages.inner.includes(e.target)).map((e) => e.target);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const leaves = (id) => graph.edges.some((e) => e.source === id && !nodes.get(e.target).test && nodes.get(e.target).kind !== "external" && !e.target.startsWith(`${FILE}:`));
  const picked = stages.outer.find((id) => calls(id).length > 0 && leaves(id) && stages.inner.length - new Set(calls(id)).size >= 2);
  await load(page);
  await pickFile(page, FILE);
  const base = (await packOf(page, FILE))?.text ?? "";
  await page.click(`.tree-row.tree-symbol[data-node="${picked}"]`);
  await waitSelected(page, picked);
  await rest(page);
  const drawnNow = await drawnIn(page, graph, FILE);
  const pulled = drawnNow.filter((id) => stages.inner.includes(id));
  const pack = await packOf(page, FILE);
  t.check(
    `${picked}를 고르면 그 파일 상자는 펼침 단계 그대로이고, 같은 파일 안 호출의 도착인 안쪽 자식 ${pulled.length}개가 나타나 손잡이 수가 그만큼 준다`,
    base.startsWith(`안쪽 ${stages.inner.length}개`) && pulled.length > 0 && calls(picked).every((id) => drawnNow.includes(id)) && stages.outer.every((id) => drawnNow.includes(id)) &&
      pack !== null && pack.text.startsWith(`안쪽 ${stages.inner.length - pulled.length}개`),
    `"${base}" → "${pack?.text}"`,
  );
  const others = await page.evaluate(() => [...document.querySelectorAll(".react-flow__node > .node-body.node-module-open")].map((box) => box.closest(".react-flow__node").dataset.id));
  const foreign = (await packsOf(page)).filter((each) => each.box !== FILE && graph.nodes.find((n) => n.id === each.box).kind === "module");
  t.check("흐름의 노드가 든 다른 파일 상자는 그 노드만 그리고 손잡이를 달지 않는다", others.length > 1 && foreign.length === 0, `펼친 파일 상자 ${others.length}개`);
  await t.shot();

  const order = (boxes, ids) => [...ids].sort((a, b) => boxes[a].x - boxes[b].x || boxes[a].y - boxes[b].y);
  const seen = [];
  for (const depth of ["1", "2", "3"]) {
    await inFilters(page, () => page.locator('.filter-panel input[type="range"]').fill(depth));
    await rest(page);
    seen.push({ depth, ids: await drawnIn(page, graph, FILE), boxes: await flowBoxes(page) });
  }
  const kept = seen[0].ids.filter((id) => seen.every((each) => each.ids.includes(id)));
  t.check(
    "흐름 단계를 1, 2, 3으로 바꿔도 이미 보이던 정의 사이의 순서가 같고 단계가 늘면 꺼낸 자식이 줄지 않는다",
    seen.every((each) => same(order(each.boxes, kept), order(seen[0].boxes, kept))) && seen[0].ids.every((id) => seen[2].ids.includes(id)),
    seen.map((each) => `${each.depth}단계 ${each.ids.length}개`).join(", "),
  );
  await inFilters(page, () => page.locator('.filter-panel input[type="range"]').fill("2"));
  await page.keyboard.press("Escape");
  await rest(page);
  t.check(
    "선택을 풀면 파일 상자가 모두 접히고 손잡이가 없다",
    (await selectedOf(page)) === null && (await count(page, ".react-flow__node > .node-body.node-module-open")) === 0 && (await packsOf(page)).filter((each) => each.box === FILE).length === 0,
  );
}

/** 손잡이에 든 함수를 검색과 파일트리로 고른다. */
async function packFind(t, page) {
  const graph = await api("/api/graph");
  const file = packedFile(graph, (each) => each.inner.length >= 4);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const lone = file.inner.filter((id) => nodes.get(id).kind === "function" && !graph.edges.some((e) => e.source === id || e.target === id));
  const targets = (lone.length >= 2 ? lone : file.inner.filter((id) => nodes.get(id).kind === "function")).slice(0, 2);
  await load(page, url, false);
  await pickFile(page, file.id);
  const hiddenBefore = !(await drawnIn(page, graph, file.id)).includes(targets[0]);
  await palettePick(page, nodes.get(targets[0]).name, targets[0]);
  await waitSelected(page, targets[0]);
  await rest(page);
  const afterPalette = await drawnIn(page, graph, file.id);
  t.check(
    `손잡이에 든 ${targets[0]}를 Mod+P로 고르면 그 함수가 그려지고 선택된다`,
    hiddenBefore && afterPalette.includes(targets[0]) && (await selectedOf(page)) === targets[0],
    `손잡이 "${(await packOf(page, file.id))?.text ?? "없음"}"`,
  );
  await pickFile(page, file.id);
  const hiddenAgain = !(await drawnIn(page, graph, file.id)).includes(targets[1]);
  await page.click(`.tree-row.tree-symbol[data-node="${targets[1]}"]`);
  await waitSelected(page, targets[1]);
  await rest(page);
  t.check(
    `손잡이에 든 ${targets[1]}를 파일트리에서 고르면 그 함수가 그려지고 선택된다`,
    hiddenAgain && (await drawnIn(page, graph, file.id)).includes(targets[1]) && (await selectedOf(page)) === targets[1],
  );
  const pack = await packOf(page, file.id);
  const left = file.inner.filter((id) => !(afterPalette.includes(id) && false)).length;
  t.check("고른 함수는 손잡이의 수에서 빠진다", pack === null || Number(/안쪽 (\d+)개/.exec(pack.text)[1]) < left, `손잡이 "${pack?.text ?? "없음"}"`);
  await t.shot();
}

/** 전부 펼친 상자가 경로 고정 동안과 고정을 끈 뒤에 어떻게 보이는지 본다. */
async function packPin(t, page) {
  const graph = await api("/api/graph");
  const file = packedFile(graph, (each) => each.id !== "arbiter" && each.id !== "note_batch" && each.id !== "date_engine");
  await load(page, url, false);
  await pickFile(page, file.id);
  await clickPack(page, file.id);
  const before = { drawn: await drawnIn(page, graph, file.id), pack: await packOf(page, file.id) };
  await pin(page);
  const path = routeOf(graph, TRIP.from.id, TRIP.to.id).paths[0];
  const onPath = await page.evaluate((ids) => ids.every((id) => document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`) !== null), path);
  const definitions = await page.evaluate(() => [...document.querySelectorAll(".react-flow__node > .node-body:is(.node-function, .node-class, .node-dataclass)")].map((body) => body.closest(".react-flow__node").dataset.id));
  t.check(
    "경로를 고정하면 경로 위 노드가 각자의 파일 상자에 보이고 파일 상자는 경로 위 노드만 그린다",
    onPath && definitions.every((id) => path.includes(id) || path.some((step) => step.startsWith(`${id}.`))),
    `그린 정의 ${definitions.length}개, 경로 ${path.length}단계`,
  );
  const shownPacks = (await packsOf(page)).filter((each) => each.open === false);
  await watchFlashes(page);
  if (shownPacks.length === 0) {
    t.skip("고정 중에 손잡이를 눌러도 단계가 바뀌지 않고 안내 줄이 뒤집힌다", "고정 중의 화면에 손잡이가 없다(파일 상자는 고정 중에 접힘이다)");
  } else {
    await clickPack(page, shownPacks[0].box);
    t.check("고정 중에 손잡이를 눌러도 단계가 바뀌지 않고 안내 줄이 뒤집힌다", (await packOf(page, shownPacks[0].box))?.open === false && (await flashesOf(page)) === 1, `뒤집힘 ${await flashesOf(page)}번`);
  }
  await t.shot();
  await page.click(".finder-clear");
  await page.click(".finder-button");
  await rest(page);
  const after = { drawn: await drawnIn(page, graph, file.id), pack: await packOf(page, file.id) };
  t.check(
    "고정을 끄면 고정 전의 단계로 돌아가 전부 펼친 파일 상자가 그대로다",
    (await selectedOf(page)) === file.id && same(after.drawn, before.drawn) && after.pack?.open === true && same(after.pack, before.pack),
    `손잡이 "${after.pack?.text ?? "없음"}"`,
  );
}

/** 미사용 덮개가 손잡이에 든 후보를 꺼내는지 본다. */
async function packOverlay(t, page) {
  const [graph, unused] = [await api("/api/graph"), await api("/api/unused")];
  const candidates = new Set(unused.candidates);
  const held = (file) => file.inner.filter((id) => candidates.has(id) || graph.nodes.some((n) => n.parent === id && candidates.has(n.id)));
  const file = packedFile(graph, (each) => held(each).length > 0);
  if (file === undefined) {
    t.skip("미사용 덮개를 켜면 손잡이에 든 후보가 그려진다", "손잡이에 미사용 후보가 든 파일이 없다");
    return;
  }
  const inside = graph.nodes.filter((n) => candidates.has(n.id) && (file.inner.includes(n.id) || file.inner.includes(n.parent))).length;
  await load(page, url, false);
  await setOverlay(page, "none");
  await pickFile(page, file.id);
  const off = await packOf(page, file.id);
  t.check(
    `덮개가 꺼져 있으면 ${file.id}의 손잡이가 "안쪽 ${file.inner.length}개 · 미사용 후보 ${inside}"다`,
    off?.text === `안쪽 ${file.inner.length}개 · 미사용 후보 ${inside}`,
    `"${off?.text}"`,
  );
  const size = await rectOf(page, node(file.id));
  await setOverlay(page, "unused");
  const on = await packOf(page, file.id);
  const drawnNow = await drawnIn(page, graph, file.id);
  const left = file.inner.length - held(file).length;
  t.check(
    `미사용 덮개를 켜면 후보가 든 자식 ${held(file).length}개가 그려지고 손잡이에 미사용 후보가 없다`,
    held(file).every((id) => drawnNow.includes(id)) && (left <= 1 ? on === null : on.text === `안쪽 ${left}개`),
    `그린 정의 ${drawnNow.length}개, 손잡이 "${on?.text ?? "없음"}"`,
  );
  await t.shot();
  await setOverlay(page, "none");
  const again = await packOf(page, file.id);
  const sizeAgain = await rectOf(page, node(file.id));
  t.check("덮개를 끄면 후보가 손잡이로 돌아가고 상자의 크기가 켜기 전과 같다", same(again, off) && near(size.width, sizeAgain.width) && near(size.height, sizeAgain.height), `"${again?.text}"`);
}

/** 전부 펼침이 탐색 이력에 들어가는지 본다. */
async function packHistory(t, page) {
  const graph = await api("/api/graph");
  const file = packedFile(graph);
  const other = packedFile(graph, (each) => each.id !== file.id);
  await load(page, url, false);
  await pickFile(page, file.id);
  await clickPack(page, file.id);
  await pickFile(page, other.id);
  const there = await packOf(page, other.id);
  t.check("다른 파일을 고르면 그 파일은 펼침 단계로 열리고 앞의 파일은 접힌다", there?.open === false && (await packOf(page, file.id)) === null, `"${there?.text}"`);
  const step = async (key, id) => {
    await page.keyboard.press(key);
    await waitSelected(page, id).catch(() => {});
    await rest(page);
    return (await packOf(page, file.id))?.open ?? null;
  };
  const first = await step("Alt+ArrowLeft", file.id);
  const second = await step("Alt+ArrowLeft", file.id);
  const third = await step("Alt+ArrowRight", file.id);
  t.check(
    "뒤로 두 번, 앞으로 한 번 가면 이력 단계마다 전부 펼침 여부가 그때와 같다",
    first === true && second === false && third === true,
    `뒤로 ${first}, 뒤로 ${second}, 앞으로 ${third}`,
  );
  await page.keyboard.press("Escape");
  await rest(page);
  await pickFile(page, file.id);
  t.check("선택을 풀었다가 다시 고르면 전부 펼침으로 열린다", (await packOf(page, file.id))?.open === true && same(await drawnIn(page, graph, file.id), file.kids));
  await t.shot();
  await page.reload();
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  await pickFile(page, file.id);
  t.check("페이지를 다시 열면 전부 펼침이 비워져 파일을 고르면 펼침 단계로 열린다", (await packOf(page, file.id))?.open === false, `"${(await packOf(page, file.id))?.text}"`);
}

/** 외부 노드 토글이 밖과 이어진 자식을 바꾸는지 본다. */
async function packToggle(t, page) {
  const graph = await api("/api/graph");
  const moved = (file) => stagesOf(graph, file.id, true).inner.length;
  const file = packedFile(graph, (each) => moved(each) < each.inner.length);
  if (file === undefined) {
    t.skip("외부 노드를 켜면 외부 패키지를 부르는 정의가 손잡이에서 나온다", "안쪽 자식 가운데 외부 노드와 선이 있는 정의가 없다");
    return;
  }
  await load(page, url, false);
  await pickFile(page, file.id);
  const before = await packOf(page, file.id);
  await setToggle(page, "외부 노드", true);
  await rest(page);
  const after = await packOf(page, file.id);
  const left = moved(file);
  t.check(
    `외부 노드를 켜면 외부 패키지를 부르는 정의 ${file.inner.length - left}개가 손잡이에서 나와 그려진다`,
    before.text.startsWith(`안쪽 ${file.inner.length}개`) && (left <= 1 ? after === null : after.text.startsWith(`안쪽 ${left}개`)) &&
      same(await drawnIn(page, graph, file.id), left <= 1 ? file.kids : stagesOf(graph, file.id, true).outer),
    `"${before.text}" → "${after?.text ?? "없음"}"`,
  );
  await t.shot();
  await setToggle(page, "외부 노드", false);
  await rest(page);
  t.check("토글을 끄면 손잡이가 켜기 전과 같다", same(await packOf(page, file.id), before));
}

/** 폴더는 접힘과 펼침 두 단계다. 펼치면 안의 파일을 모두 그리고, 펼치고 접을 때 누른 상자를 화면에 붙잡는다. */
async function packFolder(t, page) {
  const graph = await api("/api/graph");
  await load(page, url, false);
  const before = { zoom: await zoomOf(page), corner: await rectOf(page, node("parser")), view: await page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform) };
  await clickNode(page, "parser");
  await page.waitForSelector(`${node("parser")} > .node-region`, { timeout: 30_000 });
  await page.mouse.move(5, 5);
  await rest(page);
  const region = await rectOf(page, node("parser"));
  t.check(
    "폴더 상자를 눌러 펼치면 확대 비율이 그대로이고 영역의 왼쪽 위 모서리가 누른 상자의 왼쪽 위 모서리가 있던 좌표에 있다",
    near(await zoomOf(page), before.zoom, 0.001) && near(region.x, before.corner.x, 1.5) && near(region.y, before.corner.y, 1.5),
    `(${Math.round(before.corner.x)}, ${Math.round(before.corner.y)}) → (${Math.round(region.x)}, ${Math.round(region.y)})`,
  );
  const stays = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`.react-flow__node[data-id="${id}"]`).getBoundingClientRect().left > 0).length, ["arbiter", "note_batch"]);
  t.check("누른 상자의 모서리가 가리지 않는 영역 안에 있으므로 화면을 옮기지 않아 왼쪽 열의 파일 상자가 화면에 남는다", stays === 2, `왼쪽 열의 파일 상자 ${stays}개`);
  await t.shot();
  const inside = graph.nodes.filter((n) => n.parent === "parser" && !n.test).map((n) => n.id);
  const files = await drawnIn(page, graph, "parser");
  t.check(
    `parser/를 펼치면 안의 파일 ${inside.length}개를 모두 그리고 폴더에는 손잡이가 없다`,
    same(files, inside) && (await packOf(page, "parser")) === null,
    `그린 파일 ${files.length}개`,
  );
  const head = await rectOf(page, `${face("parser")} .node-region-head`);
  await page.mouse.click(head.x + 20, head.y + head.height / 2);
  await page.waitForSelector(`${node("parser")} > .node-package`, { timeout: 30_000 });
  await page.mouse.move(5, 5);
  await rest(page);
  const folded = await rectOf(page, node("parser"));
  t.check(
    "머리 줄을 눌러 접으면 폴더 상자가 영역의 왼쪽 위 모서리가 있던 좌표에 놓이고 화면이 펼치기 전과 같다",
    near(folded.x, region.x, 1.5) && near(folded.y, region.y, 1.5) && near(await zoomOf(page), before.zoom, 0.001) &&
      (await page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform)) === before.view,
    `(${Math.round(region.x)}, ${Math.round(region.y)}) → (${Math.round(folded.x)}, ${Math.round(folded.y)})`,
  );
}

// ── 4단계: 선이 지나는 길 ────────────────────────────────────────

/**
 * 선이 자기 출발·도착과 그 조상·자손이 아닌 상자의 안을 지나는 곳. 선과 줄기의 경로를 3px마다 짚어 그 점이 상자의 2px 안쪽에 드는지
 * 본다. 펼친 폴더 영역은 바탕을 지나도 되므로 상자로 세지 않고, 함수 안 import 선(`data-below`)은 세지 않는다.
 */
const crossingsOf = (page) =>
  page.evaluate(() => {
    const boxOf = (wrapper) => {
      const [x, y] = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(wrapper.style.transform).slice(1).map(Number);
      return { id: wrapper.dataset.id, x, y, width: parseFloat(wrapper.style.width), height: parseFloat(wrapper.style.height) };
    };
    const boxes = [...document.querySelectorAll(".react-flow__node")]
      .filter((wrapper) => !wrapper.dataset.id.endsWith("#face") && wrapper.querySelector(":scope > .node-region") === null)
      .map(boxOf);
    const related = (a, b) => a === b || a.startsWith(`${b}.`) || a.startsWith(`${b}:`) || b.startsWith(`${a}.`) || b.startsWith(`${a}:`);
    const found = new Set();
    for (const edge of document.querySelectorAll(".react-flow__edge .edge[data-key]:not([data-below])")) {
      const parts = edge.dataset.key.split("|");
      const endsOf = (key) => {
        const each = key.split("|");
        return each[0] === "agg" || each[0] === "step" ? [each[1], each[2]] : [each[0], each[1]];
      };
      // 줄기는 도착 노드와 줄기에 든 선의 출발 노드가 양 끝이다.
      const ends = edge.classList.contains("edge-trunk")
        ? [parts[1], ...[...document.querySelectorAll(`.edge[data-branch="${CSS.escape(edge.dataset.key)}"]`)].map((branch) => endsOf(branch.dataset.key)[0])]
        : endsOf(edge.dataset.key);
      for (const line of edge.querySelectorAll(".edge-line")) {
        const total = line.getTotalLength();
        for (let at = 0; at <= total; at += 3) {
          const point = line.getPointAtLength(at);
          for (const box of boxes) {
            const inside = point.x > box.x + 2 && point.x < box.x + box.width - 2 && point.y > box.y + 2 && point.y < box.y + box.height - 2;
            if (inside && !ends.some((end) => related(end, box.id.replace(/#pack$/, "")))) {
              found.add(`${edge.dataset.key} × ${box.id}`);
            }
          }
        }
      }
    }
    return [...found];
  });

/**
 * --wide-url의 레포를 열어 안에 든 노드가 가장 많은 최상위 폴더와 그 안에서 자식이 가장 많은 폴더 두 개를 펼치고 화면을 맞춘다.
 * 펼친 폴더 노드를 돌려준다.
 */
async function openWide(page) {
  const graph = await api("/api/graph", wideUrl);
  await page.goto(wideUrl);
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  const top = graph.nodes.filter((n) => n.kind === "package" && n.parent === null && !n.test).sort((a, b) => graph.nodes.filter((n) => n.id.startsWith(`${b.id}.`)).length - graph.nodes.filter((n) => n.id.startsWith(`${a.id}.`)).length)[0];
  const inner = graph.nodes
    .filter((n) => n.kind === "package" && n.parent === top.id)
    .sort((a, b) => graph.nodes.filter((n) => n.parent === b.id).length - graph.nodes.filter((n) => n.parent === a.id).length)
    .slice(0, 2);
  for (const folder of [top, ...inner]) {
    await page.click(`.tree-row.tree-dir[data-node="${folder.id}"]`);
    await page.waitForSelector(`${node(folder.id)} > .node-region`, { timeout: 30_000 });
    await rest(page);
  }
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await page.mouse.move(1, 1);
  await rest(page);
  return [top, ...inner];
}

/** 선이 출발·도착이 아닌 상자의 안을 지나지 않는지 본다. */
async function lanes(t, page) {
  const lines = async () => (await linesOf(page)).length;
  await load(page);
  const open = await crossingsOf(page);
  t.check(`parser/를 펼친 화면의 선 ${await lines()}개가 출발·도착이 아닌 상자를 지나지 않는다`, open.length === 0, open.slice(0, 4).join(", "));
  await t.shot();
  await pickFile(page, FILE);
  const file = await crossingsOf(page);
  t.check(`arbiter.py를 고른 화면의 선 ${await lines()}개가 출발·도착이 아닌 상자를 지나지 않는다`, file.length === 0, file.slice(0, 4).join(", "));
  await clickPack(page, FILE);
  await pick(page, FUNCTION);
  await rest(page);
  const fn = await crossingsOf(page);
  t.check(`함수를 고른 화면의 선 ${await lines()}개가 출발·도착이 아닌 상자를 지나지 않는다`, fn.length === 0, fn.slice(0, 4).join(", "));
  await pin(page);
  const pinned = await crossingsOf(page);
  t.check("경로를 고정한 화면의 걸음과 선이 출발·도착이 아닌 상자를 지나지 않는다", pinned.length === 0, pinned.slice(0, 4).join(", "));

  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포에서 폴더 세 개를 펼친 화면의 선이 상자를 지나지 않는다", "--wide-url을 주지 않았다");
    return;
  }
  const [top, ...inner] = await openWide(page);
  const wide = await crossingsOf(page);
  t.check(
    `${top.id}/와 그 안의 ${inner.map((n) => `${n.name}/`).join(", ")}를 펼친 화면의 선 ${await lines()}개가 출발·도착이 아닌 상자를 지나지 않는다`,
    wide.length === 0,
    wide.slice(0, 4).join(", "),
  );
  await page.screenshot({ path: join(OUT, "s4-lanes-wide.png") });
}

// ── 4단계: 선의 숫자 ─────────────────────────────────────────────

/**
 * 화면의 숫자(도착 노드 앞의 합계, 활성화된 선의 수)마다 다른 숫자, 합류점, 노드의 상자·글자·배지, 자기 선이 아닌 선과 겹치는 곳.
 * 숫자의 사각형은 글자의 사각형이고 좌표는 그래프 좌표다. 줄기 위에 전체 경로를 그리는 선이 줄기의 합계를 같은 자리에 다시 적은 것은
 * 한 숫자로 센다. 줄기의 합계는 줄기와 그 가지가 자기 선이고, 선이 적는 수는 그 선(합계를 다시 적은 것이면 그 줄기까지)이 자기 선이다.
 * 활성화된 선의 수가 같은 노드에서 나가는 선과 겹치는 것은 세지 않는다.
 */
const numberClashes = (page) =>
  page.evaluate(() => {
    const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const boxOf = (text) => {
      const b = text.getBBox();
      return { x: b.x + 0.5, y: b.y + 0.5, width: b.width - 1, height: b.height - 1 };
    };
    const viewport = document.querySelector(".react-flow__viewport");
    const zoom = Number(/scale\(([^)]+)\)/.exec(viewport.style.transform)[1]);
    const origin = viewport.getBoundingClientRect();
    const toGraph = (rect) => ({ x: (rect.left - origin.left) / zoom, y: (rect.top - origin.top) / zoom, width: rect.width / zoom, height: rect.height / zoom });
    const endsOf = (key) => {
      const parts = key.split("|");
      return parts[0] === "agg" || parts[0] === "step" ? [parts[1], parts[2]] : [parts[0], parts[1]];
    };
    const sourceOf = (key) => (key.startsWith("trunk|") ? null : endsOf(key)[0]);
    const numbers = [];
    for (const text of document.querySelectorAll(".react-flow__edge .edge :is(.edge-weight, .edge-trunk-count)")) {
      const edge = text.closest(".edge");
      const box = boxOf(text);
      const trunk = text.classList.contains("edge-sum") ? edge.dataset.branch : edge.classList.contains("edge-trunk") ? edge.dataset.key : null;
      const same = numbers.find((n) => n.trunk !== null && n.trunk === trunk);
      if (same !== undefined) {
        same.own.add(edge.dataset.key);
        continue;
      }
      const own = new Set([edge.dataset.key]);
      if (trunk !== null) {
        own.add(trunk);
        document.querySelectorAll(`.edge[data-branch="${CSS.escape(trunk)}"]`).forEach((branch) => own.add(branch.dataset.key));
      }
      const fixed = trunk !== null || edge.dataset.branch === undefined;
      numbers.push({ label: `${edge.dataset.key}의 ${text.textContent}`, box, own, trunk, fixed, source: sourceOf(edge.dataset.key), target: edge.classList.contains("edge-trunk") ? edge.dataset.target : endsOf(edge.dataset.key)[1] });
    }
    const joints = [...document.querySelectorAll(".edge-joint")].map((dot) => ({ x: dot.cx.baseVal.value - 2.5, y: dot.cy.baseVal.value - 2.5, width: 5, height: 5 }));
    const letters = [...document.querySelectorAll(".node-face :is(.node-label, .loc, .change-mark, .badge, .node-below, .node-field, .node-pack), .node-pack")].map((el) => toGraph(el.getBoundingClientRect()));
    const bodies = [...document.querySelectorAll(".react-flow__node")]
      .filter((w) => !w.dataset.id.endsWith("#face") && !w.dataset.id.endsWith("#pack") && w.querySelector(":scope > :is(.node-region, .node-module-open)") === null && document.querySelector(`.react-flow__node[data-id^="${CSS.escape(w.dataset.id)}."], .react-flow__node[data-id^="${CSS.escape(w.dataset.id)}:"]`) === null)
      .map((w) => toGraph(w.getBoundingClientRect()));
    const lines = [...document.querySelectorAll(".react-flow__edge .edge[data-key]")].map((edge) => ({
      key: edge.dataset.key,
      points: [...edge.querySelectorAll(".edge-line")].flatMap((line) => {
        const total = line.getTotalLength();
        return Array.from({ length: Math.floor(total / 2) + 1 }, (_, i) => line.getPointAtLength(i * 2));
      }),
    }));
    const found = { numbers: [], joints: [], boxes: [], lines: [], leaving: [] };
    numbers.forEach((n, i) => {
      if (numbers.some((other, j) => j > i && overlap(n.box, other.box))) {
        found.numbers.push(n.label);
      }
      if (joints.some((joint) => overlap(n.box, joint))) {
        found.joints.push(n.label);
      }
      if ([...letters, ...bodies].some((box) => overlap(n.box, box))) {
        found.boxes.push(n.label);
      }
      // 활성화된 선의 수는 그 선만 지나는 구간에 자리가 없으면 같은 노드에서 나가는 선과 함께 지나는 구간에 놓는다.
      const together = (line) => !n.fixed && sourceOf(line.key) === n.source;
      const crossing = lines.filter((line) => !n.own.has(line.key) && !together(line) && line.points.some((p) => p.x > n.box.x && p.x < n.box.x + n.box.width && p.y > n.box.y && p.y < n.box.y + n.box.height));
      // 도착 노드 앞의 합계가 그 노드에서 같은 변 쪽으로 나가는 선과 겹치는 것은 따로 센다(진입점 단위 사이의 선, 왼쪽 열로 돌아가는 선).
      const leaving = (line) => n.fixed && sourceOf(line.key) === n.target;
      found.lines.push(...crossing.filter((line) => !leaving(line)).map((line) => `${n.label} × ${line.key}`));
      found.leaving.push(...crossing.filter(leaving).map((line) => `${n.label} × ${line.key}`));
    });
    return { count: numbers.length, ...found };
  });

/** 숫자가 도착 노드 앞과 활성화된 선 위에만 있고 다른 것과 겹치지 않는지 본다. */
async function numbers(t, page) {
  const clean = (name, found, more = true) =>
    t.check(
      `${name}: 숫자 ${found.count}개가 다른 숫자, 합류점, 상자·글자·배지, 자기 선이 아닌 선과 겹치지 않는다`,
      found.count > 0 && more && found.numbers.length + found.joints.length + found.boxes.length + found.lines.length === 0,
      [...found.numbers.map((n) => `숫자끼리 ${n}`), ...found.joints.map((n) => `합류점 ${n}`), ...found.boxes.map((n) => `상자 ${n}`), ...found.lines.map((n) => `선 ${n}`)].slice(0, 4).join(", ") +
        (found.leaving.length > 0 ? ` 남는 종류(도착 노드에서 같은 변 쪽으로 나가는 선과 겹침) ${found.leaving.length}곳` : ""),
    );
  /** 숫자마다 그 숫자를 적은 선이나 줄기의 키, 값, 끝점까지의 거리(그래프 좌표), 그 선이 활성화됐는지 */
  const shownNumbers = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".react-flow__edge .edge :is(.edge-weight, .edge-trunk-count)")].map((text) => {
        const edge = text.closest(".edge");
        const lines = [...edge.querySelectorAll(".edge-line")];
        const line = lines[0];
        const end = line.getPointAtLength(line.getTotalLength());
        const box = text.getBBox();
        return {
          key: edge.dataset.key,
          value: Number(text.textContent),
          trunk: edge.classList.contains("edge-trunk"),
          sum: text.classList.contains("edge-sum"),
          joined: edge.dataset.branch !== undefined,
          active: edge.hasAttribute("data-whole") || edge.hasAttribute("data-pointed") || edge.classList.contains("tone-strong"),
          gap: Math.hypot(box.x + box.width / 2 - end.x, box.y + box.height / 2 - end.y) - box.width / 2,
        };
      }),
    );
  await load(page);
  await zoomTo(page, NAMED_ZOOM);
  await page.mouse.move(5, 5);
  await rest(page);
  const idle = await shownNumbers();
  clean("고르지 않은 화면", await numberClashes(page));
  t.check(
    "고르지 않은 화면의 숫자는 모두 도착 노드 앞의 들어오는 합계다. 줄기는 줄기가, 따로 들어가는 선은 그 선이 화살촉 앞에 적고 가지에는 숫자가 없다",
    idle.length > 0 && idle.every((n) => !n.sum && (n.trunk || !n.joined) && n.value >= 2 && n.gap >= 13 && n.gap <= 13 + 2 + 4),
    `숫자 ${idle.length}개(줄기 ${idle.filter((n) => n.trunk).length}개), 화살촉까지 ${[...new Set(idle.map((n) => Math.round(n.gap)))].join("·")}px`,
  );
  await page.screenshot({ path: join(OUT, "s4-u7-fix-labels-idle-light.png") });

  const trunk = (await trunksOf(page)).sort((a, b) => b.count - a.count)[0];
  const spot = await trunkPoint(page, trunk.key);
  await page.mouse.move(spot.x, spot.y - 1);
  await page.mouse.move(spot.x, spot.y);
  await page.waitForSelector(".edge-trunk[data-pointed]", { timeout: 5_000 });
  await page.waitForTimeout(300);
  const hovered = await shownNumbers();
  const branchNumbers = hovered.filter((n) => n.joined && !n.sum && trunk.branches.includes(n.key));
  const wanted = await page.evaluate((keys) => keys.filter((key) => Number(document.querySelector(`.edge[data-key="${CSS.escape(key)}"]`).dataset.sites) >= 2).length, trunk.branches);
  clean("줄기에 올린 화면", await numberClashes(page));
  t.check(
    `줄기에 올리면 관계가 둘 이상인 가지 ${wanted}개 가운데 놓을 곳이 있는 가지가 저마다 그 선 위에 수를 적고, 줄기의 합계는 가지의 관계 수를 더한 값이다`,
    branchNumbers.length > 0 && branchNumbers.length <= wanted && trunk.sum === trunk.sites,
    `가지의 수 ${branchNumbers.map((n) => n.value).join("·")}(${branchNumbers.length}/${wanted}), 합계 ${trunk.sum}`,
  );
  await t.shot();
  await page.mouse.move(5, 5);
  await rest(page);
  t.check("마우스를 떼면 가지의 수가 사라진다", same(await shownNumbers(), idle));

  await pickFile(page, FILE);
  const picked = await shownNumbers();
  clean("파일을 고른 화면", await numberClashes(page));
  t.check(
    "파일을 고르면 그 파일 상자에 닿는 선 가운데 줄기에 든 선이 그 선 위에 수를 적고, 닿지 않는 가지에는 수가 없다",
    picked.filter((n) => n.joined && !n.sum).every((n) => n.active) && picked.some((n) => n.joined && !n.sum),
    `활성화된 가지의 수 ${picked.filter((n) => n.joined && !n.sum).length}개`,
  );
  await page.screenshot({ path: join(OUT, "s4-u7-fix-labels-file-light.png") });
  await clickPack(page, FILE);
  await pick(page, FUNCTION);
  await page.mouse.move(5, 5);
  await rest(page);
  clean("함수를 고른 화면", await numberClashes(page));
  await pin(page);
  await page.mouse.move(5, 5);
  await rest(page);
  clean("경로를 고정한 화면", await numberClashes(page));
  await page.click(".finder-clear");
  await page.click(".finder-button");
  await page.keyboard.press("Escape");
  await rest(page);
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await pickFile(page, FILE);
  await page.screenshot({ path: join(OUT, "s4-u7-fix-labels-file-dark.png") });

  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포에서 폴더 세 개를 펼친 화면의 숫자가 겹치지 않는다", "--wide-url을 주지 않았다");
    return;
  }
  await openWide(page);
  clean("폴더가 여러 겹인 레포에서 폴더 세 개를 펼친 화면", await numberClashes(page));
  await zoomTo(page, NAMED_ZOOM);
  await page.mouse.move(5, 5);
  await rest(page);
  await page.screenshot({ path: join(OUT, "s4-u7-fix-labels-wide-light.png") });
}

// ── 4단계: 여러 선이 함께 지나는 구간 ────────────────────────────

/** 화면의 선 가운데 pointed인 선의 키 */
const pointedLines = (page) => page.evaluate(() => [...document.querySelectorAll(".react-flow__edge .edge[data-pointed]:not(.edge-trunk)")].map((edge) => edge.dataset.key).sort());

/** 고정한 선 목록의 항목마다 선의 키와 글. 목록이 없으면 null이다. */
const menuOf = (page) =>
  page.evaluate(() => (document.querySelector(".line-menu") === null ? null : [...document.querySelectorAll(".line-menu-item")].map((item) => ({ key: item.dataset.key, text: item.textContent }))));

/**
 * 도착 노드가 다른 선 둘 이상이 함께 지나는 구간 위의 화면 좌표와 그 구간을 지나는 선의 키. 선의 경로를 4px마다 짚어 2px 격자에 모으고,
 * 그 점의 맨 위 요소가 선인 곳을 고른다. 없으면 null이다.
 */
const sharedSpot = (page) =>
  page.evaluate(() => {
    const endsOf = (key) => {
      const parts = key.split("|");
      return parts[0] === "agg" || parts[0] === "step" ? [parts[1], parts[2]] : [parts[0], parts[1]];
    };
    const cells = new Map();
    for (const edge of document.querySelectorAll(".react-flow__edge .edge[data-key]:not(.edge-trunk)")) {
      const line = edge.querySelector(".edge-hit");
      const matrix = line.getScreenCTM();
      for (let at = 8; at < line.getTotalLength() - 8; at += 4) {
        const point = new DOMPoint(line.getPointAtLength(at).x, line.getPointAtLength(at).y).matrixTransform(matrix);
        const cell = `${Math.round(point.x / 2)}:${Math.round(point.y / 2)}`;
        const found = cells.get(cell) ?? { x: point.x, y: point.y, keys: new Set() };
        found.keys.add(edge.dataset.key);
        cells.set(cell, found);
      }
    }
    const area = document.querySelector(".graph").getBoundingClientRect();
    const panel = document.querySelector(".info-panel").getBoundingClientRect();
    for (const { x, y, keys } of cells.values()) {
      const targets = new Set([...keys].map((key) => endsOf(key)[1]));
      const visible = x > area.left + 10 && x < panel.left - 10 && y > area.top + 10 && y < area.bottom - 200;
      if (keys.size >= 2 && targets.size >= 2 && visible && document.elementFromPoint(x, y)?.closest(".react-flow__edge") != null) {
        return { x, y, keys: [...keys].sort(), targets: [...targets] };
      }
    }
    return null;
  });

/** 여러 선이 함께 지나는 구간의 hover와 클릭을 본다. */
async function overlap(t, page) {
  await load(page);
  const hoverAt = async (spot) => {
    await page.mouse.move(spot.x + 1, spot.y + 1);
    await page.mouse.move(spot.x, spot.y);
    await page.waitForSelector(".tooltip", { timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(250);
  };
  // 줄기 가운데 일부 선만 지나는 구간: 줄기의 먼 쪽 끝.
  const trunk = (await trunksOf(page)).filter((each) => each.count >= 3).sort((a, b) => b.count - a.count)[0];
  const far = await page.evaluate((key) => {
    const line = document.querySelector(`.edge-trunk[data-key="${CSS.escape(key)}"] .edge-line`);
    const point = new DOMPoint(line.getPointAtLength(6).x, line.getPointAtLength(6).y).matrixTransform(line.getScreenCTM());
    return { x: point.x, y: point.y };
  }, trunk.key);
  await hoverAt(far);
  const part = { pointed: await pointedLines(page), rows: (await tipText(page)).split("\n"), trunk: (await trunksOf(page)).find((each) => each.key === trunk.key).pointed };
  t.check(
    `가지 ${trunk.count}개인 줄기의 먼 쪽 구간에 올리면 그 구간을 지나는 선만 강조하고 줄기 전체는 강조하지 않는다`,
    part.pointed.length >= 1 && part.pointed.length < trunk.count && !part.trunk && part.pointed.every((key) => trunk.branches.includes(key)),
    `강조한 선 ${part.pointed.length}개, 말풍선 ${part.rows.length}줄`,
  );
  t.check(
    "말풍선의 줄 수가 그 구간을 지나는 선의 수와 같고(도착이 같은 여럿이면 합계 한 줄을 더한다) 선마다 출발 → 도착 · 분류 · M곳을 적는다",
    part.rows.length === (part.pointed.length === 1 ? 1 : part.pointed.length + 1) && part.rows.slice(-part.pointed.length).every((row) => / → .+ · \d+곳$/.test(row)),
    part.rows.join(" / "),
  );
  await page.screenshot({ path: join(OUT, "s4-u7-fix-overlap-part.png") });

  // 도착이 같은 줄기는 누르면 바로 도착 노드를 고른다.
  const near1 = await trunkPoint(page, trunk.key);
  await hoverAt(near1);
  await page.mouse.click(near1.x, near1.y);
  await waitSelected(page, trunk.target).catch(() => {});
  t.check("도착 노드가 같은 선이 겹친 줄기를 누르면 목록 없이 바로 도착 노드를 고른다", (await selectedOf(page)) === trunk.target && (await menuOf(page)) === null, `선택 ${await selectedOf(page)}`);
  await page.keyboard.press("Escape");
  await rest(page);
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await page.mouse.move(5, 5);
  await rest(page);

  // 도착이 다른 선이 겹친 구간.
  const spot = await sharedSpot(page);
  if (spot === null) {
    t.skip("도착이 다른 선이 겹친 구간을 누르면 목록이 고정된다", `화면에 도착이 다른 선이 함께 지나는 구간이 없다 (선택 ${await selectedOf(page)}, 선 ${(await linesOf(page)).length}개)`);
    return;
  }
  await hoverAt(spot);
  const shared = { pointed: await pointedLines(page), rows: (await tipText(page)).split("\n") };
  t.check(
    `도착이 다른 선 ${spot.keys.length}개가 함께 지나는 구간에 올리면 그 선들만 강조하고 말풍선에 한 줄씩 적는다`,
    same(shared.pointed, spot.keys) && shared.rows.length === spot.keys.length && shared.rows.every((row) => / → .+ · \d+곳$/.test(row)),
    `강조 ${shared.pointed.length}개, 말풍선 ${shared.rows.join(" / ")}`,
  );
  await page.screenshot({ path: join(OUT, "s4-u7-fix-overlap-hover.png") });
  await page.mouse.click(spot.x, spot.y);
  await page.waitForSelector(".line-menu", { timeout: 3_000 }).catch(() => {});
  const menu = await menuOf(page);
  t.check(
    "그 구간을 누르면 노드를 고르지 않고 누른 자리에 선 목록을 고정한다. 항목은 말풍선의 줄과 같다",
    menu !== null && same(menu.map((item) => item.key).sort(), spot.keys) && same(menu.map((item) => item.text), shared.rows) && (await selectedOf(page)) === null && (await count(page, ".tooltip")) === 0,
    `항목 ${menu?.length ?? 0}개`,
  );
  const item = await rectOf(page, `.line-menu-item[data-key="${menu[1].key}"]`);
  await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
  await page.waitForTimeout(250);
  t.check("항목에 올리면 그 선 하나만 강조한다", same(await pointedLines(page), [menu[1].key]), (await pointedLines(page)).join(", "));
  await t.shot();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  t.check("Esc는 목록을 먼저 닫고 선택을 바꾸지 않는다", (await menuOf(page)) === null && (await selectedOf(page)) === null && (await count(page, ".edge[data-pointed]")) === 0);

  await page.mouse.click(spot.x, spot.y);
  await page.waitForSelector(".line-menu", { timeout: 3_000 }).catch(() => {});
  await page.mouse.click(40, 500);
  await page.waitForTimeout(200);
  t.check("목록 밖을 누르면 목록이 닫힌다", (await menuOf(page)) === null);

  await page.waitForTimeout(600);
  await page.mouse.click(spot.x, spot.y);
  await page.waitForSelector(".line-menu", { timeout: 3_000 }).catch(() => {});
  const picked = (await menuOf(page))[0];
  const wanted = endsOfKey(picked.key)[1];
  await page.click(`.line-menu-item[data-key="${picked.key}"]`);
  await waitSelected(page, wanted).catch(() => {});
  t.check("항목을 누르면 그 선의 도착 노드를 고르고 목록이 닫힌다", (await selectedOf(page)) === wanted && (await menuOf(page)) === null, `선택 ${await selectedOf(page)}`);
  await page.keyboard.press("Escape");
  await rest(page);
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await page.mouse.move(5, 5);
  await rest(page);

  const again = await sharedSpot(page);
  await page.waitForTimeout(600);
  await page.keyboard.down("Shift");
  await page.mouse.click(again.x, again.y);
  await page.keyboard.up("Shift");
  await page.waitForSelector(".line-menu", { timeout: 3_000 }).catch(() => {});
  const listed = (await menuOf(page))[0];
  await page.click(`.line-menu-item[data-key="${listed.key}"]`);
  await page.waitForSelector(".info-panel-sites", { timeout: 10_000 }).catch(() => {});
  t.check(
    "Shift를 누른 채 누른 목록에서 항목을 고르면 그 선의 코드 줄 목록이 열리고 노드는 선택되지 않는다",
    (await count(page, ".info-panel-site")) > 0 && (await headOf(page)).includes("→") && (await selectedOf(page)) === null,
    (await headOf(page)).replaceAll("\n", " / ").slice(0, 80),
  );
}

const SCENARIOS = [
  ["open", open],
  ["file", file],
  ["function", functionScenario],
  ["body", body],
  ["panel", panel],
  ["code-scope", codeScope],
  ["hover", hover],
  ["edge", edge],
  ["badge-tip", badgeTip],
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
  ["split", split],
  ["summary-busy", summaryBusy],
  ["summary-stale", summaryStale],
  ["explain", explain],
  ["summary-ask", summaryAsk],
  ["summary-ref", summaryRef],
  ["summary", summary],
  ["finder-open", finderOpen],
  ["finder-search", finderSearch],
  ["finder-path", finderPath],
  ["finder-folder", finderFolder],
  ["finder-step", finderStep],
  ["finder-none", finderNone],
  ["finder-pin", finderPin],
  ["finder-change", finderChange],
  ["finder-ends", finderEnds],
  ["overlay-menu", overlayMenu],
  ["reload", reloadScenario],
  ["unused", unusedScenario],
  ["finder-overlay", finderOverlay],
  ["overlay-dark", overlayDark],
  ["cycles", cyclesScenario],
  ["cycles-change", cyclesChange],
  ["cycles-pin", cyclesPin],
  ["start", start],
  ["arranging", arranging],
  ["node-hover", nodeHover],
  ["merge", merge],
  ["merge-hover", mergeHover],
  ["merge-click", mergeClick],
  ["merge-select", mergeSelect],
  ["merge-pin", mergePin],
  ["badge", badge],
  ["pack-file", packFile],
  ["pack-flow", packFlow],
  ["pack-folder", packFolder],
  ["pack-find", packFind],
  ["pack-pin", packPin],
  ["pack-overlay", packOverlay],
  ["pack-history", packHistory],
  ["pack-toggle", packToggle],
  ["lanes", lanes],
  ["numbers", numbers],
  ["overlap", overlap],
  ["progress", progress],
  ["progress-failed", progressFailed],
  ["stale", staleScenario],
];

/** 3단계 시나리오. 스크린샷 이름이 s3-로 시작한다. */
const STAGE3 = new Set(SCENARIOS.slice(SCENARIOS.findIndex(([name]) => name === "finder-open")).map(([name]) => name));
/** 4단계 시나리오. 스크린샷 이름이 s4-로 시작한다. */
const STAGE4 = new Set([
  "start",
  "arranging",
  "node-hover",
  "merge",
  "merge-hover",
  "merge-click",
  "merge-select",
  "merge-pin",
  "badge",
  "pack-file",
  "pack-flow",
  "pack-folder",
  "pack-find",
  "pack-pin",
  "pack-overlay",
  "pack-history",
  "pack-toggle",
  "lanes",
  "numbers",
  "overlap",
  "progress",
  "progress-failed",
  "stale",
]);
/** 순환이 있는 고정 레포를 연 서버에서 도는 시나리오 */
const CYCLE = new Set(["cycles", "cycles-change", "cycles-pin"]);

// ── 실행 ─────────────────────────────────────────────────────────

async function run(browser, name, scenario) {
  if (CYCLE.has(name) && cycleUrl === null) {
    console.log(`[${name}]\n  건너뜀  순환이 있는 고정 레포로 연 화면 — --cycle-url을 주지 않았다`);
    return [{ label: name, ok: null, actual: "" }];
  }
  if ((name === "reload" || name === "stale") && reloadUrl === null) {
    console.log(`[${name}]\n  건너뜀  고정 레포의 임시 복사본으로 연 화면 — --reload-url을 주지 않았다`);
    return [{ label: name, ok: null, actual: "" }];
  }
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
  const path = join(OUT, `${STAGE4.has(name) ? "s4" : STAGE3.has(name) ? "s3" : "s2"}-${name}.png`);
  const page = await context.newPage();
  let shot = false;
  const t = {
    /** 이 시나리오가 서버로 보내도 되는 POST /api/summary의 노드 id */
    summaries: new Set(),
    /** 이 시나리오가 일부러 낸 콘솔 오류에 든 글자. 이 글자가 든 콘솔 오류는 세지 않는다. */
    expected: [],
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
    if (message.type() === "error" && !t.expected.some((text) => message.text().includes(text))) {
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
