// 화면을 시나리오마다 조작해 확인 항목의 통과 여부를 한 줄씩 출력하고 스크린샷을 남긴다.
// 사용: node scripts/shots.mjs [주소] [--cycle-url 주소] [--reload-url 주소] [--wide-url 주소] [--only 이름,이름] [--with-summary]
// 떠 있는 서버의 주소를 받고(기본 http://127.0.0.1:8766) 서버를 띄우지 않는다. 노드 이름은 sync-engine을 연 서버가 기준이고 노드 수·선 수·줄 범위,
// 경로와 미사용 후보는 서버 응답에서 읽는다. 순환 시나리오(cycles, cycles-change, cycles-pin)는 tests/fixtures/cycle_repo를 연 서버의 주소를
// --cycle-url로 받았을 때만 돌고, 받지 않으면 건너뜀으로 출력한다. 새로고침 시나리오(reload, reload-key, stale)는 대상 레포의 파일을 고쳤다가 되돌리므로
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
/** 화면이 말풍선에 적는 Mod+R의 이름 */
const MOD_R = MOD === "Meta" ? "⌘R" : "Ctrl+R";
const OUT = join(homedir(), "data", "code-atlas", "screenshots");
const FILE = "arbiter";
const FUNCTION = "arbiter:_rebuild_note_sections";
/** 초점 상태에서 흐름 밖 노드가 받는 불투명도 */
const DIM = 0.4;
/** 중간 단계의 불투명도. 나가는 흐름의 마지막 단계에 든 노드와 고른 노드가 없을 때의 선이 받는다. */
const HALF = 0.6;
/** 함수 이름표가 모두 보이는 확대 비율 구간의 시작값. 이보다 작은 확대 비율에서 노드를 고르면 이 값이 된다. */
const NAMED_ZOOM = 0.8;
/** 정보 패널의 기본 폭과 기본 여백(위·오른쪽·아래)을 관계 그래프 영역의 폭으로 나눈 값, 패널의 최소 폭 */
const PANEL_SHARE = 0.4;
const PANEL_GAP = 0.01;
const PANEL_MIN = 260;
/** 큰 상자를 패널을 뺀 영역의 시작 끝에서 띄우는 폭 */
const INSET = 20;
const DARK = { surface: "#1a1a19", ink: "#ffffff" };
/** 상단 줄 오른쪽 칸의 버튼. 왼쪽부터다. */
const TOOLS = ["필터", "새로고침", "화면 맞춤", "화면 초기화", "어두운 화면"];
/** 좁은 창에서 상단 줄을 확인할 때 고르는 함수와 창 폭 */
const NARROW = { owner: "parser.plan", id: "parser.plan:_parse_week_header", label: "_parse_week_header()", widths: [1700, 1440, 1280, 1160, 980, 900, 720] };
/** 글자 요소가 그리는 글자와 배지. 이 요소의 가운데 점에서는 늘 그 노드가 눌린다. */
const TEXTS = ".node-label, .change-mark, .badge, .node-aside, .node-below, .node-field, .call-file";

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

/** 정의의 첫 줄 번호와, 정보 패널 이름 줄에 적히는 `파일 경로::이름` */
function spanOf(graph, id) {
  const found = graph.nodes.find((n) => n.id === id);
  return { from: found.range[0], text: `${found.path}::${shortName(graph, id)}` };
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

/** 정보 패널의 머리 줄과 "정보" 구역의 글. 첫 줄은 이름 줄, 둘째 줄은 종류 칩이고 그 아래는 "정보" 구역의 줄마다 `주제 내용`이며 `그 밖` 묶음은 한 칸 띄워 잇는다. */
const headOf = (page) =>
  page.evaluate(() => {
    const texts = (selector) => [...document.querySelectorAll(selector)].map((element) => element.textContent);
    const name = document.querySelector(".info-panel-name")?.textContent ?? "";
    const rows = [...document.querySelectorAll(".info-row")].map((row) => {
      const more = row.querySelector(".info-more")?.textContent ?? "";
      const content = row.querySelector("dd").textContent;
      return `${row.querySelector("dt").textContent} ${content.slice(0, content.length - more.length)}${more === "" ? "" : ` ${more}`}`;
    });
    return [name, texts(".info-panel-chip").join(" "), ...rows].join("\n");
  });

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
 * 시작점은 나가는 줄기가 출발 노드에 닿는 점이고 끝점은 들어오는 줄기가 도착 노드에 닿는 점이다. trunk는 들어오는 줄기의 키다.
 */
const linesOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge .edge[data-key]:not(.edge-trunk)")].map((edge) => {
      const line = edge.querySelector(".edge-line");
      const total = line.getTotalLength();
      const stemOf = (key) => (key === undefined || edge.hasAttribute("data-whole") ? null : document.querySelector(`.edge-trunk[data-key="${CSS.escape(key)}"] .edge-line`));
      const [from, stem] = [stemOf(edge.dataset.trunkOut), stemOf(edge.dataset.trunkIn)];
      const [start, end] = [(from ?? line).getPointAtLength(0), stem === null ? line.getPointAtLength(total) : stem.getPointAtLength(stem.getTotalLength())];
      return {
        key: edge.dataset.key,
        trunk: edge.dataset.trunkIn ?? null,
        out: edge.dataset.trunkOut ?? null,
        below: edge.hasAttribute("data-below"),
        arrow: line.hasAttribute("marker-end"),
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

/** 진하기 단계를 연한 것부터 적은 사다리(`graph/scope.ts`의 `SHADES`). 마우스를 올린 선과 노드는 한 단계 위로 그린다. */
const SHADES = [
  { tone: "muted", opacity: DIM },
  { tone: "muted", opacity: HALF },
  { tone: "muted", opacity: 1 },
  { tone: "strong", opacity: 1 },
];
const darknessOf = (shade) => (shade.tone === "strong" ? 2 : 0) + shade.opacity;
/** 진하기 shade에서 한 단계 올린 진하기. 가장 진한 단계는 그대로다. */
const liftedShade = (shade) => SHADES.find((step) => darknessOf(step) > darknessOf(shade)) ?? { tone: shade.tone, opacity: shade.opacity };

/** 선의 진하기 세 단계마다 그린 선 수 */
function toneLevels(edges) {
  const ink = edges.filter((e) => e.tone === "strong").length;
  const full = edges.filter((e) => e.tone === "muted" && e.opacity === 1).length;
  const dim = edges.filter((e) => e.tone === "muted" && e.opacity === DIM).length;
  return `본문 잉크 ${ink}개, muted 100% ${full}개, muted ${DIM * 100}% ${dim}개`;
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

/**
 * 프레임마다 화면 위치와 확대 비율, 화면 이동과 배치 움직임의 표시, 미니맵의 화면 영역 사각형, 고른 노드, 도착 표시를 적기 시작한다.
 * `framesOf`가 적은 프레임을 돌려주고 기록을 끝낸다.
 */
const watchFrames = (page) =>
  page.evaluate(() => {
    const frames = [];
    window.__shotsFrames = frames;
    const tick = (now) => {
      if (window.__shotsFrames !== frames) {
        return;
      }
      const graph = document.querySelector(".graph");
      const view = /translate\(([^p]+)px, ([^p]+)px\) scale\(([^)]+)\)/.exec(document.querySelector(".react-flow__viewport")?.style.transform ?? "");
      frames.push({
        at: now,
        x: Number(view?.[1]),
        y: Number(view?.[2]),
        zoom: Number(view?.[3]),
        flying: graph?.hasAttribute("data-flying") === true,
        moving: graph?.hasAttribute("data-moving") === true,
        mask: `${document.querySelector(".graph-minimap svg")?.getAttribute("viewBox")} ${document.querySelector(".react-flow__minimap-mask")?.getAttribute("d")}`,
        selected: document.querySelector(".react-flow__node .node-selected")?.closest(".react-flow__node")?.dataset.id ?? null,
        reached: document.querySelector(".reached") !== null,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
const framesOf = (page) =>
  page.evaluate(() => {
    const frames = window.__shotsFrames;
    window.__shotsFrames = null;
    return frames;
  });

/** 배치 움직임(`data-moving`)과 화면 이동(`data-flying`)이 끝나 노드 수와 화면 위치가 quiet ms 동안 그대로일 때까지 기다린다. */
async function settle(page, quiet = 500) {
  await page.waitForFunction(
    (ms) => {
      const graph = document.querySelector(".graph");
      const busy = graph === null || graph.hasAttribute("data-moving") || graph.hasAttribute("data-flying") || document.querySelector(".graph-empty") !== null;
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

/**
 * 정보 패널을 관계 그래프 영역의 오른쪽 끝으로 밀어 둔 채로 화면이 열리게 한다. 저장한 사각형이 영역을 벗어나면 화면이 머리 줄 60px만
 * 영역 안에 남기므로, 기본 패널이 덮는 그래프의 오른쪽 열(줄기의 도착 노드 앞)을 마우스로 가리킬 수 있다. load보다 먼저 부른다.
 */
async function asidePanel(page) {
  await page.addInitScript(() => {
    if (localStorage.getItem("code-atlas:ui:v2") === null) {
      localStorage.setItem("code-atlas:ui:v2", JSON.stringify({ panel: { x: 100_000, y: 0, width: 260, height: 100_000 } }));
    }
  });
}

/** 노드의 이름표(펼친 파일 상자는 머리 줄) 가운데를 마우스로 누른다. times가 2면 더블클릭이고, button이 "right"면 우클릭이다. */
async function clickNode(page, id, times = 1, button = "left") {
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
  await (times === 2 ? page.mouse.dblclick(at.x, at.y) : page.mouse.click(at.x, at.y, { button }));
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
/** 수로 세는 관계의 종류(`graph/names.ts`의 `COUNTED_KINDS`). 실행할 때 그 코드가 실제로 도는 관계다. */
const COUNTED = ["call", "construct", "pass", "read", "write", "decorate", "inherit", "override"];
/** 토글로 숨기는 노드인지(`graph/visible.ts`의 `hidden`). 테스트 코드는 늘 숨긴 것으로 보고, 외부 노드와 외부 값 변수는 external이 거짓일 때 숨긴다. */
const veiled = (n, external = false) => n.test || (!external && (n.kind === "external" || n.external_value === true));
/** 접힌 파일 상자 id의 배지에 적는 수. 바로 아래에 든 함수·클래스·변수 가운데 토글이 꺼진 화면에 보이는 것의 수다. */
const insideOf = (graph, id) => graph.nodes.filter((n) => n.parent === id && !veiled(n)).length;
/** 큰 수를 줄여 적는 글(`graph/names.ts`의 `kilo`) */
const kilo = (count) => (count < 1000 ? String(count) : `${count / 1000 < 9.95 ? (count / 1000).toFixed(1) : Math.round(count / 1000)}k`);
/** 폴더 id 아래(하위 폴더 포함) 파일 노드. tests가 거짓이면 테스트 코드를 뺀다. */
const filesUnder = (graph, id, tests = false) => {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const under = (n) => n !== undefined && (n.id === id || under(nodes.get(n.parent)));
  return graph.nodes.filter((n) => n.kind === "module" && (tests || !n.test) && under(nodes.get(n.parent)));
};
/** 상자의 오른쪽 위 배지에 적는 줄 수. 폴더는 그 아래 파일의 줄 수 합(`graph/visible.ts`의 `folderLines`)이고 그 밖의 상자는 노드의 줄 수다. */
const locOf = (graph, id, tests = false) => {
  const found = graph.nodes.find((n) => n.id === id);
  return found.kind === "package" ? filesUnder(graph, id, tests).reduce((sum, n) => sum + n.loc, 0) : found.loc;
};
/** 배지의 말풍선(`graph/tips.ts`의 `sizeTip`). 줄이지 않은 줄 수 뒤에 안에 든 것의 수를 적는다. */
const sizeTipOf = (graph, id, tests = false) => {
  const found = graph.nodes.find((n) => n.id === id);
  const lines = `줄 수 ${locOf(graph, id, tests)}줄 · 빈 줄을 뺀 수`;
  const inside = found.kind === "package" ? filesUnder(graph, id, tests).length : found.kind === "module" ? graph.nodes.filter((n) => n.parent === id && (tests || !n.test) && n.kind !== "external" && n.external_value !== true).length : 0;
  return inside === 0 ? lines : `${lines} · 안에 든 ${found.kind === "package" ? "파일" : "함수·클래스·변수"} ${inside}개`;
};
/** 안쪽 자식 ids를 묶은 손잡이의 글 머리(`graph/tips.ts`의 `packCount`): `내부 함수 14개`, `내부 함수 14개 · 변수 5개`, `내부 변수 3개` */
const packWords = (graph, ids) => {
  const variables = ids.filter((id) => graph.nodes.find((n) => n.id === id).kind === "variable").length;
  const definitions = ids.length - variables;
  return variables === 0 ? `내부 함수 ${definitions}개` : definitions === 0 ? `내부 변수 ${variables}개` : `내부 함수 ${definitions}개 · 변수 ${variables}개`;
};
/** 세는 관계가 없는 선에 수 대신 적는 글과 그 순서(`graph/names.ts`의 `ALONE`) */
const ALONE = [
  ["type", "타입에만 쓰임"],
  ["import", "import 관계만 있음"],
];
/** 원래 선 edges의 종류마다 코드 줄 수 */
const kindsOf = (edges) => {
  const kinds = {};
  for (const edge of edges) {
    kinds[edge.kind] = (kinds[edge.kind] ?? 0) + edge.sites.length;
  }
  return kinds;
};
/** 원래 선 edges 가운데 세는 관계의 코드 줄 수 */
const countedSites = (edges) => edges.filter((edge) => COUNTED.includes(edge.kind)).reduce((sum, edge) => sum + edge.sites.length, 0);
/** 선의 말풍선이 관계 칸에 적는 글: 세는 관계의 종류 이름과 수(`호출 2곳 · 생성 1곳`)이거나 세는 관계가 없을 때의 글 */
const RELATIONS = String.raw`(?:\S+ \d+곳(?: · \S+ \d+곳)*|${ALONE.map(([, text]) => text).join("|")})`;

/**
 * 선의 말풍선. 칸 이름, 고정했는지, 사각형과 줄마다 그 줄을 낸 선의 키, 세 칸의 글, 출발·도착 칸의 노드 id와 앞쪽 경로, 칸마다 누를 수 있는지다.
 * 말풍선이 없으면 null이다.
 */
const bubbleOf = (page) =>
  page.evaluate(() => {
    const bubble = document.querySelector(".line-bubble");
    if (bubble === null) {
      return null;
    }
    const rect = bubble.getBoundingClientRect();
    return {
      pinned: bubble.hasAttribute("data-pinned"),
      head: [...bubble.querySelectorAll("th")].map((th) => th.textContent),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      rows: [...bubble.querySelectorAll("tbody tr")].map((row) => {
        const cells = [...row.querySelectorAll("td")];
        return {
          key: row.dataset.key,
          source: cells[0].textContent,
          target: cells[1].textContent,
          relation: cells[2].textContent,
          nodes: [cells[0].dataset.node, cells[1].dataset.node],
          paths: cells.slice(0, 2).map((cell) => cell.querySelector(".line-cell-path")?.textContent ?? ""),
          pressable: cells.map((cell) => cell.querySelector("button") !== null),
        };
      }),
    };
  });
/** 말풍선의 줄을 `출발 → 도착 · 관계` 한 줄로 적은 글 */
const rowText = (row) => `${row.source} → ${row.target} · ${row.relation}`;
/** 떠 있는 선의 말풍선의 줄마다 `rowText`로 적은 글. 말풍선이 없으면 빈 배열이다. */
const bubbleRows = async (page) => ((await bubbleOf(page))?.rows ?? []).map(rowText);
/** 선 위의 점 at에 마우스를 올린 동안의 말풍선 */
async function bubbleOver(page, at) {
  await page.mouse.move(at.x - 1, at.y);
  await page.mouse.move(at.x, at.y);
  await page.waitForSelector(".line-bubble", { timeout: 3_000 }).catch(() => {});
  return bubbleOf(page);
}
/**
 * 점 at의 선을 눌러 고정한 말풍선. 마우스를 먼저 올려 선이 강조된 뒤에 누른다. 올리자마자 누르면 강조하며 다른 선 위의 층으로 옮겨 그린 선이
 * 누른 요소와 달라져 클릭이 그래프 바탕으로 간다.
 */
async function pinBubble(page, at) {
  await bubbleOver(page, at);
  await page.waitForTimeout(150);
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector(".line-bubble[data-pinned]", { timeout: 3_000 }).catch(() => {});
  return bubbleOf(page);
}
/** 고정한 말풍선에서 줄 row(0부터)의 칸 cell(source, target, relation)을 누른다. */
const pressCell = (page, row, cell) => page.click(`.line-bubble tbody tr:nth-child(${row + 1}) td[data-cell="${cell}"] button`, { timeout: 5_000 });
/**
 * 점 at의 선을 눌러 말풍선을 고정하고 줄 하나의 칸 cell을 누른다. 기본은 도착 이름이다. 줄은 번호 row로 고르거나, 선의 키 key와
 * 도착 노드 to가 맞는 첫 줄로 고른다. 어느 것도 주지 않으면 첫 줄이다. 누를 줄이 없으면 거짓을 돌려준다.
 */
async function followLine(page, at, { row = null, key = null, to = null, cell = "target" } = {}) {
  const bubble = await pinBubble(page, at);
  const index = row ?? bubble?.rows.findIndex((each) => (key === null || each.key === key) && (to === null || each.nodes[1] === to)) ?? -1;
  if (index < 0) {
    return false;
  }
  await pressCell(page, index, cell).catch(async (error) => {
    const now = await bubbleOf(page);
    throw new Error(`말풍선의 줄 ${index}에서 ${cell} 칸을 누르지 못했다: ${now === null ? "말풍선 없음" : `고정 ${now.pinned}, ${now.rows.map((each) => `${rowText(each)} [${each.pressable}]`).join(" / ")}`} (${error.message.split("\n")[0]})`);
  });
  return true;
}
/** 화면이 선 종류를 적는 이름과 순서(`graph/names.ts`) */
const KIND_NAMES = { call: "호출", construct: "생성", import: "import", pass: "전달", read: "읽음", write: "바꿈", decorate: "데코레이터", type: "타입", inherit: "상속", override: "오버라이드" };
/** 브라우저 기본 말풍선을 띄우는 요소: `title` 속성과 SVG의 `<title>` */
const nativeTips = (page) => page.evaluate(() => [...document.querySelectorAll("[title], svg title")].map((element) => `${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""} "${element.getAttribute("title") ?? element.textContent}"`));

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
  const gap = Math.round(area.width * PANEL_GAP);
  t.check(
    "정보 패널이 관계 그래프 영역 폭의 40%를 차지하고 위·오른쪽·아래 끝에서 영역 폭의 1%씩 띄운다",
    near(gaps.top, gap) && near(gaps.bottom, gap) && near(gaps.right, gap) && near(panel.width, area.width * PANEL_SHARE),
    `여백 위 ${gaps.top}, 오른쪽 ${gaps.right}, 아래 ${gaps.bottom}, 기대 여백 ${gap}, 패널 ${panel.width}×${panel.height}, 영역 ${area.width}×${area.height}`,
  );
  const frame = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector(".info-panel"));
    return { widths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], radius: style.borderTopLeftRadius, shadow: style.boxShadow };
  });
  t.check(
    "기본 패널은 네 변에 1px 테두리를 그리고 모서리를 4px 둥글리며 그림자를 둔다",
    frame.widths.every((width) => width === "1px") && frame.radius === "4px" && frame.shadow !== "none",
    `테두리 ${frame.widths.join(" ")}, 모서리 ${frame.radius}, 그림자 ${frame.shadow}`,
  );
  const badges = await page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node .node-module > .badge-lines")].map((badge) => ({
      id: badge.closest(".react-flow__node").dataset.id.replace(/#face$/, ""),
      text: badge.textContent,
    })),
  );
  t.check(
    "접힌 파일 상자의 배지가 그 파일의 줄 수이고 미확인 호출 수 배지는 없다",
    badges.length > 0 && badges.every((badge) => badge.text === kilo(locOf(graph, badge.id))) && (await count(page, ".badge-unresolved")) === 0,
    `배지 ${badges.length}개: ${badges.slice(0, 5).map((badge) => `${badge.id} ${badge.text}`).join(", ")}`,
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
    `파일 밖과 이어진 함수 노드 ${outer}개가 나타나고 나머지는 "${packWords(graph, stages.inner)}" 손잡이에 든다`,
    outer > 0 && functions === outer && (await packOf(page, FILE))?.text.startsWith(packWords(graph, stages.inner)),
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
  const around = crossing(graph, FILE);
  t.check(
    "정보 구역의 나가는 연결과 들어오는 연결이 arbiter.py의 경계를 넘는 선의 코드 줄 수와 같다",
    title.includes(`나가는 연결 ${linksWords(around.out).text}`) && title.includes(`들어오는 연결 ${linksWords(around.into).text}`),
    title.replaceAll("\n", " / "),
  );
  const unresolved = graph.nodes.filter((n) => n.path === `src/${FILE}.py`).reduce((sum, n) => sum + n.unresolved, 0);
  t.check(
    "펼친 arbiter.py 상자의 배지는 줄 수 하나뿐이고 안의 함수는 배지가 없으며, 정보 구역이 안에 든 함수의 미확인 호출 수 합을 적는다",
    unresolved > 0 && (await count(page, `${face(FILE)} .badge-lines`)) === 1 && (await count(page, ".node-face:is(.node-function, .node-variable) .badge-lines")) === 0 && (await count(page, ".badge-unresolved")) === 0 && title.includes(`미확인 호출 ${unresolved}곳`),
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
    `그 밖의 선은 muted 잉크이고 불투명도가 1(흐름에 든 노드 사이)이나 ${DIM}다`,
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
    `arbiter.py 상자 안의 흐름 밖 함수 이름표가 불투명도 ${DIM}로 보인다`,
    local.length > 0 && local.every((n) => n.opacity === DIM && n.label === "visible"),
    `흐름 밖 노드 ${local.length}개, 불투명도 ${[...new Set(local.map((n) => n.opacity))].join("·")}, 이름표 ${[...new Set(local.map((n) => n.label))].join("·")}`,
  );
}

async function functionScenario(t, page) {
  await load(page);
  await focused(t, page);
  await t.shot();

  // 고른 함수를 그래프와 파일트리에서 다시 눌러도 선택과 펼친 파일 상자, 이력이 그대로다.
  const state = async () => ({
    selected: await selectedOf(page),
    open: (await boxes(page)).filter((b) => b.open).map((b) => b.id),
    steps: await count(page, ".trail-step"),
  });
  const before = await state();
  await clickNode(page, FUNCTION);
  await page.mouse.move(5, 5);
  await rest(page);
  const onGraph = await state();
  t.check("고른 함수를 그래프에서 다시 눌러도 선택, 펼친 파일 상자, 탐색 이력이 그대로다", before.selected === FUNCTION && before.open.includes(FILE) && same(onGraph, before), `선택 ${onGraph.selected}, 펼친 파일 상자 ${onGraph.open.length}개`);
  await page.click(`.tree-row.tree-symbol[data-node="${FUNCTION}"]`);
  await page.mouse.move(5, 5);
  await rest(page);
  const onTree = await state();
  t.check("고른 함수의 파일트리 행을 다시 눌러도 그대로다", same(onTree, before), `선택 ${onTree.selected}, 펼친 파일 상자 ${onTree.open.length}개`);

  // 그래프의 빈 곳을 눌러도 선택이 풀리지 않고, Esc와 탐색 경로의 소스 루트 이름, 고른 파일 상자의 머리 줄이 선택을 푼다.
  const blank = async () => {
    const { free } = await stageOf(page);
    return page.evaluate(({ x, y, width, height }) => {
      for (let dy = 8; dy < height; dy += 16) {
        for (let dx = 8; dx < width; dx += 16) {
          if (document.elementFromPoint(x + dx, y + dy)?.classList.contains("react-flow__pane")) {
            return { x: x + dx, y: y + dy };
          }
        }
      }
      return null;
    }, free);
  };
  const whole = async () => ({ ...(await state()), head: await headOf(page), code: await count(page, ".info-panel .code") });
  const kept = await whole();
  const empty = await blank();
  await page.mouse.click(empty.x, empty.y);
  await page.waitForTimeout(600);
  await rest(page);
  const onPane = await whole();
  t.check("함수를 고른 채 그래프의 빈 곳을 눌러도 선택, 펼친 파일 상자, 정보 패널, 탐색 이력이 그대로다", kept.selected === FUNCTION && kept.code === 1 && same(onPane, kept), `누른 곳 (${empty.x}, ${empty.y}), 선택 ${onPane.selected}`);
  const line = await hittable(page, await linesOf(page));
  if (line === null) {
    t.skip("고정한 말풍선은 빈 곳을 누르면 닫히고 선택은 남는다", "화면에 누를 선이 없다");
  } else {
    const pinned = await pinBubble(page, line.at);
    const spot = await blank();
    await page.mouse.click(spot.x, spot.y);
    await page.waitForSelector(".line-bubble", { state: "detached", timeout: 3_000 }).catch(() => {});
    await page.mouse.move(5, 5);
    await rest(page);
    t.check("고정한 말풍선은 빈 곳을 누르면 닫히고 선택은 남는다", pinned?.pinned === true && (await count(page, ".line-bubble[data-pinned]")) === 0 && same(await whole(), kept), `선택 ${await selectedOf(page)}`);
  }
  await page.keyboard.press("Escape");
  await rest(page);
  t.check("Esc는 선택을 풀고 파일 상자를 접는다", (await selectedOf(page)) === null && !(await boxes(page)).some((b) => b.open));
  await palettePick(page, FUNCTION.split(":")[1], FUNCTION);
  await waitSelected(page, FUNCTION);
  const steps = await count(page, ".trail-step");
  await page.click(".trail-root");
  await page.mouse.move(5, 5);
  await rest(page);
  const cleared = (await selectedOf(page)) === null && (await count(page, ".trail-step")) === 0;
  await page.keyboard.press("Alt+ArrowLeft");
  await waitSelected(page, FUNCTION).catch(() => {});
  t.check("탐색 경로 맨 앞의 레포 이름을 누르면 선택이 풀리고, 뒤로 가면 그 함수를 고른 화면으로 돌아온다", steps > 0 && cleared && (await selectedOf(page)) === FUNCTION, `선택 ${await selectedOf(page)}`);
  await pickFile(page, FILE);
  // 펼친 상자의 머리 줄이 화면 안에 오도록 그래프 전체를 맞춘 뒤 누른다.
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await page.mouse.move(1, 1);
  await settle(page);
  await clickNode(page, FILE);
  await page.mouse.move(5, 5);
  await rest(page);
  t.check("고른 파일 상자의 머리 줄을 다시 누르면 선택이 풀리고 파일 상자가 접힌다", (await selectedOf(page)) === null && !(await boxes(page)).some((b) => b.open));
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
  /** 기본 사각형이 지금의 관계 그래프 영역에서 폭의 40%(최소 폭보다 좁으면 최소 폭)를 차지하고 위·오른쪽·아래 끝에서 영역 폭의 1%씩 띄우는지 */
  const docked = async () => {
    const { area, panel: box } = await stageOf(page);
    const width = Math.max(PANEL_MIN, Math.round(area.width * PANEL_SHARE));
    const gap = Math.round(area.width * PANEL_GAP);
    const ok =
      near(box.width, width) && near(box.x + box.width, area.x + area.width - gap) && near(box.y, area.y + gap) && near(box.height, area.height - 2 * gap);
    return { ok, text: `영역 ${Math.round(area.width)}×${Math.round(area.height)}, 패널 ${rectText(box)}, 기대 폭 ${width}, 기대 여백 ${gap}` };
  };
  /** 창 크기를 바꾼 뒤 기본 패널이 새 영역에 다시 놓일 때까지 기다린다. */
  const redocked = async () => {
    await page
      .waitForFunction(
        ([share, least, margin]) => {
          const [box, stage] = [document.querySelector(".info-panel").getBoundingClientRect(), document.querySelector(".stage").getBoundingClientRect()];
          const gap = Math.round(stage.width * margin);
          return (
            Math.abs(box.width - Math.max(least, Math.round(stage.width * share))) <= 1 &&
            Math.abs(box.right - (stage.right - gap)) <= 1 &&
            Math.abs(box.height - (stage.height - 2 * gap)) <= 1
          );
        },
        [PANEL_SHARE, PANEL_MIN, PANEL_GAP],
        { timeout: 5_000 },
      )
      .catch(() => {});
    await settle(page);
  };
  for (const width of [1280, 720]) {
    await page.setViewportSize({ width, height: VIEW.height });
    await redocked();
    const narrow = await docked();
    t.check(`창 폭을 ${width}px로 바꾸면 기본 패널이 영역 폭의 40%와 1% 여백을 따라 다시 놓인다`, narrow.ok, narrow.text);
  }
  await page.setViewportSize(VIEW);
  await redocked();
  const wide = await docked();
  t.check("기본 패널은 영역 폭의 40%를 차지하고 위·오른쪽·아래 끝에서 영역 폭의 1%씩 띄운다", wide.ok && sameRect(await rectOf(page, ".info-panel"), start), wide.text);
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
    const top = editor.getBoundingClientRect().top;
    const at = (element) => Math.round(element.getBoundingClientRect().top - top);
    const numbers = new Map([...editor.querySelectorAll(".line-numbers")].map((element) => [at(element), Number(element.textContent)]));
    return [...editor.querySelectorAll(".view-line")]
      .map((element) => ({ line: numbers.get(at(element)) ?? null, dim: element.querySelector(".code-dim") !== null, blank: element.textContent.trim() === "", y: at(element) }))
      .filter((row) => row.line !== null)
      .sort((a, b) => a.y - b.y);
  });

/** 파일을 고르면 파일 전체가, 함수를 고르면 파일 전체에서 그 함수 밖의 줄만 흐리게 보이는지 본다. */
/**
 * 코드 뷰어에서 줄 범위 [from, to]가 놓인 곳. first는 범위 첫 줄의 위 끝, top은 1번 줄의 위 끝이고(둘 다 뷰어의 위 끝에서 잰다),
 * off는 범위의 세로 가운데에서 뷰어의 세로 가운데를 뺀 값이다. 화면에 그린 줄 하나의 위치와 줄 높이로 센다.
 */
const placedOf = (page, range) =>
  page.evaluate(([from, to]) => {
    const editor = document.querySelector(".info-panel .monaco-editor");
    const box = editor.getBoundingClientRect();
    const line = editor.querySelector(".view-line").getBoundingClientRect().height;
    const shown = [...editor.querySelectorAll(".line-numbers")].find((element) => element.textContent !== "");
    const y = (n) => shown.getBoundingClientRect().top - box.top + (n - Number(shown.textContent)) * line;
    return { first: y(from), top: y(1), off: (y(from) + y(to) + line - box.height) / 2, line, height: box.height, long: (to - from + 1) * line > box.height };
  }, range);
/** 규칙대로 놓였는지: 뷰어보다 긴 범위는 첫 줄이 뷰어 맨 위에 있고, 그 밖의 범위는 가운데가 뷰어 가운데와 줄 높이 한 줄 안에서 같다. */
const centered = (at) => (at.long ? near(at.first, 0, 2) : Math.abs(at.off) <= at.line);
const placedText = (at) => `첫 줄의 위 끝 ${Math.round(at.first)}px, 가운데 차이 ${Math.round(at.off)}px, 줄 높이 ${at.line}px, 뷰어 높이 ${Math.round(at.height)}px`;

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
  const long = await placedOf(page, target.range);
  t.check(
    `코드 뷰어보다 긴 함수를 고르면 정의의 첫 줄 ${target.range[0]}번이 코드 뷰어 맨 위에 있고 그 줄부터 흐리지 않다`,
    long.long && opened[0]?.line === target.range[0] && near(opened[0].y, 0, 2) && dimmedOutside(opened, target.range),
    `첫 줄 번호 ${opened[0]?.line}, 높이 ${opened[0]?.y}`,
  );
  await page.screenshot({ path: HF3("code-center-long") });
  const gap = await page.evaluate(() => {
    const [viewer, editor] = [document.querySelector(".info-panel .code"), document.querySelector(".info-panel .monaco-editor")];
    return {
      top: editor.getBoundingClientRect().top - viewer.getBoundingClientRect().top - viewer.clientTop,
      line: editor.querySelector(".view-line").getBoundingClientRect().height,
    };
  });
  t.check("요약 칸 아래 경계선과 코드 첫 줄 사이에 코드 한 줄 높이를 비운다", gap.line > 0 && near(gap.top, gap.line), `여백 ${gap.top}px, 줄 높이 ${gap.line}px`);
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
  const movedAt = await placedOf(page, later.range);
  t.check(
    `스크롤한 뒤에 같은 파일의 다른 함수(${later.range[0]}~${later.range[1]}번 줄)를 고르면 그 정의가 가운데 규칙대로 놓이고 흐린 범위가 바뀐다`,
    centered(movedAt) && moved.some((row) => row.line === later.range[0]) && dimmedOutside(moved, later.range),
    placedText(movedAt),
  );

  // 짧은 정의는 범위의 가운데가 뷰어 가운데에 온다. 뷰어 높이가 바뀌면 다시 가운데에 두고, 스크롤한 뒤에는 옮기지 않는다.
  const short = graph.nodes.find((n) => n.kind === "function" && n.path === path && (n.range[1] - n.range[0] + 1) * long.line < long.height / 3 && n.range[0] > 100 && n.range[1] < total - 100);
  await page.click(`.tree-row.tree-symbol[data-node="${short.id}"]`);
  await waitSelected(page, short.id);
  await waitLine(short.range[0]);
  await page.waitForTimeout(300);
  const shortAt = await placedOf(page, short.range);
  t.check(
    `코드 뷰어보다 짧은 함수(${short.range[0]}~${short.range[1]}번 줄)를 고르면 범위의 가운데가 뷰어의 가운데와 줄 높이 한 줄 안에서 같다`,
    !shortAt.long && Math.abs(shortAt.off) <= shortAt.line && shortAt.first > shortAt.line,
    placedText(shortAt),
  );
  await page.screenshot({ path: HF3("code-center-short") });
  const divide = () => rectOf(page, ".info-panel-divide").then(center);
  await drag(page, await divide(), 0, 160);
  await page.waitForTimeout(400);
  const resized = await placedOf(page, short.range);
  t.check(
    "요약 칸과 코드 뷰어 사이의 경계선을 끌어 뷰어 높이를 바꾸면 그 정의를 다시 가운데에 둔다",
    Math.abs(resized.height - shortAt.height) > 100 && Math.abs(resized.off) <= resized.line,
    `${placedText(shortAt)} → ${placedText(resized)}`,
  );
  await page.screenshot({ path: HF3("code-center-resized") });
  const viewer = await rectOf(page, ".info-panel .code");
  await page.mouse.move(viewer.x + viewer.width / 2, viewer.y + viewer.height / 2);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(300);
  const wheeled = await placedOf(page, short.range);
  await drag(page, await divide(), 0, -160);
  await page.waitForTimeout(400);
  const kept = await placedOf(page, short.range);
  t.check(
    "사용자가 스크롤한 뒤에는 뷰어 높이를 바꿔도 스크롤 위치를 옮기지 않는다",
    resized.first - wheeled.first > wheeled.line && near(kept.first, wheeled.first, 1) && near(kept.height, shortAt.height, 2) && Math.abs(kept.off) > kept.line,
    `스크롤한 뒤 첫 줄의 위 끝 ${Math.round(wheeled.first)}px → 높이를 되돌린 뒤 ${Math.round(kept.first)}px`,
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
  t.check(`함수 셋과 파일을 차례로 고르는 동안 /api/file 요청이 ${path} 한 번뿐이다`, same(asked, [path]), asked.join(", "));

  // 파일 맨 위의 정의는 가운데에 둘 줄이 위에 없으므로 1번 줄부터 보인다. 창을 높여 뷰어 높이의 절반 안에서 끝나는 정의를 찾는다.
  await page.setViewportSize({ width: VIEW.width, height: 1400 });
  await rest(page);
  const tall = (await rectOf(page, ".info-panel .monaco-editor")).height;
  const head = graph.nodes
    .filter((n) => ["function", "class", "dataclass"].includes(n.kind) && !n.test && n.range !== null && (n.range[0] + n.range[1]) * long.line < tall)
    .sort((x, y) => x.range[0] - y.range[0])[0];
  if (head === undefined) {
    t.skip("파일 맨 위의 정의를 고르면 1번 줄부터 보인다", "범위의 가운데가 뷰어 높이의 절반보다 위에 있는 정의가 없다");
    return;
  }
  const owner = graph.nodes.find((n) => n.kind === "module" && n.path === head.path);
  await pickInTree(page, { id: head.id, owner: owner.id });
  await waitLine(head.range[0]);
  await page.waitForTimeout(300);
  const headAt = await placedOf(page, head.range);
  const headRows = await codeRows(page);
  t.check(
    `파일 맨 위의 정의(${head.path} ${head.range[0]}~${head.range[1]}번 줄)를 고르면 스크롤 위치가 0이어서 1번 줄이 여백 바로 아래에 보인다`,
    near(headAt.top, 0, 1) && headRows[0]?.line === 1 && headAt.off < 0 && dimmedOutside(headRows, head.range),
    `1번 줄의 위 끝 ${Math.round(headAt.top)}px, ${placedText(headAt)}`,
  );
  await page.screenshot({ path: HF3("code-center-top") });
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
    `고른 노드가 없으면 모든 선이 muted 잉크에 불투명도 ${HALF}여서 불투명도 1인 상자 테두리보다 연하다`,
    lines.length > 0 && lines.every((line) => line.tone === "muted" && line.opacity === HALF && line.stroke === muted) && border === muted,
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
  const up = liftedShade(first);
  t.check(
    "선에 마우스를 올리면 그 선만 굵어지고 빛을 두르며 진하기를 한 단계 올려 다른 선 위의 층에 그려진다",
    over.pointed && over.width > first.width && over.glow && over.tone === up.tone && over.opacity === up.opacity && over.layer === "5" &&
      rest.every((line) => !line.pointed && line.layer === "4" && !line.glow),
    `굵기 ${first.width} → ${over.width}, 층 ${first.layer} → ${over.layer}, 진하기 ${first.tone} ${first.opacity} → ${over.tone} ${over.opacity}`,
  );
  t.check(
    "마우스를 올린 선의 숫자도 선과 같은 색이다",
    over.digits === null ? digitsMatch(rest) : over.digits === over.stroke,
    `선 ${over.stroke}, 숫자 ${over.digits ?? "없음"}`,
  );
  await t.shot();
  await page.mouse.move(spot.x, spot.y - 40);
  await page.waitForFunction(() => document.querySelector(".edge[data-pointed]") === null, null, { timeout: 5_000 }).catch(() => {});
  const back = (await linesOf(page)).find((line) => line.key === first.key);
  t.check("마우스를 떼면 굵기와 층이 돌아온다", !back.pointed && back.width === first.width && back.layer === "4", `굵기 ${back.width}, 층 ${back.layer}`);

  // 선 클릭
  const target = ends(first)[1];
  await followLine(page, spot, { key: first.key });
  await waitSelected(page, target).catch(() => {});
  t.check("선을 눌러 고정한 말풍선에서 도착 이름을 누르면 도착 노드가 선택되고 정보 패널이 그 노드를 적는다", (await selectedOf(page)) === target && (await count(page, ".info-panel-sites")) === 0, `선택 ${await selectedOf(page)}`);
  const focusedLines = await linesOf(page);
  const levels = [...new Set(focusedLines.map((line) => `${line.tone} ${line.opacity}`))].sort();
  t.check(
    `노드를 고르면 닿는 선은 본문 잉크 1, 그 밖의 선은 muted 1이나 ${DIM}이고, 세 단계 모두 숫자의 색이 선의 색과 같다`,
    levels.includes("strong 1") && levels.includes(`muted ${DIM}`) && levels.every((level) => ["strong 1", "muted 1", `muted ${DIM}`].includes(level)) && digitsMatch(focusedLines),
    levels.join(", "),
  );
  const again = await hittable(page, (await linesOf(page)).filter((line) => ends(line)[1] === target));
  if (again === null) {
    t.skip("고른 노드로 들어오는 선의 도착 이름을 눌러도 선택이 풀리지 않는다", "화면에 누를 선이 없다");
  } else {
    await followLine(page, again.at, { key: again.line.key, to: target });
    await settle(page);
    t.check("고른 노드로 들어오는 선의 도착 이름을 눌러도 선택이 풀리지 않는다", (await selectedOf(page)) === target, `선택 ${await selectedOf(page)}`);
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
  const [painted, viewer] = [await rectOf(page, ".info-panel .monaco-editor .code-range"), await rectOf(page, ".info-panel .monaco-editor")];
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
  await followLine(page, point, { key: call.key });
  await waitSelected(page, ends(call)[1]).catch(() => {});
  t.check(
    "함수 시점 뷰에서 선의 도착 이름을 누르면 도착 함수가 선택되고 가운데 함수는 그대로다",
    (await selectedOf(page)) === ends(call)[1] &&
      (await page.evaluate(() => document.querySelector('.node-call[data-side="center"]')?.closest(".react-flow__node")?.dataset.id)) === FUNCTION,
    `선택 ${await selectedOf(page)}`,
  );

  // 화면을 끄는 동안의 hover. 끄는 동안에는 그래프가 커서를 따라가므로 버튼을 누른 채의 mousemove를 선에 직접 보낸다.
  await page.mouse.move(5, 5);
  await settle(page);
  const held = await hittable(page, await linesOf(page));
  const moveOver = (buttons) =>
    page.evaluate(
      ([key, at, pressed]) =>
        document
          .querySelector(`.edge[data-key="${CSS.escape(key)}"] .edge-hit`)
          .dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: at.x, clientY: at.y, buttons: pressed })),
      [held.line.key, held.at, buttons],
    );
  const marks = async () => ({ pointed: await count(page, ".edge[data-pointed]"), tip: await count(page, ".line-bubble") });
  await moveOver(1);
  await page.waitForTimeout(300);
  const pressed = await marks();
  await moveOver(0);
  await page.waitForSelector(".edge[data-pointed]", { timeout: 5_000 }).catch(() => {});
  const released = await marks();
  await moveOver(1);
  await page.waitForTimeout(300);
  const repressed = await marks();
  t.check(
    "마우스 버튼을 누른 채(화면을 끄는 동안) 선 위를 지나면 선의 강조와 말풍선이 뜨지 않고, 떠 있던 강조와 말풍선은 거둔다",
    pressed.pointed === 0 && pressed.tip === 0 && released.pointed > 0 && released.tip === 1 && repressed.pointed === 0 && repressed.tip === 0,
    `누른 채 강조한 선 ${pressed.pointed}개·말풍선 ${pressed.tip}개, 뗀 뒤 ${released.pointed}개·${released.tip}개, 다시 누른 채 ${repressed.pointed}개·${repressed.tip}개`,
  );
}

async function badgeTip(t, page) {
  await load(page);
  const graph = await api("/api/graph");
  const over = (selector) => tipOver(page, selector);
  const counted = await page.evaluate(() => {
    const badge = document.querySelector(".node-face.node-module:not(.node-module-open) .badge-lines");
    return { id: badge.closest(".react-flow__node").dataset.id, text: badge.textContent };
  });
  const id = counted.id.replace(/#face$/, "");
  const inside = await over(`${face(id)} .badge-lines`);
  t.check(
    "접힌 파일 상자의 배지에 올리면 말풍선이 줄이지 않은 줄 수와 안에 든 함수·클래스·변수 수를 적는다",
    counted.text === kilo(locOf(graph, id)) && inside === sizeTipOf(graph, id),
    inside.replaceAll("\n", " / "),
  );
  await t.shot();
  const label = await rectOf(page, `${face(id)} .node-label`);
  /** 배지의 바탕색·글자색·불투명도 */
  const badgeOf = (wrapper) =>
    page.evaluate((selector) => {
      const badge = getComputedStyle(document.querySelector(`${selector} .badge-lines`));
      return { background: badge.backgroundColor, color: badge.color, opacity: badge.opacity };
    }, wrapper);
  const hoverBadge = async (wrapper, rect, theme) => {
    await page.mouse.move(5, 5);
    await page.waitForFunction((selector) => !document.querySelector(selector).classList.contains("pointed"), wrapper, { timeout: 3_000 }).catch(() => {});
    const away = await badgeOf(wrapper);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.waitForFunction((selector) => document.querySelector(selector).classList.contains("pointed"), wrapper, { timeout: 3_000 }).catch(() => {});
    const over = await badgeOf(wrapper);
    const pointed = await page.evaluate((selector) => document.querySelector(selector).classList.contains("pointed"), wrapper);
    await page.screenshot({ path: join(OUT, `hf3-badge-hover-${theme}.png`) });
    return { away, over, pointed, surface: (await colorOf(page, "--surface")).rgb, muted: (await colorOf(page, "--muted")).rgb };
  };
  /** 배지는 muted 잉크 바탕에 화면 바탕색 글자이고 커서를 올린 상자에서도 그대로다 */
  const kept = (seen) => seen.pointed && seen.away.background === seen.muted && same(seen.over, seen.away) && seen.over.color === seen.surface;
  const onFile = await hoverBadge(face(id), label, "light");
  t.check("접힌 파일 상자에 커서를 올려도 배지의 바탕은 muted 잉크, 글자는 화면 바탕색 그대로다", kept(onFile), `바탕 ${onFile.away.background} → ${onFile.over.background}`);
  await page.mouse.move(5, 5);
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const onDark = await hoverBadge(face(id), label, "dark");
  t.check("어두운 화면에서도 같다", kept(onDark) && onDark.over.color !== onFile.over.color, `바탕 ${onDark.away.background} → ${onDark.over.background}`);
  await page.mouse.move(5, 5);
  await page.getByRole("button", { name: "밝은 화면" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme !== "dark");
  await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
  await page.waitForFunction(() => !(document.querySelector(".tooltip")?.textContent ?? "").includes("안에 든"), null, { timeout: 3_000 }).catch(() => {});
  const name = await tipText(page);
  t.check("같은 상자의 이름표로 옮기면 배지의 말풍선이 사라진다", !name.includes("안에 든") && !name.includes("줄 수") && !name.includes(" · 파일"), `말풍선 "${name}"`);
  const entry = await over(`${face(FILE)} .node-entry`);
  t.check("진입점 표시에 올리면 진입점임을 적는다", entry.startsWith("진입점"), entry);
  t.check("화면이 브라우저 기본 말풍선(title)을 쓰지 않는다", (await nativeTips(page)).length === 0, (await nativeTips(page)).join(", "));
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => document.querySelector(".tooltip") === null, null, { timeout: 3_000 }).catch(() => {});
  t.check("노드 밖으로 나가면 말풍선이 사라진다", (await count(page, ".tooltip")) === 0);
  // load가 펼쳐 둔 폴더 하나를 파일트리의 폴더 행으로 접어 접힌 폴더 상자의 배지를 본다.
  await page.click('.tree-row.tree-dir[data-node="parser"]');
  await page.waitForSelector(`${node("parser")} > .node-package`, { timeout: 30_000 });
  await rest(page);
  const onFolder = await hoverBadge(face("parser"), await rectOf(page, `${face("parser")} .node-label`), "light-folder");
  t.check("접힌 폴더 상자에 커서를 올려도 배지의 바탕과 글자가 그대로다", kept(onFolder), `바탕 ${onFolder.away.background} → ${onFolder.over.background}`);
  await page.mouse.move(5, 5);
}

/**
 * 말풍선. 노드는 LLM 요약의 요지와 잘린 이름만 적고, 선은 관계의 종류와 수를 적으며, 그래프 밖의 버튼과 행도 같은 말풍선을 쓴다.
 * 요지 목록과 요약은 서버 대신 답한다. 사진은 `hf2-tip-{이름}.png`로 남긴다.
 */
async function tips(t, page) {
  const LEAD = "노트의 구역을 다시 지어 바뀐 구역만 파일에 쓴다.";
  const MADE = "새로 만든 요약의 요지다.";
  const leads = [
    { node: FILE, lead: "plan과 reminders, 일일 노트를 서로 맞춘다." },
    { node: FUNCTION, lead: LEAD },
  ];
  await page.route((at) => at.pathname === "/api/summaries", (route) => route.fulfill({ json: { summaries: leads } }));
  await page.route(
    (at) => at.pathname === "/api/summary",
    (route) => {
      const node = new URL(route.request().url()).searchParams.get("node");
      if (route.request().method() === "POST") {
        return route.fulfill({ json: { summary: `${MADE}\n\n하는 일\n문단\n\n앞뒤 흐름\n문단`, usage: null } });
      }
      const lead = leads.find((each) => each.node === node)?.lead ?? null;
      return route.fulfill({ json: { summary: lead === null ? null : `${lead}\n\n하는 일\n문단\n\n앞뒤 흐름\n문단`, stale: false, available: true, reason: null } });
    },
  );
  const shot = (name) => page.screenshot({ path: join(OUT, `hf2-tip-${name}.png`) });
  /** 요소 가운데에 마우스를 올리고 잠시 뒤의 말풍선 글. 말풍선이 없으면 빈 글이다. */
  const settled = async (selector) => {
    const rect = await rectOf(page, selector);
    await page.mouse.move(5, 5);
    await page.mouse.move(rect.x + rect.width / 2 - 1, rect.y + rect.height / 2);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.waitForTimeout(400);
    return tipText(page);
  };
  const styleOf = () =>
    page.evaluate(() => {
      const style = getComputedStyle(document.querySelector(".tooltip"));
      const panel = document.createElement("span");
      panel.style.color = "var(--panel-bg)";
      document.body.append(panel);
      const expected = getComputedStyle(panel).color;
      panel.remove();
      return { background: style.backgroundColor, color: style.color, border: style.borderTopWidth, expected };
    });

  await load(page);
  const graph = await api("/api/graph");
  const withLead = await settled(`${face(FILE)} .node-label`);
  t.check("요약이 있는 파일 상자에 올리면 말풍선이 그 요약의 요지만 적는다", withLead === leads[0].lead, withLead);
  const ink = await colorOf(page, "--ink");
  const light = await styleOf();
  t.check(
    "밝은 화면의 말풍선은 칸 바탕색에 본문 잉크로 글자를 적고 경계선을 두른다",
    light.background === light.expected && light.color === ink.rgb && light.border === "1px",
    `바탕 ${light.background}, 글자 ${light.color}, 경계선 ${light.border}`,
  );
  await shot("node-light");

  const plain = await page.evaluate(
    ([taken]) => {
      for (const wrapper of document.querySelectorAll('.react-flow__node[data-id$="#face"]')) {
        const label = wrapper.querySelector(":scope > .node-module .node-label");
        const id = wrapper.dataset.id.replace(/#face$/, "");
        if (label === null || taken.includes(id) || label.textContent.includes("…") || label.scrollWidth > label.clientWidth) {
          continue;
        }
        const rect = label.getBoundingClientRect();
        if (wrapper.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))) {
          return id;
        }
      }
      return null;
    },
    [leads.map((each) => each.node)],
  );
  const without = await settled(`${face(plain)} .node-label`);
  t.check("요약이 없고 이름표가 잘리지 않은 파일 상자에 올리면 말풍선이 뜨지 않는다", plain !== null && without === "" && (await count(page, ".tooltip")) === 0, `${plain}: "${without}"`);

  // 선: 접힌 파일 상자 사이의 집계 선 하나의 관계를 /api/graph에서 센다.
  const index = new Map(graph.nodes.map((n) => [n.id, n]));
  const fileOf = (id) => {
    let found = index.get(id);
    while (found !== undefined && found.kind !== "module") {
      found = found.parent === null ? undefined : index.get(found.parent);
    }
    return found?.id ?? null;
  };
  const aggregates = (await linesOf(page)).filter((line) => {
    const [kind, source, target] = line.key.split("|");
    return kind === "agg" && index.get(source)?.kind === "module" && index.get(target)?.kind === "module";
  });
  const found = await hittable(page, aggregates);
  if (found === null) {
    t.skip("집계 선에 올리면 말풍선이 관계의 종류와 수를 적는다", "파일 상자 사이에 누를 점이 있는 집계 선이 없다");
  } else {
    const [, source, target] = found.line.key.split("|");
    const kinds = {};
    for (const each of graph.edges) {
      if (fileOf(each.source) === source && fileOf(each.target) === target && !index.get(each.source).test && !index.get(each.target).test) {
        kinds[each.kind] = (kinds[each.kind] ?? 0) + each.sites.length;
      }
    }
    const relations = relationWords(kinds);
    const title = (id) => `${id.replaceAll(".", "/")}.py`;
    await bubbleOver(page, { x: found.at.x, y: found.at.y });
    const rows = await bubbleRows(page);
    t.check(
      "집계 선에 올리면 말풍선이 출발과 도착, 그 선에 든 세는 관계의 수를 적고 타입이나 import만 있으면 수 없이 적는다",
      rows.includes(`${title(source)} → ${title(target)} · ${relations}`) && rows.every((row) => new RegExp(` → .+ · ${RELATIONS}$`).test(row)),
      rows.join(" / "),
    );
    t.check("선의 말풍선에 분류 이름(실행, 사용, 계승)과 종류 없는 수가 없다", rows.every((row) => !/· (실행|사용|계승)( ·|$)/.test(row) && !/· \d+곳$/.test(row)), rows.join(" / "));
    await shot("line");
  }

  // 정의 노드: 요지가 있는 함수, 그리고 화면에서 만든 요약.
  await pickInTree(page, { id: FUNCTION, owner: FILE });
  await settle(page);
  const onFunction = await settled(`${face(FUNCTION)} .node-label`);
  t.check("요약이 있는 함수 노드에 올리면 말풍선이 그 요지를 적는다", onFunction === LEAD, onFunction);
  const sibling = definedIn(graph, FILE).find((n) => n.kind === "function" && n.id !== FUNCTION && n.name.length < 30);
  const treeRow = `.tree-row.tree-symbol[data-node="${sibling.id}"]`;
  const before = await settled(`${treeRow} .tree-label`);
  await page.click(treeRow);
  await waitSelected(page, sibling.id);
  await page.getByRole("button", { name: "요약 생성" }).click();
  await page.waitForSelector(".summary-lead", { timeout: 5_000 });
  const after = await settled(`${treeRow} .tree-label`);
  t.check(
    "요약이 없는 함수의 파일트리 행은 말풍선이 없고, 요약을 만들면 그 행의 말풍선이 바로 새 요지를 적는다",
    before === "" && after === MADE,
    `만들기 전 "${before}", 만든 뒤 "${after}"`,
  );
  await shot("tree");
  await settle(page);
  const made = await settled(`${face(sibling.id)} .node-label`);
  t.check("그래프의 그 노드에 올려도 새 요지가 뜬다", made === MADE, made);

  // 그래프 밖: 버튼의 말풍선, 키보드 초점, 잘린 파일트리 행.
  const legend = await settled(".legend-button");
  t.check('범례 버튼에 올리면 앱의 말풍선이 "범례"를 적고 접근성 이름이 남아 있다', legend === "범례" && (await page.getAttribute(".legend-button", "aria-label")) === "범례", legend);
  await shot("button");
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => document.querySelector(".tooltip") === null, null, { timeout: 3_000 }).catch(() => {});
  const gone = await count(page, ".tooltip");
  await page.focus(".minimap-button");
  await page.keyboard.press("Tab");
  await page.waitForSelector(".tooltip", { timeout: 3_000 }).catch(() => {});
  const focused = await page.evaluate(() => ({ label: document.activeElement?.getAttribute("aria-label") ?? "", tip: document.querySelector(".tooltip")?.textContent ?? "" }));
  t.check("버튼에서 마우스를 떼면 말풍선이 사라지고, Tab으로 초점을 옮긴 버튼에도 말풍선이 뜬다", gone === 0 && focused.tip !== "" && focused.tip === focused.label, `초점 "${focused.label}", 말풍선 "${focused.tip}"`);
  await page.evaluate(() => document.activeElement?.blur());

  const separator = center(await rectOf(page, ".separator"));
  await drag(page, separator, -200, 0);
  await rest(page);
  const clippedRow = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".tree-row.tree-symbol")].find((each) => {
      const label = each.querySelector(".tree-label");
      return label.scrollWidth > label.clientWidth;
    });
    return row === undefined ? null : { node: row.dataset.node, full: row.dataset.full };
  });
  if (clippedRow === null) {
    t.skip("이름이 잘린 파일트리 행에 올리면 말풍선이 전체 이름을 적는다", "파일트리를 좁혀도 잘린 행이 없다");
  } else {
    const row = await settled(`.tree-row.tree-symbol[data-node="${clippedRow.node}"] .tree-label`);
    t.check("이름이 잘린 파일트리 행에 올리면 말풍선 첫 줄에 전체 이름을 적는다", row.split("\n")[0] === clippedRow.full, row.replaceAll("\n", " / "));
  }
  await drag(page, center(await rectOf(page, ".separator")), 200, 0);
  await rest(page);

  // 창과 패널을 모두 연 화면에 브라우저 기본 말풍선이 없다.
  await page.click(".legend-button");
  await page.click(".finder-button");
  await page.click(".filter-button");
  await page.waitForSelector(".filter-panel", { timeout: 5_000 });
  await page.fill(".tree-search-input", "note");
  await page.waitForSelector(".tree-result", { timeout: 5_000 });
  const groups = [];
  for (const group of ["run", "use", "derive"]) {
    groups.push(await settled(`.legend li:has(.edge-${group})`));
  }
  t.check(
    "범례의 선 분류에 올리면 말풍선이 그 분류에 드는 선 종류를 적는다",
    same(groups, ["실행 선: 호출, 생성", "사용 선: import, 전달, 읽음, 바꿈, 데코레이터, 타입", "계승 선: 상속, 오버라이드"]),
    groups.join(" / "),
  );
  const native = await nativeTips(page);
  t.check("범례, 경로 탐색 창, 필터 창, 정보 패널, 파일트리 검색을 연 화면에 title 속성과 SVG title이 없다", native.length === 0, native.join(", "));
  await page.fill(".tree-search-input", "");
  await page.click(".filter-button");
  await page.click(".finder-button");
  await page.click(".legend-button");

  // 어두운 화면
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const darkLead = await settled(`${face(sibling.id)} .node-label`);
  const dark = await styleOf();
  const darkInk = await colorOf(page, "--ink");
  t.check(
    "어두운 화면의 말풍선은 어두운 칸 바탕색에 밝은 글자로 요지를 적는다",
    darkLead === MADE && dark.background === dark.expected && dark.color === darkInk.rgb && darkInk.value === DARK.ink && dark.background !== light.background,
    `바탕 ${dark.background}, 글자 ${dark.color}`,
  );
  await shot("node-dark");
  const darkButton = await settled(".minimap-button");
  t.check("어두운 화면에서 버튼의 말풍선도 같은 색이다", darkButton === "미니맵" && same(await styleOf(), dark), darkButton);
  await shot("button-dark");

  // 이름표가 잘린 노드: 폴더가 여러 겹인 레포.
  if (wideUrl === null) {
    t.skip("이름표가 잘린 노드에 올리면 말풍선이 전체 이름을 적는다", "sync-engine에는 이름표가 잘린 노드가 없다 — --wide-url을 주지 않았다");
    return;
  }
  const wide = await api("/api/graph", wideUrl);
  const long = wide.nodes.find((n) => n.kind === "module" && !n.test && `${n.id.replaceAll(".", "/")}.py`.length > 36 && !n.id.endsWith(".__init__"));
  await page.goto(wideUrl);
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  const chain = [];
  for (let parent = long.parent; parent !== null; parent = wide.nodes.find((n) => n.id === parent).parent) {
    chain.unshift(parent);
  }
  for (const folder of chain) {
    await openFolder(page, folder);
  }
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await settle(page);
  await page.click(`.tree-row.tree-file[data-node="${long.id}"]`);
  await waitSelected(page, long.id);
  await settle(page);
  await page.keyboard.press("Escape");
  await settle(page);
  const label = await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? "", `${face(long.id)} .node-label`);
  const full = await settled(`${face(long.id)} .node-label`);
  t.check(
    "이름표가 잘린 파일 상자에 올리면 요약이 없어도 말풍선이 줄이지 않은 경로를 적는다",
    label.includes("…") && full === `${long.id.replaceAll(".", "/")}.py`,
    `이름표 "${label}", 말풍선 "${full}"`,
  );
  await shot("clipped");
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

  // 함수 시점 뷰에서 나가기. 상단 줄의 뷰 이름과 돌아가는 버튼, Esc, 탐색 경로의 레포 이름을 본다.
  const HF5 = (name) => join(OUT, `hf5-callview-${name}.png`);
  /** 지금 뷰(`function`, `structure`)와 고른 노드, 그 노드의 이름표 가운데 점이 그 노드에서 눌리는지 */
  const placeOf = () =>
    page.evaluate(() => {
      const chosen = document.querySelector(".react-flow__node .node-selected")?.closest(".react-flow__node") ?? null;
      const id = chosen?.dataset.id.replace(/#face$/, "") ?? null;
      const drawn = [...document.querySelectorAll(".react-flow__node")].filter((each) => each.dataset.id.replace(/#face$/, "") === id);
      const rect = drawn.map((each) => each.querySelector(".node-label")).find((label) => label !== null)?.getBoundingClientRect();
      const hit = rect === undefined ? null : document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const seen = hit !== null && drawn.some((each) => each.contains(hit));
      return { view: document.querySelector(".node-call") === null ? "structure" : "function", selected: id, seen };
    });
  const placeText = (at) => `${at.view === "function" ? "함수 시점 뷰" : "구조 뷰"}, 선택 ${at.selected}${at.selected === null ? "" : at.seen ? ", 화면 안" : ", 화면에서 눌리지 않음"}`;
  const left = () => page.waitForFunction(() => document.querySelector(".node-call") === null && document.querySelector(".react-flow__node") !== null, null, { timeout: 30_000 }).then(() => settle(page));
  const entered2 = () => page.waitForSelector(".node-call", { timeout: 30_000 }).then(() => settle(page));
  /** 상단 줄의 뷰 이름과 돌아가는 버튼. 버튼은 가운데 점에서 눌리고 상단 줄 안에 있는지 본다. */
  const barOf = () =>
    page.evaluate(() => {
      const shown = (element) => element !== null && element.getClientRects().length > 0;
      const bar = document.querySelector(".toolbar").getBoundingClientRect();
      const pressed = (element) => {
        const rect = element?.getBoundingClientRect();
        const hit = rect === undefined || rect.width === 0 ? null : document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit !== null && element.contains(hit) && rect.right <= bar.right;
      };
      const [view, leave, last] = [".trail-view", ".trail-leave", ".trail-last"].map((selector) => document.querySelector(selector));
      return {
        view: shown(view) ? view.textContent : null,
        leave: leave === null ? null : [...leave.children].filter(shown).map((each) => each.textContent.trim()).join(""),
        label: leave?.getAttribute("aria-label") ?? null,
        leavePressed: pressed(leave),
        lastPressed: pressed(last),
        lastWidth: Math.round(last?.getBoundingClientRect().width ?? 0),
      };
    });

  await clickNode(page, FUNCTION, 2);
  await entered2();
  await page.mouse.move(5, 5);
  const bar = await barOf();
  const leaveTip = await tipOver(page, ".trail-leave");
  t.check(
    "함수 시점 뷰의 상단 줄은 탐색 경로 뒤에 뷰 이름 `리니지 뷰`와 `그래프 뷰로` 버튼을 그리고 버튼의 말풍선에 Esc를 적는다",
    bar.view === "리니지 뷰" && bar.leave === "그래프 뷰로" && bar.leavePressed && bar.lastPressed && leaveTip === "그래프 뷰로 돌아가기 · Esc" && (await nativeTips(page)).length === 0,
    `뷰 이름 "${bar.view}", 버튼 "${bar.leave}", 말풍선 "${leaveTip}"`,
  );
  await page.screenshot({ path: HF5("bar") });
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await tipOver(page, ".trail-leave");
  await page.screenshot({ path: HF5("bar-dark") });
  await page.getByRole("button", { name: "밝은 화면" }).click();
  await page.mouse.move(5, 5);

  await page.keyboard.press("Escape");
  await left();
  const out = await placeOf();
  t.check("함수 시점 뷰에서 Esc를 누르면 가운데 함수를 고른 구조 뷰로 돌아가고 그 함수가 화면 안에 있다", out.view === "structure" && out.selected === FUNCTION && out.seen && (await count(page, ".trail-view")) === 0, placeText(out));
  await page.keyboard.press("Alt+ArrowLeft");
  await entered2();
  const again = { ...(await placeOf()), center: await centered() };
  await page.keyboard.press("Alt+ArrowRight");
  await left();
  const forth = await placeOf();
  t.check(
    "Esc로 나온 뒤 Alt+←는 함수 시점 뷰로, Alt+→는 그 함수를 고른 구조 뷰로 옮긴다",
    again.view === "function" && again.center === FUNCTION && forth.view === "structure" && forth.selected === FUNCTION,
    `뒤로: ${placeText(again)}, 앞으로: ${placeText(forth)}`,
  );
  await page.keyboard.press("Escape");
  await rest(page);
  const cleared = await placeOf();
  t.check("구조 뷰에서 Esc를 한 번 더 누르면 선택이 풀린다", cleared.view === "structure" && cleared.selected === null, placeText(cleared));

  // 함수 시점 뷰에서 다른 함수를 고른 뒤 나간다.
  await page.keyboard.press("Alt+ArrowLeft");
  await waitSelected(page, FUNCTION);
  await page.keyboard.press("Alt+ArrowLeft");
  await entered2();
  const other = await page.evaluate(() => {
    const side = [...document.querySelectorAll(".node-call")].find((each) => each.dataset.side !== "center");
    const rect = side.getBoundingClientRect();
    return { id: side.closest(".react-flow__node").dataset.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(other.x, other.y);
  await waitSelected(page, other.id);
  await page.mouse.move(5, 5);
  await page.keyboard.press("Escape");
  await left();
  const moved = await placeOf();
  t.check("함수 시점 뷰에서 다른 함수를 고른 뒤 Esc를 누르면 그 함수를 고른 구조 뷰로 돌아가고 그 함수가 화면 안에 있다", moved.view === "structure" && moved.selected === other.id && moved.seen, `고른 함수 ${other.id}. ${placeText(moved)}`);

  await page.keyboard.press("Alt+ArrowLeft");
  await entered2();
  await page.click(".trail-leave");
  await left();
  const pressed = await placeOf();
  t.check("`그래프 뷰로` 버튼은 Esc와 같이 고른 함수를 고른 구조 뷰로 돌아간다", pressed.view === "structure" && pressed.selected === other.id && pressed.seen, placeText(pressed));

  await page.keyboard.press("Alt+ArrowLeft");
  await entered2();
  await page.click(".trail-root >> nth=0");
  await left();
  const rooted = await placeOf();
  await page.keyboard.press("Alt+ArrowLeft");
  await entered2();
  const returned = { ...(await placeOf()), center: await centered() };
  t.check(
    "함수 시점 뷰에서 탐색 경로의 레포 이름을 누르면 선택을 푼 구조 뷰로 돌아가고 뒤로 가면 함수 시점 뷰로 돌아온다",
    rooted.view === "structure" && rooted.selected === null && returned.view === "function" && returned.center === FUNCTION && returned.selected === other.id,
    `레포 이름: ${placeText(rooted)}, 뒤로: ${placeText(returned)}`,
  );

  // 그래프의 빈 곳 클릭과 고정한 말풍선. 빈 곳은 아무것도 바꾸지 않고, Esc는 말풍선만 닫는다.
  const steps = () => page.getByRole("button", { name: "앞으로" }).isDisabled();
  const before = [await placeOf(), await steps()];
  const pane = await page.evaluate(() => {
    const graph = document.querySelector(".graph").getBoundingClientRect();
    for (let y = graph.top + 60; y < graph.bottom - 60; y += 24) {
      for (let x = graph.left + 20; x < graph.right - 20; x += 24) {
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane") === true) {
          return { x, y };
        }
      }
    }
    return null;
  });
  await page.mouse.click(pane.x, pane.y);
  await page.waitForTimeout(400);
  t.check("함수 시점 뷰의 빈 곳을 눌러도 뷰와 선택, 이력이 그대로다", same([await placeOf(), await steps()], before), placeText(await placeOf()));
  const drawn = await hittable(page, await linesOf(page));
  const pinnedBubble = await pinBubble(page, drawn.at);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const kept = { ...(await placeOf()), bubble: await count(page, ".line-bubble[data-pinned]") };
  await page.mouse.move(5, 5);
  await page.keyboard.press("Escape");
  await left();
  const closed = await placeOf();
  t.check(
    "고정한 말풍선이 있으면 Esc는 말풍선만 닫고, 한 번 더 누르면 구조 뷰로 돌아간다",
    pinnedBubble?.pinned === true && kept.bubble === 0 && kept.view === "function" && kept.selected === other.id && closed.view === "structure" && closed.selected === other.id,
    `말풍선 고정 ${pinnedBubble?.pinned ?? false}. 첫 Esc: ${placeText(kept)}, 고정한 말풍선 ${kept.bubble}개. 둘째 Esc: ${placeText(closed)}`,
  );

  // 좁은 창. 뷰 이름을 그리지 않고 버튼은 ×만 그리며 마지막 단계와 버튼이 상단 줄 안에서 눌린다.
  await page.keyboard.press("Alt+ArrowLeft");
  await entered2();
  await page.setViewportSize({ width: 720, height: 1000 });
  await page.waitForTimeout(400);
  const narrow = await barOf();
  t.check(
    "창 폭 720px의 함수 시점 뷰는 뷰 이름을 그리지 않고 버튼을 ×로 줄이며 마지막 단계와 버튼이 상단 줄 안에서 눌린다",
    narrow.view === null && narrow.leave === "×" && narrow.label === "그래프 뷰로" && narrow.leavePressed && narrow.lastPressed,
    `뷰 이름 ${narrow.view === null ? "없음" : `"${narrow.view}"`}, 버튼 "${narrow.leave}", 마지막 단계 폭 ${narrow.lastWidth}px`,
  );
  await page.screenshot({ path: HF5("narrow") });
  await page.setViewportSize(VIEW);
  await page.waitForTimeout(400);
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
  const defined = definedIn(await api("/api/graph"), FILE).filter((n) => !veiled(n)).length;
  t.check(
    `함수·변수 행 ${defined}개가 arbiter.py 행 바로 아래에서 한 단계 더 들여쓴 안내선 아래에 있다`,
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

/** 요약을 만들지 않고 서버 대신 답해 요약 칸의 크기와, 다시 만든 요약의 머리 줄에 적는 토큰 수를 본다. 사진은 `hf5-tokens-panel.png`로 남긴다. */
async function summaryPanel(t, page) {
  await page.route(
    (at) => at.pathname === "/api/summary",
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ json: { summary: longSummary(6), usage: { input: 2, cache_write: 1885, cache_read: 16411, output: 840 } } })
        : route.fallback(),
  );
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

  const cached = await count(page, ".summary-usage");
  await page.click(".summary-head .summary-action");
  await page.waitForSelector(".summary-usage", { timeout: 5_000 }).catch(() => {});
  const usage = await page.evaluate(() => {
    const [text, button, label, probe] = [document.querySelector(".summary-usage"), document.querySelector(".summary-head .summary-action"), document.querySelector(".summary-head .info-panel-label"), document.body.appendChild(document.createElement("span"))];
    probe.style.color = "var(--muted)";
    const muted = getComputedStyle(probe).color;
    probe.remove();
    if (text === null || button === null || label === null) {
      return null;
    }
    const [at, next, name, look] = [text.getBoundingClientRect(), button.getBoundingClientRect(), label.getBoundingClientRect(), getComputedStyle(text)];
    return { text: text.textContent, gap: next.left - at.right, level: at.top + at.height / 2 - (next.top + next.height / 2), far: at.left - name.right, muted: look.color === muted, fontSize: look.fontSize };
  });
  t.check(
    "캐시에서 읽은 요약에는 토큰 수가 없고, 다시 만든 요약은 머리 줄의 오른쪽 끝 \"다시 생성\" 앞에 11px의 muted 글자로 \"입력 1.9k · 출력 840\"을 적는다",
    cached === 0 && usage !== null && usage.text === "입력 1.9k · 출력 840" && usage.gap >= 4 && usage.gap <= 12 && Math.abs(usage.level) <= 1.5 && usage.far > 20 && usage.muted && usage.fontSize === "11px",
    usage === null ? "토큰 수 없음" : `"${usage.text}", 버튼과의 틈 ${usage.gap.toFixed(1)}px, 세로 차이 ${usage.level.toFixed(1)}px, 구역 이름과의 틈 ${usage.far.toFixed(0)}px, ${usage.fontSize}`,
  );
  const tip = await tipOver(page, ".summary-usage");
  t.check("요약 칸의 토큰 수에 마우스를 올리면 말풍선이 \"캐시에서 읽은 입력 16k\"를 적는다", tip === "캐시에서 읽은 입력 16k", tip);
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF5("panel") });
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
    /** 코드 뷰어에서 위쪽 여백과 경계선을 뺀 높이 */
    room: await page.evaluate(() => {
      const viewer = document.querySelector(".info-panel .code");
      return viewer.clientHeight - parseFloat(getComputedStyle(viewer).paddingTop);
    }),
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
    near(lower.summary, start.summary + 140, 1.5) && near(lower.code, start.code - 140, 1.5) && sameRect(lower.panel, start.panel) && near(lower.editor, lower.room, 2),
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
      held.push({ node: new URL(request.url()).searchParams.get("node"), answer: (summary) => route.fulfill({ json: { summary, usage: null } }) });
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

/** hotfix 4의 사진. `hf4-{이름}.png`로 남긴다. */
const HF4 = (name) => join(OUT, `hf4-${name}.png`);
const HF6 = (name) => join(OUT, `hf6-${name}.png`);
const HF5 = (name) => join(OUT, `hf5-tokens-${name}.png`);
/** LLM 요약을 만드는 중인 노드의 도는 표시. 원이 있는 노드는 원 위의 고리, 상자는 왼쪽 위 모서리의 도는 원이다. */
const BUSY = ".badge-busy, .busy-ring";
/** 펼친 폴더 영역이 안에 든 노드의 요청을 세어 다는 도는 원을 뺀 도는 표시 */
const OWN_BUSY = ":not(.node-region) > .badge-busy, .busy-ring";

/**
 * id 노드의 원 위에서 도는 고리. 원과 같은 사각형인지(돌면서 화면 사각형이 바뀌므로 돌리기 전의 위치로 잰다), 도는지, 지금 돈 각도,
 * 진한 구간과 나머지 테두리의 색, 그 노드가 따로 단 도는 원의 수, 접근성 이름과 말풍선 글. 고리가 없으면 null이다.
 */
const ringOf = (page, id) =>
  page.evaluate((faceSel) => {
    const ring = document.querySelector(`${faceSel} .node-circle > .busy-ring`);
    if (ring === null) {
      return null;
    }
    const circle = ring.parentElement;
    const style = getComputedStyle(ring);
    const [cos, sin] = style.transform === "none" ? [1, 0] : style.transform.slice(7).split(",").map(Number);
    return {
      fits: ring.offsetLeft === 0 && ring.offsetTop === 0 && ring.offsetWidth === circle.offsetWidth && ring.offsetHeight === circle.offsetHeight,
      size: circle.offsetWidth,
      animated: style.animationName !== "none",
      angle: Math.round((Math.atan2(sin, cos) * 180) / Math.PI),
      arc: style.borderTopColor,
      rest: style.borderRightColor,
      corner: document.querySelectorAll(`${faceSel} .badge-busy`).length,
      label: ring.getAttribute("aria-label"),
      tip: ring.dataset.tip ?? "",
      title: ring.hasAttribute("title"),
      opacity: Number(getComputedStyle(ring.closest(".react-flow__node")).opacity),
    };
  }, face(id));
/** id 노드의 원과 이름표 둘레만 잘라 찍는다. */
const shootRing = async (page, id, path) => {
  const rect = await rectOf(page, `${face(id)} .node-circle`);
  await page.screenshot({ path, clip: { x: rect.x - 40, y: rect.y - 24, width: 260, height: 64 }, scale: "device" });
};

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
  const ringText = (ring) => (ring === null ? "고리 없음" : `원 ${ring.size}px, 고리가 원과 겹침 ${ring.fits}, 도는 중 ${ring.animated}, 따로 그린 도는 원 ${ring.corner}개, 진한 구간 ${ring.arc}, 나머지 ${ring.rest}`);
  await load(page);
  await pickInTree(page, target);
  await page.waitForSelector(".info-panel-summary .summary-make", { timeout: 10_000 });
  await page.click(".info-panel-summary .summary-make");
  await page.waitForSelector(`${face(target.id)} .busy-ring`, { timeout: 5_000 }).catch(() => {});
  await settle(page);
  const spinning = await ringOf(page, target.id);
  const ink = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = "var(--ink)";
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  t.check(
    '"요약 생성"을 누르면 그 함수의 지름 16px 원 위에서 고리가 돌고, 왼쪽 위 모서리에 따로 그린 도는 원은 없다',
    held.length === 1 && spinning !== null && spinning.fits && spinning.size === 16 && spinning.animated && spinning.corner === 0 && (await count(page, OWN_BUSY)) === 1,
    `POST ${held.length}번, ${ringText(spinning)}`,
  );
  t.check(
    "고리는 한 구간만 본문 잉크이고 나머지는 원의 테두리가 비치는 반투명 색이다",
    spinning !== null && spinning.arc === ink && spinning.rest !== ink && /rgba|\/ 0\.|color\(srgb .* \/ /.test(spinning.rest),
    ringText(spinning),
  );
  t.check(
    '고리는 접근성 이름 "요약을 만드는 중"과 말풍선 글을 담고 title 속성이 없다',
    spinning?.label === "요약을 만드는 중" && spinning.tip === "LLM 요약을 만드는 중 1개" && !spinning.title,
    `${spinning?.label} / ${spinning?.tip}`,
  );
  await shootRing(page, target.id, HF4("spin-light"));
  await page.waitForTimeout(240);
  const later = await ringOf(page, target.id);
  await shootRing(page, target.id, HF4("spin-light-2"));
  t.check("0.24초 뒤에는 진한 구간이 다른 각도에 있다", later !== null && later.angle !== spinning?.angle, `${spinning?.angle}° → ${later?.angle}°`);
  await t.shot();

  // 원 위에 커서를 올리면 고리의 말풍선이 뜬다.
  const circle = await rectOf(page, `${face(target.id)} .node-circle`);
  await page.mouse.move(5, 5);
  await page.mouse.move(circle.x + circle.width / 2 - 1, circle.y + circle.height / 2);
  await page.mouse.move(circle.x + circle.width / 2, circle.y + circle.height / 2);
  await page.waitForTimeout(500);
  const ringTip = await tipText(page);
  await shootRing(page, target.id, HF4("spin-hover"));
  t.check("도는 원에 커서를 올리면 고리의 말풍선이 뜬다", ringTip === "LLM 요약을 만드는 중 1개", `"${ringTip}"`);
  await page.mouse.move(5, 5);

  // 어두운 화면
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const darkRing = await ringOf(page, target.id);
  t.check("어두운 화면의 고리는 진한 구간이 밝은 본문 잉크다", darkRing !== null && darkRing.arc !== spinning?.arc && darkRing.corner === 0, ringText(darkRing));
  await shootRing(page, target.id, HF4("spin-dark"));
  await page.getByRole("button", { name: "밝은 화면" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme !== "dark");

  // 움직임을 줄이는 설정에서는 돌지 않고 진한 구간만 보인다.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const still = await ringOf(page, target.id);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  t.check("움직임을 줄이는 설정에서는 고리가 돌지 않고 진한 구간이 위쪽에 남는다", still !== null && !still.animated && still.angle === 0 && still.arc === ink, ringText(still));

  // 같은 파일의 다른 함수를 골라 요약을 만드는 중인 함수가 흐려져도 고리가 돈다.
  const siblings = functions.filter((n) => ownerOf(n).id === target.owner && n.id !== target.id).slice(0, 8);
  let dim = null;
  for (const sibling of siblings) {
    await pickInTree(page, { id: sibling.id, owner: target.owner });
    await settle(page);
    const ring = await ringOf(page, target.id);
    if (ring !== null && near(ring.opacity, DIM, 0.01)) {
      dim = ring;
      break;
    }
  }
  if (dim === null) {
    t.skip("흐린 함수 노드의 원 위에서도 고리가 돈다", `${target.owner}에서 고른 함수의 흐름 밖에 놓이는 경우를 찾지 못했다`);
  } else {
    await shootRing(page, target.id, HF4("spin-dim"));
    const label = await rectOf(page, `${face(target.id)} .node-label`);
    await page.mouse.move(label.x + label.width / 2 - 1, label.y + label.height / 2);
    await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
    await page.waitForTimeout(300);
    const lifted = await ringOf(page, target.id);
    await shootRing(page, target.id, HF4("spin-dim-hover"));
    await page.mouse.move(5, 5);
    t.check(
      `흐린 함수 노드(불투명도 ${DIM})의 원 위에서도 고리가 돌고, 커서를 올려 진하기가 한 단계 오른 동안에도 돈다`,
      dim.animated && dim.fits && dim.corner === 0 && lifted !== null && lifted.animated && lifted.opacity > DIM,
      `불투명도 ${dim.opacity} → 커서를 올리면 ${lifted?.opacity}`,
    );
  }
  await pickInTree(page, target);
  await settle(page);

  // 함수 시점 뷰에서도 그 함수의 원 위에서 고리가 돈다.
  await clickNode(page, target.id, 2);
  await page.waitForSelector(`${face(target.id)} .node-call .busy-ring`, { timeout: 30_000 }).catch(() => {});
  await settle(page);
  const called = await ringOf(page, target.id);
  t.check("함수 시점 뷰에서도 그 함수의 원 위에서 고리가 돌고 따로 그린 도는 원은 없다", called !== null && called.fits && called.animated && (await count(page, ".node-call .badge-busy")) === 0, ringText(called));
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForSelector(`${face(target.id)} .node-function .busy-ring`, { timeout: 30_000 }).catch(() => {});
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
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 1, OWN_BUSY, { timeout: 5_000 }).catch(() => {});

  if (extra === null) {
    t.skip("접힌 상자는 도는 원을 왼쪽 위에, 줄 수 배지를 오른쪽 위에 단다", "미확인 호출이 있는 파일이 없다");
  } else {
    await pickInTree(page, extra);
    await page.click(".info-panel-summary .summary-make");
    await pickInTree(page, { id: FUNCTION, owner: FILE });
    await page.waitForSelector(`${face(extra.owner)} .badge-busy`, { timeout: 5_000 }).catch(() => {});
    await settle(page);
    const both = await busyAt(page, extra.owner, node(extra.owner));
    /** 줄 수 배지가 상자의 오른쪽과 위로 나간 폭. 오른쪽은 배지의 폭이 정수가 아니면 offset 값이 1px 어긋나므로 계산된 `right`로 읽는다. */
    const mark = await page.evaluate((sel) => {
      const badge = document.querySelector(sel);
      return badge == null ? null : { right: -parseFloat(getComputedStyle(badge).right), above: -badge.offsetTop };
    }, `${face(extra.owner)} .badge-lines`);
    t.check(
      "접힌 상자는 도는 원을 왼쪽 위에, 줄 수 배지를 오른쪽 위에 단다",
      atCorner(both) && mark !== null && near(mark.right, 6, 0.5) && near(mark.above, 7, 0.5) && (await count(page, ":not(.node-region) > .badge-busy")) === 2,
      `도는 원 ${cornerText(both)}, 배지 ${mark === null ? "없음" : `오른쪽으로 ${mark.right.toFixed(1)}px, 위로 ${mark.above.toFixed(1)}px`}, 도는 원 ${await count(page, ":not(.node-region) > .badge-busy")}개`,
    );
    held[2].answer(longSummary(1));
  }
  held[0].answer(longSummary(1));
  await page.waitForFunction((sel) => document.querySelector(sel) === null, BUSY, { timeout: 5_000 }).catch(() => {});
  t.check("요약이 다 만들어지면 도는 원과 고리가 사라진다", (await count(page, BUSY)) === 0);
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

/** 코드 뷰어에 보이는 n번째 줄(1부터)의 화면 사각형. Monaco가 뷰어 위쪽 밖에 미리 그려 둔 줄은 세지 않는다. */
const codeLine = (page, n) =>
  page.evaluate((index) => {
    const top = document.querySelector(".info-panel .monaco-editor").getBoundingClientRect().top;
    const lines = [...document.querySelectorAll(".info-panel .monaco-editor .view-line")]
      .filter((line) => line.getBoundingClientRect().top >= top - 1)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
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
    // 요약 칸이 요약의 상태를 받아 높이가 정해진 뒤에 코드 줄의 위치를 잰다.
    await page.waitForFunction(() => {
      const summary = document.querySelector(".info-panel-summary");
      const hints = [...(summary?.querySelectorAll(".info-panel-hint") ?? [])];
      return summary !== null && (summary.querySelector(".summary-action, .summary-text") !== null || hints.some((hint) => hint.textContent.trim() !== ""));
    });
    await page.waitForTimeout(200);
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

/**
 * 요약을 실제로 만들지 않고 "요약 생성" 버튼과 "자동 요약" 토글이 POST를 언제 보내는지만 본다. GET /api/summary에는 서버 대신
 * 요약이 없고 만들 수 있다고 답하고, 보낸 POST는 붙잡혀 서버에 닿지 않는다.
 */
async function summaryAsk(t, page) {
  const graph = await api("/api/graph");
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ownerOf = (n) => (n.kind === "module" || n.parent === null ? n : ownerOf(byId.get(n.parent)));
  const [first, second] = graph.nodes.filter((n) => n.kind === "function" && !n.test).slice(0, 2).map((n) => ({ id: n.id, owner: ownerOf(n).id }));
  await answerSummaryReads(page, () => ({ summary: null, stale: false, available: true, reason: null }));
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
  const around = crossing(await api("/api/graph"), "parser");
  t.check(
    "정보 구역의 나가는 연결과 들어오는 연결이 parser/ 폴더의 경계를 넘는 선의 코드 줄 수와 같다",
    head.includes(`나가는 연결 ${linksWords(around.out).text}`) && head.includes(`들어오는 연결 ${linksWords(around.into).text}`),
    head.replaceAll("\n", " / "),
  );
}

/** 파일트리에서 그래프 노드가 없는 __init__.py 행을 누른다. */
async function initFile(t, page) {
  await load(page);
  await pick(page, FILE);
  const row = '.tree-row.tree-file[data-full$="parser/__init__.py"]';
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

  // 선택 없이 연 파일은 그래프 바탕을 눌러도 닫히지 않고, Esc를 누르거나 그 파일이 든 폴더를 접으면 닫힌다.
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
  await page.waitForTimeout(600);
  const stayed = (await count(page, ".info-panel .code")) === 1;
  await page.keyboard.press("Escape");
  await page.waitForSelector(".info-panel .code", { state: "detached", timeout: 5_000 }).catch(() => {});
  t.check("선택 없이 연 파일은 그래프 바탕을 눌러도 닫히지 않고 Esc에 닫힌다", opened && stayed && (await count(page, ".info-panel .code")) === 0, (await headOf(page)).replaceAll("\n", " / "));
  await page.click(row);
  await page.waitForSelector(".info-panel .code", { timeout: 10_000 }).catch(() => {});
  await page.click('.tree-row.tree-dir[data-node="parser"]');
  await page.waitForSelector(".info-panel .code", { state: "detached", timeout: 5_000 }).catch(() => {});
  t.check("연 파일이 든 폴더를 접으면 닫힌다", (await count(page, row)) === 0 && (await count(page, ".info-panel .code")) === 0, (await headOf(page)).replaceAll("\n", " / "));

  // 소스 루트의 __init__.py는 모듈 노드가 있으므로 그 행이 그래프의 상자를 고른다.
  const root = '.tree-row.tree-file[data-full="src/__init__.py"]';
  await page.click(root);
  await waitSelected(page, "__init__").catch(() => {});
  t.check(
    "소스 루트의 __init__.py 행을 누르면 그래프의 __init__.py 상자가 선택되고 그 행이 고른 행이 된다",
    (await selectedOf(page)) === "__init__" && (await page.evaluate((sel) => document.querySelector(sel)?.classList.contains("active") === true, root)),
    `선택 ${await selectedOf(page)}`,
  );
}

/** 상단 줄 오른쪽 칸에 그린 요소의 이름. 버튼은 접근성 이름이나 글자다. 새로고침 버튼이 이름 뒤에 적는 상태는 뺀다. */
const toolsOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".toolbar-tools > *")].map((element) => {
      const button = element.matches("button") ? element : element.querySelector("button");
      return (button?.getAttribute("aria-label") ?? element.textContent.trim()).split(" · ")[0];
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
      entries: root.querySelectorAll('[data-node], [role="menuitem"]').length,
      text: root.textContent,
    };
  });
  t.check(
    "필터 버튼을 누르면 보기 설정 구역에 흐름 단계, 분석 표시, 토글 세 개가 있는 창이 열린다",
    same(panel.titles, ["보기 설정", "레포 정보"]) && same(panel.view, ["흐름 단계2", "분석 표시", "테스트 코드", "외부 노드", "자동 요약"]) && same(panel.options, ["none", "cycles", "unused"]),
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
  t.check("필터 창에 진입점 목록이 없다", entries.length > 0 && panel.entries === 0 && !panel.text.includes("진입점"), `노드 항목 ${panel.entries}개`);
  await t.shot();

  // 보기 설정을 바꿔도 창이 닫히지 않고 필터 버튼이 바꾼 설정의 수를 적는다.
  const filters = page.locator(".filter-panel");
  await filters.getByLabel("테스트 코드").check();
  await filters.getByLabel("자동 요약").check();
  await filters.locator('input[type="range"]').fill("3");
  await page.click('.overlay-option[data-kind="unused"]');
  await rest(page);
  const changed = ["흐름 단계 3", "미사용 후보 표시", "테스트 코드", "자동 요약"];
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

  // 노드를 고른 채로 창 밖을 누르거나 Esc를 누르면 창만 닫힌다.
  await page.click(".toolbar-entries");
  await page.click(`.menu-item[data-node="${entries.at(-1)}"]`);
  await waitSelected(page, entries.at(-1)).catch(() => {});
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
      await page.waitForSelector(".reload-dot", { timeout: 10_000 }).catch(() => {});
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
          cut: document.querySelector(".trail-cut")?.dataset.tip ?? null,
          stale: document.querySelector(".reload-dot") !== null,
          gaps: [panel.top - stage.top, stage.bottom - panel.bottom, stage.top - area.bottom, Math.round(stage.width * 0.01)],
          filters: filters === undefined ? null : { inside: filters.left >= area.left && filters.right <= Math.min(area.right, window.innerWidth) && filters.bottom <= window.innerHeight },
        };
      });
    const bar = await read();
    t.check(
      `${name}: 상단 줄이 한 줄이고 ${["뒤로", "앞으로", ...TOOLS].join("·")} 버튼이 모두 창 안에서 가운데 점으로 눌린다`,
      bar.height < 40 && bar.fits && bar.missed.length === 0 && ["뒤로", "앞으로", ...TOOLS].every((title) => bar.controls.some((name) => name === title || name.startsWith(`${title} · `))) && bar.stale === stale,
      `상단 줄 ${bar.width}×${bar.height}, 눌리지 않는 요소 ${bar.missed.join("·") || "없음"}, 요소 ${bar.controls.join("·")}`,
    );
    t.check(
      `${name}: 탐색 경로의 마지막 단계가 상단 줄 안에 보이고, 폭이 모자라면 앞 단계부터 줄인다`,
      bar.last !== null && bar.last.text === NARROW.label && bar.last.inside && (bar.last.whole || bar.cut !== null || bar.last.width > 0),
      `마지막 단계 "${bar.last?.text}" ${bar.last?.width}px${bar.last?.whole ? "" : "(말줄임)"}, 줄인 단계 "${bar.cut ?? "없음"}"`,
    );
    t.check(
      `${name}: 관계 그래프 영역이 상단 줄 바로 아래에서 시작하고 정보 패널이 영역의 위·아래 끝에서 영역 폭의 1%씩 띄운다`,
      near(bar.gaps[2], 0) && near(bar.gaps[0], bar.gaps[3]) && near(bar.gaps[1], bar.gaps[3]),
      `패널 위 ${bar.gaps[0]}, 아래 ${bar.gaps[1]}, 기대 여백 ${bar.gaps[3]}, 상단 줄과 영역 사이 ${bar.gaps[2]}`,
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
 * 새로고침과 화면 초기화. 고정 레포의 임시 복사본에서 폴더를 펴고 보기 설정과 선택을 바꾼 뒤 파일에 함수를 더하고 새로고침을 눌러,
 * 분석하는 동안의 표시와 끝난 뒤에 보던 화면이 그대로인지를 본다. 고른 함수를 지운 뒤, 함수 시점 뷰에서도 새로고침하고,
 * "화면 초기화"로 레포를 처음 연 화면에 돌아가는지 본다. 더한 함수는 시나리오가 끝날 때 지운다.
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
  const folders = ["app.plugins", "tests"];
  const buttonOf = () =>
    page.evaluate(() => {
      const button = document.querySelector(".reload-button");
      return { text: button.getAttribute("aria-label"), busy: button.getAttribute("aria-busy"), spin: button.querySelector(".reload-spin") !== null, stale: button.querySelector(".reload-dot") !== null };
    });
  const viewport = () => page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform);
  const numbers = (transform) => (transform.match(/-?[\d.]+/g) ?? []).map(Number);
  const corner = (id) => page.evaluate((selector) => (({ left, top }) => [left, top])(document.querySelector(selector).getBoundingClientRect()), node(id));
  /** 보던 화면. 보기 설정, 선택, 펼친 폴더, 뷰, 확대 비율, 파일트리 검색어다. */
  const seen = async () => ({
    ...(await inFilters(page, async () => {
      const filters = page.locator(".filter-panel");
      return {
        tests: await filters.getByLabel("테스트 코드").isChecked(),
        auto: await filters.getByLabel("자동 요약").isChecked(),
        depth: await filters.locator('input[type="range"]').inputValue(),
        overlay: (await overlayOptions(page)).find((option) => option.checked)?.kind,
      };
    })),
    selected: await selectedOf(page),
    regions: await page.evaluate(() => [...document.querySelectorAll(".react-flow__node > .node-region")].map((region) => region.parentElement.dataset.id).sort()),
    lineage: await count(page, ".trail-view"),
    zoom: numbers(await viewport())[2],
    query: await page.inputValue(".tree-search-input"),
  });
  /** 다시 분석하는 요청. 붙잡아 두었다가 continue를 부르면 서버로 보낸다. */
  const posts = [];
  let failing = false;
  await page.route(
    (at) => at.pathname === "/api/reload",
    (route) => (failing ? route.fulfill({ status: 500, json: { error: "다시 분석하지 못했다: 분석이 멈췄다" } }) : void posts.push(route)),
  );
  /** 새로고침을 누르고 분석이 끝나 새 배치가 멈출 때까지 기다린다. */
  const refresh = async () => {
    const revision = (await api("/api/status", reloadUrl)).revision;
    await page.click(".reload-button");
    await page.waitForFunction(() => document.querySelector(".reload-button").getAttribute("aria-busy") === "true", null, { timeout: 5_000 }).catch(() => {});
    await posts.at(-1).continue();
    await page.waitForFunction(() => document.querySelector(".reload-button").getAttribute("aria-busy") === "false", null, { timeout: 120_000 });
    await page.waitForSelector(".react-flow__node", { timeout: 60_000 });
    await settle(page);
    return (await api("/api/status", reloadUrl)).revision - revision;
  };
  try {
    await load(page, reloadUrl, false);
    const home = await viewport();
    const boxed = Object.keys(await flowBoxes(page)).length;

    // 화면 색, 범례, 보기 설정을 바꾸고 폴더 둘을 펴고 함수를 고른 뒤 화면을 확대한다.
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
    for (const folder of folders) {
      await openFolder(page, folder);
    }
    await pickInTree(page, { id: target, owner: file });
    await page.mouse.move(600, 500);
    await page.mouse.wheel(0, -300);
    await settle(page);
    appendFileSync(core, "\n\ndef added():\n    return helper(1)\n");
    await page.waitForSelector(".reload-button .reload-dot", { timeout: 10_000 }).catch(() => {});
    await page.mouse.move(0, 0);
    await page.hover(".reload-button");
    await page.waitForSelector(".tooltip", { timeout: 5_000 }).catch(() => {});
    const tip = await page.evaluate(() => document.querySelector(".tooltip")?.textContent.split("\n") ?? []);
    const idle = await buttonOf();
    t.check(
      "파일을 고치면 새로고침 버튼에 점이 생기고 접근성 이름과 말풍선이 바뀐 파일 수를, 말풍선이 파일 경로를 적는다",
      idle.text === "새로고침 · 분석 뒤 바뀐 파일 1개" && idle.stale && idle.busy === "false" && same(tip, [`분석 뒤 바뀐 파일 1개 · 새로고침 ${MOD_R}`, "  src/app/core.py"]),
      `버튼 "${idle.text}", 말풍선 ${tip.join(" / ")}`,
    );

    await page.click(".reload-button");
    await page.waitForFunction(() => document.querySelector(".reload-button").getAttribute("aria-busy") === "true", null, { timeout: 5_000 }).catch(() => {});
    const busy = await buttonOf();
    await page.click(".reload-button", { force: true });
    await page.waitForTimeout(300);
    t.check(
      "새로고침을 누르면 버튼이 점 없이 도는 원을 그리고 접근성 이름이 \"분석 중\"을 적으며, 그동안 다시 눌러도 요청을 한 번만 보낸다",
      busy.text === "새로고침 · 분석 중" && busy.spin && !busy.stale && busy.busy === "true" && posts.length === 1,
      `버튼 "${busy.text}", POST ${posts.length}번`,
    );
    await page.click(`.tree-row.tree-file[data-node="app.models"]`);
    await waitSelected(page, "app.models").catch(() => {});
    t.check("분석하는 동안 앞의 그래프에서 다른 노드를 고를 수 있다", (await selectedOf(page)) === "app.models" && (await count(page, `.tree-row[data-node="${added}"]`)) === 0, `선택 ${await selectedOf(page)}`);
    await pickInTree(page, { id: target, owner: file });
    await page.fill(".tree-search-input", "help");
    await settle(page);
    const before = { ...(await seen()), at: await corner(target), back: await page.getByRole("button", { name: "뒤로" }).isDisabled() };
    await t.shot();

    await posts[0].continue();
    await page.waitForFunction(() => document.querySelector(".reload-button").getAttribute("aria-busy") === "false", null, { timeout: 120_000 });
    await page.waitForSelector(".react-flow__node", { timeout: 60_000 });
    await settle(page);
    const done = await buttonOf();
    const fresh = await api("/api/repo", reloadUrl);
    const stats = await inFilters(page, () => page.evaluate(() => document.querySelector(".filter-stats").textContent));
    t.check(
      "분석이 끝나면 버튼이 새로고침 기호로 돌아오고 점이 사라지며 레포 정보가 새 분석 결과의 수를 적는다",
      done.text === "새로고침" && !done.stale && !done.spin && fresh.stats.nodes === repo.stats.nodes + 1 && stats.includes(`노드 ${fresh.stats.nodes} `),
      `버튼 "${done.text}", ${stats}`,
    );
    const after = { ...(await seen()), at: await corner(target), back: await page.getByRole("button", { name: "뒤로" }).isDisabled() };
    t.check(
      "새로고침 뒤에 보기 설정, 고른 함수, 펼친 폴더, 확대 비율, 탐색 이력, 파일트리 검색어가 그대로다",
      same({ ...after, at: null }, { ...before, at: null }) && after.tests && after.auto && after.depth === "3" && after.overlay === "unused" && after.selected === target && folders.every((folder) => after.regions.includes(folder)) && !after.back,
      JSON.stringify({ ...after, at: undefined }),
    );
    t.check(
      "고른 함수의 왼쪽 위 모서리가 새로고침 앞과 같은 화면 좌표에 있다",
      near(after.at[0], before.at[0], 1) && near(after.at[1], before.at[1], 1),
      `앞 ${before.at.map(Math.round).join(", ")}, 뒤 ${after.at.map(Math.round).join(", ")}`,
    );
    t.check(
      "화면 색과 범례의 펼침은 그대로다",
      (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark" && (await count(page, ".legend")) === 1,
      `화면 색 ${await page.evaluate(() => document.documentElement.dataset.theme)}, 범례 ${await count(page, ".legend")}개`,
    );
    await page.fill(".tree-search-input", "");
    await page.waitForSelector(`.tree-row.tree-symbol[data-node="${added}"]`, { timeout: 10_000 }).catch(() => {});
    await page.click(`.tree-row.tree-symbol[data-node="${added}"]`).catch(() => {});
    await waitSelected(page, added).catch(() => {});
    await page.waitForSelector(".info-panel .monaco-editor .view-line", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(500);
    const shownCode = await page.evaluate(() => [...document.querySelectorAll(".info-panel .monaco-editor .view-line")].map((line) => line.textContent.replaceAll(" ", " ")).join("\n"));
    t.check(
      "새 그래프에 더한 함수 added()가 있고 코드 뷰어가 고친 파일의 본문을 보인다",
      (await selectedOf(page)) === added && shownCode.includes("def added():") && (await count(page, `${node(added)}`)) === 1,
      `선택 ${await selectedOf(page)}`,
    );

    // 고른 함수를 지우고 새로고침하면 선택만 풀린다.
    const picked = await seen();
    writeFileSync(core, source);
    const dropped = await refresh();
    const gone = await seen();
    t.check(
      "고른 함수를 지운 뒤 새로고침하면 선택만 풀리고 보기 설정, 펼친 폴더, 확대 비율은 그대로다",
      dropped === 1 && gone.selected === null && (await count(page, node(added))) === 0 && same({ ...gone, selected: null }, { ...picked, selected: null }),
      `판 번호 +${dropped}, ${JSON.stringify(gone)}`,
    );
    await page.getByRole("button", { name: "뒤로" }).click();
    await waitSelected(page, target).catch(() => {});
    t.check("뒤로 가면 지운 함수를 고르기 전의 선택으로 돌아간다", (await selectedOf(page)) === target, `선택 ${await selectedOf(page)}`);

    // 함수 시점 뷰에서 새로고침하면 그 뷰에 머문다.
    await clickNode(page, target, 2);
    await page.waitForSelector(".trail-view", { timeout: 10_000 });
    await settle(page);
    const calls = await count(page, ".node-call");
    appendFileSync(core, "\n\ndef added():\n    return helper(1)\n");
    const grown = await refresh();
    await page.waitForSelector(node(added), { timeout: 10_000 }).catch(() => {});
    await settle(page);
    const lineage = await seen();
    t.check(
      "함수 시점 뷰에서 새로고침하면 그 뷰에 머물고 가운데 함수를 부르는 새 함수가 그려진다",
      grown === 1 && lineage.lineage === 1 && lineage.selected === target && (await count(page, `${node(added)} .node-call`)) === 1 && lineage.tests && lineage.depth === "3",
      `판 번호 +${grown}, 뷰 표시 ${lineage.lineage}개, 선택 ${lineage.selected}, 노드 ${calls}개 → ${await count(page, ".node-call")}개`,
    );

    // 화면 초기화. 테스트 코드 토글을 꺼 처음 화면과 같은 조건에서 본다.
    await inFilters(page, () => page.locator(".filter-panel").getByLabel("테스트 코드").uncheck());
    await settle(page);
    await page.getByRole("button", { name: "화면 초기화" }).click();
    await page.waitForFunction(() => document.querySelector(".trail-view") === null, null, { timeout: 10_000 }).catch(() => {});
    await settle(page);
    const reset = await seen();
    const now = numbers(await viewport());
    const first = numbers(home);
    t.check(
      "화면 초기화를 누르면 구조 뷰로 돌아가 선택이 풀리고 폴더가 처음 연 상태로 접히며 화면이 레포를 연 처음 화면에 맞춰진다",
      reset.lineage === 0 && reset.selected === null && (await count(page, ".trail-step")) === 0 && (await count(page, ".react-flow__node .node-body.node-function")) === 0 && Object.keys(await flowBoxes(page)).length === boxed && now.length === 3 && now.every((n, i) => near(n, first[i], 1)),
      `선택 ${reset.selected}, 상자 ${Object.keys(await flowBoxes(page)).length}개(처음 ${boxed}개), 화면 ${now.join(", ")}(처음 ${first.join(", ")})`,
    );
    t.check(
      "화면 초기화는 보기 설정과 파일트리 검색어, 화면 색을 바꾸지 않는다",
      !reset.tests && reset.auto && reset.depth === "3" && reset.overlay === "unused" && (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark",
      JSON.stringify(reset),
    );
    await page.getByRole("button", { name: "뒤로" }).click();
    await page.waitForSelector(".trail-view", { timeout: 10_000 }).catch(() => {});
    await settle(page);
    const undone = await seen();
    t.check("뒤로 가면 초기화하기 전의 함수 시점 뷰와 선택이 되살아난다", undone.lineage === 1 && undone.selected === target, `뷰 표시 ${undone.lineage}개, 선택 ${undone.selected}`);
    await page.getByRole("button", { name: "앞으로" }).click();
    await page.waitForFunction(() => document.querySelector(".trail-view") === null, null, { timeout: 10_000 }).catch(() => {});
    await settle(page);

    // 다시 분석하지 못하면 화면을 바꾸지 않고 까닭을 적는다.
    await page.click(`.tree-row.tree-file[data-node="${file}"]`);
    await waitSelected(page, file).catch(() => {});
    failing = true;
    t.expected.push("status of 500");
    await page.click(".reload-button");
    await page.waitForSelector(".reload-error", { timeout: 10_000 }).catch(() => {});
    const error = await page.evaluate(() => document.querySelector(".reload-error")?.textContent ?? null);
    const kept = (await selectedOf(page)) === file && (await buttonOf()).text === "새로고침";
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

/**
 * 새로고침 단축키. 고정 레포의 임시 복사본에서 그래프, 코드 뷰어, 파일트리 검색 칸에 초점을 둔 채 Mod+R을 눌러 다시 분석하는 요청과
 * 페이지 다시 읽기를 본다. 페이지를 다시 읽었는지는 page의 load 이벤트 수와 window에 심은 표식으로 본다.
 */
async function reloadKey(t, page) {
  const [file, target] = ["app.core", "app.core:helper"];
  /** 다시 분석하는 요청. 붙잡아 두었다가 서버로 보낸다. */
  const posts = [];
  await page.route((at) => at.pathname === "/api/reload", (route) => void posts.push(route));
  let loads = 0;
  await load(page, reloadUrl);
  page.on("load", () => void loads++);
  await page.evaluate(() => void (window.__shotsKept = true));
  const busy = () => page.evaluate(() => document.querySelector(".reload-button").getAttribute("aria-busy"));
  const waitBusy = (value) => page.waitForFunction((want) => document.querySelector(".reload-button").getAttribute("aria-busy") === want, value, { timeout: value === "true" ? 5_000 : 120_000 }).catch(() => {});
  /** Mod+R을 누르고 요청 수, 버튼, 페이지를 다시 읽었는지를 읽은 뒤 붙잡은 요청을 보내 분석을 끝낸다. during은 분석하는 동안 부른다. */
  const press = async (during = async () => {}) => {
    const before = posts.length;
    await page.evaluate(() => void (window.__shotsKeys.length = 0));
    await page.keyboard.press(`${MOD}+r`);
    await waitBusy("true");
    await page.waitForTimeout(300);
    const key = await page.evaluate(() => window.__shotsKeys.find((each) => each.key.toLowerCase() === "r"));
    const state = { sent: posts.length - before, busy: await busy(), prevented: key?.prevented ?? null, kept: await page.evaluate(() => window.__shotsKept === true), loads };
    const extra = await during();
    await posts.at(-1)?.continue();
    await waitBusy("false");
    await page.waitForSelector(".react-flow__node", { timeout: 60_000 });
    await settle(page);
    return { ...state, ...extra };
  };
  const once = (state) => state.sent === 1 && state.busy === "true" && state.prevented === true && state.kept && state.loads === 0;

  const tip = await (async () => {
    await page.hover(".reload-button");
    await page.waitForSelector(".tooltip", { timeout: 5_000 }).catch(() => {});
    return page.evaluate(() => ({ lines: document.querySelector(".tooltip")?.textContent.split("\n") ?? [], title: document.querySelector(".reload-button").hasAttribute("title") }));
  })();
  t.check(
    "새로고침 버튼의 말풍선이 첫 줄에 단축키를 적는다",
    tip.lines[0] === `새로고침 ${MOD_R}` && !tip.title,
    tip.lines[0],
  );

  await page.mouse.click(600, 500);
  const onGraph = await press(async () => {
    const before = posts.length;
    await page.keyboard.press(`${MOD}+r`);
    await page.waitForTimeout(300);
    return { again: posts.length - before };
  });
  t.check(
    "그래프에 초점이 있을 때 Mod+R을 누르면 다시 분석하는 요청을 한 번 보내고 페이지를 다시 읽지 않는다",
    once(onGraph),
    JSON.stringify(onGraph),
  );
  t.check("분석하는 동안 Mod+R을 다시 눌러도 요청을 더 보내지 않는다", onGraph.again === 0, `더 보낸 요청 ${onGraph.again}번`);

  await pickInTree(page, { id: target, owner: file });
  await page.waitForSelector(".info-panel .monaco-editor .view-line", { timeout: 30_000 });
  await settle(page);
  await page.click(".info-panel .monaco-editor .view-line");
  await page.waitForTimeout(200);
  const inCode = await page.evaluate(() => document.activeElement?.closest(".monaco-editor") != null);
  const onCode = await press();
  t.check("코드 뷰어에 커서가 있을 때 Mod+R을 누르면 요청을 한 번 보내고 페이지를 다시 읽지 않는다", inCode && once(onCode), `포커스가 코드 뷰어에 있음 ${inCode}, ${JSON.stringify(onCode)}`);

  await page.click(".tree-search-input");
  await page.keyboard.type("help");
  const onSearch = await press(async () => ({ typed: await page.inputValue(".tree-search-input") }));
  t.check(
    "파일트리 검색 칸에 초점이 있을 때 Mod+R을 누르면 요청을 한 번 보내고 페이지를 다시 읽지 않으며 글자를 넣지 않는다",
    once(onSearch) && onSearch.typed === "help",
    JSON.stringify(onSearch),
  );

  // 열려 있던 팔레트, 필터 창, 진입점 메뉴는 새로고침이 시작될 때 닫힌다.
  const shown = () =>
    page.evaluate(() => ({
      palette: document.querySelectorAll(".palette").length,
      filters: document.querySelectorAll(".filter-panel").length,
      menu: document.querySelectorAll(".menu").length,
    }));
  await page.keyboard.press(`${MOD}+k`);
  await page.waitForSelector(".palette", { timeout: 5_000 }).catch(() => {});
  const inPalette = await press(async () => ({ shown: await shown() }));
  await page.click(".filter-button");
  const opened = { filters: (await shown()).filters };
  const inFilter = await press(async () => ({ shown: await shown() }));
  await page.click(".toolbar-entries");
  await page.waitForSelector(".menu", { timeout: 5_000 }).catch(() => {});
  opened.menu = (await shown()).menu;
  const inMenu = await press(async () => ({ shown: await shown() }));
  t.check(
    "팔레트, 필터 창, 진입점 메뉴가 열려 있을 때 Mod+R을 누르면 그 창을 닫고 요청을 한 번 보낸다",
    once(inPalette) && inPalette.shown.palette === 0 && opened.filters === 1 && once(inFilter) && inFilter.shown.filters === 0 && opened.menu === 1 && once(inMenu) && inMenu.shown.menu === 0,
    `팔레트 ${JSON.stringify(inPalette)}, 필터 창 ${JSON.stringify(inFilter)}, 메뉴 ${JSON.stringify(inMenu)}, 열림 ${JSON.stringify(opened)}`,
  );

  // Mod+Shift+R은 받지 않는다.
  const before = posts.length;
  await page.evaluate(() => void (window.__shotsKeys.length = 0));
  await page.keyboard.press(`${MOD}+Shift+r`);
  await page.waitForTimeout(500);
  const hard = await page.evaluate(() => window.__shotsKeys.find((each) => each.key.toLowerCase() === "r") ?? null).catch(() => null);
  t.check(
    "Mod+Shift+R은 화면이 막지 않고 다시 분석하는 요청을 보내지 않는다",
    hard !== null && hard.prevented === false && posts.length === before,
    `${JSON.stringify(hard)}, 요청 ${posts.length - before}번, load ${loads}번`,
  );
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
      button: { text: button.getAttribute("aria-label"), busy: button.getAttribute("aria-busy"), spin: button.querySelector(".reload-spin") !== null, mark: button.querySelector(".reload-mark") !== null },
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
    "새로고침 버튼이 도는 원을 그리고 접근성 이름이 단계 이름을, 말풍선이 진행 수를 적으며, 눌러도 요청을 보내지 않는다",
    resolve.button.text === "새로고침 · 호출 대상 확인" && resolve.button.spin && !resolve.button.mark && resolve.button.busy === "true" && tip === "레포를 분석하는 중 · 끝나면 그래프를 그린다\n호출 대상 확인 12,000 / 19,292" && posts.length === 0,
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
 * 변경 감지. 고정 레포의 임시 복사본에서 파일을 내용이 같게 저장하고, 고치고, 새 파일을 만들면서 새로고침 버튼의 점과 접근성 이름,
 * 말풍선을 본다. 다시 분석은 버튼을 누를 때만 한다. 고친 파일과 만든 파일은 시나리오가 끝날 때 되돌린다.
 * 사진은 `hf5-reload-{idle,stale,stale-dark,narrow}.png`에 남긴다.
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
      const rect = (element) => (({ left, top, right, bottom, width, height }) => ({ left, top, right, bottom, width, height }))(element.getBoundingClientRect());
      const button = document.querySelector(".reload-button");
      const [mark, dot, filter] = [button.querySelector(".reload-mark"), button.querySelector(".reload-dot"), document.querySelector(".filter-button")];
      return {
        name: button.getAttribute("aria-label"),
        text: button.textContent,
        title: button.hasAttribute("title"),
        stale: button.hasAttribute("data-stale"),
        box: rect(button),
        filter: rect(filter),
        border: [getComputedStyle(button).border, getComputedStyle(filter).border],
        dot: dot === null ? null : { ...rect(dot), color: getComputedStyle(dot).backgroundColor, radius: getComputedStyle(dot).borderRadius },
        stroke: mark === null ? null : getComputedStyle(mark).stroke,
        ink: getComputedStyle(button).color,
        busy: button.getAttribute("aria-busy"),
        order: [...document.querySelectorAll(".toolbar-tools button")].map((each) => each.getAttribute("aria-label") ?? each.textContent),
      };
    });
  const tipLines = async () => {
    await page.mouse.move(0, 0);
    await page.hover(".reload-button");
    await page.waitForSelector(".tooltip", { timeout: 5_000 }).catch(() => {});
    return (await tipText(page)).split("\n");
  };
  /** 상단 줄의 오른쪽 칸을 찍는다. */
  const snap = async (name) => {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    const tools = await page.evaluate(() => (({ left, top, width, height }) => ({ x: Math.max(left - 120, 0), y: 0, width: width + 128, height: top + height + 12 }))(document.querySelector(".toolbar-tools").getBoundingClientRect()));
    await page.screenshot({ path: join(OUT, `hf5-reload-${name}.png`), clip: tools });
  };
  const revisionOf = async () => (await api("/api/status", reloadUrl)).revision;
  try {
    await load(page, reloadUrl, false);
    const revision = await revisionOf();
    const calm = await markOf();
    const calmTip = await tipLines();
    t.check(
      "새로고침 버튼은 글자 없이 기호만 그리고 접근성 이름이 있으며 title 속성을 쓰지 않는다",
      calm.text === "" && calm.name === "새로고침" && !calm.title && calm.stroke === calm.ink,
      `글자 "${calm.text}", 접근성 이름 "${calm.name}"`,
    );
    t.check(
      "새로고침 버튼이 필터 버튼의 바로 오른쪽에 같은 크기와 테두리로 놓이고 그 뒤에 글자 버튼이 온다",
      same(calm.order, TOOLS) && near(calm.box.width, calm.filter.width, 0.5) && near(calm.box.height, calm.filter.height, 0.5) && near(calm.box.top, calm.filter.top, 0.5) && near(calm.box.left - calm.filter.right, 12, 0.5) && calm.border[0] === calm.border[1],
      `순서 ${calm.order.join("·")}, 새로고침 ${calm.box.width}×${calm.box.height}, 필터 ${calm.filter.width}×${calm.filter.height}, 틈 ${calm.box.left - calm.filter.right}`,
    );
    t.check(
      "바뀐 파일이 없으면 점이 없고 말풍선이 새로고침과 단축키, 하는 일을 적는다",
      !calm.stale && calm.dot === null && same(calmTip, [`새로고침 ${MOD_R}`, "레포를 다시 분석해 그래프를 바꾸고 보던 화면은 그대로 둔다"]),
      calmTip.join(" / "),
    );
    await snap("idle");

    // 내용이 같은 저장은 표시하지 않는다.
    writeFileSync(core, source);
    await page.waitForTimeout(WITHIN + 1_000);
    const saved = await markOf();
    t.check("내용이 같게 저장한 파일은 표시하지 않는다", !saved.stale && saved.dot === null, `접근성 이름 "${saved.name}"`);

    appendFileSync(core, "\n\ndef added():\n    return helper(1)\n");
    const wrote = Date.now();
    await page.waitForSelector(".reload-button[data-stale]", { timeout: 15_000 }).catch(() => {});
    const took = Date.now() - wrote;
    const one = await markOf();
    const critical = (await colorOf(page, "--critical")).rgb;
    t.check(
      `파일을 고치면 ${WITHIN / 1000}초 안에 버튼의 오른쪽 위 모서리에 critical 색의 6px 점이 생기고 기호의 색은 그대로다`,
      one.stale && one.dot !== null && one.dot.color === critical && near(one.dot.width, 6, 0.1) && near(one.dot.height, 6, 0.1) && one.dot.radius === "50%" && near((one.dot.left + one.dot.right) / 2, one.box.right, 1) && near((one.dot.top + one.dot.bottom) / 2, one.box.top, 1) && one.text === "" && one.stroke === one.ink && took <= WITHIN,
      `${(took / 1000).toFixed(2)}초 뒤, 점 ${JSON.stringify(one.dot)}, 버튼 오른쪽 위 ${one.box.right}, ${one.box.top}`,
    );
    const first = await tipLines();
    t.check(
      "접근성 이름과 말풍선의 첫 줄이 바뀐 파일 수를 적고 말풍선이 그 아래에 경로를 적는다",
      one.name === "새로고침 · 분석 뒤 바뀐 파일 1개" && same(first, [`분석 뒤 바뀐 파일 1개 · 새로고침 ${MOD_R}`, "  src/app/core.py"]),
      `접근성 이름 "${one.name}", 말풍선 ${first.join(" / ")}`,
    );
    await t.shot();

    // 필터의 수와 새로고침의 점이 나란히 있는 화면
    await inFilters(page, () => page.locator(".filter-panel").locator('input[type="range"]').fill("3"));
    const both = await page.evaluate(() => {
      const [count, dot] = [document.querySelector(".filter-count"), document.querySelector(".reload-dot")];
      return count === null || dot === null ? null : { count: count.textContent, countWidth: count.getBoundingClientRect().width, countColor: getComputedStyle(count).backgroundColor, dotText: dot.textContent, dotWidth: dot.getBoundingClientRect().width, dotColor: getComputedStyle(dot).backgroundColor };
    });
    t.check(
      "필터 버튼의 수는 숫자를 적은 잉크 색 배지이고 새로고침의 점은 숫자 없는 critical 색 점이다",
      both !== null && both.count === "1" && both.dotText === "" && both.countColor !== both.dotColor && both.countWidth >= 14 && near(both.dotWidth, 6, 0.1),
      JSON.stringify(both),
    );
    await snap("stale");

    extras.forEach((path, index) => writeFileSync(path, `def fresh_${index + 1}():\n    return ${index + 1}\n`));
    await page.waitForFunction(() => document.querySelector(".reload-button").getAttribute("aria-label").includes("7개"), null, { timeout: 15_000 }).catch(() => {});
    const many = await tipLines();
    t.check(
      "바뀐 파일이 일곱 개여도 점은 하나이고 말풍선이 수 7과 경로 다섯 개, \"외 2개\"를 적는다",
      (await count(page, ".reload-dot")) === 1 && many[0] === `분석 뒤 바뀐 파일 7개 · 새로고침 ${MOD_R}` && many.length === 7 && many.slice(1, 6).every((line) => line.startsWith("  src/app/")) && many[6] === "  외 2개",
      many.join(" / "),
    );
    await page.getByRole("button", { name: "어두운 화면" }).click();
    await page.mouse.move(0, 0);
    const night = await markOf();
    t.check("어두운 화면에서도 점이 critical 색이다", night.dot?.color === (await colorOf(page, "--critical")).rgb && night.stroke === night.ink, `점 색 ${night.dot?.color}`);
    await snap("stale-dark");
    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForTimeout(300);
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
      "창 폭 720px에서 점을 그린 채로 상단 줄이 한 줄이고 버튼이 모두 창 안에서 눌린다",
      narrow.height < 40 && narrow.fits && narrow.missed.length === 0 && (await markOf()).dot !== null,
      `상단 줄 높이 ${narrow.height}, 눌리지 않는 버튼 ${narrow.missed.join("·") || "없음"}`,
    );
    await page.screenshot({ path: join(OUT, "hf5-reload-narrow.png"), clip: { x: 0, y: 0, width: 720, height: 60 } });
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
      "새로고침이 끝나면 점이 사라지고 접근성 이름이 평소대로 돌아가며 판 번호가 1 늘고 그래프에 새 파일과 함수가 있다",
      done.name === "새로고침" && !done.stale && done.dot === null && (await revisionOf()) === revision + 1 && fresh.stats.nodes === repo.stats.nodes + 13 && (await count(page, node("app.fresh_1"))) === 1,
      `접근성 이름 "${done.name}", 판 번호 ${await revisionOf()}, 노드 ${fresh.stats.nodes}개(처음 ${repo.stats.nodes}개)`,
    );
    await page.waitForTimeout(WITHIN);
    t.check("그 뒤로 파일을 고치지 않으면 점이 다시 생기지 않는다", !(await markOf()).stale, `접근성 이름 "${(await markOf()).name}"`);
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
/** 미사용 후보 표시가 표시하는 후보의 불투명도 상한 */
const UNUSED_OPACITY = 0.4;

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** 토글이 꺼진 화면에서 숨긴 노드. 테스트 코드와 외부 노드, 외부 값 변수다. */
const hiddenOf = (graph) => new Set(graph.nodes.filter((n) => veiled(n)).map((n) => n.id));

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
      tip: button.dataset.tip,
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

/** 필터 창에서 분석 표시 kind("none"·"cycles"·"unused")를 고른다. */
async function setOverlay(page, kind) {
  await inFilters(page, () => page.click(`.overlay-option[data-kind="${kind}"]`));
  await page.waitForFunction((want) => (document.querySelector(".graph").dataset.overlay ?? "none") === want, kind, { timeout: 5_000 });
  await rest(page);
}

// ── 3단계 시나리오: 경로 찾기와 경로 고정 ─────────────────────────

async function finderOpen(t, page) {
  await load(page);
  t.check("경로 탐색 창이 접힌 채로 열리고 왼쪽 아래 버튼 줄이 미니맵, 경로 찾기, 범례 순서다", (await count(page, ".finder")) === 0 &&
    same(await page.evaluate(() => [...document.querySelectorAll(".dock-buttons > *")].map((b) => b.getAttribute("aria-label"))), ["미니맵", "경로 찾기", "범례"]),
    (await page.evaluate(() => [...document.querySelectorAll(".dock-buttons > *")].map((b) => b.getAttribute("aria-label")))).join("·"));
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
    "경로 찾기 버튼을 누르면 창이 버튼 줄 위에 펼쳐지고 미니맵·창·범례가 왼쪽부터 아래 끝을 맞춰 놓이며 서로 겹치지 않고 관계 그래프 영역 안에 있다",
    wide.ok &&
      wide.finder.y > wide.area.y + wide.area.height / 2 &&
      near(wide.finder.y + wide.finder.height, wide.map.y + wide.map.height) &&
      near(wide.legend.y + wide.legend.height, wide.map.y + wide.map.height) &&
      wide.map.x < wide.finder.x &&
      wide.finder.x < wide.legend.x &&
      wide.finder.y + wide.finder.height < wide.buttons.y,
    `미니맵 ${rectText(wide.map)}, 창 ${rectText(wide.finder)}, 범례 ${rectText(wide.legend)}`,
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
  await rest(page);
  const stepped = await transformOf();
  await page.click(".finder-fit");
  await rest(page);
  t.check(
    "경로 탐색 창의 경로 전체 보기 버튼이 화면 맞춤과 같은 화면으로 맞춘다",
    stepped !== fitted.transform && (await transformOf()) === fitted.transform,
    `${stepped} → ${await transformOf()}`,
  );
  await page.click(".finder-step >> nth=0");
  await page.click(".finder-fit");
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
    await page.waitForSelector(".line-bubble", { timeout: 3_000 }).catch(() => {});
    const hovered = (await linesOf(page)).find((line) => line.key === aggregate.line.key);
    t.check(
      "경로 밖 집계 선에 올리면 선이 굵어지거나 진해지지 않고 말풍선만 뜨며 커서가 not-allowed다",
      !hovered.pointed && near(hovered.width, LINE.rest, 0.01) && hovered.tone === "muted" && hovered.opacity === DIM && (await bubbleRows(page)).length > 0 && (await cursorAt(page, aggregate.at)) === "not-allowed",
      `굵기 ${hovered.width}px, 불투명도 ${hovered.opacity}, 말풍선 "${(await bubbleRows(page)).join(" / ")}"`,
    );
    await followLine(page, aggregate.at, { key: aggregate.line.key });
    await page.waitForTimeout(250);
    await page.mouse.move(5, 5);
    await page.waitForSelector(".finder-pinned[data-flash]", { state: "detached", timeout: 3_000 }).catch(() => {});
    await rest(page);
    const after = (await routeLinesOf(page)).map((line) => line.key).sort();
    t.check(
      "경로 밖 집계 선의 도착 이름을 누르면 강조와 보이는 노드가 그대로이고 안내 줄이 한 번 뒤집힌다",
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
  const initRow = '.tree-row.tree-file[data-full$="parser/__init__.py"]';
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
  await rest(page);
  const wide = await zoomOf(page);
  await page.click(".finder-step >> nth=0");
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
  await followLine(page, found.at, { key: found.line.key });
  await page.mouse.move(5, 5);
  const lined = await focusedOn(target);
  t.check("경로 위의 선을 눌러 고정한 말풍선에서 도착 이름을 누르면 그 노드가 정보 패널에 보이고 강조는 그대로다", lined.ok, lined.text);

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
    return { pinned: element.hasAttribute("data-pinned"), background: getComputedStyle(element).backgroundColor, title: element.dataset.tip };
  });
  const ink = await colorOf(page, "--ink");
  t.check(
    "창을 접어도 강조가 남고 경로 찾기 버튼이 본문 잉크로 채워진다",
    (await count(page, ".finder")) === 0 && same((await state()).lines, pinnedState.lines) && button.pinned && button.background === ink.rgb && button.title.includes("경로 고정 중"),
    `창 ${await count(page, ".finder")}개, 버튼 바탕 ${button.background}, 말풍선 "${button.title}"`,
  );
  await page.screenshot({ path: join(OUT, "s3-finder-pin-folded.png") });
  await page.getByRole("button", { name: "화면 맞춤" }).click();
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

// ── 3단계 시나리오: 분석 표시 ─────────────────────────────────────

/** 필터 창의 분석 표시 행마다 종류, 글자, 고른 상태 */
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
        groups === 0 ? "순환 묶음이 없는 레포는 분석 표시 없이 열린다" : "순환 묶음이 있는 레포는 순환 의존 표시를 켠 채로 열린다",
        (await page.evaluate(() => document.querySelector(".graph").dataset.overlay ?? "none")) === (groups === 0 ? "none" : "cycles"),
        `필터 버튼의 수 ${await page.evaluate(() => document.querySelector(".filter-count")?.textContent ?? "없음")}`,
      );
    }
    const before = await flowBoxes(page);
    await page.click(".filter-button");
    await page.waitForSelector(".filter-panel .overlay-option", { timeout: 5_000 }).catch(() => {});
    const options = await overlayOptions(page);
    t.check(
      `창 폭 ${width}px: 필터 창의 분석 표시 행이 없음, 순환 의존 묶음 ${groups}, 미사용 후보 ${candidates.length}개를 적고 창 안에 있다`,
      same(options.map((o) => o.text), ["없음", `순환 의존 묶음 ${groups}`, `미사용 후보 ${candidates.length}개`]) && options.every((o) => o.inside),
      options.map((o) => o.text).join(" / "),
    );
    await page.screenshot({ path: join(OUT, `s3-overlay-menu-${width}.png`) });
    if (width === 1700) {
      const named = await page.evaluate(() => ({
        label: document.querySelector(".filter-overlays .filter-label")?.textContent ?? "",
        group: document.querySelector('.filter-overlays[role="radiogroup"]')?.getAttribute("aria-label") ?? "",
        old: document.body.innerText.includes("덮개") || [...document.querySelectorAll("[aria-label], [data-tip]")].some((el) => `${el.getAttribute("aria-label")} ${el.dataset.tip}`.includes("덮개")),
      }));
      t.check('필터 창의 구역 이름과 접근성 이름이 "분석 표시"이고 화면의 글과 말풍선에 "덮개"가 없다', named.label === "분석 표시" && named.group === "분석 표시" && !named.old, JSON.stringify(named));
      await page.screenshot({ path: HF4("filter-names") });
    }
    await page.click('.overlay-option[data-kind="unused"]');
    await rest(page);
    const picked = (await overlayOptions(page)).find((o) => o.checked)?.kind;
    await page.click(".filter-button");
    if (width === 1700) {
      const tip = await page.evaluate(() => document.querySelector(".filter-button").dataset.tip ?? "");
      t.check('미사용 후보를 고른 뒤 필터 버튼의 말풍선이 "미사용 후보 표시"를 적는다', tip.includes("미사용 후보 표시") && !tip.includes("덮개"), tip);
    }
    const after = await flowBoxes(page);
    t.check(
      `창 폭 ${width}px: 미사용 후보를 고르면 분석 표시가 켜지고 그 행이 고른 행이 되며 상자의 위치와 크기가 그대로다`,
      (await page.evaluate(() => document.querySelector(".graph").dataset.overlay)) === "unused" &&
        picked === "unused" &&
        (await count(page, ".filter-panel")) === 0 &&
        Object.keys(before).every((id) => after[id] !== undefined && sameRect(after[id], before[id])),
      `분석 표시 ${await page.evaluate(() => document.querySelector(".graph").dataset.overlay)}`,
    );
  }
}

/** 미사용 후보 표시가 표시한 노드마다 id, 테두리가 점선인지, 불투명도 */
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
    `미사용 후보 표시를 켜면 접힌 date_engine.py 아래 글자가 "미사용 후보 ${inFile.length}"을 담고, 후보가 없는 arbiter.py 아래 글자는 그대로다`,
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
  t.check("후보 노드에 올리면 말풍선 마지막 줄에 미사용 후보의 뜻을 적는다", hovered.split("\n").at(-1).startsWith("미사용 후보 · "), hovered.replaceAll("\n", " / "));
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
  t.check("분석 표시를 끄면 data-unused 노드와 아래 글자의 후보 수가 없다", (await count(page, "[data-unused]")) === 0 && !(await page.evaluate(() => [...document.querySelectorAll(".node-below")].some((below) => below.textContent.includes("미사용")))));
}

/** 경로 고정과 미사용 후보 표시가 함께 켜졌을 때 경로가 먼저 읽히는지 본다. */
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
    "미사용 후보 표시를 켠 채 후보에서 출발하는 경로를 고정하면 출발 노드가 점선 테두리에 불투명도 1이고 걸음은 본문 잉크 3px다",
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
    "고정 중에 분석 표시를 껐다 켜도 고정과 걸음이 그대로이고 안내 줄이 뒤집히지 않는다",
    off.pinned && off.lines === lines.length && off.unused === 0 && (await pinnedOf(page)) && (await count(page, ".react-flow__node > .node-body[data-unused]")) === shown.length && (await flashesOf(page)) === 0,
    `끈 동안 걸음 ${off.lines}개·표시 ${off.unused}개, 뒤집힘 ${await flashesOf(page)}번`,
  );
  await page.click(".finder-clear");
  await rest(page);
  t.check("끄기를 누르면 분석 표시만 남는다", !(await pinnedOf(page)) && (await page.evaluate(() => document.querySelector(".graph").dataset.overlay)) === "unused");
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
    `순환 묶음 ${found.groups.length}개가 있는 레포는 순환 의존 표시를 켠 채로 열린다`,
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

  // 분석 표시를 껐다 켜도 상자가 움직이지 않고, 끈 동안에는 critical 색이 없고 아이콘은 남는다.
  await setOverlay(page, "none");
  const off = await cycleLinesOf(page);
  const offBoxes = await flowBoxes(page);
  t.check(
    "분석 표시를 끄면 critical 색 선이 없고 순환 아이콘은 남으며 모든 상자의 위치가 같다",
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
    "순환 의존 표시를 켠 동안 수정한 파일 상자는 색 막대와 테두리 색이 없고 M 글자는 있다",
    on.mark === "M" && on.bar === "none" && on.border === muted.rgb && (await cycleLinesOf(page)).some((line) => line.stroke === critical.rgb),
    `글자 ${on.mark}, 막대 ${on.bar}, 왼쪽 테두리 ${on.border}`,
  );
  await t.shot();
  await setOverlay(page, "none");
  const off = await read();
  t.check(
    "분석 표시를 끄면 수정 표시의 색 막대와 테두리 색이 돌아온다",
    off.mark === "M" && off.bar !== "none" && off.border !== muted.rgb && off.border !== on.border,
    `글자 ${off.mark}, 막대 ${off.bar}, 왼쪽 테두리 ${off.border} (--changed ${changedColor.value})`,
  );
}

/** 순환 의존 표시와 경로 고정이 함께 켜졌을 때와, 접힌 폴더 상자 아래의 미사용 후보 수를 본다. */
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
    `순환 의존 표시를 켠 채 경로를 고정하면 걸음 ${route.paths[0].length - 1}개가 본문 잉크 3px, 불투명도 1이다`,
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
    "고정 중에 분석 표시를 끄면 critical 색이 없고 걸음과 고정은 그대로이며 안내 줄이 뒤집히지 않는다",
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
    `미사용 후보 표시를 켜면 접힌 a/two.py 아래 글자와 접힌 a/ 폴더 상자 아래 글자가 안에 든 후보 수 ${inFolder.length}을 적는다`,
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
  t.check("분석 표시를 끄면 폴더 상자 아래 글자가 없다", (await belowOf(page, "a")) === "");
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
  const fits = rects.every((r) => r.x >= free.x && r.y >= free.y && r.x + r.width <= free.x + free.width && r.y + r.height <= free.y + free.height);
  const corner = { x: Math.min(...rects.map((r) => r.x)), y: Math.min(...rects.map((r) => r.y)) };
  t.check(
    "확대 비율이 0.8과 100% 사이이고, 그래프 전체가 정보 패널이 가리지 않는 영역에 들어오거나 0.8에서 그래프의 왼쪽 위가 그 영역의 왼쪽 위에 있다",
    zoom <= 1 && zoom >= NAMED_ZOOM - 0.001 && (fits || (near(zoom, NAMED_ZOOM, 0.001) && near(corner.x, free.x + 24, 1.5) && near(corner.y, free.y + 24, 1.5))),
    `확대 비율 ${zoom.toFixed(3)}, 전체가 들어옴 ${fits}, 왼쪽 위 (${Math.round(corner.x - free.x)}, ${Math.round(corner.y - free.y)})`,
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
  // 펼친 영역을 화면 왼쪽 위에 맞춘 화면에서는 왼쪽 열의 파일 상자가 화면 밖에 있으므로 파일트리의 행으로 고른다.
  await page.click(`.tree-row.tree-file[data-node="${FILE}"]`);
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

/** 화면에서 이름표의 가운데가 그 노드로 눌리는 노드마다 종류, 불투명도, 이름표 가운데 점 */
const hoverable = (page) =>
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

/**
 * 노드의 hover. 마우스를 올린 노드는 선의 hover처럼 가장 진한 단계(불투명도 1)로 그리고 이름표를 굵게, 모양에 옅은 빛을 준다.
 * 배치가 정한 이름표와 상자의 위치·폭은 그대로이고, 옆 노드와 부모·자식 상자의 단계는 바뀌지 않는다. 커지는 길이는 `node-grow`가 본다.
 */
async function nodeHover(t, page) {
  const candidates = () => hoverable(page);
  /** 노드의 두 요소가 받은 불투명도와 클래스, 이름표의 외곽선, 모양의 빛, 배치가 정한 이름표의 위치·폭과 React Flow 노드의 사각형 */
  const look = (id) =>
    page.evaluate((id) => {
      const body = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      const face = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}#face"]`);
      const label = face.querySelector(".node-label");
      const round = (rect) => [rect.left, rect.top, rect.width, rect.height].map((n) => Math.round(n * 100) / 100).join(",");
      return {
        opacity: [Number(getComputedStyle(body).opacity), Number(getComputedStyle(face).opacity)],
        pointed: [body.classList.contains("pointed"), face.classList.contains("pointed")],
        inked: body.classList.contains("tone-strong"),
        stroke: parseFloat(getComputedStyle(label).webkitTextStrokeWidth),
        glow: getComputedStyle(body.firstElementChild).filter !== "none",
        shadow: getComputedStyle(label).textShadow !== "none",
        layers: `${body.style.zIndex},${face.style.zIndex}`,
        place: [`${label.offsetLeft},${label.offsetWidth}`, round(body.getBoundingClientRect()), `${body.style.transform}`].join(" / "),
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
    [`불투명도 ${HALF * 100}%인 흐름 노드`, list.find((item) => leaf(item) && item.opacity === HALF)],
    ["흐린 노드", list.find((item) => leaf(item) && item.opacity === DIM)],
  ];
  for (const [name, at] of levels) {
    if (at === undefined) {
      t.skip(`${name}에 마우스를 올리면 진하기를 한 단계 올려 그린다`, "이 화면에 그 단계의 노드가 없다");
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
    const up = liftedShade({ tone: "muted", opacity: at.opacity });
    t.check(
      `${name}에 마우스를 올리면 불투명도 ${up.opacity}${up.tone === "strong" ? "에 본문 잉크 테두리" : ""}, 굵은 이름표, 옅은 빛으로 그리고 떠나면 돌아온다`,
      same(before.opacity, [at.opacity, at.opacity]) && same(on.opacity, [up.opacity, up.opacity]) && on.inked === (up.tone === "strong") && before.stroke === 0 && on.stroke > 0 && !before.glow && on.glow && same(after, before),
      `${at.id}: 불투명도 ${before.opacity} → ${on.opacity} → ${after.opacity}, 본문 잉크 테두리 ${on.inked}, 외곽선 ${before.stroke} → ${on.stroke}px, 빛 ${before.glow} → ${on.glow}`,
    );
    t.check(`${name}: 배치가 정한 이름표·상자의 위치와 폭, 층이 그대로다`, on.place === before.place && on.layers === before.layers, `${before.place} → ${on.place}, 층 ${on.layers}`);
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

/** 마우스를 올린 잎 노드의 변이 바깥으로 나가는 길이(확대하기 전 px). nodes/common.tsx의 GROW와 같다. */
const GROW = 2;

/**
 * 마우스를 올린 잎 노드가 올린 동안만 네 변이 `GROW`만큼 나가게 커지는지 본다. 접힌 파일 상자, 접힌 폴더 상자, 함수, 흐린 함수, 함수 시점 뷰의
 * 노드에 차례로 올려 화면의 사각형을 재고, 펼친 파일 상자와 폴더 영역의 머리 줄, 화면 이동·배치 움직임·화면을 끄는 동안, 움직임을 줄이는 설정을 본다.
 * 올리기 전과 올린 동안을 나란히 붙인 사진을 `hf4-grow-{이름}.png`로 남긴다.
 */
async function nodeGrow(t, page) {
  const away = async () => {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);
  };
  const over = async (at) => {
    await page.mouse.move(at.x - 1, at.y);
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(400);
  };
  /** 노드의 React Flow 노드(배치가 정한 위치와 크기)와 그 안의 바탕 요소·글자 요소·원이 화면에서 차지하는 사각형 */
  const boxOf = (id) =>
    page.evaluate((id) => {
      const body = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      const face = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}#face"]`);
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return [box.left, box.top, box.right, box.bottom];
      };
      const shape = body.querySelector(".node-circle, .call-shape");
      return {
        placed: `${body.style.transform} ${body.style.width} ${body.style.height} / ${face.style.transform}`,
        frame: rect(body),
        body: rect(body.firstElementChild),
        face: rect(face.firstElementChild),
        shape: shape === null ? null : rect(shape),
        pointed: face.classList.contains("pointed"),
        duration: getComputedStyle(body.firstElementChild).transitionDuration,
        hint: getComputedStyle(body.firstElementChild).willChange,
      };
    }, id);
  /** 사각형 b의 네 변이 사각형 a에서 바깥으로 나간 길이(왼쪽, 위, 오른쪽, 아래) */
  const outBy = (a, b) => [a[0] - b[0], a[1] - b[1], b[2] - a[2], b[3] - a[3]];
  const text = (sides) => sides.map((n) => Math.round(n * 100) / 100).join(", ");
  const all = (sides, want) => sides.every((side) => near(side, want, 0.1));
  /** 올리기 전과 올린 동안의 노드 둘레를 나란히 붙여 남긴다. */
  const shoot = async (name, id, at) => {
    const frame = (await boxOf(id)).frame;
    const clip = {
      x: Math.max(0, Math.round(frame[0] - 70)),
      y: Math.max(0, Math.round(frame[1] - 50)),
      width: Math.min(520, Math.round(frame[2] - frame[0] + 140)),
      height: Math.round(frame[3] - frame[1] + 100),
    };
    await away();
    const before = await page.screenshot({ clip });
    await over(at);
    const after = await page.screenshot({ clip });
    const sheet = await page.context().newPage();
    await sheet.setViewportSize({ width: clip.width * 2 + 12, height: clip.height });
    await sheet.setContent(
      `<body style="margin:0;display:flex;gap:12px;background:#808080">${[before, after].map((image) => `<img src="data:image/png;base64,${image.toString("base64")}" width="${clip.width}" height="${clip.height}">`).join("")}</body>`,
    );
    await sheet.screenshot({ path: HF4(`grow-${name}`) });
    await sheet.close();
    await away();
  };
  /** 노드 item에 올렸다 떠나며 잰 사각형으로 확인 항목을 적고 한 변이 나간 길이(확대하기 전 px)를 돌려준다. */
  const grows = async (name, item, picture) => {
    const zoom = await zoomOf(page);
    await away();
    const before = await boxOf(item.id);
    await over(item);
    const on = await boxOf(item.id);
    await away();
    const after = await boxOf(item.id);
    const [body, face] = [outBy(before.body, on.body), outBy(before.face, on.face)];
    t.check(
      `${name}에 마우스를 올리면 바탕 요소와 글자 요소의 네 변이 ${GROW}px(화면에서는 확대 비율을 곱한 ${Math.round(GROW * zoom * 100) / 100}px)씩 나가고 떠나면 돌아온다`,
      on.pointed && all(body, GROW * zoom) && all(face, GROW * zoom) && same(after.body, before.body) && same(after.face, before.face),
      `${item.id}: 바탕 요소 ${text(body)} / 글자 요소 ${text(face)}`,
    );
    t.check(`${name}: React Flow 노드의 위치와 크기는 올린 동안에도 그대로다`, on.placed === before.placed && same(on.frame, before.frame), on.placed);
    if (on.shape !== null) {
      const [width, height] = [on.shape[2] - on.shape[0], on.shape[3] - on.shape[1]];
      t.check(`${name}: 커진 원의 폭과 높이가 같다`, near(width, height, 0.1) && height > before.shape[3] - before.shape[1], `${Math.round(width * 100) / 100} × ${Math.round(height * 100) / 100}px`);
    }
    if (picture !== null) {
      await shoot(picture, item.id, item);
    }
    return { out: body[0] / zoom, on };
  };
  const theme = async (name) => {
    await page.getByRole("button", { name: name === "dark" ? "어두운 화면" : "밝은 화면" }).click();
    await page.waitForFunction((want) => document.documentElement.dataset.theme === want, name);
  };

  // 폴더를 접은 처음 화면: 접힌 파일 상자와 접힌 폴더 상자
  await asidePanel(page);
  await load(page, url, false);
  await away();
  const first = await hoverable(page);
  const [file, folder] = [first.find((item) => item.kind === "module"), first.find((item) => item.kind === "package")];
  const wide = await grows("접힌 파일 상자", file, "file");
  if (folder === undefined) {
    t.skip("접힌 폴더 상자에 마우스를 올리면 네 변이 나간다", "처음 화면에 접힌 폴더 상자가 없다");
  } else {
    await grows("접힌 폴더 상자", folder, "folder");
  }
  t.check("전환은 불투명도의 전환과 같은 200ms이고 will-change를 켜 두지 않는다", wide.on.duration === "0.2s" && wide.on.hint === "auto", `${wide.on.duration}, will-change ${wide.on.hint}`);

  // 올린 채 화면 이동·배치 움직임 표시가 붙거나 화면을 끌면 원래 크기로 돌아간다.
  const idle = await boxOf(file.id);
  await over(file);
  for (const [name, attribute] of [["화면 이동", "data-flying"], ["배치 움직임", "data-moving"]]) {
    await page.evaluate((attribute) => document.querySelector(".graph").setAttribute(attribute, ""), attribute);
    await page.waitForTimeout(400);
    const held = await boxOf(file.id);
    await page.evaluate((attribute) => document.querySelector(".graph").removeAttribute(attribute), attribute);
    await page.waitForTimeout(400);
    const back = await boxOf(file.id);
    t.check(
      `올린 채 관계 그래프 영역에 ${attribute}가 붙어 있는 동안(${name})에는 커지지 않고, 사라지면 다시 커진다`,
      held.pointed && all(outBy(idle.body, held.body), 0) && all(outBy(idle.body, back.body), GROW * (await zoomOf(page))),
      `붙은 동안 ${text(outBy(idle.body, held.body))}, 사라진 뒤 ${text(outBy(idle.body, back.body))}`,
    );
  }
  await page.mouse.down();
  await page.mouse.move(file.x + 40, file.y + 30, { steps: 4 });
  await page.waitForTimeout(400);
  const dragged = await boxOf(file.id);
  const paneDragging = (await count(page, ".react-flow__pane.dragging")) === 1;
  await page.mouse.up();
  t.check(
    "화면을 끄는 동안에는 커지지 않는다",
    paneDragging && all(outBy(dragged.frame, dragged.body), 0),
    `끄는 중 표시 ${paneDragging}, React Flow 노드에서 나간 길이 ${text(outBy(dragged.frame, dragged.body))}`,
  );
  await away();

  // 움직임을 줄이는 설정에서는 전환 없이 바로 커진다.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const still = await hoverable(page);
  const again = still.find((item) => item.id === file.id) ?? still.find((item) => item.kind === "module");
  const rest = await boxOf(again.id);
  await page.mouse.move(again.x, again.y);
  await page.waitForFunction((id) => document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`).classList.contains("pointed"), again.id, { timeout: 3_000 });
  const instant = await boxOf(again.id);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  t.check(
    "움직임을 줄이는 설정에서는 전환 없이 바로 커진다",
    instant.duration === "0s" && all(outBy(rest.body, instant.body), GROW * (await zoomOf(page))),
    `전환 ${instant.duration}, 나간 길이 ${text(outBy(rest.body, instant.body))}`,
  );
  await away();

  // 파일을 고른 화면: 함수 노드, 펼친 파일 상자의 머리 줄, 이웃과의 간격
  await pick(page, FILE);
  await away();
  await settle(page);
  const opened = await hoverable(page);
  const inner = opened.filter((item) => item.kind === "function" && item.id.startsWith(`${FILE}:`));
  const small = await grows("함수 노드", inner[0], "function");
  t.check(
    "넓은 파일 상자와 작은 함수 노드의 변이 확대하기 전 길이로 같은 만큼 나간다",
    near(wide.out, small.out, 0.1),
    `파일 상자 ${Math.round(wide.out * 100) / 100}px, 함수 ${Math.round(small.out * 100) / 100}px`,
  );
  await over(inner[0]);
  const covered = await page.evaluate((id) => {
    const own = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
    const grown = own.firstElementChild.getBoundingClientRect();
    return [...document.querySelectorAll(".react-flow__node > .node-body:is(.node-function, .node-class, .node-dataclass)")]
      .filter((other) => other.parentElement !== own)
      .filter((other) => {
        const rect = other.getBoundingClientRect();
        return rect.left < grown.right && rect.right > grown.left && rect.top < grown.bottom && rect.bottom > grown.top;
      })
      .map((other) => other.parentElement.dataset.id);
  }, inner[0].id);
  await away();
  t.check("커진 함수 노드가 이웃 노드와 겹치지 않는다", covered.length === 0, covered.join(", "));
  const head = opened.find((item) => item.kind === "module-open" && item.id === FILE);
  if (head === undefined) {
    t.skip("펼친 파일 상자의 머리 줄에 올리면 상자가 커지지 않는다", "머리 줄의 이름표가 화면에 없다");
  } else {
    const before = await boxOf(head.id);
    await over(head);
    const on = await boxOf(head.id);
    const child = await boxOf(inner[0].id);
    await away();
    t.check(
      "펼친 파일 상자의 머리 줄에 올리면 상자와 안의 함수가 커지지 않는다",
      on.pointed && same(on.body, before.body) && same(on.face, before.face) && all(outBy(child.frame, child.body), 0),
      `${head.id}: 나간 길이 ${text(outBy(before.body, on.body))}`,
    );
  }

  // 함수를 고른 화면: 흐린 함수 노드와 어두운 화면
  await pick(page, FUNCTION);
  await away();
  await settle(page);
  const faded = (await hoverable(page)).find((item) => item.kind === "function" && item.opacity === DIM);
  if (faded === undefined) {
    t.skip("흐린 함수 노드에 마우스를 올리면 네 변이 나간다", "이 화면에 이름표가 눌리는 흐린 함수 노드가 없다");
  } else {
    await grows("흐린 함수 노드", faded, "dim");
    await theme("dark");
    await grows("어두운 화면의 흐린 함수 노드", faded, "dark");
    await theme("light");
  }

  // 펼친 폴더 영역의 머리 줄
  await page.keyboard.press("Escape");
  await settle(page);
  const graph = await api("/api/graph");
  const dir = graph.nodes.find((n) => n.kind === "package" && n.parent === null && !n.test);
  if (dir === undefined) {
    t.skip("펼친 폴더 영역의 머리 줄에 올리면 영역이 커지지 않는다", "소스 루트 바로 아래에 폴더가 없다");
  } else {
    await openFolder(page, dir.id);
    await page.getByRole("button", { name: "화면 맞춤" }).click();
    await away();
    await settle(page);
    const at = await page.evaluate((id) => {
      const rect = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}#face"] .node-region-head .node-label`).getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, dir.id);
    const before = await boxOf(dir.id);
    await over(at);
    const on = await boxOf(dir.id);
    await away();
    t.check("펼친 폴더 영역의 머리 줄에 올리면 영역이 커지지 않는다", on.pointed && same(on.body, before.body) && same(on.face, before.face), `${dir.id}: 나간 길이 ${text(outBy(before.body, on.body))}`);
  }

  // 함수 시점 뷰의 노드
  await pick(page, FILE);
  await clickNode(page, FUNCTION, 2);
  await page.waitForSelector(".node-call", { timeout: 30_000 });
  await settle(page);
  await away();
  const call = await page.evaluate(() => {
    const face = document.querySelector('.node-call[data-side="center"]').closest(".react-flow__node");
    const rect = face.parentElement.querySelector(`[data-id="${CSS.escape(face.dataset.id.replace(/#face$/, ""))}#face"] .node-label`).getBoundingClientRect();
    return { id: face.dataset.id.replace(/#face$/, ""), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await grows("함수 시점 뷰의 노드", call, null);
  await t.shot();
}

/**
 * 마우스를 올린 선의 진하기가 그 선의 단계에서 한 단계만 오르는지 본다. 고른 노드가 없는 처음 화면, 파일을 고른 화면(고른 노드에 닿는 선,
 * 흐름에 든 노드 사이의 선, 그 밖의 선), 어두운 화면, 미사용 후보 표시의 후보 노드를 차례로 본다. 사진은 `hf3-hover-{이름}.png`로 남긴다.
 */
async function hoverStep(t, page) {
  /** 마우스를 올린 점 at의 둘레 640×420px를 남긴다. 화면에 맞춘 그래프는 선이 가늘어 전체 화면으로는 진하기가 읽히지 않는다. */
  const shot = (name, at) =>
    page.screenshot({
      path: join(OUT, `hf3-hover-${name}.png`),
      clip: { x: Math.max(0, Math.min(VIEW.width - 640, at.x - 320)), y: Math.max(0, Math.min(VIEW.height - 420, at.y - 210)), width: 640, height: 420 },
    });
  const away = async () => {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(300);
  };
  /** 선 want에 마우스를 올린 동안의 그 선 */
  const over = async (want) => {
    await page.mouse.move(want.at.x - 1, want.at.y);
    await page.mouse.move(want.at.x, want.at.y);
    await page.waitForTimeout(300);
    return (await linesOf(page)).find((line) => line.key === want.line.key);
  };
  /** 진하기가 shade인 선 가운데 누를 점이 있는 첫 선 */
  const pointable = async (shade) => hittable(page, (await linesOf(page)).filter((line) => !line.below && line.tone === shade.tone && line.opacity === shade.opacity));
  /** 단계 name의 선에 올려 한 단계 위의 진하기, 1px 굵은 선, 빛을 확인하고 올린 동안의 선을 돌려준다. */
  const step = async (name, shade, picture = null) => {
    const want = await pointable(shade);
    if (want === null) {
      t.skip(`${name}에 마우스를 올리면 진하기가 한 단계만 오른다`, "이 화면에 그 단계의 누를 수 있는 선이 없다");
      return null;
    }
    const up = liftedShade(shade);
    const line = await over(want);
    if (picture !== null) {
      await shot(picture, want.at);
    }
    await away();
    const back = (await linesOf(page)).find((each) => each.key === want.line.key);
    t.check(
      `${name}(${shade.tone} ${shade.opacity})에 마우스를 올리면 ${up.tone} ${up.opacity}로 한 단계만 오르고 1px 굵어지며 빛을 두른다`,
      line.pointed && line.tone === up.tone && line.opacity === up.opacity && near(line.width, want.line.width + 1, 0.01) && line.glow && back.tone === shade.tone && back.opacity === shade.opacity && !back.glow,
      `${want.line.key}: ${line.tone} ${line.opacity}, 굵기 ${want.line.width} → ${line.width}px, 빛 ${line.glow}, 떠난 뒤 ${back.tone} ${back.opacity}`,
    );
    return line;
  };

  await load(page);
  await away();
  await step("고른 노드가 없을 때의 선", SHADES[1], "idle-light");
  const theme = async (name) => {
    await page.getByRole("button", { name: name === "dark" ? "어두운 화면" : "밝은 화면" }).click();
    await page.waitForFunction((want) => document.documentElement.dataset.theme === want, name);
    await away();
  };
  await theme("dark");
  await step("어두운 화면에서 고른 노드가 없을 때의 선", SHADES[1], "idle-dark");
  await theme("light");

  await pick(page, FILE);
  await pick(page, FUNCTION);
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await away();
  await settle(page);
  const rest = await step("함수를 골랐을 때 그 밖의 선", SHADES[0], "rest-light");
  await step("흐름에 든 노드 사이의 선", SHADES[2], "flow-light");
  await step("고른 노드에 닿는 선", SHADES[3], "strong-light");
  const active = (await linesOf(page)).filter((line) => line.opacity === 1);
  if (rest !== null) {
    t.check(
      "흐린 선은 마우스를 올려도 활성인 선보다 연하다",
      active.length > 0 && rest.tone === "muted" && active.every((line) => rest.opacity < line.opacity),
      `올린 흐린 선의 불투명도 ${rest.opacity}, 활성인 선 ${active.length}개의 불투명도 1`,
    );
  }

  await theme("dark");
  await step("어두운 화면에서 그 밖의 선", SHADES[0], "rest-dark");
  await step("어두운 화면에서 고른 노드에 닿는 선", SHADES[3], "strong-dark");

  // 미사용 후보 표시의 후보 노드는 불투명도 40%에서 바로 위 단계로 오른다.
  await theme("light");
  await setOverlay(page, "unused");
  const [graph, unused] = [await api("/api/graph"), await api("/api/unused")];
  const holder = graph.nodes.find((n) => n.kind === "module" && candidatesOf(graph, unused).some((id) => graph.nodes.find((each) => each.id === id).path === n.path));
  if (holder !== undefined) {
    await page.click(`.tree-row.tree-file[data-node="${holder.id}"]`);
    await waitSelected(page, holder.id);
  }
  await away();
  await settle(page);
  const faded = await page.evaluate(() => {
    for (const face of document.querySelectorAll('.react-flow__node[data-id$="#face"]')) {
      const label = face.querySelector(".node-label");
      if (Number(face.style.opacity) !== 0.4 || label === null || getComputedStyle(label).visibility !== "visible") {
        continue;
      }
      const rect = label.getBoundingClientRect();
      const [x, y] = [rect.left + rect.width / 2, rect.top + rect.height / 2];
      if (face.contains(document.elementFromPoint(x, y))) {
        return { id: face.dataset.id.replace(/#face$/, ""), x, y };
      }
    }
    return null;
  });
  if (faded === null) {
    t.skip(`미사용 후보 노드에 마우스를 올리면 불투명도 40%에서 ${HALF * 100}%로 오른다`, "화면에 이름표가 눌리는 불투명도 40%의 후보가 없다");
  } else {
    await page.mouse.move(faded.x, faded.y);
    await page.waitForTimeout(300);
    const on = await page.evaluate((id) => {
      const body = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      return { opacity: Number(getComputedStyle(body).opacity), inked: body.classList.contains("tone-strong"), pointed: body.classList.contains("pointed") };
    }, faded.id);
    await shot("unused-light", faded);
    t.check(`미사용 후보 노드에 마우스를 올리면 불투명도 40%에서 ${HALF * 100}%로 오르고 테두리는 본문 잉크가 되지 않는다`, on.pointed && on.opacity === HALF && !on.inked, `${faded.id}: 불투명도 ${on.opacity}, 본문 잉크 테두리 ${on.inked}`);
  }
  await away();
}

/**
 * 함수를 고른 화면에서 흐린 노드와 선이 흐린 단계의 불투명도로 그려지고 한 단계 위(중간 단계)와 다른 값인지 본다. 흐린 항목의 이름이 읽히는지와
 * 두 단계가 눈으로 구분되는지는 사진 `hf3-dim-{레포}-{화면 색}.png`로 본다. `--wide-url`을 받으면 그 레포에서 `mdp/settings/loader.py`의 함수도 본다.
 */
async function dim(t, page) {
  /** 화면에 보이는 노드와 선의 불투명도마다의 수 */
  const levels = () =>
    page.evaluate(() => {
      const tally = (elements) => {
        const counts = {};
        for (const element of elements) {
          const opacity = getComputedStyle(element).opacity;
          counts[opacity] = (counts[opacity] ?? 0) + 1;
        }
        return counts;
      };
      return {
        nodes: tally([...document.querySelectorAll('.react-flow__node[data-id$="#face"]')]),
        lines: tally([...document.querySelectorAll(".react-flow__edge .edge[data-key]")]),
      };
    });
  const look = async (name) => {
    await page.mouse.move(1, 1);
    await settle(page);
    const found = await levels();
    const text = (counts) => Object.entries(counts).map(([opacity, count]) => `${opacity}: ${count}개`).join(", ");
    t.check(
      `${name}: 흐린 노드와 선의 불투명도가 ${DIM}이고 노드의 단계는 1, ${HALF}, ${DIM}, 선의 단계는 1, ${DIM}뿐이다`,
      found.nodes[DIM] > 0 && found.lines[DIM] > 0 && Object.keys(found.nodes).every((opacity) => [1, HALF, DIM].includes(Number(opacity))) && Object.keys(found.lines).every((opacity) => [1, DIM].includes(Number(opacity))),
      `노드 ${text(found.nodes)} / 선 ${text(found.lines)}`,
    );
    /** 중간 단계인 노드가 화면에 있으면 그 둘레 560×360px도 남겨 흐린 단계와 나란히 본다. */
    const half = await page.evaluate((level) => {
      const area = document.querySelector(".graph").getBoundingClientRect();
      const panel = document.querySelector(".info-panel").getBoundingClientRect();
      for (const face of document.querySelectorAll('.react-flow__node[data-id$="#face"]')) {
        const rect = face.getBoundingClientRect();
        if (face.style.opacity === level && rect.left > area.left && rect.right < panel.left && rect.top > area.top && rect.bottom < area.bottom) {
          const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
          return { x: clamp(rect.left + rect.width / 2 - 280, area.left, panel.left - 560), y: clamp(rect.top + rect.height / 2 - 180, area.top, area.bottom - 360), width: 560, height: 360 };
        }
      }
      return null;
    }, String(HALF));
    const shots = async (theme) => {
      await page.screenshot({ path: join(OUT, `hf3-dim-${name}-${theme}.png`) });
      if (half !== null) {
        await page.screenshot({ path: join(OUT, `hf3-dim-${name}-half-${theme}.png`), clip: half });
      }
    };
    await shots("light");
    await page.getByRole("button", { name: "어두운 화면" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.mouse.move(1, 1);
    await shots("dark");
  };

  await load(page);
  await pick(page, FILE);
  await pick(page, FUNCTION);
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await look("se");

  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포에서 함수를 고른 화면의 흐린 단계", "--wide-url을 주지 않았다");
    return;
  }
  const wide = WIDE_LINE_FOLDER;
  const graph = await api("/api/graph", wideUrl);
  await page.goto(wideUrl);
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  for (const folder of wide.open) {
    await openFolder(page, folder);
  }
  /** 펼친 폴더 바로 아래 파일의 함수 가운데 나가는 선이 가장 많은 함수 */
  const fn = graph.nodes
    .filter((n) => n.kind === "function" && !n.test && wide.open.includes(graph.nodes.find((file) => file.id === n.parent)?.parent))
    .sort((a, b) => touchingOf(graph, b.id).out - touchingOf(graph, a.id).out)[0];
  if (fn === undefined) {
    t.skip("폴더가 여러 겹인 레포에서 함수를 고른 화면의 흐린 단계", "펼친 폴더 바로 아래 파일에 함수가 없다");
    return;
  }
  await pickInTree(page, { owner: fn.parent, id: fn.id });
  await look("mdp");
}

/** 그래프의 포함 관계. within(id, ancestor)는 id가 ancestor 자신이거나 그 자손인지, unitOf(id)는 id가 든 파일(파일과 폴더는 자신)이다. */
function ancestry(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const within = (id, ancestor) => {
    for (let now = id; now != null; now = nodes.get(now)?.parent) {
      if (now === ancestor) {
        return true;
      }
    }
    return false;
  };
  const unitOf = (id) => {
    let now = nodes.get(id);
    while (now !== undefined && now.kind !== "module" && now.kind !== "package" && now.parent !== null) {
      now = nodes.get(now.parent);
    }
    return now?.id ?? id;
  };
  /** 두 토글이 꺼진 화면에서 그리는 원래 선 */
  const edges = graph.edges.filter((e) => [e.source, e.target].every((id) => !nodes.get(id).test && nodes.get(id).kind !== "external"));
  /** 화면의 선 key가 합친 원래 선. 집계 선은 출발이 키의 출발 노드 안에, 도착이 도착 노드 안에 든 선이다. */
  const origins = (key) => {
    const [source, target] = endsOfKey(key);
    return key.startsWith("agg|") ? edges.filter((e) => within(e.source, source) && within(e.target, target)) : edges.filter((e) => `${e.source}|${e.target}|${e.kind}` === key);
  };
  /** 파일과 폴더의 이름표(소스 루트 기준 경로) */
  const title = (id) => (nodes.get(id).kind === "package" ? `${id.replaceAll(".", "/")}/` : `${id.replaceAll(".", "/")}.py`);
  return { nodes, within, unitOf, edges, origins, title };
}

/** 경로 path에서 경로 from과 앞에서부터 같은 폴더를 뺀 나머지(`graph/rows.ts`의 `apartFrom`과 같은 규칙) */
const apartFrom = (path, from) => {
  const [parts, others] = [path.split("/"), from.replace(/\/$/, "").split("/")];
  const last = parts.length - (path.endsWith("/") ? 2 : 1);
  let k = 0;
  while (k < last && k < others.length - 1 && parts[k] === others[k]) {
    k += 1;
  }
  return parts.slice(k).join("/");
};
/** 클래스·함수·메서드 id를 기준 파일 base에서 갈라지는 곳부터 적은 글(`graph/rows.ts`의 `definedName`과 같은 규칙). 파일과 폴더는 이름만 적는다. 선의 말풍선과 정보 패널의 코드 줄 묶음이 쓴다. */
const nameFrom = (g, tr, base, id) => `${tr.unitOf(id) === id || tr.unitOf(id) === base ? "" : `${apartFrom(tr.title(tr.unitOf(id)), tr.title(base))}::`}${shortName(g, id)}`;

/** 선의 말풍선이 관계 칸에 적는 글(`graph/names.ts`의 `relationsOf`와 같은 규칙) */
function relationWords(kinds) {
  const counted = Object.keys(KIND_NAMES).filter((kind) => kinds[kind] !== undefined && COUNTED.includes(kind));
  return counted.length > 0 ? counted.map((kind) => `${KIND_NAMES[kind]} ${kinds[kind]}곳`).join(" · ") : (ALONE.find(([kind]) => kinds[kind] !== undefined)?.[1] ?? "");
}

/**
 * 선의 말풍선과 선을 따라가는 단계를 본다. 세 칸과 칸 이름, 선 하나의 고정, Esc와 바깥 클릭, 방향키, 이름과 관계 칸의 동작,
 * 고른 노드가 함수·파일·없음일 때 줄의 양 끝, 관계 글 세 가지와 선 위의 수, 경로 고정 중의 막음, 함수 시점 뷰를 차례로 본다.
 * 사진은 `hf3-line-{이름}.png`로 남긴다. `--wide-url`을 받으면 그 레포에서 함수를 고른 채 접힌 폴더로 가는 선도 본다.
 */
async function lineBubble(t, page) {
  const shot = (name) => page.screenshot({ path: join(OUT, `hf3-line-${name}.png`) });
  const graph = await api("/api/graph");
  const tree = ancestry(graph);
  const away = async () => {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(250);
  };
  /** from에서 to로 가는 그린 선과 누를 점 */
  const lineBetween = async (from, to) => hittable(page, (await linesOf(page)).filter((line) => same(endsOfKey(line.key), [from, to])));
  /**
   * 화면의 선에 차례로 마우스를 올려 말풍선의 줄을 모으고, 줄의 끝이 정의인 칸마다 기준 파일에서 갈라지는 곳부터 적었는지 본다.
   * 기준 파일은 줄의 한 끝만 고른 노드 focus나 그 안의 노드이면 focus가 든 파일이고, 그 밖에는 줄의 다른 쪽 끝이 든 파일이나 폴더다.
   * wrong은 규칙과 다른 칸, kinds는 규칙대로 적은 칸을 경우마다 하나씩 든 보기다.
   */
  const sweep = async (g, tr, focus, limit = 80) => {
    const rows = new Map();
    for (const line of (await linesOf(page)).slice(0, limit)) {
      const at = await edgePoint(page, line.key);
      if (at === null) {
        continue;
      }
      for (const row of (await bubbleOver(page, at))?.rows ?? []) {
        rows.set(`${row.nodes[0]}|${row.nodes[1]}`, row);
      }
      await page.mouse.move(1, 1);
    }
    const [wrong, kinds] = [[], new Map()];
    const folderOf = (unit) => tr.title(unit).replace(/\/$/, "").split("/").slice(0, -1).join("/");
    for (const row of rows.values()) {
      const touched = focus !== null && tr.nodes.get(focus).kind !== "package" && tr.within(row.nodes[0], focus) !== tr.within(row.nodes[1], focus);
      for (const [i, id] of row.nodes.entries()) {
        if (tr.unitOf(id) === id) {
          continue;
        }
        const base = touched ? tr.unitOf(focus) : tr.unitOf(row.nodes[1 - i]);
        const [want, got] = [nameFrom(g, tr, base, id), i === 0 ? row.source : row.target];
        const kind = `${touched ? "고른 노드에 닿는 줄" : "닿지 않는 줄"}, ${tr.unitOf(id) === base ? "같은 파일" : folderOf(tr.unitOf(id)) === folderOf(base) ? "같은 폴더의 다른 파일" : "다른 폴더"}`;
        if (want !== got || row.paths[i] !== want.slice(0, want.length - shortName(g, id).length)) {
          wrong.push(`${got} (기대 ${want})`);
        } else if (!kinds.has(kind)) {
          kinds.set(kind, got);
        }
      }
    }
    return { rows: rows.size, wrong, kinds };
  };
  /** sweep의 결과에서 경우 want가 모두 나왔고 규칙과 다른 칸이 없는지 확인한다. */
  const pathsCheck = (name, found, want) => {
    const missing = want.filter((kind) => !found.kinds.has(kind));
    const text = `줄 ${found.rows}개. ${[...found.kinds].map(([kind, got]) => `${kind}: ${got}`).join(" / ")}${found.wrong.length > 0 ? `. 다른 칸 ${found.wrong.slice(0, 5).join(", ")}` : ""}`;
    if (found.wrong.length === 0 && missing.length > 0) {
      t.skip(name, `화면의 선에 ${missing.join(" · ")} 경우가 없다. ${text}`);
    } else {
      t.check(name, found.wrong.length === 0, text);
    }
  };
  const TOUCH = ["같은 파일", "같은 폴더의 다른 파일", "다른 폴더"].map((kind) => `고른 노드에 닿는 줄, ${kind}`);
  /**
   * 같은 파일, 같은 폴더의 다른 파일, 다른 폴더의 정의와 모두 이어진 함수를 골라 그 함수에 닿는 줄의 끝을 본다.
   * 사진은 `hf4-line-paths-{shotName}.png`로 남긴다.
   */
  const pathsRound = async (name, g, tr, shotName) => {
    const folderOf = (unit) => tr.title(unit).replace(/\/$/, "").split("/").slice(0, -1).join("/");
    const defined = (id) => tr.unitOf(id) !== id;
    const sorts = (id) => {
      const others = tr.edges.filter((e) => (e.source === id) !== (e.target === id) && defined(e.source) && defined(e.target)).map((e) => tr.unitOf(e.source === id ? e.target : e.source));
      const mine = tr.unitOf(id);
      return [others.some((unit) => unit === mine), others.some((unit) => unit !== mine && folderOf(unit) === folderOf(mine)), others.some((unit) => folderOf(unit) !== folderOf(mine))];
    };
    const chosen = g.nodes.find((n) => n.kind === "function" && !n.test && sorts(n.id).every(Boolean));
    if (chosen === undefined) {
      t.skip(`${name}: 고른 함수에 닿는 줄의 끝`, "같은 파일, 같은 폴더의 다른 파일, 다른 폴더의 정의와 모두 이어진 함수가 없다");
      return;
    }
    await palettePick(page, chosen.name, chosen.id);
    await waitSelected(page, chosen.id);
    await page.getByRole("button", { name: "화면 맞춤" }).click();
    await away();
    await settle(page);
    pathsCheck(`${name}: ${shortName(g, chosen.id)}를 고르면 그 함수에 닿는 줄의 끝은 같은 파일 안이면 이름만, 같은 폴더의 다른 파일이면 파일 이름부터, 다른 폴더면 갈라지는 폴더부터 적는다`, await sweep(g, tr, chosen.id), TOUCH);
    const crossing = await hittable(page, (await linesOf(page)).filter((line) => endsOfKey(line.key).some((id) => tr.within(id, chosen.id)) && endsOfKey(line.key).some((id) => tr.unitOf(id) !== tr.unitOf(chosen.id))));
    if (crossing !== null) {
      const pinned = await pinBubble(page, crossing.at);
      const box = await page.evaluate(() => (({ width }) => ({ width, cells: [...document.querySelectorAll(".line-bubble .line-cell")].filter((cell) => [cell, ...cell.children].some((each) => each.scrollWidth > each.clientWidth)).length }))(document.querySelector(".line-bubble").getBoundingClientRect()));
      t.check(`${name}: 고정한 말풍선이 창 안에 있다`, pinned !== null && pinned.rect.x >= 0 && pinned.rect.x + pinned.rect.width <= VIEW.width, `말풍선 폭 ${box.width.toFixed(0)}px, 줄 ${pinned?.rows.length}개, 경로를 줄인 칸 ${box.cells}개`);
      await page.screenshot({ path: HF4(`line-paths-${shotName}`) });
      await page.keyboard.press("Escape");
      await away();
    }
  };
  /** 접힌 폴더 안의 정의를 고른 함수의 파일 base에서 적는 글 */
  const hiddenName = (id, base = FILE) => nameFrom(graph, tree, base, id);
  const folder = "parser";

  // 고른 노드가 없으면 화면에 그린 양 끝을 적는다.
  await load(page, url, false);
  await away();
  const first = await lineBetween(FILE, folder);
  if (first === null) {
    t.check("arbiter.py에서 접힌 parser/ 폴더로 가는 선이 화면에 있다", false);
    return;
  }
  const hovered = await bubbleOver(page, first.at);
  const drawnRow = hovered?.rows.find((row) => row.key === first.line.key);
  t.check(
    "선에 마우스를 올리면 칸 이름 출발·도착·관계와 줄마다 세 칸을 적은 말풍선이 뜨고 누를 수 있는 칸이 없다",
    hovered !== null && !hovered.pinned && same(hovered.head, ["출발", "도착", "관계"]) && hovered.rows.every((row) => row.pressable.every((on) => !on)) && (await count(page, ".tooltip")) === 0,
    hovered === null ? "말풍선 없음" : hovered.rows.map(rowText).join(" / "),
  );
  t.check(
    "고른 노드가 없으면 줄이 화면에 그린 양 끝과 그 선의 관계다",
    drawnRow !== undefined && same([drawnRow.source, drawnRow.target, drawnRow.relation], [tree.title(FILE), tree.title(folder), relationWords(kindsOf(tree.origins(first.line.key)))]),
    drawnRow === undefined ? "" : rowText(drawnRow),
  );
  await shot("hover");
  const pinned = await pinBubble(page, first.at);
  t.check(
    "선이 하나여도 누르면 같은 모양의 말풍선이 그곳에 고정되고 노드는 선택되지 않는다",
    pinned !== null && pinned.pinned && same(pinned.rows.map(rowText), hovered.rows.map(rowText)) && near(pinned.rect.x, hovered.rect.x, 2) && near(pinned.rect.y, hovered.rect.y, 2) && (await selectedOf(page)) === null,
    pinned === null ? "말풍선 없음" : `줄 ${pinned.rows.length}개, 말풍선 (${Math.round(hovered.rect.x)}, ${Math.round(hovered.rect.y)}) → (${Math.round(pinned.rect.x)}, ${Math.round(pinned.rect.y)})`,
  );
  t.check("고정한 말풍선은 출발·도착 이름과 관계 칸을 누를 수 있다", pinned !== null && pinned.rows.every((row) => row.pressable.every((on) => on)), pinned?.rows.map((row) => row.pressable.join(",")).join(" / "));
  await shot("pinned");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  t.check("Esc는 말풍선을 풀고 선택을 바꾸지 않는다", (await bubbleOf(page))?.pinned !== true && (await selectedOf(page)) === null);
  await page.waitForTimeout(600);
  await pinBubble(page, first.at);
  await page.mouse.click(40, 500);
  await page.waitForTimeout(200);
  t.check("말풍선 밖을 누르면 말풍선이 풀린다", (await bubbleOf(page)) === null);

  // 방향키로 칸을 옮기고 Enter로 도착 이름을 누른다. 도착이 폴더면 그 폴더를 펼친다.
  await page.waitForTimeout(600);
  await pinBubble(page, first.at);
  const focusAt = () => page.evaluate(() => [document.activeElement?.dataset.row ?? null, document.activeElement?.dataset.column ?? null]);
  const start = await focusAt();
  await page.keyboard.press("ArrowRight");
  const right = await focusAt();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  const back = await focusAt();
  t.check("고정하면 첫 줄의 출발 칸에 초점이 가고 방향키로 칸을 옮긴다", same(start, ["0", "0"]) && same(right, ["0", "1"]) && same(back, ["0", "1"]), `${start} → ${right} → ${back}`);
  const row = (await bubbleOf(page)).rows.findIndex((each) => each.key === first.line.key);
  for (let i = 0; i < row; i += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Enter");
  const reached = await page.waitForSelector(`.reached[data-node="${folder}"]`, { timeout: 5_000 }).then(() => true, () => false);
  await away();
  await settle(page);
  t.check(
    "고른 노드가 없을 때 도착 칸의 폴더 이름을 누르면 그 폴더를 펼치고 정보 패널이 연결과 관계 줄을 적는다",
    reached && (await count(page, `${node(folder)} > .node-region`)) > 0 && (await selectedOf(page)) === null && (await headOf(page)).includes(`연결 ${shortName(graph, FILE)} → ${shortName(graph, folder)}`),
    (await headOf(page)).replaceAll("\n", " / ").slice(0, 120),
  );

  // 관계 칸은 그 선의 코드 줄 목록을 연다.
  await load(page, url, false);
  await away();
  const again = await lineBetween(FILE, folder);
  await page.waitForTimeout(600);
  await followLine(page, again.at, { row: (await bubbleOver(page, again.at)).rows.findIndex((each) => each.key === again.line.key), cell: "relation" });
  await page.waitForSelector(".info-panel-sites", { timeout: 10_000 }).catch(() => {});
  const sites = tree.origins(again.line.key).reduce((sum, edge) => sum + edge.sites.length, 0);
  t.check(
    "관계 칸을 누르면 그 선의 코드 줄 목록이 열리고 폴더는 접힌 채이며 노드는 선택되지 않는다",
    (await count(page, ".info-panel-site")) === sites && (await count(page, `${node(folder)} > .node-package`)) > 0 && (await selectedOf(page)) === null && (await bubbleOf(page)) === null,
    `코드 줄 ${await count(page, ".info-panel-site")}개, 그래프의 코드 줄 ${sites}개`,
  );

  // 함수를 고르면 접힌 폴더로 뭉친 선을 실제 상대 함수로 풀어 적고, 그 이름을 누르면 폴더를 펼쳐 그 함수를 고른다.
  /** 양 끝이 파일이나 폴더가 아닌 선. 함수 단계의 줄이 되는 선이다. */
  const defined = (from) => (e) => [e.source, e.target].every((id) => !["module", "package"].includes(from.nodes.get(id).kind));
  const callsInto = (id, box) => tree.edges.filter((e) => e.source === id && defined(tree)(e) && tree.within(e.target, box));
  const caller = graph.nodes
    .filter((n) => n.kind === "function" && n.parent === FILE)
    .sort((a, b) => new Set(callsInto(b.id, folder).map((e) => e.target)).size - new Set(callsInto(a.id, folder).map((e) => e.target)).size)[0];
  await load(page, url, false);
  await pickInTree(page, { owner: FILE, id: caller.id });
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await away();
  await settle(page);
  /** 함수 id에서 상자 box 안으로 가는 선의 줄: 실제 도착 정의마다 관계를 묶는다. */
  const functionRows = (id, box) => {
    const targets = [...new Set(callsInto(id, box).map((e) => e.target))];
    return targets.map((target) => `${shortName(graph, id).replace(/^.*\./, "")} → ${hiddenName(target)} · ${relationWords(kindsOf(callsInto(id, box).filter((e) => e.target === target)))}`);
  };
  const lump = await lineBetween(caller.id, folder);
  if (lump === null) {
    t.skip("함수를 고른 채 접힌 폴더로 가는 선의 줄이 실제 상대 함수다", `${caller.id}에서 접힌 ${folder}/로 가는 누를 수 있는 선이 없다`);
  } else {
    const stage = await bubbleOver(page, lump.at);
    const mine = stage.rows.filter((each) => each.key === lump.line.key);
    t.check(
      "함수를 고른 채 접힌 폴더로 가는 선의 줄은 실제 상대 함수이고 모두 누를 수 있으며, 다른 폴더의 함수는 갈라지는 폴더부터의 파일 경로를 함께 적는다",
      mine.length > 0 && same(mine.map(rowText).sort(), functionRows(caller.id, folder).sort()) && mine.every((each) => each.paths[1].endsWith(".py::") && each.paths[0] === ""),
      mine.map(rowText).join(" / "),
    );
    t.check("함수를 고른 채로는 폴더가 저절로 열리지 않는다", (await count(page, `${node(folder)} > .node-package`)) > 0);
    await shot("function");
    await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await shot("function-dark");
    await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
    const at = stage.rows.findIndex((each) => each.key === lump.line.key);
    const wanted = stage.rows[at].nodes[1];
    await followLine(page, lump.at, { row: at });
    await waitSelected(page, wanted).catch(() => {});
    await away();
    const head = await headOf(page);
    t.check(
      "그 줄의 도착 이름을 누르면 폴더를 펼치고 그 함수를 고르며 지나온 선이 굵게 남는다",
      (await selectedOf(page)) === wanted && (await count(page, `${node(folder)} > .node-region`)) > 0 && (await viaLines(page)).some((line) => line.via) && head.includes(`연결 ${shortName(graph, caller.id)} → ${shortName(graph, wanted)}`),
      `선택 ${await selectedOf(page)}, ${head.replaceAll("\n", " / ").slice(0, 120)}`,
    );
    await shot("function-arrived");

    // 줄의 끝은 기준 파일에서 갈라지는 곳부터 적는다.
    await pathsRound("sync-engine", graph, tree, "se");
    await pickInTree(page, { owner: FILE, id: caller.id });
    await page.getByRole("button", { name: "화면 맞춤" }).click();
    await away();
    await settle(page);
    const loose = await sweep(graph, tree, caller.id);
    pathsCheck("고른 함수에 닿지 않는 줄은 두 끝이 서로 갈라지는 곳부터 적는다", { ...loose, kinds: new Map([...loose.kinds].filter(([kind]) => kind.startsWith("닿지 않는"))) }, ["닿지 않는 줄, 같은 파일", "닿지 않는 줄, 다른 폴더"]);
  }

  // 파일을 고르면 접힌 폴더로 뭉친 선의 상대 끝을 그 안의 파일로 풀어 적는다.
  await load(page, url, false);
  await pick(page, FILE);
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await away();
  await settle(page);
  const fileLine = await lineBetween(FILE, folder);
  if (fileLine === null) {
    t.skip("파일을 고른 채 접힌 폴더로 가는 선의 줄이 파일 이름이다", "arbiter.py에서 접힌 parser/로 가는 누를 수 있는 선이 없다");
  } else {
    const crossing = tree.edges.filter((e) => tree.within(e.source, FILE) && tree.within(e.target, folder));
    const files = [...new Set(crossing.map((e) => tree.unitOf(e.target)))];
    const want = files.map((file) => `${tree.title(FILE)} → ${tree.title(file)} · ${relationWords(kindsOf(crossing.filter((e) => tree.unitOf(e.target) === file)))}`);
    const stage = await bubbleOver(page, fileLine.at);
    const mine = stage.rows.filter((each) => each.key === fileLine.line.key);
    t.check(
      "파일을 고른 채 접힌 폴더로 가는 선의 줄은 그 폴더 안의 파일마다 하나이고 앞쪽 폴더 경로를 함께 적는다",
      same(mine.map(rowText).sort(), want.sort()) && mine.every((each) => each.paths[1] === tree.title(folder)),
      mine.map(rowText).join(" / "),
    );
    await shot("file");
    const at = stage.rows.findIndex((each) => each.key === fileLine.line.key);
    const wanted = stage.rows[at].nodes[1];
    await followLine(page, fileLine.at, { row: at });
    await waitSelected(page, wanted).catch(() => {});
    await away();
    t.check(
      "그 줄의 도착 이름을 누르면 폴더를 펼치고 그 파일을 고른다",
      (await selectedOf(page)) === wanted && tree.nodes.get(wanted).kind === "module" && (await count(page, `${node(folder)} > .node-region`)) > 0,
      `선택 ${await selectedOf(page)}`,
    );
  }

  // 관계 글 세 가지와 선 위의 수. 폴더를 펼친 처음 화면의 모든 선을 /api/graph에서 센 값과 견준다.
  await load(page);
  await away();
  const drawnLines = await page.evaluate(() => [...document.querySelectorAll(".react-flow__edge .edge[data-key]:not(.edge-trunk)")].map((edge) => ({ key: edge.dataset.key, sites: Number(edge.dataset.sites) })));
  const wrong = drawnLines.filter((line) => line.sites !== countedSites(tree.origins(line.key)));
  t.check(
    `처음 화면의 선 ${drawnLines.length}개마다 선의 수가 /api/graph에서 센 실행 관계(호출·생성·전달·데코레이터·상속·오버라이드)의 수와 같다`,
    drawnLines.length > 0 && wrong.length === 0,
    wrong.slice(0, 3).map((line) => `${line.key}: 화면 ${line.sites}, 그래프 ${countedSites(tree.origins(line.key))}`).join(" / "),
  );
  const sums = await trunksOf(page, "in");
  t.check(
    `들어오는 줄기 ${sums.length}개의 합계가 가지의 실행 관계 수를 더한 값이고 0이나 1이면 적지 않는다`,
    sums.every((trunk) => trunk.sum === (trunk.sites >= 2 ? trunk.sites : null)) && sums.every((trunk) => trunk.sites === trunk.branches.reduce((sum, key) => sum + countedSites(tree.origins(key)), 0)),
    sums.filter((trunk) => trunk.sum !== (trunk.sites >= 2 ? trunk.sites : null)).slice(0, 3).map((trunk) => `${trunk.key}: 적힌 수 ${trunk.sum}, 합 ${trunk.sites}`).join(" / "),
  );
  /** 관계 글의 세 가지 경우와 그 글. 처음 화면에 그런 선이 없으면 순환이 있는 고정 레포의 화면에서 찾는다. */
  const TEXTS = { "세는 관계": /^\S+ \d+곳( · \S+ \d+곳)*$/, 타입: /^타입에만 쓰임$/, import: /^import 관계만 있음$/ };
  const left = new Set(Object.keys(TEXTS));
  /** lines 가운데 가운데 점에 마우스를 올렸을 때 말풍선에 줄이 적히는 첫 선과 그 줄. 종류가 다른 선과 겹쳐 그려진 선은 맨 위 요소가 아니어도 줄이 적힌다. */
  const over = async (lines) => {
    for (const line of lines.slice(0, 12)) {
      const at =
        (await edgePoint(page, line.key)) ??
        (await page.evaluate((key) => {
          const path = [...document.querySelectorAll(".react-flow__edge .edge[data-key]")].find((edge) => edge.dataset.key === key).querySelector(".edge-line");
          const middle = path.getPointAtLength(path.getTotalLength() / 2);
          const point = new DOMPoint(middle.x, middle.y).matrixTransform(path.getScreenCTM());
          return document.elementFromPoint(point.x, point.y)?.closest(".react-flow__edge") == null ? null : { x: point.x, y: point.y };
        }, line.key));
      const row = at === null ? undefined : (await bubbleOver(page, at))?.rows.find((each) => each.key === line.key);
      if (row !== undefined) {
        return { line, at, row };
      }
      await away();
    }
    return null;
  };
  for (const base of [url, cycleUrl]) {
    if (base === null || left.size === 0) {
      continue;
    }
    const from = base === url ? tree : ancestry(await api("/api/graph", base));
    if (base !== url) {
      await load(page, base);
      await away();
    }
    for (const name of [...left]) {
      const found = await over((await linesOf(page)).filter((line) => !line.below && TEXTS[name].test(relationWords(kindsOf(from.origins(line.key))))));
      if (found === null) {
        continue;
      }
      left.delete(name);
      const seen = found.row;
      if (name !== "세는 관계") {
        await shot(name === "타입" ? "type" : "import");
      }
      await away();
      t.check(
        `${name}${name === "세는 관계" ? "가 있는 선은 그 종류만 수와 함께 적는다" : "만 있는 선은 수 없이 적는다"}`,
        seen !== undefined && seen.relation === relationWords(kindsOf(from.origins(found.line.key))) && !/import \d|타입 \d/.test(seen.relation),
        seen === undefined ? "" : `${rowText(seen)} (원래 선 ${JSON.stringify(kindsOf(from.origins(found.line.key)))})`,
      );
    }
  }
  for (const name of left) {
    t.skip(`${name}만 있는 선의 관계 글`, "화면에 그런 누를 수 있는 선이 없다");
  }

  // 함수를 고른 채 import만 있는 선은 풀어 적을 끝이 없어 누를 수 없는 안내 줄 하나다.
  await load(page);
  await pick(page, FILE);
  await pick(page, FUNCTION);
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await away();
  await settle(page);
  let bare = null;
  for (const line of (await linesOf(page)).filter((each) => each.key.endsWith("|import") && each.key.startsWith(`${FUNCTION}|`))) {
    const at = await edgePoint(page, line.key);
    const seen = at === null ? null : await bubbleOver(page, at);
    if (seen !== null && seen.rows.length === 1 && seen.rows[0].key === line.key) {
      bare = { line, at, seen };
      break;
    }
    await away();
  }
  if (bare === null) {
    t.skip("함수를 고른 채 import만 있는 선의 줄", "고른 함수의 import 선 하나만 지나는 누를 수 있는 점이 없다");
  } else {
    await shot("function-bare");
    const held = await pinBubble(page, bare.at);
    t.check(
      "함수를 고른 채 import만 있는 선은 관계 글을 적은 줄 하나이고 출발·도착 이름을 누를 수 없다",
      held !== null && held.rows.length === 1 && held.rows[0].relation === "import 관계만 있음" && same(held.rows[0].pressable.slice(0, 2), [false, false]) && (await selectedOf(page)) === FUNCTION,
      held === null ? "" : `${rowText(held.rows[0])}, 누를 수 있는 칸 ${held.rows[0].pressable}`,
    );
    await page.keyboard.press("Escape");
  }

  // 함수를 고른 채 타입에만 쓰이는 관계의 줄도 누를 수 있다.
  let typed = null;
  for (const line of (await linesOf(page)).filter((each) => each.key.endsWith("|type") && each.key.startsWith(`${FUNCTION}|`))) {
    const at = await edgePoint(page, line.key);
    const seen = at === null ? null : await bubbleOver(page, at);
    if (seen !== null && seen.rows.length === 1 && seen.rows[0].key === line.key) {
      typed = { line, at };
      break;
    }
    await away();
  }
  if (typed === null) {
    t.skip("함수를 고른 채 타입에만 쓰이는 선의 줄", "고른 함수의 타입 선 하나만 지나는 누를 수 있는 점이 없다");
  } else {
    const held = await pinBubble(page, typed.at);
    const wanted = endsOfKey(typed.line.key)[1];
    await pressCell(page, 0, "target");
    await waitSelected(page, wanted).catch(() => {});
    t.check(
      "함수를 고른 채 타입에만 쓰이는 선의 줄은 `타입에만 쓰임`이고 도착 이름을 누르면 그 정의로 간다",
      held.rows[0].relation === "타입에만 쓰임" && held.rows[0].pressable.every((on) => on) && (await selectedOf(page)) === wanted,
      `${rowText(held.rows[0])}, 선택 ${await selectedOf(page)}`,
    );
  }

  // 경로 고정 중에는 경로 밖 이름을 눌러도 가지 않는다.
  await load(page);
  await pin(page);
  await watchFlashes(page);
  await away();
  const outside = await hittable(page, (await linesOf(page)).filter((line) => line.tone === "muted" && !line.below));
  if (outside === null) {
    t.skip("경로 고정 중에 걸음이 아닌 선의 이름 클릭", "누를 수 있는 걸음 밖의 선이 없다");
  } else {
    const flashes = await flashesOf(page);
    await followLine(page, outside.at);
    await page.waitForTimeout(300);
    t.check(
      "경로 고정 중에 걸음이 아닌 선의 도착 이름을 누르면 가지 않고 안내 줄이 뒤집힌다",
      (await pinnedOf(page)) && (await flashesOf(page)) === flashes + 1 && (await bubbleOf(page))?.pinned !== true,
      `뒤집힘 ${(await flashesOf(page)) - flashes}번`,
    );
    await page.waitForSelector(".finder-pinned[data-flash]", { state: "detached", timeout: 3_000 }).catch(() => {});
  }

  // 함수 시점 뷰의 선도 같은 말풍선을 쓴다.
  await load(page);
  await pick(page, FILE);
  await clickNode(page, FUNCTION, 2);
  await page.waitForSelector(".node-call", { timeout: 30_000 });
  await settle(page);
  await away();
  const callLine = await hittable(page, await linesOf(page));
  const callTip = await bubbleOver(page, callLine.at);
  await shot("call");
  const calls = await sweep(graph, tree, null);
  t.check("함수 시점 뷰의 줄도 두 끝이 서로 갈라지는 곳부터 적는다", calls.rows > 0 && calls.wrong.length === 0, `줄 ${calls.rows}개. ${[...calls.kinds].map(([kind, got]) => `${kind}: ${got}`).join(" / ")}${calls.wrong.length > 0 ? `. 다른 칸 ${calls.wrong.slice(0, 5).join(", ")}` : ""}`);
  await bubbleOver(page, callLine.at);
  const callRow = callTip.rows.findIndex((each) => each.key === callLine.line.key);
  const callEnd = endsOfKey(callLine.line.key).find((id) => id !== FUNCTION);
  await followLine(page, callLine.at, { row: callRow, cell: endsOfKey(callLine.line.key)[0] === callEnd ? "source" : "target" });
  await waitSelected(page, callEnd).catch(() => {});
  t.check(
    "함수 시점 뷰의 선도 세 칸 말풍선을 띄우고 이름을 누르면 그 함수를 고른다",
    same(callTip.head, ["출발", "도착", "관계"]) && callRow >= 0 && new RegExp(`^${RELATIONS}$`).test(callTip.rows[callRow].relation) && (await selectedOf(page)) === callEnd && (await count(page, ".node-call")) > 0,
    `${rowText(callTip.rows[Math.max(callRow, 0)])}, 선택 ${await selectedOf(page)}`,
  );

  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포에서 함수를 고른 채 접힌 폴더로 가는 선", "--wide-url을 주지 않았다");
    return;
  }
  const wideGraph = await api("/api/graph", wideUrl);
  const wide = ancestry(wideGraph);
  const top = WIDE_LINE_FOLDER.open[0];
  /** top 바로 아래 파일의 함수와 그 함수가 닿는 top 바로 아래의 폴더 */
  const pairs = wideGraph.nodes
    .filter((n) => n.kind === "function" && !n.test && wide.nodes.get(n.parent)?.parent === top)
    .flatMap((fn) => wideGraph.nodes.filter((box) => box.kind === "package" && box.parent === top).map((box) => ({ fn, box, edges: wide.edges.filter((e) => e.source === fn.id && defined(wide)(e) && wide.within(e.target, box.id)) })))
    .filter((pair) => pair.edges.length > 0)
    .sort((a, b) => new Set(b.edges.map((e) => e.target)).size - new Set(a.edges.map((e) => e.target)).size);
  await page.goto(wideUrl);
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  await openFolder(page, top);
  let wideDone = false;
  for (const { fn, box, edges } of pairs.slice(0, 5)) {
    await pickInTree(page, { owner: fn.parent, id: fn.id });
    await away();
    const found = await lineBetween(fn.id, box.id);
    if (found === null) {
      continue;
    }
    const seen = (await bubbleOver(page, found.at)).rows.filter((each) => each.key === found.line.key);
    const want = [...new Set(edges.map((e) => e.target))].map(
      (target) => `${shortName(wideGraph, fn.id)} → ${nameFrom(wideGraph, wide, wide.unitOf(fn.id), target)} · ${relationWords(kindsOf(edges.filter((e) => e.target === target)))}`,
    );
    await shot("mdp-function");
    t.check(`mdp: 함수 ${shortName(wideGraph, fn.id)}를 고른 채 접힌 ${wide.title(box.id)}로 가는 선의 줄이 실제 상대 함수다`, same(seen.map(rowText).sort(), want.sort()), seen.map(rowText).join(" / "));
    const wanted = seen[0].nodes[1];
    await followLine(page, found.at, { row: (await bubbleOf(page)).rows.findIndex((each) => each.key === found.line.key) });
    await waitSelected(page, wanted).catch(() => {});
    t.check("mdp: 그 줄의 도착 이름을 누르면 폴더를 펼치고 그 함수를 고른다", (await selectedOf(page)) === wanted && (await count(page, `${node(box.id)} > .node-region`)) > 0, `선택 ${await selectedOf(page)}`);
    await away();
    await shot("mdp-arrived");
    wideDone = true;
    break;
  }
  if (!wideDone) {
    t.skip("mdp: 함수를 고른 채 접힌 폴더로 가는 선", "그런 누를 수 있는 선이 없다");
  }

  // 타입에만 쓰이는 클래스를 고르고 들어오는 선을 누르면 줄의 출발 이름이 눌리고 그 정의로 간다.
  const typeOnly = wideGraph.nodes
    .filter((n) => (n.kind === "class" || n.kind === "dataclass") && !n.test)
    .map((n) => ({ node: n, into: wide.edges.filter((e) => e.target === n.id) }))
    .filter(({ into }) => into.length >= 2 && into.every((e) => e.kind === "type"))
    .sort((a, b) => b.into.length - a.into.length);
  let typeDone = false;
  for (const { node: used } of typeOnly.slice(0, 4)) {
    await page.goto(wideUrl);
    await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
    await settle(page);
    await palettePick(page, used.name, used.id);
    await waitSelected(page, used.id).catch(() => {});
    await away();
    await settle(page);
    const found = await hittable(page, (await linesOf(page)).filter((line) => endsOfKey(line.key)[1] === used.id));
    if (found === null) {
      continue;
    }
    const held = await pinBubble(page, found.at);
    await shot("mdp-type");
    const from = held.rows[0].nodes[0];
    await pressCell(page, 0, "source");
    await waitSelected(page, from).catch(() => {});
    t.check(
      `mdp: 타입에만 쓰이는 ${used.name}을 고르고 들어오는 선을 누르면 줄이 모두 \`타입에만 쓰임\`이고 눌리며, 출발 이름을 누르면 그 정의로 간다`,
      held.rows.length > 0 && held.rows.every((row) => row.relation === "타입에만 쓰임" && row.pressable.every((on) => on) && row.nodes[1] === used.id) && (await selectedOf(page)) === from,
      `줄 ${held.rows.length}개: ${held.rows.slice(0, 3).map(rowText).join(" / ")}, 선택 ${await selectedOf(page)}`,
    );
    typeDone = true;
    break;
  }
  if (!typeDone) {
    t.skip("mdp: 타입에만 쓰이는 클래스로 들어오는 선의 줄", "그런 클래스로 들어오는 누를 수 있는 선이 없다");
  }

  // 폴더가 여러 겹인 레포에서도 줄의 끝을 기준 파일에서 갈라지는 곳부터 적는다.
  await page.keyboard.press("Escape");
  await pathsRound("mdp", wideGraph, wide, "mdp");
}

// ── 4단계: 선의 합류 ─────────────────────────────────────────────

/**
 * end 쪽 줄기마다 키, 줄기가 붙은 노드(target), 가지의 수(count), 적힌 합계(sum. 나가는 줄기는 null), 가지의 sites 수 합(sites), 가지의 키,
 * 합류점이나 갈림점의 수, 진하기, 선이 가는 방향의 끝점(그래프 좌표. 들어오는 줄기는 도착 노드에 닿는 점), 누름 영역의 커서.
 * end는 "in"(들어오는 줄기)이나 "out"(나가는 줄기)이다.
 */
const trunksOf = (page, end = "in") =>
  page.evaluate((side) =>
    [...document.querySelectorAll(`.react-flow__edge .edge-trunk[data-end="${side}"]`)].map((trunk) => {
      const line = trunk.querySelector(".edge-line");
      const end = line.getPointAtLength(line.getTotalLength());
      const branches = [...document.querySelectorAll(`.edge[data-trunk-${side}="${CSS.escape(trunk.dataset.key)}"]`)];
      return {
        key: trunk.dataset.key,
        target: trunk.dataset.node,
        count: branches.length,
        sum: trunk.querySelector(".edge-trunk-count") === null ? null : Number(trunk.querySelector(".edge-trunk-count").textContent),
        sites: branches.reduce((total, edge) => total + Number(edge.dataset.sites), 0),
        branches: branches.map((edge) => edge.dataset.key),
        joints: trunk.querySelectorAll(`.edge-joint-${side}`).length,
        arrows: trunk.querySelectorAll(".edge-line[marker-end]").length,
        tone: trunk.classList.contains("tone-strong") ? "strong" : "muted",
        opacity: Number(getComputedStyle(trunk).opacity),
        width: parseFloat(getComputedStyle(line).strokeWidth),
        pointed: trunk.hasAttribute("data-pointed"),
        step: trunk.hasAttribute("data-step"),
        layer: getComputedStyle(trunk.closest("svg")).zIndex,
        start: { x: line.getPointAtLength(0).x, y: line.getPointAtLength(0).y },
        end: { x: end.x, y: end.y },
        cursor: getComputedStyle(trunk.querySelector(".edge-hit")).cursor,
      };
    }),
    end,
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
  const off = (id) => veiled(nodes.get(id));
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
  const arrows = await page.evaluate(() => [...document.querySelectorAll(".edge[data-trunk-in]:not([data-whole]) .edge-line[marker-end]")].length);
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

/** 접은 처음 화면과 파일을 고른 화면에서 나가는 줄기의 구성과 갈림점을 보고, 나가는 줄기에 마우스를 올리고 누른다. */
async function mergeOut(t, page) {
  await asidePanel(page);
  await load(page, url, false);
  const marksOf = () =>
    page.evaluate(() => {
      const read = (selector) =>
        [...document.querySelectorAll(`.react-flow__edge ${selector}`)].map((mark) => ({
          x: mark.cx.baseVal.value,
          y: mark.cy.baseVal.value,
          fill: getComputedStyle(mark).fill,
          stroke: getComputedStyle(mark).stroke,
          line: getComputedStyle(mark.closest(".edge").querySelector(".edge-line")).stroke,
        }));
      return { forks: read(".edge-joint-out"), joints: read(".edge-joint-in") };
    });
  const built = async (name) => {
    const [lines, stems, boxes, marks] = [await linesOf(page), await trunksOf(page, "out"), await flowBoxes(page), await marksOf()];
    const surface = (await colorOf(page, "--surface")).rgb;
    const onSide = (stem) => {
      const box = boxes[stem.target];
      return box !== undefined && (near(stem.start.x, box.x + box.width) || near(stem.start.x, box.x)) && stem.start.y > box.y - 1 && stem.start.y < box.y + box.height + 1;
    };
    t.check(
      `${name}: 나가는 줄기 ${stems.length}개마다 화살촉과 수가 없고, 든 선이 모두 그 줄기의 출발 노드에서 나가며, 줄기가 출발 노드의 옆 변에서 시작하고 굵기는 선 하나와 같다`,
      stems.length > 0 && stems.every((stem) => stem.sum === null && stem.arrows === 0 && stem.count >= 1 && stem.branches.every((key) => endsOfKey(key)[0] === stem.target) && onSide(stem) && near(stem.width, 1.5, 0.01)),
      stems.map((stem) => `${stem.target} ${stem.count}`).join(", "),
    );
    const starts = new Map();
    for (const line of lines.filter((each) => !each.below)) {
      const at = `${endsOfKey(line.key)[0]}@${Math.round(line.start.x)},${Math.round(line.start.y)}`;
      starts.set(at, [...(starts.get(at) ?? []), line]);
    }
    const fanned = [...starts.values()].filter((group) => new Set(group.map((line) => endsOfKey(line.key)[1])).size >= 2);
    // 출발과 도착이 같은 선끼리는 경로 전체가 겹쳐 들어오는 줄기에만 든다.
    const loose = fanned.flatMap((group) => group.filter((line) => line.out === null && line.trunk === null));
    t.check(
      `${name}: 한 노드의 같은 점에서 도착이 다른 선이 나가는 ${fanned.length}곳마다 그 선이 나가는 줄기에 든다`,
      fanned.length > 0 && loose.length === 0,
      loose.map((line) => line.key).slice(0, 4).join(", "),
    );
    const alone = lines.filter((line) => line.out !== null && line.trunk === null);
    t.check(`${name}: 나가는 줄기에만 든 선 ${alone.length}개는 가지 끝에 화살촉을 단다`, alone.every((line) => line.arrow));
    const apart = marks.forks.every((fork) => !marks.joints.some((joint) => near(fork.x, joint.x) && near(fork.y, joint.y)));
    t.check(
      `${name}: 갈림점 ${marks.forks.length}개는 바탕색으로 채우고 줄기 색 테두리를 두른 빈 원, 합류점 ${marks.joints.length}개는 줄기 색으로 채운 원이고 두 점은 같은 곳에 놓이지 않는다`,
      marks.forks.length > 0 && marks.joints.length > 0 && marks.forks.every((fork) => fork.fill === surface && fork.stroke === fork.line) && marks.joints.every((joint) => joint.fill === joint.line) && apart,
    );
  };
  await built("접은 처음 화면");

  const ink = (await colorOf(page, "--ink")).rgb;
  const spot = await sharedSpot(page);
  await page.mouse.move(spot.x + 1, spot.y + 1);
  await page.mouse.move(spot.x, spot.y);
  await page.waitForSelector(".edge-trunk[data-pointed]", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const stem = (await trunksOf(page, "out")).find((each) => each.key === spot.trunk);
  const rows = await bubbleRows(page);
  t.check(
    `선 ${spot.keys.length}개가 든 나가는 줄기의 출발 노드 쪽에 올리면 줄기와 그 선이 모두 한 단계 진한 muted 100%로 다른 선 위의 층에 그려지고, 말풍선은 선마다 한 줄이다`,
    stem.pointed && stem.tone === "muted" && stem.opacity === 1 && stem.layer === "5" && same(await pointedLines(page), spot.keys) && (await linesOf(page)).filter((line) => line.pointed).every((line) => line.tone === "muted" && line.opacity === 1) &&
      rows.length === spot.keys.length && rows.every((row) => new RegExp(` → .+ · ${RELATIONS}$`).test(row)),
    rows.join(" / "),
  );
  t.check("나가는 줄기 위에는 수를 적지 않는다", (await count(page, '.edge-trunk[data-end="out"] text')) === 0);
  await t.shot();
  await page.mouse.click(spot.x, spot.y);
  await page.waitForSelector(".line-bubble[data-pinned]", { timeout: 3_000 }).catch(() => {});
  const menu = await menuOf(page);
  t.check(
    "나가는 줄기를 누르면 노드를 고르지 않고 그 줄기에 든 선의 말풍선을 고정한다",
    menu !== null && same(menu.map((item) => item.key).sort(), spot.keys) && (await selectedOf(page)) === null,
    `항목 ${menu?.length ?? 0}개`,
  );
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5);
  await rest(page);

  await page.click(".legend-button");
  t.check(
    "범례가 갈림 견본(빈 원)과 합류 견본(채운 원)을 하나씩 보여 준다",
    (await count(page, ".legend .edge-joint-out")) === 1 && (await count(page, ".legend .edge-joint-in")) === 1 && (await page.evaluate(() => document.querySelector(".legend").textContent.includes("갈림"))),
  );
  await page.click(".legend-button");

  await pickFile(page, FILE);
  await page.mouse.move(5, 5);
  await rest(page);
  await built("파일을 고른 화면");
  await page.screenshot({ path: join(OUT, "s4-merge-out-file.png") });

  await page.getByRole("button", { name: "어두운 화면" }).click();
  await rest(page);
  const [dark, surface] = [await marksOf(), await colorOf(page, "--surface")];
  t.check("어두운 화면의 갈림점은 어두운 바탕색으로 채운다", surface.value === DARK.surface && dark.forks.length > 0 && dark.forks.every((fork) => fork.fill === surface.rgb && fork.stroke === fork.line));
  await page.screenshot({ path: join(OUT, "s4-merge-out-file-dark.png") });
}

/** 가지와 줄기에 마우스를 올린다. */
async function mergeHover(t, page) {
  await asidePanel(page);
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
  const branchTip = (await bubbleRows(page)).join("\n");
  t.check(
    "가지에 올리면 그 선 하나가 출발부터 도착 노드까지 한 단계 진한 muted 100%로 다른 선 위의 층에 그려지고 줄기와 다른 가지는 그대로다",
    over.pointed && whole && over.tone === "muted" && over.opacity === 1 && over.layer === "5" && near(over.end.x, trunk.end.x) && near(over.end.y, trunk.end.y) &&
      lines.filter((line) => line.key !== over.key).every((line) => !line.pointed) && (await trunksOf(page)).every((each) => !each.pointed),
    `올린 선 ${over.key}, 전체 경로 ${whole}, 층 ${over.layer}`,
  );
  t.check("가지의 말풍선은 그 선의 출발·도착·관계 한 줄이다", new RegExp(`^.+ → .+ · ${RELATIONS}$`).test(branchTip), branchTip);

  const spot = await trunkPoint(page, trunk.key);
  await page.mouse.move(spot.x, spot.y - 1);
  await page.mouse.move(spot.x, spot.y);
  await page.waitForSelector(".edge-trunk[data-pointed]", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const pointed = (await trunksOf(page)).find((each) => each.key === trunk.key);
  const members = (await linesOf(page)).filter((line) => line.trunk === trunk.key);
  const tipRows = await bubbleRows(page);
  t.check(
    `줄기에 올리면 줄기와 가지 ${trunk.count}개가 모두 한 단계 진한 muted 100%로 다른 선 위의 층에 그려진다`,
    pointed.pointed && pointed.tone === "muted" && pointed.opacity === 1 && pointed.layer === "5" && members.length === trunk.count && members.every((line) => line.pointed && line.tone === "muted" && line.opacity === 1),
    `줄기 ${pointed.tone} ${pointed.opacity}, 올린 가지 ${members.filter((line) => line.pointed).length}개`,
  );
  t.check(
    "도착 노드 앞 줄기의 말풍선은 그 구간을 지나는 선을 한 줄씩 적는다",
    tipRows.length === trunk.count && tipRows.every((row) => new RegExp(` → .+ · ${RELATIONS}$`).test(row)),
    tipRows.join(" / "),
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
  const tree = ancestry(await api("/api/graph"));
  const along = trunk.branches.flatMap((key) => tree.origins(key));
  t.check("정보 구역의 관계 줄이 줄기에 든 선의 관계를 적고 목록의 코드 줄 수가 그 선의 코드 줄 수와 같다", head.includes(`관계 ${linksWords(along).relation}`) && total === linksWords(along).total + linksWords(along).rest, `코드 줄 ${total}개, ${head.replaceAll("\n", " / ").slice(-80)}`);
  await t.shot();
  await page.click(".info-panel-site");
  await page.waitForSelector(".info-panel .monaco-editor .code-range", { timeout: 30_000 }).catch(() => {});
  t.check("목록의 줄을 누르면 코드 뷰어가 그 줄을 칠해 보인다", (await count(page, ".info-panel .monaco-editor .code-range")) > 0);

  await page.waitForTimeout(600);
  const held = await pinBubble(page, spot);
  t.check("줄기를 누르면 그 구간을 지나는 선마다 한 줄인 말풍선이 고정된다", held !== null && held.pinned && held.rows.length > 0 && held.rows.every((row) => trunk.branches.includes(row.key)), `줄 ${held?.rows.length ?? 0}개, 가지 ${trunk.count}개`);
  await pressCell(page, 0, "target");
  await waitSelected(page, trunk.target).catch(() => {});
  t.check("말풍선의 도착 이름을 누르면 도착 노드가 선택된다", (await selectedOf(page)) === trunk.target, `선택 ${await selectedOf(page)}`);
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

/** 경로 고정과 순환 의존 표시가 줄기 위에서 그리는 선을 본다. */
async function mergePin(t, page) {
  await asidePanel(page);
  await load(page);
  await pin(page);
  const ink = (await colorOf(page, "--ink")).rgb;
  const [steps, trunks] = [await routeLinesOf(page), await trunksOf(page)];
  const stepKeys = new Set(steps.map((line) => line.key));
  const joined = await page.evaluate(() =>
    [...document.querySelectorAll(".edge[data-route][data-trunk-in]")].map((edge) => ({ key: edge.dataset.key, whole: edge.hasAttribute("data-whole") })),
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
  await followLine(page, spot);
  await page.mouse.move(5, 5);
  await rest(page);
  t.check(
    "걸음이 지나지 않는 줄기의 말풍선에서 도착 이름을 눌러도 고정과 보이는 노드가 그대로이고 안내 줄이 뒤집힌다",
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
      return { key: edge.dataset.key, joined: edge.dataset.trunkIn !== undefined, whole: edge.hasAttribute("data-whole"), stroke: getComputedStyle(line).stroke, arrow: line.hasAttribute("marker-end") };
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
    graph.nodes.filter((n) => n.parent === box).sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0)).map((n) => n.id),
  );

/**
 * 상자 box의 바로 아래 자식을 상자 밖과 선을 주고받는 자식(outer)과 그 밖의 자식(inner)으로 가른다. 테스트 코드와의 선은 세지 않고,
 * 외부 노드와의 선과 외부 값 변수는 external이 참일 때만 센다. 진입점은 outer에 넣는다. 자식은 소스 정의 줄 순서다.
 */
function stagesOf(graph, box, external = false) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const off = (id) => veiled(nodes.get(id), external);
  const within = (id, ancestor) => {
    for (let at = nodes.get(id); at !== undefined; at = at.parent === null ? undefined : nodes.get(at.parent)) {
      if (at.id === ancestor) {
        return true;
      }
    }
    return false;
  };
  const kids = graph.nodes.filter((n) => n.parent === box && !off(n.id)).sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0));
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

/** 안쪽 자식이 둘 이상이고 밖과 이어진 자식이 있는 파일. 손잡이가 생기는 파일이고 안쪽 자식이 많은 파일이 앞에 온다. */
function packedFiles(graph) {
  return graph.nodes
    .filter((n) => n.kind === "module" && !n.test)
    .map((n) => ({ id: n.id, path: n.path, ...stagesOf(graph, n.id) }))
    .filter((file) => file.inner.length >= 2 && file.outer.length >= 1)
    .sort((a, b) => b.inner.length - a.inner.length);
}

/** 손잡이가 생기는 파일 가운데 want에 맞고 안쪽 자식이 가장 많은 파일 */
function packedFile(graph, want = () => true) {
  return packedFiles(graph).filter(want)[0];
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

/** 상자의 배지와 정보 패널의 미확인 호출 수를 본다. */
async function badge(t, page) {
  const graph = await api("/api/graph");
  await load(page, url, false);
  const shownBadges = await page.evaluate(() =>
    [...document.querySelectorAll(".node-face .badge-lines")].map((badge) => ({ id: badge.closest(".react-flow__node").dataset.id.replace(/#face$/, ""), text: badge.textContent })),
  );
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  t.check(
    `접힌 파일 상자 ${shownBadges.filter((b) => nodes.get(b.id).kind === "module").length}개의 배지는 그 파일의 줄 수, 접힌 폴더 상자의 배지는 그 폴더 아래 파일의 줄 수 합이다`,
    shownBadges.length > 1 && shownBadges.some((b) => nodes.get(b.id).kind === "package") && shownBadges.every((b) => b.text === kilo(locOf(graph, b.id))),
    shownBadges.map((b) => `${b.id} ${b.text}`).join(", "),
  );
  const boxesShown = await count(page, ".react-flow__node > .node-body:is(.node-module, .node-package)");
  t.check("접힌 상자마다 배지가 하나다", shownBadges.length === boxesShown, `상자 ${boxesShown}개, 배지 ${shownBadges.length}개`);
  t.check(
    "미확인 호출 수 배지와 접힌 파일 상자 아래의 함수 수 글자가 없다",
    (await count(page, ".badge-unresolved")) === 0 && (await count(page, ".node-below")) === 0 && !(await page.evaluate(() => document.querySelector(".react-flow__viewport").textContent.includes("?"))),
  );
  const tip = await tipOver(page, `${face(FILE)} .badge-lines`);
  t.check("파일 상자의 배지에 올리면 줄 수와 안에 든 함수·클래스·변수 수를 적는다", tip === sizeTipOf(graph, FILE) && tip.includes("안에 든 함수·클래스·변수"), tip);
  const folderTip = await tipOver(page, `${face("parser")} .badge-lines`);
  t.check("폴더 상자의 배지에 올리면 줄 수 합과 안에 든 파일 수를 적는다", folderTip === sizeTipOf(graph, "parser") && folderTip.includes("안에 든 파일"), folderTip);
  await t.shot();

  const sum = (id) => graph.nodes.filter((n) => !n.test && (n.id === id || n.id.startsWith(`${id}:`) || n.id.startsWith(`${id}.`))).reduce((total, n) => total + n.unresolved, 0);
  await pickFile(page, FILE);
  t.check(`파일을 고르면 정보 패널의 정보 구역이 안의 합계를 "미확인 호출 ${sum(FILE)}곳"으로 적는다`, sum(FILE) > 0 && (await headOf(page)).includes(`미확인 호출 ${sum(FILE)}곳`), (await headOf(page)).replaceAll("\n", " / "));
  t.check("펼친 파일 상자도 같은 줄 수 배지를 단다", (await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? null, `${face(FILE)} .node-module-open > .badge-lines`)) === kilo(locOf(graph, FILE)));
  const fn = graph.nodes.find((n) => n.parent === FILE && n.unresolved > 0);
  await page.click(`.tree-row.tree-symbol[data-node="${fn.id}"]`);
  await waitSelected(page, fn.id);
  t.check(`함수를 고르면 정보 구역이 그 함수의 "미확인 호출 ${fn.unresolved}곳"을 적는다`, (await headOf(page)).includes(`미확인 호출 ${fn.unresolved}곳`), (await headOf(page)).replaceAll("\n", " / "));
}

/** 손잡이가 생기는 파일을 하나씩 골라 손잡이가 상자 안 왼쪽 아래, 자식 상자 아래에 놓이는지 본다. */
async function packPlace(t, page) {
  /** layout.ts의 PAD. 자식을 그리는 상자의 안쪽 여백이다. */
  const pad = 16;
  const seen = async (name, at) => {
    const files = packedFiles(await api("/api/graph", at));
    await page.goto(at);
    await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
    await settle(page);
    const wrong = [];
    let placed = 0;
    for (const file of files) {
      await page.keyboard.press(`${MOD}+p`);
      await page.waitForSelector(".palette-input", { timeout: 5_000 });
      await page.keyboard.type(file.path);
      const option = await page.waitForSelector(`.palette-option[data-node="${file.id}"]`, { timeout: 3_000 }).catch(() => null);
      if (option === null) {
        await page.keyboard.press("Escape");
        wrong.push(`${file.id} 검색에 없음`);
        continue;
      }
      await option.click();
      await waitSelected(page, file.id);
      const read = await page.evaluate((box) => {
        const zoom = Number(/scale\(([^)]+)\)/.exec(document.querySelector(".react-flow__viewport").style.transform)[1]);
        const rect = (element) => {
          const r = element.getBoundingClientRect();
          return { x: r.left / zoom, y: r.top / zoom, width: r.width / zoom, height: r.height / zoom };
        };
        const pack = document.querySelector(`.node-pack[data-box="${CSS.escape(box)}"]`);
        const kids = [...document.querySelectorAll(".react-flow__node")].filter((wrapper) => {
          const id = wrapper.dataset.id;
          return id.startsWith(`${box}:`) && !id.endsWith("#face") && !id.slice(box.length + 1).includes(".");
        });
        return { pack: pack === null ? null : rect(pack), box: rect(document.querySelector(`.react-flow__node[data-id="${CSS.escape(box)}"]`)), kids: kids.map(rect) };
      }, file.id);
      if (read.pack === null) {
        wrong.push(`${file.id} 손잡이 없음`);
        continue;
      }
      placed += 1;
      const { pack, box, kids } = read;
      const left = near(pack.x, box.x + pad, 1.5);
      const bottom = near(pack.y + pack.height, box.y + box.height - pad, 1.5);
      const below = kids.length > 0 && kids.every((kid) => pack.y >= kid.y + kid.height - 0.5);
      const clear = kids.every((kid) => pack.x >= kid.x + kid.width || kid.x >= pack.x + pack.width || pack.y >= kid.y + kid.height || kid.y >= pack.y + pack.height);
      if (!(left && bottom && below && clear)) {
        wrong.push(`${file.id}(왼쪽 ${left}, 아래 여백 ${bottom}, 자식 아래 ${below}, 겹치지 않음 ${clear})`);
      }
    }
    t.check(
      `${name}: 손잡이가 생기는 파일 ${files.length}개를 하나씩 고르면 손잡이의 왼쪽이 상자 안쪽 여백에 맞고, 위쪽이 모든 자식 상자의 아래쪽보다 아래이며, 어느 자식 상자와도 겹치지 않는다`,
      files.length > 0 && placed === files.length && wrong.length === 0,
      `확인한 손잡이 ${placed}개${wrong.length > 0 ? ` / 어긋남 ${wrong.slice(0, 4).join(", ")}` : ""}`,
    );
  };
  await seen("sync-engine", url);
  await t.shot();
  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포의 손잡이가 상자 안 왼쪽 아래, 자식 상자 아래에 놓인다", "--wide-url을 주지 않았다");
    return;
  }
  await seen("폴더가 여러 겹인 레포", wideUrl);
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
    `${file.id}를 고르면 밖과 이어진 정의 ${file.outer.length}개와 "${packWords(graph, file.inner)}" 손잡이가 보인다`,
    same(first, file.outer) && pack !== null && !pack.open && pack.text.startsWith(packWords(graph, file.inner)),
    `그린 정의 ${first.length}개, 손잡이 "${pack?.text}"`,
  );
  const tip = await tipOver(page, `.node-pack[data-box="${file.id}"]`);
  t.check("손잡이의 말풍선이 안에서만 쓰이는 정의의 수와 이름을 적는다", tip.startsWith(`이 파일 안에서만 쓰이는 ${packWords(graph, file.inner)} · `), tip);
  const handle = await rectOf(page, `.node-pack[data-box="${file.id}"]`);
  const drawnBoxes = await flowBoxes(page);
  const lowest = Math.max(...first.map((id) => drawnBoxes[id].y));
  t.check(
    "손잡이는 상자 안 왼쪽 아래, 그린 정의 아래에 놓인다",
    near(drawnBoxes[`${file.id}#pack`].x, drawnBoxes[file.id].x + 16) && drawnBoxes[`${file.id}#pack`].y > lowest,
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
    `손잡이를 누르면 정의 ${file.kids.length}개가 모두 보이고 손잡이가 "${packWords(graph, file.inner)} 접기"로 바뀌며 선택과 확대 비율이 그대로다`,
    same(all, file.kids) && opened?.open === true && opened.text === `${packWords(graph, file.inner)} 접기` && (await selectedOf(page)) === before.selected && near(await zoomOf(page), before.zoom, 0.001),
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

  // 손잡이를 눌러 펼친 뒤에는 화면을 옮기지 않으므로, 긴 상자의 접는 손잡이는 왼쪽 아래 칸의 미니맵 아래에 놓여 눌리지 않을 수 있다. 그때는 미니맵을 접고 누른다.
  const under = await page.evaluate((box) => {
    const pack = document.querySelector(`.node-pack[data-box="${box}"]`);
    const rect = pack.getBoundingClientRect();
    return !pack.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }, file.id);
  if (under) {
    await page.click(".minimap-button");
    await rest(page);
  }
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
    `상자 (${Math.round(back.x)}, ${Math.round(back.y)})${under ? ", 접는 손잡이가 미니맵 아래에 있어 미니맵을 접고 눌렀다" : ""}`,
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
    base.startsWith(packWords(graph, stages.inner)) && pulled.length > 0 && calls(picked).every((id) => drawnNow.includes(id)) && stages.outer.every((id) => drawnNow.includes(id)) &&
      pack !== null && pack.text.startsWith(packWords(graph, stages.inner.filter((id) => !pulled.includes(id)))),
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
  const opened = await packOf(page, file.id);
  t.check("고른 함수가 든 파일 상자는 전부 펼침 단계가 되어 손잡이가 접는 손잡이로 바뀐다", opened?.open === true && same(afterPalette, file.kids), `손잡이 "${opened?.text ?? "없음"}"`);
  await t.shot();
  await load(page, url, false);
  await pickFile(page, file.id);
  const hiddenAgain = !(await drawnIn(page, graph, file.id)).includes(targets[1]);
  await page.click(`.tree-row.tree-symbol[data-node="${targets[1]}"]`);
  await waitSelected(page, targets[1]);
  await rest(page);
  t.check(
    `손잡이에 든 ${targets[1]}를 파일트리에서 고르면 그 함수가 그려지고 선택된다`,
    hiddenAgain && (await drawnIn(page, graph, file.id)).includes(targets[1]) && (await selectedOf(page)) === targets[1],
  );
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
  t.check("고정 중의 화면에 손잡이가 없다", (await packsOf(page)).length === 0, `손잡이 ${(await packsOf(page)).length}개`);
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

/** 미사용 후보 표시가 손잡이에 든 후보를 꺼내는지 본다. */
async function packOverlay(t, page) {
  const [graph, unused] = [await api("/api/graph"), await api("/api/unused")];
  const candidates = new Set(unused.candidates);
  const held = (file) => file.inner.filter((id) => candidates.has(id) || graph.nodes.some((n) => n.parent === id && candidates.has(n.id)));
  const file = packedFile(graph, (each) => held(each).length > 0);
  if (file === undefined) {
    t.skip("미사용 후보 표시를 켜면 손잡이에 든 후보가 그려진다", "손잡이에 미사용 후보가 든 파일이 없다");
    return;
  }
  const inside = graph.nodes.filter((n) => candidates.has(n.id) && (file.inner.includes(n.id) || file.inner.includes(n.parent))).length;
  await load(page, url, false);
  await setOverlay(page, "none");
  await pickFile(page, file.id);
  const off = await packOf(page, file.id);
  t.check(
    `분석 표시가 꺼져 있으면 ${file.id}의 손잡이가 "${packWords(graph, file.inner)} · 미사용 후보 ${inside}"다`,
    off?.text === `${packWords(graph, file.inner)} · 미사용 후보 ${inside}`,
    `"${off?.text}"`,
  );
  const size = await rectOf(page, node(file.id));
  await setOverlay(page, "unused");
  const on = await packOf(page, file.id);
  const drawnNow = await drawnIn(page, graph, file.id);
  const left = file.inner.length - held(file).length;
  t.check(
    `미사용 후보 표시를 켜면 후보가 든 자식 ${held(file).length}개가 그려지고 손잡이에 미사용 후보가 없다`,
    held(file).every((id) => drawnNow.includes(id)) && (left <= 1 ? on === null : on.text === packWords(graph, file.inner.filter((id) => !held(file).includes(id)))),
    `그린 정의 ${drawnNow.length}개, 손잡이 "${on?.text ?? "없음"}"`,
  );
  await t.shot();
  await setOverlay(page, "none");
  const again = await packOf(page, file.id);
  const sizeAgain = await rectOf(page, node(file.id));
  t.check("분석 표시를 끄면 후보가 손잡이로 돌아가고 상자의 크기가 켜기 전과 같다", same(again, off) && near(size.width, sizeAgain.width) && near(size.height, sizeAgain.height), `"${again?.text}"`);
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

/**
 * 손잡이가 생기는 파일에서 밖과 이어진 함수 caller가 안쪽 함수 callee를 부르는 호출. 코드 뷰어가 caller의 첫 줄부터 보일 때 호출 줄이
 * 함께 보이고 callee의 정의 줄은 보이지 않도록, 호출 줄이 caller의 첫 줄에서 12줄 안에 있고 callee의 정의가 40줄 넘게 떨어진 호출만 낸다.
 * 안쪽 자식이 다섯 개 이상인 파일만 보고, 호출 줄이 caller의 첫 줄에 가까운 호출이 앞에 온다.
 */
function innerCalls(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const plain = (id) => nodes.get(id).kind === "function";
  return packedFiles(graph)
    .filter((file) => file.inner.length >= 5)
    .flatMap((file) =>
      graph.edges
        .filter((e) => e.kind === "call" && file.outer.includes(e.source) && file.inner.includes(e.target) && plain(e.source) && plain(e.target))
        .map((e) => ({ file, caller: e.source, callee: e.target, gap: e.sites[0].line - nodes.get(e.source).range[0], apart: Math.abs(nodes.get(e.target).range[0] - nodes.get(e.source).range[0]) })),
    )
    .filter((call) => call.gap >= 1 && call.gap <= 12 && call.apart > 40)
    .sort((a, b) => a.gap - b.gap);
}

/** 코드 뷰어에 보이는 줄 가운데 정의 줄이 아닌 줄에서 word가 처음 나오는 곳의 화면 사각형. 뷰어에 보이지 않으면 null이다. */
const callRect = (page, word) =>
  page.evaluate((text) => {
    const editor = document.querySelector(".info-panel .monaco-editor");
    const area = editor?.getBoundingClientRect();
    const lines = [...(editor?.querySelectorAll(".view-lines .view-line") ?? [])].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    for (const line of lines) {
      if (/^\s*(async\s+)?def\s/.test(line.textContent.replaceAll(" ", " "))) {
        continue;
      }
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let leaf = walker.nextNode(); leaf !== null; leaf = walker.nextNode()) {
        const index = leaf.data.search(new RegExp(`(?<![A-Za-z0-9_])${text}(?![A-Za-z0-9_])`));
        if (index < 0) {
          continue;
        }
        const range = document.createRange();
        range.setStart(leaf, index);
        range.setEnd(leaf, index + text.length);
        const rect = range.getBoundingClientRect();
        if (rect.top >= area.top && rect.bottom <= area.bottom && rect.left >= area.left && rect.right <= area.right) {
          return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        }
      }
    }
    return null;
  }, word);

/**
 * 안쪽 자식을 고르면 그 파일 상자가 전부 펼침 단계가 되는지 본다. 고르는 경로는 코드 뷰어의 Mod+클릭, 파일트리, Mod+P 세 가지이고,
 * 접는 손잡이를 누른 뒤의 선택과 뒤로·앞으로도 본다. --wide-url을 받으면 그 레포에서도 본다. 사진은 `hf3-inner-{이름}.png`로 남긴다.
 */
async function innerPick(t, page) {
  const seen = async (name, at, tag) => {
    const graph = await api("/api/graph", at);
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const call = innerCalls(graph)[0];
    if (call === undefined) {
      t.skip(`${name}: 안쪽 함수를 코드 뷰어에서 Mod+클릭한다`, "밖과 이어진 함수가 첫 줄 가까이에서 안쪽 함수를 부르는 파일이 없다");
      return;
    }
    const { file, caller, callee } = call;
    const others = file.inner.filter((id) => id !== callee && nodes.get(id).kind === "function");
    const open = async () => {
      await page.goto(at);
      await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
      await settle(page);
    };
    /** 파일 상자가 전부 펼침 단계인지: 손잡이가 접는 손잡이이고 바로 아래 자식을 모두 그렸다. 손잡이의 수는 흐름이 꺼낸 자식만큼 준다. */
    const full = async () => {
      const [pack, drawnNow] = [await packOf(page, file.id), await drawnIn(page, graph, file.id)];
      return { ok: pack?.open === true && /^내부 (?:함수 \d+개(?: · 변수 \d+개)?|변수 \d+개) 접기$/.test(pack.text) && same(drawnNow, file.kids), text: `그린 정의 ${drawnNow.length}/${file.kids.length}개, 손잡이 "${pack?.text ?? "없음"}"` };
    };
    const staged = async () => (await packOf(page, file.id))?.open === false;

    // 코드 뷰어의 Mod+클릭
    await open();
    await palettePick(page, nodes.get(caller).name, caller);
    await waitSelected(page, caller);
    await rest(page);
    const before = await packOf(page, file.id);
    t.check(`${name}: 밖과 이어진 ${caller}를 고르면 ${file.id}는 펼침 단계이고 묶는 손잡이가 있다`, before?.open === false, `손잡이 "${before?.text ?? "없음"}"`);
    await page.waitForFunction((text) => document.querySelector(".info-panel .monaco-editor .view-lines")?.textContent.includes(text), nodes.get(callee).name, { timeout: 10_000 }).catch(() => {});
    const word = await callRect(page, nodes.get(callee).name);
    if (word === null) {
      t.check(`${name}: 코드 뷰어에 ${callee}를 부르는 줄이 보인다`, false, "보이지 않는다");
      return;
    }
    await page.keyboard.down(MOD);
    await page.mouse.move(word.x + word.width / 2 - 6, word.y + word.height / 2);
    await page.mouse.move(word.x + word.width / 2, word.y + word.height / 2, { steps: 3 });
    await page.waitForSelector(".info-panel .code-link", { timeout: 3_000 }).catch(() => {});
    await page.mouse.click(word.x + word.width / 2, word.y + word.height / 2);
    await page.keyboard.up(MOD);
    await waitSelected(page, callee).catch(() => {});
    await page.mouse.move(5, 5);
    await rest(page);
    const clicked = await full();
    t.check(
      `${name}: 코드 뷰어에서 안쪽 함수 ${callee}를 Mod+클릭하면 그 함수를 고르고 ${file.id}가 전부 펼침 단계가 된다`,
      (await selectedOf(page)) === callee && clicked.ok,
      `선택 ${await selectedOf(page)}, ${clicked.text}`,
    );
    const reach = await reachable(page, callee);
    t.check(`${name}: 전부 펼친 배치에서 고른 함수의 이름표가 가리지 않는 영역 안에 있다`, reach.ok, reach.at);
    await page.screenshot({ path: join(OUT, `hf3-inner-${tag}.png`) });

    // 접는 손잡이와 뒤로·앞으로
    // 손잡이는 상자의 왼쪽 아래에 있으므로 그래프 전체를 맞춰 화면 안에 둔 뒤 누른다.
    const steps = await count(page, ".trail-step");
    await page.getByRole("button", { name: "화면 맞춤" }).click();
    await page.mouse.move(1, 1);
    await settle(page);
    await clickPack(page, file.id);
    await waitSelected(page, file.id).catch(() => {});
    await rest(page);
    t.check(
      `${name}: 안쪽 함수를 고른 채 접는 손잡이를 누르면 선택이 ${file.id}로 올라가고 밖과 이어진 정의와 묶는 손잡이만 남는다`,
      (await selectedOf(page)) === file.id && (await staged()) && same(await drawnIn(page, graph, file.id), file.outer),
      `선택 ${await selectedOf(page)}, 손잡이 "${(await packOf(page, file.id))?.text ?? "없음"}", 이력 ${steps} → ${await count(page, ".trail-step")}단계`,
    );
    const step = async (key, id) => {
      await page.keyboard.press(key);
      await waitSelected(page, id).catch(() => {});
      await rest(page);
      return { selected: await selectedOf(page), open: (await packOf(page, file.id))?.open ?? null };
    };
    const back1 = await step("Alt+ArrowLeft", callee);
    const back2 = await step("Alt+ArrowLeft", caller);
    const forth = await step("Alt+ArrowRight", callee);
    t.check(
      `${name}: 뒤로 가면 안쪽 함수를 고른 전부 펼침으로, 한 번 더 가면 ${caller}를 고른 펼침으로 돌아가고, 앞으로 가면 다시 전부 펼침이다`,
      same(back1, { selected: callee, open: true }) && same(back2, { selected: caller, open: false }) && same(forth, { selected: callee, open: true }),
      [back1, back2, forth].map((each) => `${each.selected} ${each.open}`).join(" → "),
    );
    await palettePick(page, nodes.get(caller).name, caller);
    await waitSelected(page, caller);
    await rest(page);
    t.check(`${name}: 그 뒤에 밖과 이어진 함수를 골라도 손잡이를 눌러 연 상자처럼 전부 펼침이 남는다`, (await full()).ok, (await full()).text);

    // 파일트리
    await open();
    await palettePick(page, file.path, file.id);
    await waitSelected(page, file.id);
    await rest(page);
    const closed = await staged();
    await page.waitForSelector(`.tree-row.tree-symbol[data-node="${others[0]}"]`, { timeout: 10_000 });
    await page.click(`.tree-row.tree-symbol[data-node="${others[0]}"]`);
    await waitSelected(page, others[0]);
    await page.mouse.move(5, 5);
    await rest(page);
    const viaTree = await full();
    t.check(`${name}: 파일트리에서 안쪽 함수 ${others[0]}를 고르면 ${file.id}가 전부 펼침 단계가 된다`, closed && (await selectedOf(page)) === others[0] && viaTree.ok, viaTree.text);

    // Mod+P 검색
    await open();
    await palettePick(page, file.path, file.id);
    await waitSelected(page, file.id);
    await rest(page);
    const closedAgain = await staged();
    await palettePick(page, nodes.get(others[1]).name, others[1]);
    await waitSelected(page, others[1]);
    await rest(page);
    const viaPalette = await full();
    t.check(`${name}: Mod+P로 안쪽 함수 ${others[1]}를 고르면 ${file.id}가 전부 펼침 단계가 된다`, closedAgain && (await selectedOf(page)) === others[1] && viaPalette.ok, viaPalette.text);
    const outerOne = file.outer.find((id) => id !== caller && nodes.get(id).kind === "function") ?? caller;
    await open();
    await palettePick(page, nodes.get(outerOne).name, outerOne);
    await waitSelected(page, outerOne);
    await rest(page);
    t.check(`${name}: 페이지를 다시 열고 밖과 이어진 ${outerOne}를 고르면 ${file.id}는 펼침 단계다`, await staged(), `손잡이 "${(await packOf(page, file.id))?.text ?? "없음"}"`);
  };
  await seen("sync-engine", url, "sync");
  await t.shot();
  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포에서 안쪽 함수를 고르면 그 파일 상자가 전부 펼침 단계가 된다", "--wide-url을 주지 않았다");
    return;
  }
  await seen("폴더가 여러 겹인 레포", wideUrl, "wide");
}

/**
 * "외부 노드" 토글이 외부 패키지를 부르는 안쪽 정의를 손잡이에서 꺼내는지 본다. 주소 url의 레포에 그런 정의가 없으면
 * --wide-url의 레포에서 본다.
 */
async function packToggle(t, page) {
  const pickedIn = async (at) => {
    const graph = await api("/api/graph", at);
    /** 외부 노드를 켰을 때 손잡이에서 나오는 안쪽 자식 */
    const moved = (file) => file.inner.filter((id) => !stagesOf(graph, file.id, true).inner.includes(id));
    return { at, graph, moved, file: packedFile(graph, (each) => moved(each).length > 0) };
  };
  let found = await pickedIn(url);
  if (found.file === undefined && wideUrl !== null) {
    found = await pickedIn(wideUrl);
  }
  const { at, graph, moved, file } = found;
  if (file === undefined) {
    t.skip("외부 노드를 켜면 외부 패키지를 부르는 정의가 손잡이에서 나온다", `안쪽 자식 가운데 외부 노드와 선이 있는 정의가 없다${wideUrl === null ? "(--wide-url을 주지 않았다)" : ""}`);
    return;
  }
  await load(page, at, false);
  await palettePick(page, graph.nodes.find((n) => n.id === file.id).name, file.id);
  await waitSelected(page, file.id);
  await rest(page);
  const before = await packOf(page, file.id);
  await setToggle(page, "외부 노드", true);
  await rest(page);
  const after = await packOf(page, file.id);
  const wide = stagesOf(graph, file.id, true);
  t.check(
    `외부 노드를 켜면 외부 패키지를 부르는 정의 ${moved(file).length}개가 손잡이에서 나와 그려진다`,
    before.text.startsWith(packWords(graph, file.inner)) && (wide.inner.length <= 1 ? after === null : after.text.startsWith(packWords(graph, wide.inner))) &&
      same(await drawnIn(page, graph, file.id), wide.inner.length <= 1 ? wide.kids : wide.outer),
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
  const viewport = () => page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform);
  /** 그린 상자 가운데 정보 패널이 가리지 않는 영역을 벗어난 상자의 id */
  const outside = async () => {
    const { free } = await stageOf(page);
    const rects = await page.evaluate(() =>
      [...document.querySelectorAll(".react-flow__node")].map((wrapper) => {
        const r = wrapper.getBoundingClientRect();
        return { id: wrapper.dataset.id, x: r.left, y: r.top, width: r.width, height: r.height };
      }),
    );
    return rects.filter((rect) => !within(rect, free)).map((rect) => rect.id);
  };
  const expand = async () => {
    await clickNode(page, "parser");
    await page.waitForSelector(`${node("parser")} > .node-region`, { timeout: 30_000 });
    await page.mouse.move(5, 5);
    await rest(page);
  };
  const fold = async () => {
    const head = await rectOf(page, `${face("parser")} .node-region-head`);
    await page.mouse.click(head.x + 20, head.y + head.height / 2);
    await page.waitForSelector(`${node("parser")} > .node-package`, { timeout: 30_000 });
    await page.mouse.move(5, 5);
    await rest(page);
  };

  // 전체 맞춤 상태: 레포를 연 처음 화면. 폴더를 여닫으면 다시 맞추지 않고 누른 상자의 모서리를 붙잡는다.
  const first = { zoom: await zoomOf(page), view: await viewport() };
  const firstOut = await outside();
  t.check(
    "처음 화면은 확대 비율이 이름표가 읽히는 값(0.8) 이상이고, 전체가 들어오지 않으면 그래프의 왼쪽 위를 가리지 않는 영역의 왼쪽 위에 놓는다",
    first.zoom >= NAMED_ZOOM - 0.001 && first.zoom <= 1.001 && (firstOut.length === 0 || near(first.zoom, NAMED_ZOOM, 0.001)),
    `확대 비율 ${first.zoom.toFixed(3)}, 영역을 벗어난 상자 ${firstOut.length}개`,
  );
  const pressed = await rectOf(page, node("parser"));
  await expand();
  const inside = graph.nodes.filter((n) => n.parent === "parser" && !n.test).map((n) => n.id);
  const opened = { zoom: await zoomOf(page), corner: await rectOf(page, node("parser")) };
  t.check(
    "처음 화면에서 폴더 상자를 눌러 펼치면 확대 비율이 그대로이고 영역의 왼쪽 위 모서리가 누른 상자의 왼쪽 위 모서리가 있던 좌표에 있다",
    opened.zoom === first.zoom && near(opened.corner.x, pressed.x, 1.5) && near(opened.corner.y, pressed.y, 1.5),
    `확대 비율 ${first.zoom.toFixed(3)} → ${opened.zoom.toFixed(3)}, (${Math.round(pressed.x)}, ${Math.round(pressed.y)}) → (${Math.round(opened.corner.x)}, ${Math.round(opened.corner.y)})`,
  );
  await t.shot();
  const files = await drawnIn(page, graph, "parser");
  t.check(
    `parser/를 펼치면 안의 파일 ${inside.length}개를 모두 그리고 폴더에는 손잡이가 없다`,
    same(files, inside) && (await packOf(page, "parser")) === null,
    `그린 파일 ${files.length}개`,
  );
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await rest(page);
  const fit = { zoom: await zoomOf(page), out: (await outside()).length };
  t.check('"화면 맞춤"을 누르면 확대 비율을 줄여서라도 모든 상자가 정보 패널이 가리지 않는 영역 안에 들어온다', fit.out === 0 && fit.zoom <= opened.zoom + 0.001, `확대 비율 ${fit.zoom.toFixed(3)}, 영역을 벗어난 상자 ${fit.out}개`);
  const fitCorner = await rectOf(page, node("parser"));
  await fold();
  const folded0 = { zoom: await zoomOf(page), corner: await rectOf(page, node("parser")) };
  t.check(
    '"화면 맞춤" 뒤에 머리 줄을 눌러 접으면 다시 맞추지 않아 확대 비율이 그대로이고 폴더 상자가 영역의 왼쪽 위 모서리가 있던 좌표에 놓인다',
    folded0.zoom === fit.zoom && near(folded0.corner.x, fitCorner.x, 1.5) && near(folded0.corner.y, fitCorner.y, 1.5),
    `확대 비율 ${fit.zoom.toFixed(3)} → ${folded0.zoom.toFixed(3)}, (${Math.round(fitCorner.x)}, ${Math.round(fitCorner.y)}) → (${Math.round(folded0.corner.x)}, ${Math.round(folded0.corner.y)})`,
  );

  // 사용자가 화면을 끈 뒤: 확대 비율을 그대로 두고 누른 상자의 모서리를 붙잡는다
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await rest(page);
  const spot = await page.evaluate(() => {
    const area = document.querySelector(".graph").getBoundingClientRect();
    for (let y = area.top + 30; y < area.bottom - 30; y += 20) {
      for (let x = area.left + 30; x < area.right - 30; x += 20) {
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) {
          return { x, y };
        }
      }
    }
    return null;
  });
  await drag(page, spot, -40, 30);
  await rest(page);
  const before = { zoom: await zoomOf(page), corner: await rectOf(page, node("parser")), view: await viewport() };
  await expand();
  const region = await rectOf(page, node("parser"));
  t.check(
    "화면을 끈 뒤 폴더 상자를 눌러 펼치면 확대 비율이 그대로이고 영역의 왼쪽 위 모서리가 누른 상자의 왼쪽 위 모서리가 있던 좌표에 있다",
    before.view !== first.view && near(await zoomOf(page), before.zoom, 0.001) && near(region.x, before.corner.x, 1.5) && near(region.y, before.corner.y, 1.5),
    `(${Math.round(before.corner.x)}, ${Math.round(before.corner.y)}) → (${Math.round(region.x)}, ${Math.round(region.y)})`,
  );
  const stays = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`.react-flow__node[data-id="${id}"]`).getBoundingClientRect().left > 0).length, ["arbiter", "note_batch"]);
  t.check("누른 상자의 모서리가 가리지 않는 영역 안에 있으므로 화면을 옮기지 않아 왼쪽 열의 파일 상자가 화면에 남는다", stays === 2, `왼쪽 열의 파일 상자 ${stays}개`);
  await fold();
  const folded = await rectOf(page, node("parser"));
  t.check(
    "머리 줄을 눌러 접으면 폴더 상자가 영역의 왼쪽 위 모서리가 있던 좌표에 놓이고 화면이 펼치기 전과 같다",
    near(folded.x, region.x, 1.5) && near(folded.y, region.y, 1.5) && near(await zoomOf(page), before.zoom, 0.001) && (await viewport()) === before.view,
    `(${Math.round(region.x)}, ${Math.round(region.y)}) → (${Math.round(folded.x)}, ${Math.round(folded.y)})`,
  );

  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포에서도 펼칠 때마다 확대 비율과 누른 폴더의 왼쪽 위가 그대로다", "--wide-url을 주지 않았다");
    return;
  }
  // 폴더가 여러 겹인 레포: 가장 큰 최상위 폴더와 그 안에서 자식이 가장 많은 폴더를 파일트리의 폴더 행으로 차례로 펼친다
  const wide = await api("/api/graph", wideUrl);
  await page.goto(wideUrl);
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  const size = (id) => wide.nodes.filter((n) => n.id.startsWith(`${id}.`)).length;
  const top = wide.nodes.filter((n) => n.kind === "package" && n.parent === null && !n.test).sort((a, b) => size(b.id) - size(a.id))[0];
  const inner = wide.nodes.filter((n) => n.kind === "package" && n.parent === top.id).sort((a, b) => wide.nodes.filter((n) => n.parent === b.id).length - wide.nodes.filter((n) => n.parent === a.id).length)[0];
  const seen = [`처음 ${(await zoomOf(page)).toFixed(3)}`];
  const start = await zoomOf(page);
  let kept = start >= NAMED_ZOOM - 0.001;
  for (const folder of [top, inner]) {
    const corner = await rectOf(page, node(folder.id));
    await openFolder(page, folder.id);
    await page.mouse.move(5, 5);
    await rest(page);
    const [zoom, region] = [await zoomOf(page), await rectOf(page, node(folder.id))];
    kept = kept && zoom === start && near(region.x, corner.x, 1.5) && near(region.y, corner.y, 1.5);
    seen.push(`${folder.name}/ ${zoom.toFixed(3)}, (${Math.round(corner.x)}, ${Math.round(corner.y)}) → (${Math.round(region.x)}, ${Math.round(region.y)})`);
  }
  t.check("폴더가 여러 겹인 레포에서도 펼칠 때마다 확대 비율과 누른 폴더의 왼쪽 위가 그대로다", kept, seen.join(" → "));
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await rest(page);
  t.check('그 화면에서 "화면 맞춤"을 누르면 모든 상자가 들어온다', (await outside()).length === 0, `확대 비율 ${(await zoomOf(page)).toFixed(3)}`);
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
      // 줄기는 줄기가 붙은 노드와 줄기에 든 선의 반대쪽 끝 노드가 양 끝이다.
      const ends = edge.classList.contains("edge-trunk")
        ? [parts[1], ...[...document.querySelectorAll(`.edge[data-trunk-${edge.dataset.end}="${CSS.escape(edge.dataset.key)}"]`)].map((branch) => endsOf(branch.dataset.key)[edge.dataset.end === "in" ? 0 : 1])]
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
 * 화면의 숫자(도착 노드 앞의 합계, 활성화된 선의 수)마다 다른 숫자, 합류점·갈림점, 노드의 상자·글자·배지, 자기 선이 아닌 선과 겹치는 곳.
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
    const sourceOf = (key) => (key.startsWith("trunk|") ? (key.split("|")[2] === "out" ? key.split("|")[1] : null) : endsOf(key)[0]);
    const numbers = [];
    for (const text of document.querySelectorAll(".react-flow__edge .edge :is(.edge-weight, .edge-trunk-count)")) {
      const edge = text.closest(".edge");
      const box = boxOf(text);
      const trunk = text.classList.contains("edge-sum") ? edge.dataset.trunkIn : edge.classList.contains("edge-trunk") ? edge.dataset.key : null;
      const same = numbers.find((n) => n.trunk !== null && n.trunk === trunk);
      if (same !== undefined) {
        same.own.add(edge.dataset.key);
        continue;
      }
      const own = new Set([edge.dataset.key]);
      if (trunk !== null) {
        own.add(trunk);
        document.querySelectorAll(`.edge[data-trunk-in="${CSS.escape(trunk)}"]`).forEach((branch) => own.add(branch.dataset.key));
      }
      const fixed = trunk !== null || edge.dataset.trunkIn === undefined;
      numbers.push({ label: `${edge.dataset.key}의 ${text.textContent}`, box, own, trunk, fixed, target: edge.classList.contains("edge-trunk") ? edge.dataset.node : endsOf(edge.dataset.key)[1] });
    }
    const joints = [...document.querySelectorAll(".edge-joint-in, .edge-joint-out")].map((dot) => ({ x: dot.cx.baseVal.value - 2.5, y: dot.cy.baseVal.value - 2.5, width: 5, height: 5 }));
    const letters = [...document.querySelectorAll(".node-face :is(.node-label, .change-mark, .badge, .node-below, .node-field, .node-pack), .node-pack")].map((el) => toGraph(el.getBoundingClientRect()));
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
      const crossing = lines.filter((line) => !n.own.has(line.key) && line.points.some((p) => p.x > n.box.x && p.x < n.box.x + n.box.width && p.y > n.box.y && p.y < n.box.y + n.box.height));
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
          joined: edge.dataset.trunkIn !== undefined,
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

/** 고정한 말풍선의 줄마다 그 줄을 낸 선의 키와 `rowText`로 적은 글. 고정한 말풍선이 없으면 null이다. */
const menuOf = async (page) => {
  const bubble = await bubbleOf(page);
  return bubble === null || !bubble.pinned ? null : bubble.rows.map((row) => ({ key: row.key, text: rowText(row) }));
};

/**
 * 도착 노드가 다른 선 둘 이상이 함께 지나는 구간 위의 화면 좌표와 그 구간을 지나는 선의 키, 그 구간을 그리는 나가는 줄기의 키.
 * 나가는 줄기가 출발 노드를 떠난 지 10px인 점을 본다. 그 점에서는 줄기에 든 선이 모두 함께 지난다. 다른 선이나 줄기의 누름 영역이 그 점을
 * 지나지 않고 그 점의 맨 위 요소가 선인 줄기를 고른다. 없으면 null이다.
 */
const sharedSpot = (page) =>
  page.evaluate(() => {
    const endsOf = (key) => {
      const parts = key.split("|");
      return parts[0] === "agg" || parts[0] === "step" ? [parts[1], parts[2]] : [parts[0], parts[1]];
    };
    const area = document.querySelector(".graph").getBoundingClientRect();
    const panel = document.querySelector(".info-panel").getBoundingClientRect();
    const hits = [...document.querySelectorAll(".react-flow__edge .edge[data-key] .edge-hit")];
    for (const trunk of document.querySelectorAll('.react-flow__edge .edge-trunk[data-end="out"]')) {
      const keys = [...document.querySelectorAll(`.edge[data-trunk-out="${CSS.escape(trunk.dataset.key)}"]`)].map((edge) => edge.dataset.key);
      const targets = new Set(keys.map((key) => endsOf(key)[1]));
      const line = trunk.querySelector(".edge-line");
      if (targets.size < 2 || line.getTotalLength() < 20) {
        continue;
      }
      const at = line.getPointAtLength(10);
      if (hits.some((hit) => hit.closest(".edge") !== trunk && hit.isPointInStroke(at))) {
        continue;
      }
      const { x, y } = new DOMPoint(at.x, at.y).matrixTransform(line.getScreenCTM());
      const visible = x > area.left + 10 && x < panel.left - 10 && y > area.top + 10 && y < area.bottom - 200;
      if (visible && document.elementFromPoint(x, y)?.closest(".react-flow__edge") != null) {
        return { x, y, keys: keys.sort(), targets: [...targets], trunk: trunk.dataset.key };
      }
    }
    return null;
  });

/** 여러 선이 함께 지나는 구간의 hover와 클릭을 본다. */
async function overlap(t, page) {
  await asidePanel(page);
  await load(page);
  const hoverAt = async (spot) => {
    await page.mouse.move(spot.x + 1, spot.y + 1);
    await page.mouse.move(spot.x, spot.y);
    await page.waitForSelector(".line-bubble", { timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(250);
  };
  // 줄기 가운데 일부 선만 지나는 구간: 줄기의 먼 쪽 끝. 이웃한 통로의 선이나 나가는 줄기가 커서에서 6px 안에 들지 않는 점을 먼 쪽 끝에서부터 찾는다.
  const trunk = (await trunksOf(page)).filter((each) => each.count >= 3).sort((a, b) => b.count - a.count)[0];
  for (const along of [6, 3, 9, 12, 15, 18, 24, 30, 36]) {
    const far = await page.evaluate(
      ([key, length]) => {
        const line = document.querySelector(`.edge-trunk[data-key="${CSS.escape(key)}"] .edge-line`);
        const point = new DOMPoint(line.getPointAtLength(length).x, line.getPointAtLength(length).y).matrixTransform(line.getScreenCTM());
        return { x: point.x, y: point.y };
      },
      [trunk.key, along],
    );
    await hoverAt(far);
    const under = await pointedLines(page);
    if (under.length > 0 && under.every((key) => trunk.branches.includes(key))) {
      break;
    }
  }
  const part = { pointed: await pointedLines(page), rows: await bubbleRows(page), trunk: (await trunksOf(page)).find((each) => each.key === trunk.key).pointed };
  t.check(
    `가지 ${trunk.count}개인 줄기의 먼 쪽 구간에 올리면 그 구간을 지나는 선만 강조하고 줄기 전체는 강조하지 않는다`,
    part.pointed.length >= 1 && part.pointed.length < trunk.count && !part.trunk && part.pointed.every((key) => trunk.branches.includes(key)),
    `강조한 선 ${part.pointed.length}개, 말풍선 ${part.rows.length}줄`,
  );
  t.check(
    "말풍선의 줄 수가 그 구간을 지나는 선의 수와 같고 선마다 출발·도착·관계를 적는다",
    part.rows.length === part.pointed.length && part.rows.every((row) => new RegExp(` → .+ · ${RELATIONS}$`).test(row)),
    part.rows.join(" / "),
  );
  await page.screenshot({ path: join(OUT, "s4-u7-fix-overlap-part.png") });

  // 도착이 같은 줄기도 누르면 말풍선을 고정하고, 도착 이름을 누르면 그 노드를 고른다.
  const near1 = await trunkPoint(page, trunk.key);
  await hoverAt(near1);
  const stemRows = await pinBubble(page, near1);
  await pressCell(page, 0, "target");
  await waitSelected(page, trunk.target).catch(() => {});
  t.check(
    "도착 노드가 같은 선이 겹친 줄기를 누르면 그 선마다 한 줄인 말풍선이 고정되고 도착 이름을 누르면 도착 노드를 고른다",
    stemRows !== null && stemRows.pinned && stemRows.rows.length === trunk.count && (await selectedOf(page)) === trunk.target && (await menuOf(page)) === null,
    `줄 ${stemRows?.rows.length ?? 0}개, 선택 ${await selectedOf(page)}`,
  );
  await page.keyboard.press("Escape");
  await rest(page);
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await page.mouse.move(5, 5);
  await rest(page);

  // 도착이 다른 선이 겹친 구간.
  const spot = await sharedSpot(page);
  if (spot === null) {
    t.skip("도착이 다른 선이 겹친 구간을 누르면 말풍선이 고정된다", `화면에 도착이 다른 선이 함께 지나는 구간이 없다 (선택 ${await selectedOf(page)}, 선 ${(await linesOf(page)).length}개)`);
    return;
  }
  await hoverAt(spot);
  const shared = { pointed: await pointedLines(page), rows: await bubbleRows(page) };
  t.check(
    `도착이 다른 선 ${spot.keys.length}개가 함께 지나는 구간에 올리면 그 선들만 강조하고 말풍선에 한 줄씩 적는다`,
    same(shared.pointed, spot.keys) && shared.rows.length === spot.keys.length && shared.rows.every((row) => new RegExp(` → .+ · ${RELATIONS}$`).test(row)),
    `강조 ${shared.pointed.length}개, 말풍선 ${shared.rows.join(" / ")}`,
  );
  await page.screenshot({ path: join(OUT, "s4-u7-fix-overlap-hover.png") });
  await page.mouse.click(spot.x, spot.y);
  await page.waitForSelector(".line-bubble[data-pinned]", { timeout: 3_000 }).catch(() => {});
  const menu = await menuOf(page);
  t.check(
    "그 구간을 누르면 노드를 고르지 않고 말풍선을 그곳에 고정한다. 줄은 올렸을 때의 말풍선과 같다",
    menu !== null && same(menu.map((item) => item.key).sort(), spot.keys) && same(menu.map((item) => item.text), shared.rows) && (await selectedOf(page)) === null && (await count(page, ".tooltip")) === 0,
    `줄 ${menu?.length ?? 0}개`,
  );
  t.check("고정한 동안 누른 구간의 선이 모두 강조된다", same(await pointedLines(page), spot.keys), (await pointedLines(page)).join(", "));
  const item = await rectOf(page, `.line-bubble tbody tr[data-key="${menu[1].key}"]`);
  await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
  await page.waitForTimeout(250);
  t.check("줄에 올리면 그 선 하나만 강조한다", same(await pointedLines(page), [menu[1].key]), (await pointedLines(page)).join(", "));
  await t.shot();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  // 목록이 닫힌 뒤 커서 밑에 선이 있으면 그 선의 hover가 다시 뜬다.
  const onLine = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".react-flow__edge") != null, [item.x + item.width / 2, item.y + item.height / 2]);
  t.check("Esc는 말풍선을 먼저 풀고 선택을 바꾸지 않는다", (await menuOf(page)) === null && (await selectedOf(page)) === null && (onLine || (await count(page, ".edge[data-pointed]")) === 0), `커서 밑에 선 ${onLine}`);

  await page.mouse.click(spot.x, spot.y);
  await page.waitForSelector(".line-bubble[data-pinned]", { timeout: 3_000 }).catch(() => {});
  await page.mouse.click(40, 500);
  await page.waitForTimeout(200);
  t.check("말풍선 밖을 누르면 말풍선이 풀린다", (await menuOf(page)) === null);

  await page.waitForTimeout(600);
  await page.mouse.click(spot.x, spot.y);
  await page.waitForSelector(".line-bubble[data-pinned]", { timeout: 3_000 }).catch(() => {});
  const picked = (await menuOf(page))[0];
  const wanted = endsOfKey(picked.key)[1];
  await pressCell(page, 0, "target");
  await waitSelected(page, wanted).catch(() => {});
  t.check("줄의 도착 이름을 누르면 그 선의 도착 노드를 고르고 말풍선이 풀린다", (await selectedOf(page)) === wanted && (await menuOf(page)) === null, `선택 ${await selectedOf(page)}`);
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
  await page.waitForSelector(".line-bubble[data-pinned]", { timeout: 3_000 }).catch(() => {});
  await pressCell(page, 0, "relation");
  await page.waitForSelector(".info-panel-sites", { timeout: 10_000 }).catch(() => {});
  t.check(
    "Shift를 누른 채 누르면 말풍선이 고정되고 줄의 관계 칸을 누르면 그 선의 코드 줄 목록이 열리며 노드는 선택되지 않는다",
    (await count(page, ".info-panel-site")) > 0 && (await headOf(page)).includes("→") && (await selectedOf(page)) === null,
    (await headOf(page)).replaceAll("\n", " / ").slice(0, 80),
  );
}

/** 선을 눌러 가는 폴더. 파일 file을 고른 채 흐리게 그려진, 상자 from에서 접힌 폴더 상자 to로 가는 집계 선을 누른다. */
const LINE_FOLDER = { file: "doc_update", from: "arbiter", to: "parser" };
/** --wide-url의 레포에서 선을 눌러 가는 폴더. 폴더 open을 차례로 펼친 뒤 file을 고른다. */
const WIDE_LINE_FOLDER = { open: ["mdp", "mdp.settings"], file: "mdp.settings.loader", from: "mdp.cli", to: "mdp.runtime" };

/**
 * 접힌 폴더 상자 to로 들어가는 선을 at에서 누른 뒤의 화면. 도착 표시는 배치 움직임과 화면 이동이 끝난 뒤 1.2초 동안만 있으므로 화면이 멎기 전에 읽고,
 * shot을 받았으면 그때 부른다. after는 도착 표시가 배치 움직임과 화면 이동이 끝난 프레임에만 있었는지다.
 * fits는 펼친 폴더 영역이 가리지 않는 영역 안에 들어와 있는지다.
 */
async function lineToFolder(page, to, at, shot = null) {
  await watchFrames(page);
  await followLine(page, at, { to });
  await page.mouse.move(1, 1);
  const marked = await page.waitForSelector(`.reached[data-node="${to}"]`, { timeout: 5_000 }).then(() => true, () => false);
  await shot?.();
  await settle(page);
  const frames = await framesOf(page);
  const [box, { clear }] = [await rectOf(page, `${node(to)}:has(> .node-region)`), await stageOf(page)];
  /** 영역이 들어가는 축은 전부 들어와 있고, 영역이 더 긴 축은 시작 끝이 20px 안쪽에 있는지 */
  const along = (start, length, low, room) => (length > room ? near(start, low + INSET, 2) : start >= low && start + length <= low + room);
  return {
    marked,
    after: frames.some((frame) => frame.flying || frame.moving) && frames.every((frame) => !frame.reached || (!frame.flying && !frame.moving)),
    opened: box !== null,
    fits: box !== null && along(box.x, box.width, clear.x, clear.width) && along(box.y, box.height, clear.y, clear.height),
    selected: await selectedOf(page),
    strong: (await linesOf(page)).filter((line) => line.tone === "strong").length,
    via: (await viaLines(page)).filter((line) => line.via).length,
    text: box === null ? "펼친 폴더 영역 없음" : `영역 (${Math.round(box.x)}, ${Math.round(box.y)}) ${Math.round(box.width)}×${Math.round(box.height)}, 가리지 않는 영역 (${Math.round(clear.x)}, ${Math.round(clear.y)}) ${Math.round(clear.width)}×${Math.round(clear.height)}`,
  };
}

/**
 * 흐리게 그려진, 상자 from에서 접힌 폴더 상자 to로 가는 집계 선과 누를 점. 선이 화면 밖에 있으면 그래프 바탕을 끌어 선의 가운데를
 * 가리지 않는 영역의 가운데로 옮긴 뒤 찾는다. 없으면 null이다.
 */
async function dimFolderLine(page, from, to) {
  const line = (await linesOf(page)).find((each) => same(endsOfKey(each.key), [from, to]) && each.opacity === DIM);
  if (line === undefined || (await count(page, `${node(to)} > .node-package`)) === 0) {
    return null;
  }
  const found = await hittable(page, [line]);
  if (found !== null) {
    return found;
  }
  const { clear } = await stageOf(page);
  const spots = await page.evaluate((key) => {
    const path = [...document.querySelectorAll(".react-flow__edge .edge[data-key]")].find((edge) => edge.dataset.key === key).querySelector(".edge-line");
    const at = path.getPointAtLength(path.getTotalLength() / 2);
    const middle = new DOMPoint(at.x, at.y).matrixTransform(path.getScreenCTM());
    const area = document.querySelector(".graph").getBoundingClientRect();
    for (let y = area.top + 60; y < area.bottom - 120; y += 20) {
      for (let x = area.left + 20; x < area.right - 20; x += 20) {
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane") === true) {
          return { middle: { x: middle.x, y: middle.y }, pane: { x, y } };
        }
      }
    }
    return null;
  }, line.key);
  if (spots === null) {
    return null;
  }
  await drag(page, spots.pane, center(clear).x - spots.middle.x, center(clear).y - spots.middle.y);
  await page.mouse.move(1, 1);
  await settle(page);
  return hittable(page, [line]);
}

/** 선의 도착 노드가 접힌 폴더 상자일 때 선 클릭이 그 폴더로 가는지 본다. */
async function lineFolder(t, page) {
  const { file, from, to } = LINE_FOLDER;
  await load(page, url, false);
  const plain = await hittable(page, (await linesOf(page)).filter((line) => same(endsOfKey(line.key), [from, to])));
  const first = await lineToFolder(page, to, plain.at);
  t.check(
    "고른 노드가 없을 때 접힌 폴더 상자로 들어가는 선을 누르면 그 폴더가 펼쳐지고 펼친 영역에 도착 표시가 잠깐 그려진다",
    first.opened && first.marked && first.selected === null,
    `펼침 ${first.opened}, 도착 표시 ${first.marked}, ${first.text}`,
  );
  t.check(
    "도착 표시는 배치 움직임과 화면 이동이 끝난 뒤에 그려진다",
    first.after,
  );
  t.check("도착 표시는 사라진다", (await page.waitForSelector(".reached", { state: "detached", timeout: 5_000 }).then(() => true, () => false)));

  await load(page, url, false);
  await pick(page, file);
  const shifted = await dimFolderLine(page, from, to);
  await page.keyboard.down("Shift");
  await page.mouse.click(shifted.at.x, shifted.at.y);
  await page.keyboard.up("Shift");
  await page.waitForSelector(".info-panel-sites", { timeout: 10_000 }).catch(() => {});
  await page.mouse.move(1, 1);
  await settle(page);
  t.check(
    "Shift를 누른 채 누르면 폴더는 접힌 채로 코드 줄 목록만 열리고 고른 파일의 초점은 그대로다",
    (await count(page, ".info-panel-sites")) > 0 && (await count(page, `${node(to)} > .node-package`)) > 0 && (await selectedOf(page)) === file,
    `선택 ${await selectedOf(page)}`,
  );
  await page.getByRole("button", { name: "뒤로" }).click();
  await settle(page);

  const dim = await dimFolderLine(page, from, to);
  const before = await zoomOf(page);
  const went = await lineToFolder(page, to, dim.at);
  t.check(
    `${file}.py를 고른 채 흐린 선 ${from} → ${to}/를 누르면 ${to}/가 펼쳐지고 앞 선택과 그 흐름의 강조가 풀려 본문 잉크 선은 누른 선이 갈라진 선뿐이다`,
    went.opened && went.selected === null && went.via > 0 && went.strong === went.via && (await count(page, `${node(file)} > .node-module-open`)) === 0,
    `펼침 ${went.opened}, 선택 ${went.selected}, 본문 잉크 선 ${went.strong}개, 누른 선이 갈라진 선 ${went.via}개`,
  );
  t.check(`펼친 ${to}/ 영역이 정보 패널과 왼쪽 아래 칸이 가리지 않는 영역 안에 오고 확대 비율은 그대로다`, went.fits && near(await zoomOf(page), before, 0.001), went.text);
  t.check("펼친 영역에 도착 표시가 화면 이동이 끝난 뒤에 잠깐 그려진다", went.marked && went.after);
  await page.getByRole("button", { name: "뒤로" }).click();
  await waitSelected(page, file).catch(() => {});
  t.check("뒤로 한 번이면 폴더가 접히고 앞 선택이 돌아온다", (await selectedOf(page)) === file && (await count(page, `${node(to)} > .node-package`)) > 0, `선택 ${await selectedOf(page)}`);

  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포에서 고른 파일과 떨어진 접힌 폴더로 가는 선을 누른다", "--wide-url을 주지 않았다");
    return;
  }
  const wide = WIDE_LINE_FOLDER;
  await page.goto(wideUrl);
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  for (const folder of wide.open) {
    await openFolder(page, folder);
  }
  await page.click(`.tree-row.tree-file[data-node="${wide.file}"]`);
  await waitSelected(page, wide.file);
  const far = await dimFolderLine(page, wide.from, wide.to);
  if (far === null) {
    t.skip(`${wide.file}을 고른 채 흐린 선 ${wide.from} → ${wide.to}/를 누른다`, "그 선이 화면에 없거나 누를 점이 다른 선에 덮였다");
    return;
  }
  const scale = await zoomOf(page);
  const there = await lineToFolder(page, wide.to, far.at, t.shot);
  t.check(
    `${wide.file}을 고른 채 흐린 선 ${wide.from} → ${wide.to}/를 누르면 ${wide.to}/가 펼쳐지고 앞 선택과 그 흐름의 강조가 풀려 본문 잉크 선은 누른 선이 갈라진 선뿐이다`,
    there.opened && there.selected === null && there.via > 0 && there.strong === there.via && (await count(page, `${node(wide.file)} > .node-module-open`)) === 0,
    `펼침 ${there.opened}, 선택 ${there.selected}, 본문 잉크 선 ${there.strong}개, 누른 선이 갈라진 선 ${there.via}개`,
  );
  t.check(`펼친 ${wide.to}/ 영역이 가리지 않는 영역 안에 오고 확대 비율은 그대로다`, there.fits && near(await zoomOf(page), scale, 0.001), there.text);
  t.check("펼친 영역에 도착 표시가 화면 이동이 끝난 뒤에 잠깐 그려진다", there.marked && there.after);
}

// ── 정보 패널의 머리 줄과 "정보" 구역 ───────────────────────────────

const KIND_WORDS = { call: "호출", construct: "생성", import: "import", pass: "전달", read: "읽음", write: "바꿈", decorate: "데코레이터", type: "타입", inherit: "상속", override: "오버라이드" };

/** 노드를 그 노드 하나로 가리킬 때 적는 이름(frontend/src/graph/names.ts의 nameOf와 같은 규칙) */
function shortName(graph, id) {
  const found = graph.nodes.find((n) => n.id === id);
  if (found.kind === "module") {
    return found.path.split("/").pop();
  }
  if (found.kind === "package") {
    return `${found.name}/`;
  }
  if (found.kind === "method") {
    return `${graph.nodes.find((n) => n.id === found.parent).name}.${found.name}()`;
  }
  return found.kind === "function" ? `${found.name}()` : found.name;
}

/**
 * 원래 선 edges를 정보 패널이 적는 글로 바꾼다(frontend/src/panel/links.ts의 linksText·restText·relationText와 같은 규칙).
 * total은 세는 관계의 코드 줄 수, rest는 그 밖의 관계의 코드 줄 수, main은 연결 줄의 합계, more는 `그 밖` 묶음, text는 둘을 이은 글,
 * relation은 선 하나의 `관계` 줄에 적는 글이다.
 */
function linksWords(edges) {
  const kinds = kindsOf(edges);
  const names = (counted) =>
    Object.keys(KIND_WORDS)
      .filter((kind) => kinds[kind] !== undefined && COUNTED.includes(kind) === counted)
      .map((kind) => `${KIND_WORDS[kind]} ${kinds[kind]}${kind === "import" ? "줄" : "곳"}`);
  const [each, others] = [names(true), names(false)];
  const total = countedSites(edges);
  const main = each.length === 0 ? "없음" : each.length === 1 ? each[0] : `${total}곳 (${each.join(", ")})`;
  const more = others.length === 0 ? "" : `그 밖 ${others.join(", ")}`;
  const words = relationWords(kinds);
  return {
    total,
    rest: edges.reduce((sum, edge) => sum + edge.sites.length, 0) - total,
    main,
    more,
    text: more === "" ? main : `${main} ${more}`,
    relation: total > 0 && more !== "" ? `${words} · ${more}` : words,
  };
}

/** 노드 id의 경계를 넘어 나가는 선과 들어오는 선. 테스트 코드와 외부 노드에 닿는 선은 뺀다(두 토글이 꺼진 화면). */
function crossing(graph, id) {
  const parents = new Map(graph.nodes.map((n) => [n.id, n.parent]));
  const off = hiddenOf(graph);
  const inside = (at) => {
    for (let now = at; now != null; now = parents.get(now)) {
      if (now === id) {
        return true;
      }
    }
    return false;
  };
  const seen = graph.edges.filter((e) => !off.has(e.source) && !off.has(e.target));
  return { out: seen.filter((e) => inside(e.source) && !inside(e.target)), into: seen.filter((e) => !inside(e.source) && inside(e.target)) };
}

/** 정보 패널의 이름 줄과 "정보" 구역. rows는 줄마다 줄 이름, 주제, 내용, 누를 수 있는지와 두 칸의 왼쪽 x다. */
const factsOf = (page) =>
  page.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent ?? null;
    return {
      path: text(".info-panel-path"),
      name: text(".info-panel-own"),
      chips: [...document.querySelectorAll(".info-panel-chip")].map((chip) => chip.textContent),
      open: document.querySelector(".info-panel-facts .info-section-head")?.getAttribute("aria-expanded") ?? null,
      brief: text(".info-panel-facts .info-section-brief"),
      rows: [...document.querySelectorAll(".info-row")].map((row) => {
        const [topic, value] = [row.querySelector("dt"), row.querySelector("dd")];
        const link = value.querySelector(".info-link");
        const more = value.querySelector(".info-more")?.textContent ?? "";
        return {
          id: row.dataset.row,
          topic: topic.textContent,
          text: `${value.textContent.slice(0, value.textContent.length - more.length)}${more === "" ? "" : ` ${more}`}`,
          pressable: link !== null,
          link: link === null ? null : { color: getComputedStyle(link).color, line: getComputedStyle(link).textDecorationLine },
          left: [topic.getBoundingClientRect().left, value.getBoundingClientRect().left],
        };
      }),
    };
  });

/** 그린 선마다 지나온 선 표시와 선 굵기, 진하기 */
const viaLines = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge .edge[data-key]:not(.edge-trunk)")].map((edge) => ({
      key: edge.dataset.key,
      via: edge.hasAttribute("data-via"),
      strong: edge.classList.contains("tone-strong"),
      opacity: Number(getComputedStyle(edge).opacity),
      width: parseFloat(getComputedStyle(edge.querySelector(".edge-line")).strokeWidth),
      derive: edge.classList.contains("edge-derive"),
    })),
  );

const rowsText = (facts) => facts.rows.map((row) => `${row.topic}: ${row.text}`).join(" / ");
const HF2 = (name) => join(OUT, `hf2-panel-${name}.png`);

/** 이름 줄의 경로 표기, "정보" 구역의 두 칸 목록, 구역 접기, 선을 눌러 온 상태를 본다. */
async function panelHead(t, page) {
  await answerSummaryReads(page, () => ({ summary: longSummary(2), stale: false, available: true, reason: null }));
  const graph = await api("/api/graph");
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  await load(page);

  // 파일 노드
  await pick(page, FILE);
  await page.waitForSelector(".info-panel-summary .summary-text", { timeout: 10_000 });
  const fileNode = byId.get(FILE);
  const inFile = graph.nodes.filter((n) => n.path === fileNode.path && n.id !== FILE);
  const fileLinks = crossing(graph, FILE);
  const onFile = await factsOf(page);
  const at = fileNode.path.lastIndexOf("/") + 1;
  t.check(
    "파일 노드의 이름 줄은 폴더 경로와 파일 이름이고 종류 칩이 남는다",
    onFile.path === fileNode.path.slice(0, at) && onFile.name === fileNode.path.slice(at) && onFile.chips.includes("파일"),
    `${onFile.path}${onFile.name} [${onFile.chips.join(", ")}]`,
  );
  const fileWant = [
    ["크기", `${fileNode.loc}줄`],
    [
      "포함",
      [
        ["함수", inFile.filter((n) => n.kind === "function").length],
        ["클래스", inFile.filter((n) => n.kind === "class" || n.kind === "dataclass").length],
        ["변수", inFile.filter((n) => n.kind === "variable" && !veiled(n)).length],
      ]
        .filter(([, n]) => n > 0)
        .map(([name, n]) => `${name} ${n}개`)
        .join(", "),
    ],
    ["나가는 연결", linksWords(fileLinks.out).text],
    ["들어오는 연결", linksWords(fileLinks.into).text],
  ];
  t.check(
    "파일 노드의 정보 구역은 크기, 포함, 나가는 연결, 들어오는 연결 순서의 두 칸 목록이다",
    same(onFile.rows.filter((row) => row.id !== "unresolved").map((row) => [row.topic, row.text]), fileWant),
    rowsText(onFile),
  );
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF2("file-light") });

  // 함수 노드
  await pick(page, FUNCTION);
  await page.waitForSelector(".info-panel .monaco-editor .line-numbers", { timeout: 30_000 });
  await page.waitForSelector(".info-panel-summary .summary-text", { timeout: 10_000 });
  const fn = byId.get(FUNCTION);
  const fnLinks = crossing(graph, FUNCTION);
  const onFn = await factsOf(page);
  t.check(
    "함수 노드의 이름 줄은 `파일 경로::이름`이고 위치 줄이 따로 없다",
    onFn.path === `${fn.path}::` && onFn.name === `${fn.name}()` && (await count(page, ".info-panel-facts-text")) === 0 && !(await headOf(page)).includes("·"),
    `${onFn.path}${onFn.name} [${onFn.chips.join(", ")}] / 머리 줄: ${(await headOf(page)).replaceAll("\n", " / ")}`,
  );
  const fnWant = [
    ["크기", `${fn.loc}줄 (${fn.range[0]}~${fn.range[1]})`],
    ["나가는 연결", linksWords(fnLinks.out).text],
    ["들어오는 연결", linksWords(fnLinks.into).text],
    ...(fn.unresolved > 0 ? [["미확인 호출", `${fn.unresolved}곳`]] : []),
  ];
  t.check("함수 노드의 정보 구역은 크기, 나가는 연결, 들어오는 연결, 미확인 호출 순서이고 없는 줄은 뺀다", same(onFn.rows.map((row) => [row.topic, row.text]), fnWant), rowsText(onFn));
  const lefts = onFn.rows.map((row) => row.left);
  t.check(
    "주제 칸과 내용 칸이 줄마다 같은 x에서 시작하고 가운데 점으로 잇지 않는다",
    lefts.every(([topic, value]) => near(topic, lefts[0][0], 0.5) && near(value, lefts[0][1], 0.5)) && onFn.rows.every((row) => !row.text.includes("·")),
    lefts.map(([topic, value]) => `${topic.toFixed(0)}/${value.toFixed(0)}`).join(", "),
  );
  const link = await colorOf(page, "--link");
  const links = onFn.rows.filter((row) => row.pressable);
  t.check(
    "누를 수 있는 합계는 --link 색으로 적고 밑줄을 긋지 않는다",
    links.length > 0 && links.every((row) => row.link.line === "none" && row.link.color === link.rgb),
    `${links.map((row) => `${row.topic} ${row.link.color} ${row.link.line}`).join(", ")}, --link ${link.rgb}`,
  );
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF2("function-light") });

  // 합계를 누르면 코드 줄 목록이 열린다
  const total = linksWords(fnLinks.out).total;
  await page.click('.info-row[data-row="out"] .info-link');
  await page.waitForSelector(".info-panel-sites", { timeout: 5_000 }).catch(() => {});
  const heads = await count(page, ".info-panel-sites-head");
  await spreadAll(page);
  const listed = await count(page, ".info-panel-site");
  t.check(
    "나가는 연결의 합계를 누르면 상대 노드마다 묶음 줄 하나인 목록이 열리고, 묶음을 모두 펴면 코드 줄 수가 합계와 같다",
    listed === total && heads === new Set(fnLinks.out.filter((e) => COUNTED.includes(e.kind)).map((e) => e.target)).size,
    `묶음 줄 ${heads}개, 코드 줄 ${listed}개, 합계 ${total}`,
  );
  await page.click(".info-panel-site >> nth=0");
  await page.waitForSelector(".info-panel .code .site-line, .info-panel .code [class*='highlight']", { timeout: 3_000 }).catch(() => {});
  t.check("코드 줄을 누르면 그 줄이 열린 줄로 표시된다", (await count(page, '.info-panel-site[aria-current="true"]')) === 1);
  await page.click('.info-row[data-row="out"] .info-link');
  await page.waitForTimeout(200);
  t.check("합계를 다시 누르면 목록이 닫힌다", (await count(page, ".info-panel-sites")) === 0);
  const others = linksWords(fnLinks.out);
  if (others.rest === 0) {
    t.skip("나가는 연결의 그 밖 묶음을 누르면 세지 않는 관계의 코드 줄 목록이 열린다", "고른 함수에서 나가는 import·타입 관계가 없다");
  } else {
    await page.click('.info-row[data-row="out"] .info-more');
    await page.waitForSelector(".info-panel-sites", { timeout: 5_000 }).catch(() => {});
    await spreadAll(page);
    t.check(
      "나가는 연결의 그 밖 묶음을 누르면 타입과 import 관계의 코드 줄 목록이 열린다",
      (await count(page, ".info-panel-site")) === others.rest && (await page.textContent('.info-row[data-row="out"] .info-more')) === others.more,
      `코드 줄 ${await count(page, ".info-panel-site")}개, ${others.more}`,
    );
    await page.click('.info-row[data-row="out"] .info-more');
    await page.waitForTimeout(200);
  }

  // 구역 접기
  const sizes = async () => ({
    summary: (await rectOf(page, ".info-panel-summary")).height,
    code: (await rectOf(page, ".info-panel .code")).height,
    facts: (await rectOf(page, ".info-panel-facts")).height,
  });
  const opened = await sizes();
  await page.click(".info-panel-summary .info-section-head");
  await page.waitForTimeout(300);
  const foldedSummary = await sizes();
  const brief = await page.evaluate(() => document.querySelector(".info-panel-summary .info-section-brief")?.textContent ?? "");
  t.check(
    "LLM 요약 구역을 접으면 요지 한 줄만 남고 줄어든 높이만큼 코드 뷰어가 커지며 경계선이 사라진다",
    brief === longSummary(2).split("\n")[0] &&
      foldedSummary.summary < 40 &&
      near(foldedSummary.code - opened.code, opened.summary - foldedSummary.summary, 2) &&
      (await count(page, ".info-panel-divide")) === 0,
    `요약 칸 ${opened.summary.toFixed(0)} → ${foldedSummary.summary.toFixed(0)}, 코드 뷰어 ${opened.code.toFixed(0)} → ${foldedSummary.code.toFixed(0)}, 한 줄: ${brief.slice(0, 30)}`,
  );
  await page.click(".info-panel-facts .info-section-head");
  await page.waitForTimeout(300);
  const shut = await factsOf(page);
  const foldedBoth = await sizes();
  t.check(
    "정보 구역을 접으면 크기와 연결 수를 한 줄로 보이고 코드 뷰어가 그만큼 더 커진다",
    shut.rows.length === 0 &&
      shut.brief === `${fn.loc}줄, 나가는 연결 ${total}곳, 들어오는 연결 ${linksWords(fnLinks.into).total}곳` &&
      near(foldedBoth.code - foldedSummary.code, foldedSummary.facts - foldedBoth.facts, 2),
    `${shut.brief} / 정보 구역 ${foldedSummary.facts.toFixed(0)} → ${foldedBoth.facts.toFixed(0)}, 코드 뷰어 ${foldedBoth.code.toFixed(0)}`,
  );
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF2("folded-light") });
  await page.click(`.tree-row.tree-file[data-node="${FILE}"]`);
  await waitSelected(page, FILE);
  const other = await factsOf(page);
  t.check("노드를 바꿔도 두 구역이 접힌 채다", other.open === "false" && (await count(page, ".info-panel-summary[data-folded]")) === 1, `정보 ${other.open}`);
  await page.reload();
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  await pick(page, FILE);
  await pick(page, FUNCTION);
  await page.waitForSelector(".info-panel .monaco-editor .line-numbers", { timeout: 30_000 });
  t.check(
    "새로 고친 뒤에도 두 구역이 접힌 채다",
    (await factsOf(page)).open === "false" && (await count(page, ".info-panel-summary[data-folded]")) === 1,
  );
  await page.click(".info-panel-facts .info-section-head");
  await page.click(".info-panel-summary .info-section-head");
  await page.waitForSelector(".info-panel-summary .summary-text", { timeout: 10_000 });
  await page.waitForTimeout(300);
  const again = await sizes();
  await drag(page, center(await rectOf(page, ".info-panel-divide")), 0, 80);
  await page.waitForTimeout(300);
  const pulled = await sizes();
  t.check(
    "구역을 다시 펴면 앞의 높이로 돌아오고 요약 칸과 코드 뷰어 사이의 경계선을 끌 수 있다",
    near(again.summary, opened.summary, 2) && near(again.facts, opened.facts, 1) && near(pulled.summary, again.summary + 80, 1.5) && near(pulled.code, again.code - 80, 1.5),
    `요약 칸 ${again.summary.toFixed(0)} → ${pulled.summary.toFixed(0)}, 코드 뷰어 ${again.code.toFixed(0)} → ${pulled.code.toFixed(0)}`,
  );
  await page.dblclick(".info-panel-divide");

  // 선을 눌러 온 상태
  const candidates = (await linesOf(page)).filter((line) => {
    const [source, target] = endsOfKey(line.key);
    return line.trunk === null && source === FUNCTION && byId.get(target)?.kind !== "package" && COUNTED.some((kind) => line.key.endsWith(`|${kind}`));
  });
  const found = await hittable(page, candidates);
  if (found === null) {
    t.skip("고른 함수에서 나가는 선을 눌러 도착 노드로 간다", "줄기에 들지 않고 누를 점이 있는 세는 관계의 선이 없다");
  } else {
    const [, target] = endsOfKey(found.line.key);
    const along = found.line.key.startsWith("agg|") ? crossing(graph, target).into.filter((e) => e.source === FUNCTION) : graph.edges.filter((e) => `${e.source}|${e.target}|${e.kind}` === found.line.key);
    await followLine(page, found.at, { key: found.line.key, to: target });
    await page.mouse.move(1, 1);
    await waitSelected(page, target);
    const came = await factsOf(page);
    const wantLink = `${shortName(graph, FUNCTION)} → ${shortName(graph, target)}`;
    t.check(
      "선을 눌러 도착 노드로 오면 정보 구역 맨 위에 연결과 관계 줄이 더해진다",
      came.rows[0]?.topic === "연결" && came.rows[0].text === wantLink && came.rows[1]?.topic === "관계" && came.rows[1].text === linksWords(along).relation && came.rows[1].pressable,
      rowsText(came),
    );
    const lines = await viaLines(page);
    const via = lines.filter((line) => line.via);
    const rest = lines.filter((line) => !line.via && line.strong);
    t.check(
      "그 선 하나만 본문 잉크에 1px 굵게 그리고, 도착 노드에 닿는 다른 선은 본문 잉크의 보통 굵기다",
      via.length === 1 &&
        via.every((line) => line.strong && line.opacity === 1 && line.width === (line.derive ? 4 : 2.5)) &&
        rest.length > 0 &&
        rest.every((line) => line.width === (line.derive ? 3 : 1.5)),
      `지나온 선 ${via.map((line) => `${line.key} ${line.width}px`).join(", ")}, 다른 본문 잉크 선 ${rest.length}개`,
    );
    await page.click('.info-row[data-row="via"] .info-link');
    await page.waitForSelector(".info-panel-sites", { timeout: 5_000 }).catch(() => {});
    t.check("관계의 글을 누르면 그 선의 코드 줄 목록이 열린다", (await count(page, ".info-panel-site")) === linksWords(along).total + linksWords(along).rest, `코드 줄 ${await count(page, ".info-panel-site")}개`);
    await page.click('.info-row[data-row="via"] .info-link');
    await page.screenshot({ path: HF2("line-light") });
    await page.getByRole("button", { name: "어두운 화면" }).click();
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);
    await page.screenshot({ path: HF2("line-dark") });
    await page.getByRole("button", { name: "밝은 화면" }).click();

    await pickInTree(page, { owner: FILE, id: FUNCTION });
    const left = await factsOf(page);
    t.check(
      "다른 방법으로 노드를 고르면 연결과 관계 줄, 굵은 선이 사라진다",
      left.rows.every((row) => row.topic !== "연결" && row.topic !== "관계") && (await viaLines(page)).every((line) => !line.via),
      rowsText(left),
    );
    // 파일트리에서 고르면 파일과 함수가 한 단계씩 이력에 들어간다.
    for (let i = 0; i < 2; i += 1) {
      await page.getByRole("button", { name: "뒤로" }).click();
      await settle(page);
    }
    await waitSelected(page, target);
    const back = await factsOf(page);
    t.check(
      "뒤로 가서 그 단계로 돌아오면 선을 눌러 온 상태가 돌아온다",
      back.rows[0]?.text === wantLink && (await viaLines(page)).filter((line) => line.via).length === 1,
      rowsText(back),
    );
  }

  // 좁은 패널
  await pickInTree(page, { owner: FILE, id: FUNCTION });
  const edge = await rectOf(page, '.info-panel-resize[data-dir="w"]');
  await drag(page, center(edge), 600, 0);
  await page.waitForTimeout(300);
  const cut = await page.evaluate(() => {
    const [path, own, panel] = [".info-panel-path", ".info-panel-own", ".info-panel"].map((selector) => document.querySelector(selector));
    const [a, b] = [own.getBoundingClientRect(), panel.getBoundingClientRect()];
    return { path: path.scrollWidth > path.clientWidth, own: own.scrollWidth <= own.clientWidth && a.right <= b.right, width: b.width };
  });
  t.check("패널이 좁아 이름 줄이 넘치면 앞쪽 경로를 줄이고 이름은 끝까지 보인다", cut.path && cut.own, `패널 폭 ${cut.width}, 경로 줄임 ${cut.path}, 이름 온전 ${cut.own}`);
  await page.screenshot({ path: HF2("narrow-light") });
  await page.dblclick(".info-panel-head");
  await settle(page);

  // 폴더 도착
  const { from, to } = LINE_FOLDER;
  await load(page, url, false);
  const plain = await hittable(page, (await linesOf(page)).filter((line) => same(endsOfKey(line.key), [from, to])));
  const reached = await lineToFolder(page, to, plain.at);
  const atFolder = await factsOf(page);
  const intoFolder = crossing(graph, to).into.filter((e) => e.source === from || byId.get(e.source)?.path === byId.get(from).path);
  const split = (await viaLines(page)).filter((line) => line.via);
  t.check(
    "접힌 폴더로 들어가는 선을 누르면 선택 없이 폴더가 펼쳐지고 정보 패널에 연결과 관계 줄이 보인다",
    reached.opened && reached.selected === null && atFolder.rows.length === 2 && atFolder.rows[0].text === `${shortName(graph, from)} → ${shortName(graph, to)}` && atFolder.rows[1].text === linksWords(intoFolder).relation,
    `${atFolder.name} / ${rowsText(atFolder)}`,
  );
  t.check(
    "그 선이 펼친 뒤 갈라진 선만 본문 잉크로 굵게 남는다",
    split.length > 0 &&
      split.every((line) => endsOfKey(line.key)[0] === from && (byId.get(endsOfKey(line.key)[1])?.id ?? "").startsWith(`${to}.`) && line.strong && line.opacity === 1) &&
      reached.strong === split.length,
    `굵은 선 ${split.map((line) => line.key).join(", ")}, 본문 잉크 선 ${reached.strong}개`,
  );
  await page.screenshot({ path: HF2("folder-light") });
  await page.getByRole("button", { name: "뒤로" }).click();
  await page.waitForSelector(`${node(to)} > .node-package`, { timeout: 30_000 }).catch(() => {});
  await settle(page);
  const folded = { box: await count(page, `${node(to)} > .node-package`), rows: (await factsOf(page)).rows.length, via: (await viaLines(page)).filter((line) => line.via).length };
  t.check("뒤로 가면 폴더가 접히고 연결과 관계 줄, 굵은 선이 사라진다", folded.box > 0 && folded.rows === 0 && folded.via === 0, `접힌 상자 ${folded.box}, 줄 ${folded.rows}, 굵은 선 ${folded.via}`);
  await page.getByRole("button", { name: "앞으로" }).click();
  await page.waitForSelector(`${node(to)} > .node-region`, { timeout: 30_000 }).catch(() => {});
  await settle(page);
  const forth = await factsOf(page);
  t.check(
    "앞으로 가면 폴더가 펼쳐지고 선을 눌러 온 상태가 돌아온다",
    forth.rows.length === 2 && (await viaLines(page)).filter((line) => line.via).length === split.length,
    rowsText(forth),
  );
  await page.click(`.tree-row.tree-file[data-node="${from}"]`);
  await waitSelected(page, from);
  t.check("노드를 고르면 폴더에 온 상태의 줄과 굵은 선이 사라진다", (await factsOf(page)).rows.every((row) => row.topic !== "연결") && (await viaLines(page)).every((line) => !line.via));
  await t.shot();
}

/** 코드 뷰어 위의 칸 하나가 처음에 쓰는 높이의 상한을 패널 높이로 나눈 값(`--part-share`)과 코드 뷰어의 최소 높이(`MIN_CODE`) */
const PART_SHARE = 0.25;
const CODE_MIN = 96;
/** 나가는 연결의 상대 노드가 많은 함수 */
const LINKED = "arbiter:arbiter_sync";

/** "정보" 구역의 코드 줄 목록. heads는 묶음 줄마다 이름, 관계 글, 코드 줄을 폈는지이고 inside는 목록이 "정보" 구역의 자손인지다. */
const sitesOf = (page) =>
  page.evaluate(() => {
    const list = document.querySelector(".info-panel-sites");
    const height = (selector) => document.querySelector(selector)?.getBoundingClientRect().height ?? 0;
    return {
      inside: list?.closest(".info-panel-facts") != null,
      heads: [...document.querySelectorAll(".info-panel-sites-head")].map((head) => ({
        name: head.querySelector(".info-panel-sites-name").textContent,
        text: head.querySelector(".info-link").textContent,
        spread: head.querySelector(".info-link").getAttribute("aria-expanded") === "true",
      })),
      sites: document.querySelectorAll(".info-panel-site").length,
      height: list?.getBoundingClientRect().height ?? 0,
      scrolls: list != null && list.scrollHeight > list.clientHeight && getComputedStyle(list).overflowY === "auto",
      panel: height(".info-panel"),
      summary: height(".info-panel-summary"),
      code: height(".info-panel .code"),
      pressed: [...document.querySelectorAll(".info-rows .info-link[aria-expanded='true']")].map((link) => link.closest(".info-row").dataset.row + (link.classList.contains("info-more") ? "-rest" : "")),
    };
  });

/** 코드 줄 목록에서 접힌 묶음의 코드 줄을 모두 편다. */
async function spreadAll(page) {
  for (let left = await count(page, '.info-panel-sites-head .info-link[aria-expanded="false"]'); left > 0; left -= 1) {
    await page.click('.info-panel-sites-head .info-link[aria-expanded="false"] >> nth=0');
  }
  await page.waitForTimeout(200);
}

/** "정보" 구역 안의 코드 줄 목록: 구역과 함께 접힘, 높이의 상한, 한 번에 하나, 묶음 줄을 본다. */
async function factsList(t, page) {
  await answerSummaryReads(page, () => ({ summary: longSummary(2), stale: false, available: true, reason: null }));
  const graph = await api("/api/graph");
  await load(page);
  await pick(page, FILE);
  await pick(page, LINKED);
  await page.waitForSelector(".info-panel .monaco-editor .line-numbers", { timeout: 30_000 });
  await page.waitForSelector(".info-panel-summary .summary-text", { timeout: 10_000 });
  const links = crossing(graph, LINKED);
  const counted = (edges) => edges.filter((e) => COUNTED.includes(e.kind));
  const tree = ancestry(graph);
  /** 묶음 줄의 이름: 고른 노드가 든 파일에서 갈라지는 곳부터 적은 상대 노드의 이름 */
  const peerName = (id) => nameFrom(graph, tree, tree.unitOf(LINKED), id);
  const peers = (edges, end) => [...new Set(counted(edges).map((e) => e[end]))].map(peerName);
  const shut = await sitesOf(page);

  await page.click('.info-row[data-row="out"] .info-link');
  await page.waitForSelector(".info-panel-sites", { timeout: 5_000 }).catch(() => {});
  const out = await sitesOf(page);
  t.check(
    "나가는 연결의 합계를 누르면 상대 노드마다 한 줄인 목록이 정보 구역의 자손으로 열리고 코드 줄은 접혀 있다",
    out.inside && same(out.heads.map((head) => head.name).sort(), peers(links.out, "target").sort()) && out.heads.every((head) => !head.spread && /\d(곳|줄)$/.test(head.text)) && out.sites === 0,
    `정보 구역 안 ${out.inside}, 묶음 줄 ${out.heads.length}개, 코드 줄 ${out.sites}개, 첫 줄: ${out.heads[0]?.name} ${out.heads[0]?.text}`,
  );
  t.check("열린 목록의 합계에 aria-expanded와 밑줄이 붙는다", same(out.pressed, ["out"]) && (await factsOf(page)).rows.find((row) => row.id === "out").link.line === "underline", out.pressed.join(", "));
  const cap = out.panel * PART_SHARE;
  t.check(
    "상대 노드가 많아도 목록의 높이가 패널 높이의 4분의 1을 넘지 않고 목록 안에서 스크롤되며 요약 칸은 그대로다",
    out.height <= cap + 1 && out.scrolls && near(out.summary, shut.summary, 1) && out.code >= CODE_MIN,
    `목록 ${out.height.toFixed(0)} (상한 ${cap.toFixed(0)}), 요약 칸 ${shut.summary.toFixed(0)} → ${out.summary.toFixed(0)}, 코드 뷰어 ${shut.code.toFixed(0)} → ${out.code.toFixed(0)}`,
  );
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF4("facts-after") });

  // 묶음 줄의 관계를 눌러 코드 줄을 편다
  await page.focus(".info-panel-sites-head .info-link >> nth=0");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".info-panel-site", { timeout: 5_000 }).catch(() => {});
  const one = await sitesOf(page);
  t.check("묶음 줄의 관계에 초점을 두고 Enter를 누르면 그 묶음의 코드 줄만 펴진다", one.heads[0].spread && one.heads.filter((head) => head.spread).length === 1 && one.sites > 0, `편 묶음 ${one.heads.filter((head) => head.spread).length}개, 코드 줄 ${one.sites}개`);
  await page.click(".info-panel-site >> nth=0");
  await page.waitForSelector(".info-panel .monaco-editor .code-range", { timeout: 30_000 }).catch(() => {});
  t.check("코드 줄을 누르면 코드 뷰어가 그 줄을 열고 열린 줄로 표시한다", (await count(page, '.info-panel-site[aria-current="true"]')) === 1 && (await count(page, ".info-panel .monaco-editor .code-range")) > 0);
  await spreadAll(page);
  const all = await sitesOf(page);
  t.check(
    "묶음을 모두 펴면 코드 줄 수가 합계와 같고 목록의 높이는 상한 그대로다",
    all.sites === linksWords(links.out).total && all.height <= cap + 1 && all.scrolls && all.code >= CODE_MIN,
    `코드 줄 ${all.sites}개, 합계 ${linksWords(links.out).total}, 목록 ${all.height.toFixed(0)}, 코드 뷰어 ${all.code.toFixed(0)}`,
  );

  // 구역 접기
  await page.click(".info-panel-facts .info-section-head");
  await page.waitForTimeout(300);
  const folded = await sitesOf(page);
  t.check(
    "정보 구역을 접으면 목록이 함께 사라지고 코드 뷰어가 그만큼 커진다",
    (await count(page, ".info-panel-sites")) === 0 && (await factsOf(page)).brief.includes("나가는 연결") && folded.code > shut.code,
    `코드 뷰어 ${all.code.toFixed(0)} → ${folded.code.toFixed(0)}, 한 줄: ${(await factsOf(page)).brief}`,
  );
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF4("facts-folded") });
  await page.click(".info-panel-facts .info-section-head");
  await page.waitForSelector(".info-panel-sites", { timeout: 5_000 }).catch(() => {});
  const unfolded = await sitesOf(page);
  t.check(
    "구역을 다시 펴면 열어 둔 목록과 편 묶음, 연 코드 줄이 그대로 돌아온다",
    same(unfolded.pressed, ["out"]) && unfolded.sites === all.sites && unfolded.heads.every((head) => head.spread) && (await count(page, '.info-panel-site[aria-current="true"]')) === 1,
    `열린 합계 ${unfolded.pressed.join(", ")}, 코드 줄 ${unfolded.sites}개`,
  );

  // 한 번에 하나
  if (counted(links.into).length === 0) {
    t.skip("들어오는 연결의 합계를 누르면 나가는 연결의 목록이 닫히고 들어오는 연결의 목록이 열린다", "고른 함수로 들어오는 세는 관계가 없다");
  } else {
    await page.click('.info-row[data-row="into"] .info-link');
    await page.waitForTimeout(300);
    const into = await sitesOf(page);
    t.check(
      "들어오는 연결의 합계를 누르면 나가는 연결의 목록이 닫히고 같은 곳에 들어오는 연결의 목록이 열린다",
      (await count(page, ".info-panel-sites")) === 1 && same(into.pressed, ["into"]) && same(into.heads.map((head) => head.name).sort(), peers(links.into, "source").sort()) && into.sites === 0,
      `열린 합계 ${into.pressed.join(", ")}, 묶음 줄 ${into.heads.map((head) => `${head.name} ${head.text}`).join(" / ")}`,
    );
    await page.click('.info-row[data-row="into"] .info-link');
    await page.waitForTimeout(200);
    t.check("열린 합계를 다시 누르면 목록이 닫힌다", (await count(page, ".info-panel-sites")) === 0 && (await sitesOf(page)).pressed.length === 0);
  }
  if (linksWords(links.out).rest === 0) {
    t.skip("그 밖 묶음을 누르면 합계의 목록 대신 그 밖의 관계의 목록이 열린다", "고른 함수에서 나가는 import·타입 관계가 없다");
  } else {
    await page.click('.info-row[data-row="out"] .info-link');
    await page.click('.info-row[data-row="out"] .info-more');
    await page.waitForTimeout(300);
    const rest = await sitesOf(page);
    await spreadAll(page);
    t.check(
      "그 밖 묶음을 누르면 합계의 목록 대신 그 밖의 관계의 목록이 정보 구역 안에 열린다",
      rest.inside && same(rest.pressed, ["out-rest"]) && (await count(page, ".info-panel-sites")) === 1 && (await sitesOf(page)).sites === linksWords(links.out).rest,
      `열린 글 ${rest.pressed.join(", ")}, 묶음 줄 ${rest.heads.length}개, 코드 줄 ${(await sitesOf(page)).sites}개`,
    );
  }

  // 어두운 화면, 낮은 패널
  await page.click('.info-row[data-row="out"] .info-link');
  await page.waitForSelector(".info-panel-sites", { timeout: 5_000 }).catch(() => {});
  await page.click(".info-panel-sites-head .info-link >> nth=1");
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: HF4("facts-dark") });
  await page.getByRole("button", { name: "밝은 화면" }).click();
  await spreadAll(page);
  const tall = await sitesOf(page);
  await drag(page, center(await rectOf(page, '.info-panel-resize[data-dir="s"]')), 0, -(tall.panel - 420));
  await page.waitForTimeout(400);
  const low = await sitesOf(page);
  t.check(
    "패널의 높이를 줄여도 목록은 줄어든 패널 높이의 4분의 1 안에서 스크롤되고 코드 뷰어가 최소 높이를 지킨다",
    low.panel < tall.panel - 100 && low.height <= low.panel * PART_SHARE + 1 && low.scrolls && low.code >= CODE_MIN - 1 && (await factsOf(page)).rows.length > 0,
    `패널 ${tall.panel.toFixed(0)} → ${low.panel.toFixed(0)}, 목록 ${low.height.toFixed(0)}, 요약 칸 ${low.summary.toFixed(0)}, 코드 뷰어 ${low.code.toFixed(0)}`,
  );
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF4("facts-short-panel") });
  await page.dblclick(".info-panel-head");
  await settle(page);

  // 묶음 줄의 이름을 눌러 그 노드로 간다
  const first = (await sitesOf(page)).heads[0].name;
  const target = counted(links.out).map((e) => e.target).find((id) => peerName(id) === first);
  await page.click(".info-panel-sites-name >> nth=0");
  await waitSelected(page, target);
  t.check(
    "묶음 줄의 이름을 누르면 그 노드를 고르고, 노드가 바뀌면 열린 목록이 닫힌다",
    (await selectedOf(page)) === target && (await factsOf(page)).name === shortName(graph, target) && (await count(page, ".info-panel-sites")) === 0 && (await sitesOf(page)).pressed.length === 0,
    `선택 ${await selectedOf(page)}, 이름 줄 ${(await factsOf(page)).name}`,
  );

  // 파일 상자: 상대 노드가 든 파일마다 한 줄
  await page.click(`.tree-row.tree-file[data-node="${FILE}"]`);
  await waitSelected(page, FILE);
  await page.click('.info-row[data-row="out"] .info-link');
  await page.waitForSelector(".info-panel-sites", { timeout: 5_000 }).catch(() => {});
  const fileOut = await sitesOf(page);
  const texts = fileOut.heads.map((head) => head.text);
  await spreadAll(page);
  const fileAll = await sitesOf(page);
  t.check(
    "파일을 고르면 묶음 줄이 상대 파일마다 하나이고, 모두 펴도 목록이 상한 안에서 스크롤된다",
    fileOut.heads.length > 0 && texts.every((text) => /\d곳$/.test(text)) && fileAll.sites === linksWords(crossing(graph, FILE).out).total && fileAll.height <= fileAll.panel * PART_SHARE + 1 && fileAll.scrolls,
    `묶음 줄 ${fileOut.heads.map((head) => `${head.name} ${head.text}`).slice(0, 3).join(" / ")}, 코드 줄 ${fileAll.sites}개, 목록 ${fileAll.height.toFixed(0)}, 코드 뷰어 ${fileAll.code.toFixed(0)}`,
  );
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF4("facts-file") });

  // 폴더가 여러 겹인 레포의 큰 파일
  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포에서 나가는 연결이 가장 많은 파일의 목록도 상한 안에서 스크롤된다", "--wide-url을 주지 않았다");
  } else {
    const wide = await api("/api/graph", wideUrl);
    await openWide(page);
    const rows = await page.evaluate(() => [...document.querySelectorAll(".tree-row.tree-file[data-node]")].map((row) => row.dataset.node));
    const sized = rows.map((id) => ({ id, total: linksWords(crossing(wide, id).out).total })).sort((a, b) => b.total - a.total)[0];
    await page.click(`.tree-row.tree-file[data-node="${sized.id}"]`);
    await waitSelected(page, sized.id);
    await page.waitForSelector(".info-panel .monaco-editor .line-numbers", { timeout: 30_000 });
    await page.click('.info-row[data-row="out"] .info-link');
    await page.waitForSelector(".info-panel-sites", { timeout: 5_000 }).catch(() => {});
    await spreadAll(page);
    const big = await sitesOf(page);
    t.check(
      "폴더가 여러 겹인 레포에서 나가는 연결이 가장 많은 파일의 목록도 상한 안에서 스크롤된다",
      big.inside && big.sites === sized.total && big.height <= big.panel * PART_SHARE + 1 && big.scrolls && big.code >= CODE_MIN,
      `${sized.id}: 묶음 줄 ${big.heads.length}개, 코드 줄 ${big.sites}개, 목록 ${big.height.toFixed(0)} (상한 ${(big.panel * PART_SHARE).toFixed(0)}), 코드 뷰어 ${big.code.toFixed(0)}`,
    );
    await page.mouse.move(1, 1);
    await page.screenshot({ path: HF4("facts-wide") });
  }
  await t.shot();
}

/** hotfix 3의 사진. `hf3-{이름}.png`로 남긴다. */
const HF3 = (name) => join(OUT, `hf3-${name}.png`);

/** 화면에 그린 진입점 표지마다 SVG 윤곽이 있는지, 글자가 있는지, 칸의 크기와 채운 색, 이름표의 글자 색 */
const entryMarks = (page, root) =>
  page.evaluate((sel) => {
    return [...document.querySelectorAll(`${sel} .entry-mark`)].map((mark) => {
      const [rect, path] = [mark.getBoundingClientRect(), mark.querySelector("svg path")];
      const scale = rect.width / mark.offsetWidth;
      return {
        drawn: path !== null && path.getBBox().width > 0,
        text: mark.textContent,
        size: [mark.offsetWidth, mark.offsetHeight],
        fill: path === null ? null : getComputedStyle(path).fill,
        ink: getComputedStyle(mark.parentElement).color,
        name: mark.getAttribute("aria-label"),
        tip: mark.dataset.tip,
        scale,
      };
    });
  }, root);

/** 진입점 표지. 굵은 체크를 SVG로 그리고 화면에 세모와 체크 글자를 적지 않는다. 사진은 `hf3-entry-mark-{이름}.png`로 남긴다. */
async function entryMark(t, page) {
  const graph = await api("/api/graph");
  const entries = graph.nodes.filter((n) => n.entry && !veiled(n));
  const glyphs = () => page.evaluate(() => [...document.body.innerText.matchAll(/[▶►✓✔]/g)].length);
  await load(page);
  await page.click(".legend-button");
  await pick(page, FILE);
  const light = await entryMarks(page, ".react-flow__viewport");
  const shown = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`.react-flow__node[data-id="${id}#face"]`) !== null), entries.map((n) => n.id));
  t.check(
    `화면에 보이는 진입점 노드 ${shown.length}개가 이름표 앞에 SVG 체크를 달고 표지 안에 글자가 없다`,
    shown.length > 0 && light.length === shown.length && light.every((mark) => mark.drawn && mark.text === ""),
    `표지 ${light.length}개`,
  );
  t.check(
    '표지는 12px 칸에 이름표의 글자 색으로 그리고 접근성 이름 "진입점"과 말풍선 글을 그대로 둔다',
    light.every((mark) => same(mark.size, [12, 12]) && mark.fill === mark.ink && mark.name === "진입점" && mark.tip.startsWith("진입점")),
    light.map((mark) => `${mark.size.join("×")} ${mark.fill}`).join(", "),
  );
  const fits = await page.evaluate((sel) => {
    const [head, label, aside] = [".node-module-head", ".node-label", ".node-module-head .node-aside"].map((each) => document.querySelector(`${sel} ${each}`).getBoundingClientRect());
    return { whole: label.right <= aside.left && aside.right <= head.right, gap: Math.round(aside.left - label.right) };
  }, face(FILE));
  t.check("펼친 진입점 파일 상자의 머리 줄에서 표지와 이름표가 함수 수 글자와 겹치지 않는다", fits.whole, `이름표와 함수 수 사이 ${fits.gap}px`);
  const legend = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".legend li")].find((item) => item.textContent === "진입점");
    return { path: row?.querySelector("path.legend-entry") !== null, text: row?.querySelector("svg")?.textContent ?? null };
  });
  const head = await entryMarks(page, ".info-panel-head");
  t.check(
    "범례의 진입점 견본과 정보 패널 이름 줄의 표지도 같은 SVG 체크다",
    legend.path && legend.text === "" && head.length === 1 && head[0].drawn && head[0].text === "",
    `범례 ${legend.path}, 이름 줄 ${head.length}개`,
  );
  t.check("화면의 글에 세모(▶)와 체크(✔) 글자가 없다", (await glyphs()) === 0, `${await glyphs()}개`);
  await page.screenshot({ path: HF3("entry-mark-light") });

  // 미사용 후보 표시와 순환 아이콘 옆에서도 체크가 진입점 표지에만 쓰인다.
  await setOverlay(page, "unused");
  await settle(page);
  const checks = await page.evaluate(() => document.querySelectorAll(".graph svg.entry-icon").length);
  t.check("미사용 후보 표시를 켜도 그래프의 체크 아이콘은 진입점 표지뿐이다", checks === light.length, `체크 ${checks}개, 표지 ${light.length}개`);
  await page.screenshot({ path: HF3("entry-mark-unused") });
  await setOverlay(page, "none");

  await page.getByRole("button", { name: "어두운 화면" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const dark = await entryMarks(page, ".react-flow__viewport");
  const ink = await colorOf(page, "--ink");
  t.check("어두운 화면에서 표지가 어두운 화면의 글자 색을 따른다", dark.length === light.length && dark.every((mark) => mark.fill === mark.ink && mark.fill === ink.rgb), dark.map((mark) => mark.fill).join(", "));
  await page.screenshot({ path: HF3("entry-mark-dark") });
}

/** 진입점 버튼의 글자, 테두리 폭과 바탕, 글자 색, 상단 줄 왼쪽 칸에서 앞뒤에 놓인 요소 */
const entriesButton = (page) =>
  page.evaluate(() => {
    const button = document.querySelector(".toolbar-entries");
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return {
      text: button.getAttribute("aria-label"),
      shown: [...button.children].filter((child) => child.getBoundingClientRect().width > 0).length,
      borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(parseFloat),
      background: style.backgroundColor,
      shadow: style.boxShadow,
      color: style.color,
      arrow: button.querySelector("svg path") !== null,
      before: button.previousElementSibling?.getAttribute("aria-label") ?? null,
      after: button.nextElementSibling?.className ?? null,
      nav: button.parentElement.className,
      expanded: button.getAttribute("aria-expanded"),
      disabled: button.disabled,
      rect: { left: rect.left, right: rect.right, bottom: rect.bottom },
    };
  });

/** 편 메뉴의 역할과 항목, 활성 항목, 화면 사각형 */
const listOf = (page) =>
  page.evaluate(() => {
    const menu = document.querySelector(".menu");
    if (menu === null) {
      return null;
    }
    const rect = menu.getBoundingClientRect();
    const items = [...menu.querySelectorAll(".menu-item")];
    const active = menu.querySelector("[data-active]");
    return {
      role: menu.getAttribute("role"),
      label: menu.getAttribute("aria-label"),
      roles: [...new Set(items.map((item) => item.getAttribute("role")))],
      items: items.map((item) => ({ key: item.dataset.key, node: item.dataset.node ?? null, text: item.textContent, disabled: item.getAttribute("aria-disabled") === "true", icon: item.querySelector("svg.entry-icon") !== null })),
      active: active?.dataset.key ?? null,
      activeShown: active === null || (active.getBoundingClientRect().top >= rect.top - 1 && active.getBoundingClientRect().bottom <= rect.bottom + 1),
      pointed: menu.getAttribute("aria-activedescendant") === (active?.id ?? null),
      focused: document.activeElement === menu,
      scrolls: menu.scrollHeight > menu.clientHeight,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      inside: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      style: (({ backgroundColor, color, borderTopColor }) => ({ backgroundColor, color, borderTopColor }))(getComputedStyle(menu)),
    };
  });

/** 말풍선과 선 목록이 쓰는 칸 바탕색, 본문 잉크, 경계선 색을 브라우저가 계산한 값 */
const menuTokens = (page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.cssText = "background: var(--panel-bg); color: var(--ink); border: 1px solid var(--line)";
    document.body.append(probe);
    const { backgroundColor, color, borderTopColor } = getComputedStyle(probe);
    probe.remove();
    return { backgroundColor, color, borderTopColor };
  });

/**
 * 상단 줄의 진입점 버튼. 테두리와 바탕이 없는 글자 버튼이고 누르면 글자 아래로 메뉴가 내려온다. 필터 창에는 진입점이 없다.
 * 사진은 `hf3-entry-{이름}.png`로 남긴다.
 */
async function entry(t, page) {
  const graph = await api("/api/graph");
  const entries = graph.nodes.filter((n) => n.entry && !veiled(n));
  const title = (n) => (n.kind === "module" ? `${n.id.replaceAll(".", "/")}.py` : null);
  await load(page);
  const ink = await colorOf(page, "--ink");
  const idle = await entriesButton(page);
  t.check(
    `상단 줄 왼쪽 칸의 앞으로 버튼과 탐색 경로 사이에 "진입점 ${entries.length}"과 아래 화살표를 적은 버튼이 있다`,
    idle.text === `진입점 ${entries.length}` && idle.arrow && idle.before === "앞으로" && idle.after === "toolbar-trail" && idle.nav === "toolbar-nav",
    `"${idle.text}", 앞 ${idle.before}, 뒤 ${idle.after}`,
  );
  await page.hover(".toolbar-entries");
  const hovered = await entriesButton(page);
  const bare = (button) => button.borders.every((width) => width === 0) && button.background === "rgba(0, 0, 0, 0)" && button.shadow === "none";
  t.check(
    "버튼은 테두리와 바탕이 없고, 커서를 올려도 상자가 생기지 않고 글자만 본문 잉크로 진해진다",
    bare(idle) && bare(hovered) && idle.color !== ink.rgb && hovered.color === ink.rgb,
    `평소 ${idle.color}, 올렸을 때 ${hovered.color}, 테두리 ${hovered.borders.join("/")}, 바탕 ${hovered.background}`,
  );
  await page.mouse.move(5, 5);
  await page.screenshot({ path: HF3("entry-button") });

  await page.click(".toolbar-entries");
  await page.waitForSelector(".menu", { timeout: 5_000 }).catch(() => {});
  const opened = await listOf(page);
  const button = await entriesButton(page);
  t.check(
    "버튼을 누르면 글자 바로 아래로 진입점 이름의 메뉴가 내려온다",
    opened !== null &&
      button.expanded === "true" &&
      near(opened.rect.left, button.rect.left) &&
      opened.rect.top >= button.rect.bottom &&
      opened.rect.top - button.rect.bottom < 12 &&
      same(opened.items.map((item) => item.node), entries.map((n) => n.id)) &&
      opened.items.every((item, i) => item.icon && (title(entries[i]) === null || item.text === title(entries[i]))),
    opened === null ? "메뉴 없음" : `항목 ${opened.items.map((item) => item.text).join(", ")}, 버튼 아래 ${Math.round(opened.rect.top - button.rect.bottom)}px`,
  );
  const tokens = await menuTokens(page);
  t.check(
    "메뉴는 role=menu와 menuitem이고 말풍선·선 목록과 같은 칸 바탕색, 경계선, 본문 잉크를 쓴다",
    opened?.role === "menu" && opened.label === "진입점" && same(opened.roles, ["menuitem"]) && same(opened.style, tokens),
    JSON.stringify(opened?.style),
  );
  await page.screenshot({ path: HF3("entry-open-light") });

  // 필터 창에는 진입점이 없고, 필터 버튼을 누르면 메뉴가 닫힌다.
  await page.click(".filter-button");
  await page.waitForSelector(".filter-panel", { timeout: 5_000 }).catch(() => {});
  const filters = await page.evaluate(() => document.querySelector(".filter-panel")?.textContent ?? "");
  t.check("메뉴 밖의 필터 버튼을 누르면 메뉴가 닫히고, 필터 창에는 진입점이 없다", (await count(page, ".menu")) === 0 && filters !== "" && !filters.includes("진입점"), filters.slice(0, 60));
  await page.screenshot({ path: HF3("entry-filters") });
  await page.click(".filter-button");

  // 고르기
  const target = entries.at(-1);
  await page.click(".toolbar-entries");
  await page.click(`.menu-item[data-node="${target.id}"]`);
  await waitSelected(page, target.id).catch(() => {});
  t.check("이름을 고르면 그래프가 그 노드를 고르고 화면을 옮긴 뒤 메뉴가 닫힌다", (await selectedOf(page)) === target.id && (await count(page, ".menu")) === 0 && (await entriesButton(page)).expanded === "false", `선택 ${await selectedOf(page)}`);

  // 키보드
  await page.focus(".toolbar-entries");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".menu", { timeout: 5_000 }).catch(() => {});
  const byKey = await listOf(page);
  await page.keyboard.press("ArrowDown");
  const second = await listOf(page);
  await page.keyboard.press("End");
  const last = await listOf(page);
  await page.keyboard.press("Home");
  const home = await listOf(page);
  t.check(
    "Enter로 열면 첫 항목이 활성 항목이고 아래 화살표, End, Home이 활성 항목을 옮긴다",
    byKey?.focused === true && byKey.pointed && byKey.active === entries[0].id && second.active === entries[Math.min(1, entries.length - 1)].id && last.active === entries.at(-1).id && home.active === entries[0].id,
    [byKey?.active, second?.active, last?.active, home?.active].join(" → "),
  );
  await page.keyboard.press("Escape");
  const escaped = { menu: await count(page, ".menu"), selected: await selectedOf(page), focus: await page.evaluate(() => document.activeElement?.className ?? "") };
  t.check("Esc는 메뉴만 닫고 선택을 그대로 두며 초점을 버튼에 돌려준다", escaped.menu === 0 && escaped.selected === target.id && escaped.focus === "toolbar-entries", JSON.stringify(escaped));
  const ring = await page.evaluate(() => {
    const style = (selector) => {
      const element = document.querySelector(selector);
      return { visible: element.matches(":focus-visible"), outline: getComputedStyle(element).outlineStyle };
    };
    const own = style(".toolbar-entries");
    document.querySelector('.toolbar-button[aria-label="앞으로"]').disabled = false;
    return { own };
  });
  await page.keyboard.press("Shift+Tab");
  const other = await page.evaluate(() => ({ label: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className, outline: getComputedStyle(document.activeElement).outlineStyle }));
  t.check("키보드 초점을 받은 진입점 버튼은 다른 상단 줄 버튼과 같은 초점 테두리를 그린다", ring.own.visible && ring.own.outline !== "none" && ring.own.outline === other.outline, `진입점 ${ring.own.outline}, ${other.label} ${other.outline}`);
  await page.focus(".toolbar-entries");
  await page.keyboard.press("ArrowDown");
  await page.waitForSelector(".menu", { timeout: 5_000 }).catch(() => {});
  await page.keyboard.press("Enter");
  await waitSelected(page, entries[0].id).catch(() => {});
  t.check("버튼에서 아래 화살표로 열고 Enter로 고르면 활성 항목의 노드를 고른다", (await selectedOf(page)) === entries[0].id && (await count(page, ".menu")) === 0, `선택 ${await selectedOf(page)}`);
  await page.click(".toolbar-entries");
  await page.click(".toolbar-trail", { position: { x: 2, y: 2 } });
  t.check("메뉴 밖을 누르면 메뉴가 닫히고 선택이 그대로다", (await count(page, ".menu")) === 0 && (await selectedOf(page)) === entries[0].id, `선택 ${await selectedOf(page)}`);

  // 어두운 화면
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.click(".toolbar-entries");
  const dark = await listOf(page);
  const darkTokens = await menuTokens(page);
  t.check("어두운 화면의 메뉴는 어두운 칸 바탕색에 밝은 글자다", same(dark?.style, darkTokens) && dark.style.backgroundColor !== opened.style.backgroundColor && bare(await entriesButton(page)), JSON.stringify(dark?.style));
  await page.screenshot({ path: HF3("entry-open-dark") });
  await page.keyboard.press("Escape");

  // 창 폭 720px
  await page.setViewportSize({ width: 720, height: 900 });
  await rest(page);
  await page.click(".toolbar-entries");
  const narrow = await page.evaluate(() => {
    const toolbar = document.querySelector(".toolbar");
    const rect = document.querySelector(".toolbar-entries").getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { fits: toolbar.scrollWidth <= toolbar.clientWidth, height: toolbar.getBoundingClientRect().height, hit: hit?.closest(".toolbar-entries") !== null, right: rect.right <= window.innerWidth };
  });
  const narrowMenu = await listOf(page);
  t.check(
    "창 폭 720px에서 상단 줄이 한 줄에 들어가고 진입점 버튼이 눌리며 메뉴가 창 안에 열린다",
    narrow.fits && narrow.height < 40 && narrow.hit && narrow.right && narrowMenu?.inside === true,
    `상단 줄 높이 ${narrow.height}, 넘침 없음 ${narrow.fits}, 메뉴 창 안 ${narrowMenu?.inside}`,
  );
  await page.screenshot({ path: HF3("entry-720") });
  await page.keyboard.press("Escape");
  await page.setViewportSize(VIEW);

  // 진입점이 없는 레포: /api/graph의 진입점 표시를 모두 지워 연다.
  const isGraph = (at) => at.pathname === "/api/graph";
  await page.route(isGraph, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, nodes: body.nodes.map((n) => ({ ...n, entry: false })) } });
  });
  await page.reload();
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  const none = await entriesButton(page);
  const muted = await colorOf(page, "--muted");
  await page.click(".toolbar-entries", { force: true });
  t.check("진입점이 없으면 버튼이 \"진입점 0\"을 muted 잉크로 적고 눌러도 메뉴가 열리지 않는다", none.text === "진입점 0" && none.disabled && none.color === muted.rgb && (await count(page, ".menu")) === 0, `"${none.text}" ${none.color}`);
  await page.screenshot({ path: HF3("entry-none") });
  await page.unroute(isGraph);

  // 진입점이 많은 레포: 낮은 창에서 메뉴가 창 안에서 스크롤하고, 함수 진입점을 고르면 그 노드가 표지를 달고 그려진다.
  if (wideUrl === null) {
    t.skip("진입점이 많으면 메뉴가 화면 안에서 스크롤한다", "sync-engine의 진입점은 두 개다 — --wide-url을 주지 않았다");
    return;
  }
  const marked = (await api("/api/graph", wideUrl)).nodes.filter((n) => n.entry);
  const wide = marked.filter((n) => !veiled(n));
  t.check(
    "변수 노드는 진입점이 아니다",
    marked.every((n) => n.kind !== "variable"),
    `진입점 ${marked.length}개 가운데 변수 ${marked.filter((n) => n.kind === "variable").length}개`,
  );
  await page.setViewportSize({ width: VIEW.width, height: 260 });
  await page.goto(wideUrl);
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  await page.click(".toolbar-entries");
  await page.keyboard.press("ArrowUp");
  const long = await listOf(page);
  t.check(
    `진입점 ${wide.length}개의 메뉴는 높이 260px 창 안에 열려 안에서 스크롤하고, 위 화살표로 간 마지막 항목이 보인다`,
    long !== null && long.items.length === wide.length && long.inside && long.scrolls && long.active === wide.at(-1).id && long.activeShown,
    long === null ? "메뉴 없음" : `항목 ${long.items.length}개, 창 안 ${long.inside}, 스크롤 ${long.scrolls}, 활성 ${long.active}${long.activeShown ? "" : "(메뉴 밖)"}`,
  );
  await page.screenshot({ path: HF3("entry-long") });
  await page.keyboard.press("Escape");
  await page.setViewportSize(VIEW);
  const fn = wide.find((n) => n.kind === "function");
  if (fn === undefined) {
    t.skip("함수 진입점을 고르면 그 노드가 표지를 달고 그려진다", "함수 진입점이 없다");
    return;
  }
  await page.click(".toolbar-entries");
  await page.click(`.menu-item[data-node="${fn.id}"]`);
  await waitSelected(page, fn.id).catch(() => {});
  const drawn = await page.evaluate((sel) => {
    const label = document.querySelector(`${sel} .node-label`);
    const wrapper = document.querySelector(sel);
    return label === null ? null : { mark: label.querySelector(".entry-mark svg path") !== null, inside: label.getBoundingClientRect().right <= wrapper.getBoundingClientRect().right + 0.5 };
  }, face(fn.id));
  t.check("함수 진입점을 메뉴에서 고르면 그 함수 노드가 체크 표지를 달고 이름표가 노드 폭 안에 그려진다", (await selectedOf(page)) === fn.id && drawn?.mark === true && drawn.inside, JSON.stringify(drawn));
  await page.screenshot({ path: HF3("entry-function") });
}

/**
 * 노드의 우클릭 메뉴. 그래프의 노드와 파일트리의 행에서 LLM 요약을 요청하고, 선택과 화면, 탐색 이력이 그대로인지 본다.
 * 요지 목록과 요약은 서버 대신 답하고 LLM을 부르지 않는다. 사진은 `hf3-menu-{이름}.png`와 `hf4-menu-all.png`로 남긴다.
 */
async function menu(t, page) {
  const graph = await api("/api/graph");
  // 변수 노드는 요약 대상이 아니다.
  const defined = definedIn(graph, FILE).filter((n) => !n.test && n.kind !== "variable");
  const functions = defined.filter((n) => n.kind === "function" && n.id !== FUNCTION);
  const KEPT = "노트의 구역을 다시 지어 바뀐 구역만 파일에 쓴다.";
  const leadOf = (id) => `${id.split(":").at(-1)}의 요지다.`;
  const text = (lead) => `${lead}\n\n하는 일\n문단\n\n앞뒤 흐름\n문단`;
  /** 화면이 보낸 POST /api/summary. 시나리오가 answer나 fail로 답할 때까지 붙잡아 둔다. */
  const posts = [];
  await page.route((at) => at.pathname === "/api/summaries", (route) => route.fulfill({ json: { summaries: [{ node: FUNCTION, lead: KEPT }] } }));
  await page.route(
    (at) => at.pathname === "/api/summary",
    (route) => {
      const id = new URL(route.request().url()).searchParams.get("node");
      if (route.request().method() === "POST") {
        posts.push({
          node: id,
          refresh: new URL(route.request().url()).searchParams.get("refresh") === "true",
          done: false,
          answer: () => route.fulfill({ json: { summary: text(leadOf(id)), usage: null } }),
          fail: (error) => route.fulfill({ status: 503, json: { error } }),
        });
        return undefined;
      }
      return route.fulfill({ json: { summary: id === FUNCTION ? text(KEPT) : null, stale: false, available: true, reason: null } });
    },
  );
  /** 붙잡아 둔 요청에 차례로 답한다. 답하면 화면이 기다리던 다음 요청을 보내므로 더 오지 않을 때까지 되풀이한다. */
  const answerAll = async () => {
    for (let quiet = 0; quiet < 3; ) {
      const open = posts.filter((post) => !post.done);
      for (const post of open) {
        post.done = true;
        await post.answer();
      }
      quiet = open.length === 0 ? quiet + 1 : 0;
      await page.waitForTimeout(150);
    }
  };
  await page.addInitScript(() => {
    window.__shotsMenus = [];
    window.addEventListener("contextmenu", (event) => setTimeout(() => window.__shotsMenus.push(event.defaultPrevented)));
  });
  const blocked = async () => {
    await page.waitForTimeout(50);
    return page.evaluate(() => window.__shotsMenus.at(-1) ?? null);
  };
  /** 선택, 화면 위치, 뒤로·앞으로 버튼이 눌리는지, 탐색 경로의 글. 메뉴가 바꾸면 안 되는 값이다. */
  const stateOf = () =>
    page.evaluate(() => ({
      selected: document.querySelector(".react-flow__node .node-selected")?.closest(".react-flow__node")?.dataset.id ?? null,
      view: document.querySelector(".react-flow__viewport").style.transform,
      steps: [...document.querySelectorAll(".toolbar-nav > .toolbar-button")].map((button) => button.disabled),
      trail: document.querySelector(".toolbar-trail").textContent,
      nodes: document.querySelectorAll(".react-flow__node").length,
    }));
  /** 원 위에서 고리가 돌고 따로 그린 도는 원은 없는 함수 노드의 수 */
  const busyOn = (ids) =>
    page.evaluate((sels) => sels.filter((sel) => document.querySelector(`${sel} .node-circle > .busy-ring`) !== null && document.querySelector(`${sel} .badge-busy`) === null).length, ids.map(face));
  const labels = async () => (await listOf(page))?.items.map((item) => `${item.text}${item.disabled ? "(비활성)" : ""}`) ?? null;
  const rightClick = async (selector) => {
    await page.locator(selector).scrollIntoViewIfNeeded();
    const rect = await rectOf(page, selector);
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, { button: "right" });
  };
  const tip = async (selector) => {
    const rect = await rectOf(page, selector);
    await page.mouse.move(5, 5);
    await page.mouse.move(rect.x + rect.width / 2 - 1, rect.y + rect.height / 2);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.waitForTimeout(400);
    return tipText(page);
  };

  await load(page);
  await pick(page, FILE);
  const shownIds = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`.react-flow__node[data-id="${id}#face"] .node-label`) !== null), functions.map((n) => n.id));
  const [a, b, c] = shownIds;
  const before = await stateOf();

  // 여는 것만으로는 아무것도 바뀌지 않는다.
  await clickNode(page, a, 1, "right");
  await page.waitForSelector(".menu", { timeout: 5_000 }).catch(() => {});
  const opened = await listOf(page);
  t.check(
    '요약이 없는 함수 노드를 우클릭하면 브라우저의 메뉴 대신 "LLM 요약 요청" 항목의 메뉴가 뜬다',
    (await blocked()) === true && opened?.role === "menu" && same(opened.roles, ["menuitem"]) && same(await labels(), ["LLM 요약 요청"]) && opened.inside,
    `${(await labels())?.join(", ")}, 브라우저 메뉴 막음 ${await blocked()}`,
  );
  t.check("메뉴는 말풍선·선 목록과 같은 칸 바탕색, 경계선, 본문 잉크를 쓴다", same(opened?.style, await menuTokens(page)), JSON.stringify(opened?.style));
  t.check("우클릭은 노드를 고르지 않고 화면과 탐색 이력을 그대로 둔다", same(await stateOf(), before) && posts.length === 0, JSON.stringify(await stateOf()));
  await page.screenshot({ path: HF3("menu-open") });
  await page.keyboard.press("Escape");
  t.check("Esc는 메뉴만 닫고 선택을 그대로 둔다", (await count(page, ".menu")) === 0 && same(await stateOf(), before), `선택 ${(await stateOf()).selected}`);

  // 상태별 항목 이름
  await clickNode(page, FUNCTION, 1, "right");
  const kept = await labels();
  await page.click(".explorer-header");
  const outside = (await count(page, ".menu")) === 0;
  t.check('요약이 있는 함수 노드의 항목은 "요약 다시 만들기"이고 메뉴 밖을 누르면 닫힌다', same(kept, ["요약 다시 만들기"]) && outside, `${kept?.join(", ")}, 밖을 눌러 닫힘 ${outside}`);
  await clickNode(page, FILE, 1, "right");
  const onFile = await labels();
  const allLabel = (count) => `이 파일과 안에 든 정의 모두 요약 (${count}개)`;
  // 요약이 있는 정의 하나를 빼고 파일 자신을 더한 수다.
  const bare = defined.length;
  t.check(
    `파일 노드에는 그 파일과 안에 든 정의 가운데 요약이 없는 것의 수(${bare})를 적은 "이 파일과 안에 든 정의 모두 요약 (N개)"가 더해진다`,
    same(onFile, ["LLM 요약 요청", allLabel(bare)]),
    onFile?.join(", "),
  );
  await page.screenshot({ path: HF3("menu-file") });
  await page.screenshot({ path: HF4("menu-all") });
  await page.keyboard.press("Escape");
  const folder = graph.nodes.find((n) => n.kind === "package" && !n.test && n.parent !== null) ?? graph.nodes.find((n) => n.kind === "package" && !n.test);
  await rightClick(`.tree-row.tree-dir[data-node="${folder.id}"] .tree-label`);
  const onDir = await labels();
  t.check('폴더의 메뉴에는 "안에 든 파일 모두 요약 (N개)" 하나만 있고 선택과 화면이 그대로다', onDir?.length === 1 && /^안에 든 파일 모두 요약 \(\d+개\)$/.test(onDir[0]) && (await blocked()) === true && same(await stateOf(), before), onDir?.join(", "));
  await page.keyboard.press("Escape");

  // 연달아 세 개를 요청한다. 서버로는 둘만 보내고 하나는 차례를 기다린다.
  for (const id of [a, b, c]) {
    await clickNode(page, id, 1, "right");
    await page.click('.menu-item[data-key="one"]');
  }
  await page.waitForTimeout(300);
  const asked = { busy: await busyOn([a, b, c]), posts: posts.map((post) => post.node), menu: await count(page, ".menu") };
  t.check(
    "세 노드에 연달아 요청하면 세 노드에 도는 표시가 뜨고, 서버로는 요청 두 개만 가고, 선택과 화면과 탐색 이력이 그대로다",
    asked.busy === 3 && same(asked.posts, [a, b]) && posts.every((post) => !post.refresh) && asked.menu === 0 && same(await stateOf(), before),
    `도는 표시 ${asked.busy}개, POST ${asked.posts.join(", ")}`,
  );
  await clickNode(page, c, 1, "right");
  const waiting = await labels();
  await page.click('.menu-item[data-key="one"]', { force: true });
  await page.waitForTimeout(200);
  t.check('만드는 중이거나 차례를 기다리는 노드의 항목은 누를 수 없는 "요약 만드는 중"이다', same(waiting, ["요약 만드는 중(비활성)"]) && posts.length === 2, waiting?.join(", "));
  await page.screenshot({ path: HF3("menu-busy") });
  await page.keyboard.press("Escape");
  await answerAll();
  const made = [];
  for (const id of [a, b, c]) {
    made.push(await tip(`${face(id)} .node-label`));
  }
  t.check(
    "요청이 끝나면 기다리던 셋째 요청까지 가고, 도는 표시가 사라지며 세 노드의 말풍선이 새 요지를 적는다",
    same(posts.map((post) => post.node), [a, b, c]) && (await busyOn([a, b, c])) === 0 && same(made, [a, b, c].map(leadOf)),
    made.join(" / "),
  );
  await page.mouse.move(5, 5);
  await clickNode(page, a, 1, "right");
  t.check('요약을 만든 노드의 항목이 "요약 다시 만들기"로 바뀐다', same(await labels(), ["요약 다시 만들기"]), (await labels())?.join(", "));
  await page.click('.menu-item[data-key="one"]');
  await page.waitForTimeout(200);
  t.check("다시 만들기는 캐시에 있어도 새로 만드는 요청을 보낸다", posts.at(-1).node === a && posts.at(-1).refresh, `POST ${posts.at(-1).node} refresh=${posts.at(-1).refresh}`);
  await answerAll();

  // 파일의 모두 요약
  const rest3 = bare - 3;
  await clickNode(page, FILE, 1, "right");
  const fewer = await labels();
  await page.click('.menu-item[data-key="all"]');
  await page.waitForTimeout(300);
  const sentNow = posts.filter((post) => !post.done).length;
  const boxBusy = await page.evaluate((sel) => ({ corner: document.querySelectorAll(`${sel} > .node-module .badge-busy`).length, ring: document.querySelectorAll(`${sel} .busy-ring`).length }), face(FILE));
  const fileBusy = await busyAt(page, FILE, node(FILE));
  await clickNode(page, FILE, 1, "right");
  const drained = await labels();
  await page.keyboard.press("Escape");
  t.check(
    `파일의 "모두 요약"은 그 파일과 요약이 없는 정의 ${rest3 - 1}개를 요청하고, 서버로는 둘씩 보내며, 요청한 뒤에는 0개가 되어 누를 수 없다`,
    same(fewer, ["LLM 요약 요청", allLabel(rest3)]) && sentNow === 2 && same(drained, ["요약 만드는 중(비활성)", `${allLabel(0)}(비활성)`]),
    `${fewer?.join(", ")} → ${drained?.join(", ")}, 보낸 요청 ${sentNow}개`,
  );
  t.check(
    "요약을 만드는 중인 파일 상자는 왼쪽 위 모서리에 도는 원을 달고 원 위의 고리는 없다",
    boxBusy.corner === 1 && boxBusy.ring === 0 && atCorner(fileBusy),
    `도는 원 ${boxBusy.corner}개, 고리 ${boxBusy.ring}개, ${cornerText(fileBusy)}`,
  );
  await answerAll();
  await page.waitForFunction((sel) => document.querySelector(sel) === null, BUSY, { timeout: 15_000 }).catch(() => {});
  const all = posts.map((post) => post.node);
  const wanted = [FILE, ...defined.filter((n) => n.id !== FUNCTION).map((n) => n.id)];
  t.check(
    "모두 요약이 끝나면 그 파일과, 이미 요약이 있던 정의를 뺀 나머지 정의마다 요청이 한 번씩 갔고 도는 표시가 모두 사라졌다",
    wanted.every((id) => all.filter((each) => each === id).length === (id === a ? 2 : 1)) && !all.includes(FUNCTION) && (await count(page, BUSY)) === 0 && same(await stateOf(), before),
    `POST ${all.length}번, 파일과 정의 ${wanted.length}개`,
  );
  await clickNode(page, FILE, 1, "right");
  const filled = await labels();
  await page.keyboard.press("Escape");
  t.check('모두 요약한 파일의 항목은 "요약 다시 만들기"와 누를 수 없는 0개다', same(filled, ["요약 다시 만들기", `${allLabel(0)}(비활성)`]), filled?.join(", "));

  // 실패한 요청
  /** 이름표의 가운데 점이 눌리는 접힌 파일 상자. skip은 고르지 않을 상자를 정한다. */
  const foldedBox = (skip) =>
    page.evaluate((selector) => {
      for (const wrapper of document.querySelectorAll('.react-flow__node[data-id$="#face"]')) {
        const rect = wrapper.querySelector(`:scope > ${selector} .node-module-name .node-label`)?.getBoundingClientRect();
        if (rect !== undefined && wrapper.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))) {
          return { id: wrapper.dataset.id.replace(/#face$/, ""), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
      return null;
    }, skip);
  const other = graph.nodes.find((n) => n.kind === "module" && !n.test && n.id !== FILE && n.entry);
  t.expected.push("503");
  await rightClick(`.tree-row.tree-file[data-node="${other.id}"] .tree-label`);
  await page.click('.menu-item[data-key="one"]');
  await page.waitForTimeout(200);
  posts.at(-1).done = true;
  await posts.at(-1).fail("Claude Code에 로그인돼 있지 않다");
  await page.waitForSelector(".summary-notice", { timeout: 5_000 }).catch(() => {});
  const notice = await page.evaluate(() => document.querySelector(".summary-notice")?.textContent ?? "");
  t.check(
    "파일트리의 파일 행에서 요청한 요약을 만들지 못하면 그래프 영역 위쪽에 그 노드의 이름과 까닭을 적는다",
    notice === `LLM 요약을 만들지 못했다 · ${other.id.replaceAll(".", "/")}.py: Claude Code에 로그인돼 있지 않다` && same(await stateOf(), before),
    notice,
  );
  await page.screenshot({ path: HF3("menu-failed") });
  await page.click(".summary-notice");
  t.check("알림을 누르면 닫힌다", (await count(page, ".summary-notice")) === 0);

  // 파일트리
  const row = (id) => `.tree-row.tree-symbol[data-node="${id}"]`;
  await rightClick(`${row(b)} .tree-label`);
  const inTree = await labels();
  t.check("파일트리의 함수 행을 우클릭해도 같은 메뉴가 뜨고 선택이 그대로다", (await blocked()) === true && same(inTree, ["요약 다시 만들기"]) && same(await stateOf(), before), inTree?.join(", "));
  await page.screenshot({ path: HF3("menu-tree") });
  await page.keyboard.press("Escape");
  await page.focus(".tree");
  await page.keyboard.press("Shift+F10");
  await page.waitForSelector(".menu", { timeout: 5_000 }).catch(() => {});
  const byKey = await listOf(page);
  await page.keyboard.press("ArrowDown");
  const moved = await listOf(page);
  await page.keyboard.press("Escape");
  const back = await page.evaluate(() => document.activeElement?.className ?? "");
  t.check(
    "파일트리에서 Shift+F10을 누르면 활성 행(고른 파일)의 메뉴가 첫 항목을 활성 항목으로 두고 뜨고, Esc에 닫히며 초점이 파일트리로 돌아간다",
    byKey?.focused === true && byKey.active === "one" && same(byKey.items.map((item) => item.node), [FILE, FILE]) && moved?.active === "one" && back === "tree",
    `항목 ${byKey?.items.map((item) => item.text).join(", ")}, 활성 ${byKey?.active}, 닫은 뒤 초점 ${back}`,
  );
  await page.keyboard.press("ContextMenu");
  await page.waitForSelector(".menu", { timeout: 5_000 }).catch(() => {});
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  t.check("메뉴 키로 열어 Enter를 누르면 활성 항목인 파일의 요약을 다시 만드는 요청을 보낸다", posts.at(-1).node === FILE && posts.at(-1).refresh && (await count(page, ".menu")) === 0 && same(await stateOf(), before), `POST ${posts.at(-1).node} refresh=${posts.at(-1).refresh}`);
  await answerAll();

  // 어두운 화면
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await clickNode(page, FILE, 1, "right");
  const dark = await listOf(page);
  t.check("어두운 화면의 메뉴는 어두운 칸 바탕색에 밝은 글자다", same(dark?.style, await menuTokens(page)) && dark.style.backgroundColor !== opened.style.backgroundColor, JSON.stringify(dark?.style));
  t.check("메뉴를 연 화면에 title 속성과 SVG title이 없다", (await nativeTips(page)).length === 0, (await nativeTips(page)).join(", "));
  await page.screenshot({ path: HF3("menu-dark") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "밝은 화면" }).click();

  // 경로 고정 중에도 경로 밖 노드의 요약을 요청한다.
  await page.keyboard.press("Escape");
  await rest(page);
  await pin(page);
  const off = await foldedBox(".node-module:not([data-route])");
  if (off === null) {
    t.skip("경로 고정 중에 경로 밖 노드를 우클릭하면 메뉴가 뜬다", "화면에 보이는 경로 밖 파일 상자가 없다");
    return;
  }
  const pinned = await stateOf();
  const flashes = () => page.evaluate(() => document.querySelector(".finder-pinned[data-flash]") !== null);
  await page.mouse.click(off.x, off.y, { button: "right" });
  const pinnedMenu = await labels();
  await page.click('.menu-item[data-key="one"]');
  await page.waitForTimeout(200);
  t.check(
    "경로 고정 중에 경로 밖 파일 상자를 우클릭해 요약을 요청해도 고정과 선택이 그대로고 막힌 조작의 알림이 뜨지 않는다",
    pinnedMenu !== null && posts.at(-1).node === off.id && (await count(page, ".graph[data-pinned]")) === 1 && same(await stateOf(), pinned) && !(await flashes()),
    `${off.id}: ${pinnedMenu?.join(", ")}`,
  );
  await page.screenshot({ path: HF3("menu-pinned") });
  await answerAll();
}

/**
 * 폴더의 우클릭 메뉴. 접힌 폴더 상자, 펼친 폴더 영역의 머리 줄, 파일트리의 폴더 행에서 "안에 든 파일 모두 요약 (N개)"가 뜨고, 누르면
 * 그 폴더 아래 파일마다 요약을 한 번씩 요청하며 정의에는 요청하지 않는다. 요청한 동안 폴더 상자와 폴더 영역이 도는 원을 달고
 * 말풍선에 남은 수를 적는다. 요약은 서버 대신 답한다. `--wide-url`을 받으면 그 레포에서도 본다. 사진은 `hf4-foldersum-{이름}.png`로 남긴다.
 */
async function folderSum(t, page) {
  await page.route((at) => at.pathname === "/api/summaries", (route) => route.fulfill({ json: { summaries: [] } }));
  await answerSummaryReads(page, () => ({ summary: null, stale: false, available: true, reason: null }));
  const posts = await holdSummaryPosts(page);
  await page.addInitScript(() => {
    window.__shotsMenus = [];
    window.addEventListener("contextmenu", (event) => setTimeout(() => window.__shotsMenus.push(event.defaultPrevented)));
  });
  const blocked = async () => {
    await page.waitForTimeout(50);
    return page.evaluate(() => window.__shotsMenus.at(-1) ?? null);
  };
  /** 선택, 화면 위치, 뒤로·앞으로 버튼이 눌리는지, 탐색 경로의 글, 노드 수. 메뉴가 바꾸면 안 되는 값이다. */
  const stateOf = () =>
    page.evaluate(() => ({
      selected: document.querySelector(".react-flow__node .node-selected")?.closest(".react-flow__node")?.dataset.id ?? null,
      view: document.querySelector(".react-flow__viewport").style.transform,
      steps: [...document.querySelectorAll(".toolbar-nav > .toolbar-button")].map((button) => button.disabled),
      trail: document.querySelector(".toolbar-trail").textContent,
      nodes: document.querySelectorAll(".react-flow__node").length,
    }));
  const labels = async () => {
    await page.waitForSelector(".menu", { timeout: 5_000 }).catch(() => {});
    return (await listOf(page))?.items.map((item) => `${item.text}${item.disabled ? "(비활성)" : ""}`) ?? null;
  };
  /** 화면에서 눌리는 접힌 폴더 상자의 id */
  const folded = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".react-flow__node:has(> .node-package)")]
        .filter((wrapper) => {
          const rect = wrapper.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit !== null && (wrapper.contains(hit) || hit.closest(".react-flow__node")?.dataset.id === `${wrapper.dataset.id}#face`);
        })
        .map((wrapper) => wrapper.dataset.id),
    );
  /** id 노드가 단 도는 원의 말풍선 글. 도는 원이 없으면 null이다. */
  const busyTipOf = (id) => page.evaluate((sel) => document.querySelector(`${sel} > * > .badge-busy`)?.dataset.tip ?? null, face(id));
  const answer = async (limit) => {
    for (const post of posts.filter((each) => !each.done).slice(0, limit)) {
      post.done = true;
      await post.answer(`${post.node}의 요지다.\n\n하는 일\n문단\n\n앞뒤 흐름\n문단`);
    }
    await page.waitForTimeout(200);
  };
  const round = async (name, at, shoot) => {
    posts.length = 0;
    const graph = await api("/api/graph", at);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const under = (n, id) => n !== undefined && (n.id === id || (n.parent !== null && under(byId.get(n.parent), id)));
    const filesOf = (id) => graph.nodes.filter((n) => n.kind === "module" && !n.test && under(n, id)).map((n) => n.id);
    const nests = (id) => graph.nodes.some((n) => n.kind === "package" && !n.test && n.parent === id);
    await load(page, at, false);
    // 하위 폴더가 있는 폴더를 먼저 고르고, 그 가운데 파일이 세 개 이상이면서 가장 적은 폴더를 고른다.
    const id = (await folded())
      .filter((each) => filesOf(each).length >= 3)
      .sort((a, b) => Number(nests(b)) - Number(nests(a)) || filesOf(a).length - filesOf(b).length)[0];
    if (id === undefined) {
      t.skip(`${name}: 폴더의 메뉴`, "파일이 세 개 이상 든 접힌 폴더 상자가 화면에 없다");
      return;
    }
    const files = filesOf(id);
    const item = (count) => `안에 든 파일 모두 요약 (${count}개)`;
    const row = `.tree-row.tree-dir[data-node="${id}"]`;
    const before = await stateOf();

    await clickNode(page, id, 1, "right");
    const onBox = await labels();
    t.check(
      `${name}: 접힌 폴더 상자를 우클릭하면 그 폴더 아래의 요약 없는 파일 수(${files.length})를 적은 항목 하나만 뜨고, 선택과 화면이 그대로이며 폴더가 펼쳐지지 않는다`,
      same(onBox, [item(files.length)]) && (await blocked()) === true && same(await stateOf(), before) && (await count(page, `${node(id)} > .node-package`)) === 1,
      `${id}${nests(id) ? "(하위 폴더 있음)" : ""}: ${onBox?.join(", ")}`,
    );
    if (shoot) {
      await page.screenshot({ path: HF4("foldersum-menu") });
    }
    await page.keyboard.press("Escape");
    const tree = center(await rectOf(page, `${row} .tree-label`));
    await page.mouse.click(tree.x, tree.y, { button: "right" });
    const onRow = await labels();
    t.check(`${name}: 파일트리의 폴더 행을 우클릭해도 같은 항목이 뜨고 폴더가 펼쳐지지 않는다`, same(onRow, onBox) && (await blocked()) === true && same(await stateOf(), before), onRow?.join(", "));
    await page.keyboard.press("Escape");

    await openFolder(page, id);
    await page.mouse.move(1, 1);
    const open = await stateOf();
    const head = center(await rectOf(page, `${face(id)} .node-region-head .node-label`));
    await page.mouse.click(head.x, head.y, { button: "right" });
    const onHead = await labels();
    t.check(
      `${name}: 펼친 폴더 영역의 머리 줄을 우클릭해도 같은 항목이 뜨고 폴더가 접히지 않는다`,
      same(onHead, onBox) && (await blocked()) === true && same(await stateOf(), open) && (await count(page, `${node(id)} > .node-region`)) === 1,
      onHead?.join(", "),
    );
    await page.keyboard.press("Escape");
    await page.click(row);
    await page.waitForSelector(`${node(id)} > .node-package`, { timeout: 30_000 });
    await page.mouse.move(1, 1);
    await settle(page);

    // 요청한다. 서버로는 둘만 가고 나머지는 차례를 기다린다.
    const closed = await stateOf();
    await clickNode(page, id, 1, "right");
    await labels();
    await page.click('.menu-item[data-key="all"]');
    await page.waitForTimeout(300);
    const left = (count) => `LLM 요약을 만드는 중 · 안에 든 노드 남은 ${count}개`;
    const asked = { posts: posts.map((post) => post.node), tip: await busyTipOf(id), busy: await count(page, BUSY) };
    t.check(
      `${name}: 항목을 누르면 서버로 요청 두 개가 가고, 접힌 폴더 상자가 도는 원을 달아 말풍선에 남은 수(${files.length})를 적으며, 선택과 화면이 그대로다`,
      asked.posts.length === 2 && asked.posts.every((each) => files.includes(each)) && asked.tip === left(files.length) && asked.busy === 1 && same(await stateOf(), closed),
      `POST ${asked.posts.join(", ")}, 말풍선 "${asked.tip}", 도는 표시 ${asked.busy}개`,
    );
    const shown = await tipOver(page, `${face(id)} .badge-busy`);
    t.check(`${name}: 도는 원에 마우스를 올리면 말풍선이 남은 수를 적는다`, shown === left(files.length), shown);
    if (shoot) {
      await page.screenshot({ path: HF4("foldersum-busy") });
    }
    await page.mouse.move(1, 1);
    await clickNode(page, id, 1, "right");
    const again = await labels();
    t.check(`${name}: 요청한 뒤의 항목은 대상이 0개여서 누를 수 없다`, same(again, [`${item(0)}(비활성)`]), again?.join(", "));
    await page.keyboard.press("Escape");
    await answer(1);
    const fewer = { tip: await busyTipOf(id), posts: posts.length };
    t.check(`${name}: 요청 하나가 끝나면 말풍선의 남은 수가 하나 줄고 기다리던 요청이 간다`, fewer.tip === left(files.length - 1) && fewer.posts === 3, `말풍선 "${fewer.tip}", POST ${fewer.posts}번`);

    // 펼치면 폴더 영역이 왼쪽 위 모서리에 도는 원을 달고, 안의 파일 상자와 접힌 하위 폴더 상자가 저마다 도는 원을 단다.
    await openFolder(page, id);
    await page.mouse.move(1, 1);
    const inside = await page.evaluate(
      ([ids, own]) => ids.filter((each) => each !== own && document.querySelector(`.react-flow__node[data-id="${each}#face"] > * > .badge-busy`) !== null).length,
      [graph.nodes.filter((n) => under(n, id) && (n.kind === "module" || n.kind === "package")).map((n) => n.id), id],
    );
    const region = { tip: await busyTipOf(id), at: await busyAt(page, id, `${node(id)} > .node-region`) };
    t.check(
      `${name}: 펼친 폴더 영역은 왼쪽 위 모서리에 도는 원을 달아 남은 수를 적고, 안의 파일 상자와 접힌 하위 폴더 상자도 도는 원을 단다`,
      region.tip === left(files.length - 1) && atCorner(region.at) && inside > 0 && (nests(id) || inside === files.length - 1),
      `말풍선 "${region.tip}", ${cornerText(region.at)}, 안의 도는 원 ${inside}개`,
    );
    if (shoot) {
      await page.screenshot({ path: HF4("foldersum-region") });
    }
    for (let quiet = 0; quiet < 3; ) {
      const pending = posts.filter((post) => !post.done).length;
      await answer(pending);
      quiet = pending === 0 ? quiet + 1 : 0;
    }
    const sent = posts.map((post) => post.node);
    t.check(
      `${name}: 끝나면 그 폴더 아래 파일 ${files.length}개에 요청이 한 번씩 갔고 정의에는 가지 않았으며 도는 표시가 사라진다`,
      same([...sent].sort(), [...files].sort()) && (await count(page, BUSY)) === 0,
      `POST ${sent.length}번, 정의로 간 요청 ${sent.filter((each) => each.includes(":")).length}번, 도는 표시 ${await count(page, BUSY)}개`,
    );
    const head2 = center(await rectOf(page, `${face(id)} .node-region-head .node-label`));
    await page.mouse.click(head2.x, head2.y, { button: "right" });
    const after = await labels();
    t.check(`${name}: 요약이 모두 생긴 폴더의 항목은 누를 수 없다`, same(after, [`${item(0)}(비활성)`]), after?.join(", "));
    t.check(`${name}: 화면에 title 속성과 SVG title이 없다`, (await nativeTips(page)).length === 0, (await nativeTips(page)).join(", "));
    await page.keyboard.press("Escape");
  };
  await round("sync-engine", url, true);
  await t.shot();
  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포에서 폴더의 메뉴", "--wide-url을 주지 않았다");
  } else {
    await round("폴더가 여러 겹인 레포", wideUrl, false);
  }
}

/** 요약 요청 묶음의 진행 칸. 글, 만들지 못한 수와 토큰 수의 글·사각형·글자 모양, 막대가 찬 비율, 취소 버튼, 화면 사각형과 색. 칸이 없으면 null이다. */
const queueOf = (page) =>
  page.evaluate(() => {
    const box = document.querySelector(".summary-queue");
    if (box === null) {
      return null;
    }
    const rect = box.getBoundingClientRect();
    const button = box.querySelector("button");
    const style = getComputedStyle(box);
    const [failed, usage] = [box.querySelector(".summary-queue-failed"), box.querySelector(".summary-queue-usage")];
    const shape = (element) => {
      const [at, look] = [element.getBoundingClientRect(), getComputedStyle(element)];
      return { rect: { x: at.left, y: at.top, width: at.width, height: at.height }, color: look.color, fontSize: look.fontSize, numeric: look.fontVariantNumeric };
    };
    return {
      text: box.querySelector('[role="status"]')?.textContent ?? null,
      failed: failed === null ? null : shape(failed),
      usage: usage === null ? null : { text: usage.textContent, tip: usage.dataset.tip ?? null, last: usage === box.lastElementChild, ...shape(usage) },
      lean: box.dataset.lean !== undefined,
      fontSize: style.fontSize,
      share: box.querySelector(".progress-bar")?.dataset.share ?? null,
      cancel: button?.textContent ?? null,
      tab: button?.tabIndex ?? null,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      style: { backgroundColor: style.backgroundColor, color: style.color, borderTopColor: style.borderTopColor },
      shadow: style.boxShadow !== "none",
    };
  });

/**
 * 요약 요청 묶음의 진행 칸과 취소. 폴더의 "모두 요약"으로 요청을 여럿 넣고 서버 대신 하나씩 답해, 칸의 수와 막대가 진행에 따라 바뀌는지,
 * 칸이 영역의 바닥 줄에서 정보 패널·왼쪽 아래 칸을 피하는지, "취소" 뒤에 요청이 더 가지 않고 도는 표시가 줄어드는지 본다. 요청 하나에는 칸이 뜨지 않는다.
 * 사용량을 담은 응답으로 칸의 토큰 수(합, k 표기, 말풍선의 캐시 읽기, 좁은 구간에서 감추는 순서)도 본다.
 * `--wide-url`을 받으면 그 레포에서도 본다. 사진은 `hf4-queue-bottom-{이름}.png`, `hf5-tokens-queue.png`, `hf5-tokens-queue-dark.png`로 남긴다.
 */
async function summaryQueue(t, page) {
  const posts = [];
  await page.route((at) => at.pathname === "/api/summaries", (route) => route.fulfill({ json: { summaries: [] } }));
  await page.route(
    (at) => at.pathname === "/api/summary",
    (route) => {
      const id = new URL(route.request().url()).searchParams.get("node");
      if (route.request().method() !== "POST") {
        return route.fulfill({ json: { summary: null, stale: false, available: true, reason: null } });
      }
      posts.push({
        node: id,
        done: false,
        answer: (usage) => route.fulfill({ json: { summary: `${id}의 요지다.\n\n하는 일\n문단\n\n앞뒤 흐름\n문단`, usage } }),
        fail: () => route.fulfill({ status: 503, json: { error: "Claude Code CLI가 응답하지 않았다" } }),
      });
      return undefined;
    },
  );
  t.expected.push("503");
  /** 붙잡아 둔 요청 가운데 앞의 count개를 끝낸다. failed면 만들지 못했다고 답하고, usage를 주면 응답에 그 사용량을 담는다. */
  const end = async (count, failed = false, usage = null) => {
    for (const post of posts.filter((each) => !each.done).slice(0, count)) {
      post.done = true;
      await (failed ? post.fail() : post.answer(usage));
    }
    await page.waitForTimeout(250);
  };
  const folded = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".react-flow__node:has(> .node-package)")]
        .filter((wrapper) => {
          const rect = wrapper.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit !== null && (wrapper.contains(hit) || hit.closest(".react-flow__node")?.dataset.id === `${wrapper.dataset.id}#face`);
        })
        .map((wrapper) => wrapper.dataset.id),
    );
  const menuOf = async (act) => {
    await act();
    await page.waitForSelector(".menu", { timeout: 5_000 }).catch(() => {});
    return (await listOf(page))?.items.map((item) => `${item.text}${item.disabled ? "(비활성)" : ""}`) ?? null;
  };
  /**
   * 칸의 위치. 영역의 바닥 줄(아래 끝에서 12px 위, 칸의 높이)에서 정보 패널과 왼쪽 아래 칸이 덮지 않는 가장 넓은 가로 구간에 칸이 양옆 12px를
   * 두고 들어가면 그 구간의 가로 가운데와 버튼 줄의 아래 끝에 있어야 하고(mode "바닥"), 들어가지 않으면 둘이 가리지 않는 사각형의 가로 가운데,
   * 아래 끝에서 12px 위에 있어야 한다(mode "빈 영역"). 어느 쪽이든 정보 패널, 왼쪽 아래 칸과 겹치지 않아야 한다.
   */
  const placed = async () => {
    const [queue, stage] = [await queueOf(page), await stageOf(page)];
    const [dock, buttons] = await page.evaluate(() => {
      const plain = (element) => (({ left, top, width, height }) => ({ x: left, y: top, width, height }))(element.getBoundingClientRect());
      return [[...document.querySelectorAll(".dock-panels > *, .dock-buttons")].map(plain), plain(document.querySelector(".dock-buttons"))];
    });
    if (queue === null) {
      return { ok: false, mode: null, text: "칸 없음" };
    }
    const floor = stage.area.y + stage.area.height - 12;
    const across = [stage.panel, ...dock].filter((cover) => cover.y < floor && cover.y + cover.height > floor - queue.rect.height).sort((a, b) => a.x - b.x);
    let [from, span] = [stage.area.x, { x: stage.area.x, width: 0 }];
    for (const cover of [...across, { x: stage.area.x + stage.area.width, width: 0 }]) {
      if (cover.x - from > span.width) {
        span = { x: from, width: cover.x - from };
      }
      from = Math.max(from, cover.x + cover.width);
    }
    const mode = span.width - 24 >= queue.rect.width ? "바닥" : "빈 영역";
    const room = mode === "바닥" ? span : stage.clear;
    const off = queue.rect.x + queue.rect.width / 2 - (room.x + room.width / 2);
    const gap = (mode === "바닥" ? floor + 12 : stage.clear.y + stage.clear.height) - (queue.rect.y + queue.rect.height);
    const level = near(queue.rect.y + queue.rect.height, buttons.y + buttons.height) && near(queue.rect.height, buttons.height);
    return {
      ok: [stage.panel, ...dock].every((cover) => apart(queue.rect, cover)) && near(off, 0) && near(gap, 12) && (mode !== "바닥" || level),
      mode,
      text: `${mode}: 칸 ${rectText(queue.rect)}, 패널 ${rectText(stage.panel)}, 버튼 줄 ${rectText(buttons)}, 덮지 않는 구간 ${span.x.toFixed(0)}~${(span.x + span.width).toFixed(0)}, 가운데 차이 ${off.toFixed(1)}px, 아래 ${gap.toFixed(1)}px`,
    };
  };
  /** 레포를 열고, 화면의 접힌 폴더 상자 가운데 파일이 다섯 개 이상 든 가장 작은 폴더와 그 파일 수를 고른다. 없으면 id가 undefined다. */
  const opened = async (at) => {
    posts.length = 0;
    const graph = await api("/api/graph", at);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const under = (n, id) => n !== undefined && (n.id === id || (n.parent !== null && under(byId.get(n.parent), id)));
    const filesOf = (id) => graph.nodes.filter((n) => n.kind === "module" && !n.test && under(n, id)).map((n) => n.id);
    await load(page, at, false);
    const id = (await folded()).filter((each) => filesOf(each).length >= 5).sort((a, b) => filesOf(a).length - filesOf(b).length)[0];
    return { id, total: id === undefined ? 0 : filesOf(id).length };
  };
  const round = async (name, at, shoot) => {
    const { id, total } = await opened(at);
    if (id === undefined) {
      t.skip(`${name}: 요약 요청 묶음의 진행 칸`, "파일이 다섯 개 이상 든 접힌 폴더 상자가 화면에 없다");
      return;
    }
    const item = (count) => `안에 든 파일 모두 요약 (${count}개)`;
    const busyTip = () => page.evaluate((sel) => document.querySelector(`${sel} > * > .badge-busy`)?.dataset.tip ?? null, face(id));

    // 요청 하나에는 칸이 뜨지 않는다.
    const single = await page.evaluate(() => document.querySelector(".tree-row.tree-file[data-node]")?.dataset.node ?? null);
    if (single === null) {
      t.skip(`${name}: 요청 하나에는 진행 칸이 뜨지 않는다`, "파일트리에 보이는 파일 행이 없다");
    } else {
      const row = center(await rectOf(page, `.tree-row.tree-file[data-node="${single}"] .tree-label`));
      await menuOf(() => page.mouse.click(row.x, row.y, { button: "right" }));
      await page.click('.menu-item[data-key="one"]');
      await page.waitForTimeout(300);
      const alone = { posts: posts.length, queue: await queueOf(page) };
      await end(1);
      t.check(`${name}: 요청 하나에는 진행 칸이 뜨지 않는다`, alone.posts === 1 && alone.queue === null && (await queueOf(page)) === null, `POST ${alone.posts}번, 칸 ${alone.queue?.text ?? "없음"}`);
    }
    posts.length = 0;

    await menuOf(() => clickNode(page, id, 1, "right"));
    await page.click('.menu-item[data-key="all"]');
    await page.waitForTimeout(300);
    const first = await queueOf(page);
    t.check(
      `${name}: 폴더의 파일 ${total}개를 요청하면 그래프 아래쪽에 "요약 0 / ${total}"과 빈 막대, "취소"가 뜬다`,
      posts.length === 2 && first?.text === `요약 0 / ${total}` && Number(first.share) === 0 && first.cancel === "취소" && first.tab === 0,
      `POST ${posts.length}번, "${first?.text}", 막대 ${first?.share}, 버튼 ${first?.cancel}`,
    );
    const where = await placed();
    t.check(`${name}: 칸은 왼쪽 아래 칸의 버튼 줄과 같은 높이·같은 아래 끝에 있고, 그 바닥 줄에서 버튼 줄과 정보 패널이 덮지 않는 구간의 가로 가운데에 있다`, where.ok && where.mode === "바닥", where.text);
    t.check(`${name}: 칸은 칸 바탕색에 본문 잉크, 선 색 테두리와 그림자를 쓴다`, same(first?.style, await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement("span"));
      probe.style.cssText = "background: var(--surface); color: var(--ink); border: 1px solid var(--line)";
      const { backgroundColor, color, borderTopColor } = getComputedStyle(probe);
      probe.remove();
      return { backgroundColor, color, borderTopColor };
    })) && first.shadow, JSON.stringify(first?.style));

    await end(1);
    const one = await queueOf(page);
    await end(1, true);
    const two = await queueOf(page);
    t.check(
      `${name}: 요청이 끝날 때마다 수와 막대가 늘고, 만들지 못한 요청은 "실패 1"을 가운데 점 없이 간격을 두고 다른 글자색으로 적는다`,
      one?.text === `요약 1 / ${total}` && near(Number(one.share), 1 / total, 0.001) && one.failed === null && two?.text === `요약 2 / ${total} 실패 1` && near(Number(two.share), 2 / total, 0.001) && posts.length === 4 &&
        two.failed !== null && two.failed.color !== two.style.color && two.failed.rect.x - (two.rect.x + 15) > 40,
      `"${one?.text}" 막대 ${one?.share} → "${two?.text}" 막대 ${two?.share}, POST ${posts.length}번, 실패 글자색 ${two?.failed?.color}, 칸 글자색 ${two?.style.color}`,
    );
    t.check(`${name}: 사용량이 없는 응답과 실패만 끝난 동안에는 칸에 토큰 수가 없다`, one?.usage === null && two?.usage === null, `${one?.usage?.text ?? "없음"}, ${two?.usage?.text ?? "없음"}`);
    if (shoot) {
      await page.screenshot({ path: HF4("queue-bottom-light") });
      await page.getByRole("button", { name: "어두운 화면" }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      await page.mouse.move(1, 1);
      const dark = await queueOf(page);
      t.check(`${name}: 어두운 화면의 칸은 어두운 바탕에 밝은 글자다`, dark !== null && dark.style.backgroundColor !== first.style.backgroundColor && dark.style.color !== first.style.color, JSON.stringify(dark?.style));
      await page.screenshot({ path: HF4("queue-bottom-dark") });
      await page.getByRole("button", { name: "밝은 화면" }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme !== "dark");
    }

    // 정보 패널을 왼쪽으로 끄는 동안과 놓은 뒤, 범례를 펼친 뒤에도 칸이 바닥 줄에서 패널을 피한다.
    const before = (await queueOf(page)).rect;
    const head = center(await rectOf(page, ".info-panel-head"));
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    await page.mouse.move(head.x - 600, head.y + 300, { steps: 8 });
    await page.waitForTimeout(300);
    const held = await placed();
    t.check(`${name}: 정보 패널을 왼쪽으로 끄는 동안 칸이 바닥 줄에서 패널이 덮지 않는 구간으로 따라 옮겨 간다`, held.ok && held.mode === "바닥" && !sameRect(before, (await queueOf(page)).rect), held.text);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const moved = await placed();
    t.check(`${name}: 패널을 놓은 뒤에도 칸이 같은 곳에 있다`, moved.ok && moved.mode === "바닥" && moved.text === held.text, moved.text);
    await page.click(".legend-button");
    await page.waitForTimeout(300);
    const wide = await placed();
    t.check(`${name}: 범례를 펼쳐도 칸이 왼쪽 아래 칸과 겹치지 않는다`, wide.ok, wide.text);
    if (shoot) {
      await page.screenshot({ path: HF4("queue-bottom-moved") });
    }
    await page.click(".legend-button");

    // 패널을 낮고 넓게 바꿔 바닥 줄을 모두 덮으면 칸은 패널과 왼쪽 아래 칸이 가리지 않는 영역으로 물러난다.
    await page.dblclick(".info-panel-head");
    await page.waitForTimeout(300);
    for (const [dir, dx, dy] of [["n", 0, 600], ["w", -1500, 0]]) {
      await drag(page, center(await rectOf(page, `.info-panel-resize[data-dir="${dir}"]`)), dx, dy);
    }
    await page.waitForTimeout(300);
    const covered = await placed();
    t.check(`${name}: 패널이 바닥 줄을 덮으면 칸은 패널과 왼쪽 아래 칸이 가리지 않는 영역의 가로 가운데, 아래 끝에서 12px 위로 물러난다`, covered.ok && covered.mode === "빈 영역", covered.text);
    if (shoot) {
      await page.screenshot({ path: HF4("queue-bottom-covered") });
    }
    await page.dblclick(".info-panel-head");
    await page.waitForTimeout(300);
    const home = await placed();
    t.check(`${name}: 패널을 기본 위치로 돌리면 칸이 바닥 줄로 돌아온다`, home.ok && home.mode === "바닥", home.text);

    // 취소. 아직 보내지 않은 요청만 빠지고 보낸 두 개는 끝까지 간다.
    await page.focus(".summary-queue-cancel");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const stopped = { queue: await queueOf(page), posts: posts.length, tip: await busyTip() };
    t.check(
      `${name}: 취소 버튼에 초점을 두고 Enter를 누르면 요청이 더 가지 않고, 칸은 "요약 만드는 중 2개"만 적으며 막대와 취소 버튼이 없다`,
      stopped.posts === 4 && stopped.queue?.text === "요약 만드는 중 2개" && stopped.queue.share === null && stopped.queue.cancel === null,
      `POST ${stopped.posts}번, "${stopped.queue?.text}"`,
    );
    t.check(`${name}: 취소한 노드의 도는 표시가 바로 사라져 폴더 상자의 말풍선이 남은 2개를 적는다`, stopped.tip === "LLM 요약을 만드는 중 · 안에 든 노드 남은 2개", stopped.tip);
    const dir = center(await rectOf(page, `.tree-row.tree-dir[data-node="${id}"] .tree-label`));
    const back = await menuOf(() => page.mouse.click(dir.x, dir.y, { button: "right" }));
    t.check(`${name}: 취소한 파일과 만들지 못한 파일은 요청 전처럼 다시 대상에 든다`, same(back, [item(total - 3)]), back?.join(", "));
    await page.keyboard.press("Escape");
    await end(2);
    await page.waitForTimeout(400);
    t.check(`${name}: 보낸 두 요청이 끝나면 칸과 도는 표시가 사라지고 요청은 모두 네 번 갔다`, (await queueOf(page)) === null && (await count(page, BUSY)) === 0 && posts.length === 4, `POST ${posts.length}번, 도는 표시 ${await count(page, BUSY)}개`);
    t.check(`${name}: 화면에 title 속성과 SVG title이 없다`, (await nativeTips(page)).length === 0, (await nativeTips(page)).join(", "));
    await page.click(".summary-notice").catch(() => {});
  };
  /**
   * 칸의 토큰 수. 사용량을 담은 응답 둘을 받아 합과 k 표기, 말풍선의 캐시 읽기, 글자 모양과 위치를 보고, 창을 좁혀 칸이 바닥 줄의 구간에
   * 들어가지 않게 되면 칸이 물러나기 전에 토큰 수부터 감추는지 본다. 취소한 뒤에도 합은 그대로다.
   */
  const spent = async (name, at) => {
    const { id, total } = await opened(at);
    if (id === undefined) {
      t.skip(`${name}: 진행 칸의 토큰 수`, "파일이 다섯 개 이상 든 접힌 폴더 상자가 화면에 없다");
      return;
    }
    const muted = () =>
      page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement("span"));
        probe.style.color = "var(--muted)";
        const { color } = getComputedStyle(probe);
        probe.remove();
        return color;
      });
    const used = [
      { input: 2, cache_write: 1487, cache_read: 16411, output: 527 },
      { input: 3, cache_write: 19500, cache_read: 164110, output: 8486 },
    ];
    await menuOf(() => clickNode(page, id, 1, "right"));
    await page.click('.menu-item[data-key="all"]');
    await page.waitForTimeout(300);
    const none = await queueOf(page);
    await end(1, false, used[0]);
    const one = await queueOf(page);
    await end(1, false, used[1]);
    const two = await queueOf(page);
    t.check(
      `${name}: 첫 응답 전에는 토큰 수가 없고, 응답이 끝날 때마다 사용량을 더해 "입력 1.5k · 출력 527", "입력 21k · 출력 9.0k"로 적는다(입력은 input과 cache_write의 합 1,489와 20,992, 출력 527과 9,013)`,
      none?.usage === null && one?.usage?.text === "입력 1.5k · 출력 527" && two?.usage?.text === "입력 21k · 출력 9.0k" && two.text === `요약 2 / ${total}`,
      `"${none?.usage?.text ?? "없음"}" → "${one?.usage?.text}" → "${two?.text}", "${two?.usage?.text}"`,
    );
    t.check(
      `${name}: 토큰 수는 칸의 맨 오른쪽 끝, 취소 버튼 뒤에 있고 칸의 글자(12px)보다 작은 11px의 muted 글자, tabular-nums다`,
      two?.usage != null && two.usage.last && near(two.rect.x + two.rect.width - (two.usage.rect.x + two.usage.rect.width), 15, 1.5) && two.fontSize === "12px" && two.usage.fontSize === "11px" &&
        two.usage.color === (await muted()) && two.usage.color !== two.style.color && two.usage.numeric.includes("tabular-nums") && !two.lean,
      `칸 ${rectText(two.rect)} ${two.fontSize}, 토큰 수 ${two.usage === null ? "없음" : `${rectText(two.usage.rect)} ${two.usage.fontSize} ${two.usage.color} ${two.usage.numeric}`}`,
    );
    const tip = await tipOver(page, ".summary-queue-usage");
    t.check(`${name}: 토큰 수에 마우스를 올리면 말풍선이 캐시에서 읽은 입력의 합 180,521을 "캐시에서 읽은 입력 181k"로 적는다`, tip === "캐시에서 읽은 입력 181k" && two?.usage?.tip === tip, tip);
    await page.mouse.move(1, 1);
    const where = await placed();
    t.check(`${name}: 토큰 수를 적은 칸도 바닥 줄에서 버튼 줄과 정보 패널이 덮지 않는 구간의 가로 가운데에 있다`, where.ok && where.mode === "바닥", where.text);
    await page.screenshot({ path: HF5("queue") });
    await page.getByRole("button", { name: "어두운 화면" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.mouse.move(1, 1);
    const dark = await queueOf(page);
    t.check(`${name}: 어두운 화면에서도 토큰 수는 muted 글자이고 칸의 글자색과 다르다`, dark?.usage != null && dark.usage.color === (await muted()) && dark.usage.color !== dark.style.color, `${dark?.usage?.color}, 칸 ${dark?.style.color}`);
    await page.screenshot({ path: HF5("queue-dark") });
    await page.getByRole("button", { name: "밝은 화면" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme !== "dark");

    // 창을 20px씩 좁힌다. 칸이 바닥 줄의 구간에 들어가지 않게 되는 폭에서 토큰 수가 먼저 사라지고 칸은 바닥 줄에 남는다.
    const size = page.viewportSize();
    const steps = [];
    for (let width = size.width; width >= 700 && !steps.some((step) => step.mode !== "바닥"); width -= 20) {
      await page.setViewportSize({ width, height: size.height });
      await page.waitForTimeout(250);
      const [queue, at] = [await queueOf(page), await placed()];
      steps.push({ width, lean: queue.lean, shown: queue.usage.rect.width > 0, mode: at.mode, ok: at.ok, box: queue.rect.width });
    }
    const lean = steps.findIndex((step) => step.lean);
    const away = steps.findIndex((step) => step.mode !== "바닥");
    t.check(
      `${name}: 창을 좁혀 칸이 바닥 줄의 구간에 들어가지 않게 되면 토큰 수를 먼저 감춰 칸이 바닥 줄에 남고, 감춘 칸도 들어가지 않을 때에야 물러난다`,
      lean > 0 && steps.slice(0, lean).every((step) => step.shown && step.mode === "바닥" && step.ok) && steps[lean].mode === "바닥" && !steps[lean].shown && steps[lean].ok &&
        steps[lean].box < steps[lean - 1].box && (away === -1 || away > lean) && steps.every((step) => step.ok),
      steps.filter((step, index) => index === 0 || step.lean !== steps[index - 1].lean || step.mode !== steps[index - 1].mode).map((step) => `창 ${step.width}px: ${step.mode}, 토큰 수 ${step.shown ? "있음" : "감춤"}, 칸 폭 ${step.box.toFixed(0)}`).join(" → "),
    );
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
    const back = await queueOf(page);
    t.check(`${name}: 창을 되돌리면 토큰 수가 다시 보인다`, back?.usage != null && !back.lean && back.usage.rect.width > 0, `${back?.usage?.text}`);

    await page.focus(".summary-queue-cancel");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const stopped = await queueOf(page);
    t.check(
      `${name}: 취소한 뒤의 칸은 "요약 만드는 중 2개"와 오른쪽 끝의 토큰 수를 적고 합은 그대로다`,
      stopped?.text === "요약 만드는 중 2개" && stopped.usage?.text === "입력 21k · 출력 9.0k" && stopped.usage.last && posts.length === 4,
      `"${stopped?.text}", "${stopped?.usage?.text}", POST ${posts.length}번`,
    );
    await end(1, true);
    const failed = await queueOf(page);
    t.check(`${name}: 취소한 뒤 보낸 요청이 실패하면 "실패 1"을 같은 배치로 적는다`, failed?.text === "요약 만드는 중 1개 실패 1" && failed.usage?.text === "입력 21k · 출력 9.0k", `"${failed?.text}"`);
    await end(1);
    await page.waitForTimeout(400);
    t.check(`${name}: 묶음이 끝나면 칸이 사라진다`, (await queueOf(page)) === null);
    await page.click(".summary-notice").catch(() => {});
  };
  await round("sync-engine", url, true);
  await spent("sync-engine", url);
  await t.shot();
  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포에서 요약 요청 묶음의 진행 칸", "--wide-url을 주지 않았다");
  } else {
    await round("폴더가 여러 겹인 레포", wideUrl, false);
  }
}

/**
 * 코드 뷰어 안의 이력 이동. 코드 뷰어의 본문을 눌러 커서를 둔 채 `Alt+←`·`Alt+→`가 탐색 이력을 옮기고 커서를 낱말만큼 옮기지 않는지,
 * 코드 뷰어의 찾기 창과 파일트리 검색 칸에서는 같은 키가 이력을 바꾸지 않고 글자 커서를 낱말만큼 옮기는지 본다.
 */
async function keysCode(t, page) {
  const cursor = () => page.evaluate(() => (({ left, top }) => `${left}, ${top}`)(document.querySelector(".info-panel .monaco-editor .cursor").style));
  const focus = () => page.evaluate(() => document.activeElement?.closest(".monaco-editor") !== null && !(document.activeElement instanceof HTMLTextAreaElement && document.activeElement.classList.contains("input")));
  /** 코드 뷰어의 본문에서 화면에 보이는 줄 가운데 글자가 있는 줄을 눌러 커서를 둔다. */
  const clickCode = async () => {
    await page.waitForSelector(".info-panel .monaco-editor .view-line", { timeout: 20_000 });
    await settle(page);
    const at = await page.evaluate(() => {
      const editor = document.querySelector(".info-panel .monaco-editor").getBoundingClientRect();
      const line = [...document.querySelectorAll(".info-panel .monaco-editor .view-line > span")].map((span) => span.getBoundingClientRect()).find((rect) => rect.width > 80 && rect.top > editor.top + 40 && rect.bottom < editor.bottom - 40);
      return { x: line.left + 60, y: line.top + line.height / 2 };
    });
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(200);
  };
  const caret = () => page.evaluate(() => ({ at: document.activeElement.selectionStart, length: document.activeElement.value?.length ?? null }));
  await load(page);
  await pickInTree(page, { id: FUNCTION, owner: FILE });
  await clickCode();
  const placed = { cursor: await cursor(), focus: await focus() };
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(300);
  t.check(
    "코드 뷰어의 본문에 커서를 두고 앞으로 갈 이력이 없을 때 Alt+→를 누르면 선택이 그대로고 커서가 옮겨지지 않는다",
    placed.focus && (await selectedOf(page)) === FUNCTION && (await cursor()) === placed.cursor,
    `포커스가 본문에 있음 ${placed.focus}, 커서 ${placed.cursor} → ${await cursor()}`,
  );
  await page.keyboard.press("Alt+ArrowLeft");
  await waitSelected(page, FILE).catch(() => {});
  t.check("코드 뷰어의 본문에 커서를 둔 채 Alt+←를 누르면 앞 선택으로 돌아간다", (await selectedOf(page)) === FILE, `${await selectedOf(page)}`);
  await clickCode();
  const again = await focus();
  await page.keyboard.press("Alt+ArrowRight");
  await waitSelected(page, FUNCTION).catch(() => {});
  t.check("다시 본문에 커서를 두고 Alt+→를 누르면 돌아오기 전의 선택으로 간다", again && (await selectedOf(page)) === FUNCTION, `포커스가 본문에 있음 ${again}, ${await selectedOf(page)}`);

  // 코드 뷰어의 찾기 창은 입력 칸이다.
  await clickCode();
  await page.keyboard.press(`${MOD}+f`);
  await page.waitForSelector(".info-panel .monaco-editor .find-widget textarea", { timeout: 5_000 }).catch(() => {});
  await page.keyboard.type("note sections");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForTimeout(300);
  const found = { caret: await caret(), tag: await page.evaluate(() => document.activeElement.tagName), selected: await selectedOf(page) };
  t.check(
    "코드 뷰어의 찾기 창에서 Alt+←를 누르면 이력이 바뀌지 않고 글자 커서가 낱말만큼 옮겨진다",
    found.tag === "TEXTAREA" && found.selected === FUNCTION && found.caret.at > 0 && found.caret.at < found.caret.length,
    `${found.tag}, 선택 ${found.selected}, 글자 커서 ${found.caret.at} / ${found.caret.length}`,
  );
  await page.keyboard.press("Escape");

  // 파일트리 검색 칸
  await page.click(".tree-search-input");
  await page.keyboard.type("note sections");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForTimeout(300);
  const searched = { caret: await caret(), selected: await selectedOf(page) };
  t.check(
    "파일트리 검색 칸에서 Alt+←를 누르면 이력이 바뀌지 않고 글자 커서가 낱말만큼 옮겨진다",
    searched.selected === FUNCTION && searched.caret.at > 0 && searched.caret.at < searched.caret.length,
    `선택 ${searched.selected}, 글자 커서 ${searched.caret.at} / ${searched.caret.length}`,
  );
}

/**
 * 화면 이동. 파일트리의 파일 행을 눌러 먼 노드와 가까운 노드로 가며 프레임마다의 화면을 읽는다. 먼 이동의 프레임은
 * `s4-motion-{0~5}.png`에 남긴다.
 */
async function motion(t, page) {
  await load(page);
  const row = (id) => `.tree-row.tree-file[data-node="${id}"]`;
  const go = async (id) => {
    await page.click(row(id));
    await waitSelected(page, id);
  };
  /** 파일트리에 행이 보이는 파일 상자와 그 가운데의 화면 좌표 */
  const files = async () => {
    const list = await boxes(page);
    const zoom = await zoomOf(page);
    const shown = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`.tree-row.tree-file[data-node="${CSS.escape(id)}"]`) !== null), list.map((box) => box.id));
    return list.filter((box) => shown.includes(box.id)).map((box) => ({ id: box.id, x: box.x + (box.width * zoom) / 2, y: box.y + (box.height * zoom) / 2 }));
  };
  const apartOf = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  /**
   * 화면 이동을 그린 프레임과 걸린 시간, 프레임 사이에 화면이 간 빠르기(1초에 간 길이). 길이는 옆으로 간 폭을 보이는 폭으로 나눈 값과
   * 확대 비율의 로그 차이를 합친 값이다.
   */
  const flightOf = (frames, clear, area) => {
    const flying = frames.filter((frame) => frame.flying);
    const side = Math.min(clear.width, clear.height);
    const eye = (frame) => ({ x: (clear.x - area.x + clear.width / 2 - frame.x) / frame.zoom, y: (clear.y - area.y + clear.height / 2 - frame.y) / frame.zoom });
    const rates = flying
      .slice(1)
      .map((frame, i) => (Math.hypot((apartOf(eye(frame), eye(flying[i])) * frame.zoom) / side, Math.log(frame.zoom / flying[i].zoom)) * 1000) / (frame.at - flying[i].at));
    return { flying, rates, ms: flying.length === 0 ? 0 : flying.at(-1).at - flying[0].at, lowest: Math.min(...flying.map((frame) => frame.zoom)) };
  };

  await go(FILE);
  const { clear, area } = await stageOf(page);
  const middle = center(clear);
  const far = (await files()).reduce((a, b) => (apartOf(b, middle) > apartOf(a, middle) ? b : a));
  await watchFrames(page);
  await go(far.id);
  const frames = await framesOf(page);
  const long = flightOf(frames, clear, area);
  const [from, to] = [frames[0], frames.at(-1)];
  const turn = long.flying.findIndex((frame) => frame.zoom === long.lowest);
  const dips = long.flying.slice(1, turn + 1).every((frame, i) => frame.zoom <= long.flying[i].zoom) && long.flying.slice(turn + 1).every((frame, i) => frame.zoom >= long.flying[turn + i].zoom);
  t.check(
    "가리지 않는 영역 밖의 먼 노드로 가는 이동은 가운데에서 출발·도착 화면보다 축소했다가 도착의 확대 비율로 돌아온다",
    long.flying.length > 0 && long.lowest < Math.min(from.zoom, to.zoom) * 0.8 && dips && near(to.zoom, Math.max(from.zoom, NAMED_ZOOM), 0.001),
    `${FILE} → ${far.id}, 확대 비율 ${from.zoom.toFixed(3)} → ${long.lowest.toFixed(3)} → ${to.zoom.toFixed(3)}, ${Math.round(long.ms)}ms, 프레임 ${long.flying.length}개`,
  );
  t.check("이동을 시작하는 프레임에 도착 노드가 이미 골라져 있다", long.flying[0]?.selected === far.id, `첫 프레임의 고른 노드 ${long.flying[0]?.selected}`);
  const moved = long.flying.slice(1).filter((frame, i) => frame.x !== long.flying[i].x || frame.zoom !== long.flying[i].zoom);
  const followed = long.flying.slice(1).filter((frame, i) => (frame.x !== long.flying[i].x || frame.zoom !== long.flying[i].zoom) && frame.mask !== long.flying[i].mask);
  t.check("미니맵의 화면 영역 사각형이 이동하는 프레임마다 함께 움직인다", moved.length > 0 && followed.length === moved.length, `화면이 바뀐 프레임 ${moved.length}개 가운데 사각형이 바뀐 프레임 ${followed.length}개`);
  t.check(
    "이동이 끝나면 data-flying이 사라지고 도착 노드가 가리지 않는 영역에 있다",
    !to.flying && (await count(page, ".graph[data-flying]")) === 0 && (await reachable(page, far.id)).ok,
    `도착 노드의 이름표 ${(await reachable(page, far.id)).at}`,
  );

  // 먼 이동의 프레임을 남긴다.
  await page.click(row(FILE));
  await page.waitForSelector(".graph[data-flying]", { timeout: 10_000 });
  const taken = [];
  for (let i = 0; i < 6 && (await count(page, ".graph[data-flying]")) > 0; i += 1) {
    taken.push((await zoomOf(page)).toFixed(2));
    await page.screenshot({ path: join(OUT, `s4-motion-${i}.png`) });
    if (i === 1) {
      await t.shot();
    }
  }
  await waitSelected(page, FILE);
  t.check("먼 이동 도중의 화면을 남긴다", taken.length >= 3, `확대 비율 ${taken.join(", ")}`);

  // 고른 파일 안의 함수 가운데 가리지 않는 영역 안에 보이는 함수로 간다.
  const inside = (
    await page.evaluate(() =>
      [...document.querySelectorAll(".tree-row.tree-symbol[data-node]")].map((symbol) => {
        const rect = document.querySelector(`.react-flow__node[data-id="${CSS.escape(symbol.dataset.node)}"]`)?.getBoundingClientRect();
        return rect === undefined ? null : { id: symbol.dataset.node, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }),
    )
  ).filter((each) => each !== null && each.x > clear.x + 40 && each.x < clear.x + clear.width - 40 && each.y > clear.y + 40 && each.y < clear.y + clear.height - 40);
  if (inside.length === 0) {
    t.skip("가리지 않는 영역 안에 보이는 가까운 노드로 가는 이동은 확대 비율을 그대로 둔다", "가리지 않는 영역 안에 고른 파일의 함수가 없다");
  } else {
    const close = inside.reduce((a, b) => (apartOf(b, middle) > apartOf(a, middle) ? b : a));
    const zoom = await zoomOf(page);
    await watchFrames(page);
    await page.click(`.tree-row.tree-symbol[data-node="${close.id}"]`);
    await waitSelected(page, close.id);
    const short = flightOf(await framesOf(page), clear, area);
    t.check(
      "가리지 않는 영역 안에 보이는 가까운 노드로 가는 이동은 확대 비율을 그대로 두고 먼 이동보다 짧게 걸린다",
      short.flying.length > 0 && short.flying.every((frame) => near(frame.zoom, zoom, 0.001)) && short.ms < long.ms,
      `${FILE} → ${close.id}, 확대 비율 ${zoom.toFixed(3)} → ${short.lowest.toFixed(3)}, ${Math.round(short.ms)}ms(먼 이동 ${Math.round(long.ms)}ms)`,
    );
  }

  // 이동 중에 다른 노드를 고른다.
  const other = (await files()).reduce((a, b) => (apartOf(b, middle) > apartOf(a, middle) ? b : a));
  const next = other.id === far.id ? FILE : other.id;
  await watchFrames(page);
  await page.click(row(far.id));
  await page.waitForSelector(".graph[data-flying]", { timeout: 10_000 });
  await page.waitForTimeout(400);
  const midway = (await count(page, ".graph[data-flying]")) > 0;
  await page.click(row(next));
  await waitSelected(page, next);
  const chained = await framesOf(page);
  const span = chained.slice(chained.findIndex((frame) => frame.flying), chained.findLastIndex((frame) => frame.flying) + 1);
  const chain = flightOf(span, clear, area);
  const turned = span.findIndex((frame) => frame.selected === next);
  const mean = (list) => list.reduce((total, value) => total + value, 0) / list.length;
  const [pace, kept] = [mean(chain.rates.slice(Math.max(turned - 4, 0), turned - 1)), mean(chain.rates.slice(turned, turned + 3))];
  const typical = [...chain.rates].sort((a, b) => a - b)[Math.floor(chain.rates.length / 2)];
  t.check(
    "이동 중에 다른 노드를 고르면 그 순간의 화면에서 멈추지 않고 새 도착 노드로 이어 간다",
    midway && turned > 0 && span.every((frame) => frame.flying) && kept > pace * 0.4 && Math.max(...chain.rates) < typical * 4 && (await reachable(page, next)).ok,
    `${far.id}로 가다가 ${next}로, 빠르기는 바꾸기 전 세 프레임 ${pace.toFixed(2)} · 바꾼 뒤 세 프레임 ${kept.toFixed(2)}, 가장 빠른 프레임 ${Math.max(...chain.rates).toFixed(2)}(가운데값 ${typical.toFixed(2)})`,
  );

  // 이동 중에 휠을 굴리고, 이동 중에 화면을 끈다.
  const viewport = () => page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform);
  const halted = async (act) => {
    await page.waitForSelector(".graph[data-flying]", { timeout: 10_000 });
    await page.waitForTimeout(300);
    const flying = (await count(page, ".graph[data-flying]")) > 0;
    await act();
    const stopped = await page.waitForSelector(".graph[data-flying]", { state: "detached", timeout: 300 }).then(() => true, () => false);
    await settle(page);
    return { flying, stopped };
  };
  await page.click(row(far.id));
  const wheeled = await halted(async () => {
    await page.mouse.move(middle.x, middle.y);
    await page.mouse.wheel(0, -100);
  });
  const stayed = await viewport();
  t.check(
    "이동 중에 휠을 굴리면 이동을 멈추고 도착 노드로 가지 않는다",
    wheeled.flying && wheeled.stopped && !(await reachable(page, far.id)).ok && (await viewport()) === stayed,
    `굴릴 때 이동 중 ${wheeled.flying}, 멈춤 ${wheeled.stopped}, 도착 노드의 이름표 ${(await reachable(page, far.id)).at}`,
  );
  await page.click(row(next));
  const dragged = await halted(async () => {
    await page.mouse.move(middle.x, middle.y);
    await page.mouse.down();
  });
  await page.mouse.move(middle.x + 60, middle.y + 30, { steps: 4 });
  await page.mouse.up();
  await settle(page);
  t.check("이동 중에 화면을 잡으면 이동을 멈춘다", dragged.flying && dragged.stopped && (await count(page, ".graph[data-flying]")) === 0, `잡을 때 이동 중 ${dragged.flying}, 멈춤 ${dragged.stopped}`);
  await page.mouse.move(1, 1);

  // 움직임을 줄이는 설정에서는 바로 옮긴다.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await watchFrames(page);
  await go(far.id);
  const still = await framesOf(page);
  t.check(
    "움직임을 줄이는 설정에서는 화면 이동 없이 바로 옮긴다",
    still.every((frame) => !frame.flying) && (await reachable(page, far.id)).ok && new Set(still.map((frame) => `${frame.x} ${frame.zoom}`)).size <= 2,
    `이동 프레임 ${still.filter((frame) => frame.flying).length}개, 도착 노드의 이름표 ${(await reachable(page, far.id)).at}`,
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // "화면 맞춤"도 같은 이동을 지난다.
  await watchFrames(page);
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await settle(page);
  const fitting = flightOf(await framesOf(page), clear, area);
  const fitted = await viewport();
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await settle(page);
  t.check(
    '"화면 맞춤"은 화면 이동을 그리며 그래프 전체를 맞추고, 맞춘 화면에서 다시 누르면 화면이 그대로다',
    fitting.flying.length > 0 && (await viewport()) === fitted,
    `${Math.round(fitting.ms)}ms, 프레임 ${fitting.flying.length}개, ${fitted}`,
  );
}

/**
 * 폴더를 직접 여닫을 때 화면 이동이 없는지 본다. 접힌 폴더 상자를 그래프에서 눌러 펴고, 펼친 폴더 영역의 머리 줄을 눌러 접고,
 * 파일트리의 폴더 행으로 펴고 접는다. 조작마다 `data-flying`이 붙은 프레임이 없고 그 폴더의 왼쪽 위 화면 좌표와 확대 비율이 그대로인지 본다.
 * 첫 조작은 레포를 연 전체 맞춤 상태에서, 나머지는 전체 맞춤 상태가 꺼진 뒤에 한다. `--wide-url`을 받으면 그 레포에서도 본다.
 */
async function folderHold(t, page) {
  const viewport = () => page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform);
  /** 그래프에서 눌리는 접힌 폴더 상자 가운데 첫 상자의 id */
  const folded = () =>
    page.evaluate(() => {
      for (const wrapper of document.querySelectorAll(".react-flow__node:has(> .node-package)")) {
        const rect = wrapper.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const row = document.querySelector(`.tree-row.tree-dir[data-node="${CSS.escape(wrapper.dataset.id)}"]`);
        if (row !== null && hit !== null && (wrapper.contains(hit) || hit.closest(".react-flow__node")?.dataset.id === `${wrapper.dataset.id}#face`)) {
          return wrapper.dataset.id;
        }
      }
      return null;
    });
  const held = async (name, label, id, act, opens) => {
    const before = { corner: await rectOf(page, node(id)), zoom: await zoomOf(page) };
    await watchFrames(page);
    await act();
    await page.waitForSelector(`${node(id)} > ${opens ? ".node-region" : ".node-package"}`, { timeout: 30_000 });
    await page.mouse.move(1, 1);
    await settle(page);
    const frames = await framesOf(page);
    const after = { corner: await rectOf(page, node(id)), zoom: await zoomOf(page) };
    t.check(
      `${name}: ${label} 화면 이동이 없고 그 폴더의 왼쪽 위와 확대 비율이 그대로다`,
      frames.every((frame) => !frame.flying) && frames.some((frame) => frame.moving) && near(after.corner.x, before.corner.x) && near(after.corner.y, before.corner.y) && after.zoom === before.zoom,
      `${id}, 이동 프레임 ${frames.filter((frame) => frame.flying).length}개, 왼쪽 위 (${before.corner.x.toFixed(1)}, ${before.corner.y.toFixed(1)}) → (${after.corner.x.toFixed(1)}, ${after.corner.y.toFixed(1)}), 확대 비율 ${before.zoom} → ${after.zoom}`,
    );
  };
  const round = async (name, at) => {
    await load(page, at, false);
    const id = await folded();
    if (id === null) {
      t.skip(`${name}: 폴더를 여닫아도 화면 이동이 없다`, "그래프에서 눌리는 접힌 폴더 상자가 없다");
      return;
    }
    const row = `.tree-row.tree-dir[data-node="${id}"]`;
    await held(name, "전체 맞춤 상태에서 접힌 폴더 상자를 눌러 펴면", id, () => clickNode(page, id), true);
    const open = await viewport();
    await page.getByRole("button", { name: "화면 맞춤" }).click();
    await settle(page);
    const refit = await viewport();
    await page.getByRole("button", { name: "화면 맞춤" }).click();
    await settle(page);
    t.check(`${name}: 폴더를 편 화면은 다시 맞춘 화면이 아니고 "화면 맞춤"을 누르면 그래프 전체를 맞춘다`, (await viewport()) === refit, `편 뒤 ${open}, 맞춘 뒤 ${refit}`);
    await held(name, "전체 맞춤 상태에서 폴더 영역의 머리 줄을 눌러 접으면", id, async () => {
      const head = center(await rectOf(page, `${face(id)} .node-region-head`));
      await page.mouse.click(head.x, head.y);
    }, false);
    await held(name, "전체 맞춤 상태가 꺼진 뒤 파일트리의 폴더 행으로 펴면", id, () => page.click(row), true);
    await held(name, "전체 맞춤 상태가 꺼진 뒤 파일트리의 폴더 행으로 접으면", id, () => page.click(row), false);
  };
  await round("sync-engine", url);
  await t.shot();
  if (wideUrl === null) {
    t.skip("폴더가 여러 겹인 레포에서 폴더를 여닫아도 화면 이동이 없다", "--wide-url을 주지 않았다");
  } else {
    await round("폴더가 여러 겹인 레포", wideUrl);
  }
}

/** 폴더 색을 만드는 비율(styles.css의 --folder, --folder-tint, --folder-line)과 layout.ts의 PAD, REGION_HEAD */
const FOLDER = { edge: 0.5, tint: 0.1, line: 0.6, pad: 16, head: 28 };

/** CSS 색 글(`rgb()`, `rgba()`, `color(srgb …)`)을 0~1의 [r, g, b, a]로 바꾼다. */
function channels(text) {
  const [body, alpha] = text.slice(text.indexOf("(") + 1, -1).split("/");
  const values = body.replace("srgb", "").split(/[\s,]+/).filter((part) => part !== "").map(Number);
  const scale = text.startsWith("rgb") ? 255 : 1;
  return [values[0] / scale, values[1] / scale, values[2] / scale, alpha !== undefined ? Number(alpha) : (values[3] ?? 1)];
}

/** 색 a를 share만큼, 색 b를 나머지만큼 섞은 불투명한 색 */
const blend = (a, b, share) => [0, 1, 2].map((i) => a[i] * share + b[i] * (1 - share)).concat(1);
const sameColor = (a, b) => a.every((value, i) => near(value, b[i], 0.012));
/** 파란 채널이 빨간 채널보다 높으면 폴더 색이 섞인 색이다. 무채색 토큰은 세 채널이 거의 같다. */
const tinted = (color) => color[2] - color[0] > 0.02;
const colorText = (color) => `rgb(${color.slice(0, 3).map((value) => Math.round(value * 255)).join(" ")}${color[3] === 1 ? "" : ` / ${color[3].toFixed(2)}`})`;

/**
 * 폴더 색. 접힌 폴더 상자의 채움과 테두리, 펼친 폴더 영역의 머리 줄 띠·폴더 경로·테두리가 --link를 섞은 색이고 파일 상자는 무채색인지,
 * 영역의 바탕이 불투명해 겹쳐도 같은 색인지, 머리 줄 띠와 첫 자식 사이가 옆 안쪽 여백과 같은지를 밝은 화면과 어두운 화면에서 본다.
 * 여러 겹으로 펼친 폴더는 `--wide-url`을 받았을 때 그 레포에서 본다.
 */
async function folderTint(t, page) {
  /** 화면의 폴더 영역, 접힌 폴더 상자, 파일 상자에서 읽은 색 */
  const seen = () =>
    page.evaluate(() => {
      const style = (selector) => {
        const element = document.querySelector(selector);
        return element === null ? null : getComputedStyle(element);
      };
      const [area, head, box, file] = [
        style(".react-flow__node > .node-body.node-region"),
        style(".react-flow__node > .node-face.node-region .node-region-head"),
        style(".react-flow__node > .node-body.node-package"),
        style(".react-flow__node > .node-body.node-module:not(.node-module-open)"),
      ];
      return {
        area: area && { fill: area.backgroundColor, edge: area.borderTopColor },
        head: head && { fill: head.backgroundColor, text: getComputedStyle(document.querySelector(".node-face.node-region .node-label")).color },
        box: box && { fill: box.backgroundColor, edge: box.borderTopColor },
        file: file && { fill: file.backgroundColor, edge: file.borderTopColor },
        regions: [...document.querySelectorAll(".react-flow__node > .node-body.node-region")].map((element) => getComputedStyle(element).backgroundColor),
      };
    });
  const token = async (name) => channels((await colorOf(page, name)).rgb);
  const colors = async (name) => {
    const [found, link, muted, surface, ink] = [await seen(), await token("--link"), await token("--muted"), await token("--surface"), await token("--ink")];
    const edge = blend(link, muted, FOLDER.edge);
    const [fill, band, text, line] = [channels(found.box.fill), channels(found.head.fill), channels(found.head.text), channels(found.area.edge)];
    t.check(
      `${name}: 접힌 폴더 상자의 채움이 화면 바탕에 --link를 ${FOLDER.tint * 100}% 섞은 색이고 테두리가 --link와 muted 잉크를 반씩 섞은 색이다`,
      sameColor(fill, blend(link, surface, FOLDER.tint)) && sameColor(channels(found.box.edge), edge) && tinted(fill),
      `채움 ${colorText(fill)}, 테두리 ${colorText(channels(found.box.edge))}`,
    );
    t.check(
      `${name}: 펼친 폴더 영역의 머리 줄 띠가 --link ${FOLDER.tint * 100}%이고 폴더 경로가 접힌 폴더 상자의 테두리 색이며 영역의 테두리가 그 색의 ${FOLDER.line * 100}%다`,
      sameColor(band, [...link.slice(0, 3), FOLDER.tint]) && sameColor(text, edge) && sameColor(line, [...edge.slice(0, 3), FOLDER.line]),
      `띠 ${colorText(band)}, 폴더 경로 ${colorText(text)}, 테두리 ${colorText(line)}`,
    );
    const [paper, sheet] = [channels(found.file.fill), channels(found.area.fill)];
    t.check(
      `${name}: 파일 상자의 채움과 테두리, 폴더 영역의 바탕은 무채색이고 영역의 바탕은 불투명하다`,
      !tinted(paper) && !tinted(channels(found.file.edge)) && !tinted(sheet) && sheet[3] === 1 && sameColor(sheet, blend(ink, surface, 0.02)),
      `파일 상자 ${colorText(paper)}, 영역 바탕 ${colorText(sheet)}`,
    );
    return found;
  };
  /** 펼친 폴더 영역마다 머리 줄 아래, 왼쪽, 아래의 안쪽 여백. 자식은 그 폴더 바로 아래의 상자와 영역이다. */
  const gaps = async (graph) => {
    const at = await flowBoxes(page);
    const heads = await page.evaluate(() => {
      const zoom = Number(/scale\(([^)]+)\)/.exec(document.querySelector(".react-flow__viewport").style.transform)?.[1] ?? 1);
      return Object.fromEntries(
        [...document.querySelectorAll(".react-flow__node > .node-face.node-region")].map((element) => {
          const [strip, around] = [element.querySelector(".node-region-head").getBoundingClientRect(), element.getBoundingClientRect()];
          return [element.parentElement.dataset.id.replace(/#face$/, ""), (strip.bottom - around.top) / zoom];
        }),
      );
    });
    return Object.entries(heads).map(([id, head]) => {
      const kids = graph.nodes.filter((n) => n.parent === id && at[n.id] !== undefined).map((n) => at[n.id]);
      const around = at[id];
      return {
        id,
        head,
        top: Math.min(...kids.map((box) => box.y)) - around.y - head,
        left: Math.min(...kids.map((box) => box.x)) - around.x,
        bottom: around.y + around.height - Math.max(...kids.map((box) => box.y + box.height)),
      };
    });
  };
  /** 배치는 선이 지나는 통로만큼 자식을 더 띄울 수 있으므로 여백은 PAD 이상이고, 통로가 없는 영역에서는 머리 줄 아래와 왼쪽이 모두 PAD다. */
  const spaced = (found) =>
    found.length > 0 &&
    found.every((gap) => near(gap.head, FOLDER.head) && gap.top >= FOLDER.pad - 1 && gap.left >= FOLDER.pad - 1) &&
    found.some((gap) => near(gap.top, FOLDER.pad) && near(gap.left, FOLDER.pad));
  const gapText = (found) => found.map((gap) => `${gap.id} 머리 줄 ${gap.head.toFixed(0)}, 아래 ${gap.top.toFixed(0)}, 왼쪽 ${gap.left.toFixed(0)}, 바닥 ${gap.bottom.toFixed(0)}`).join(" / ");
  const dark = async () => {
    await page.getByRole("button", { name: "어두운 화면" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.mouse.move(1, 1);
    await page.waitForTimeout(300);
  };

  // sync-engine: parser/를 펼친 채 tests/ 폴더 상자를 함께 그린다.
  await load(page);
  await setToggle(page, "테스트 코드", true);
  await page.waitForSelector(".react-flow__node > .node-body.node-package", { timeout: 30_000 });
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await page.mouse.move(1, 1);
  await rest(page);
  const graph = await api("/api/graph");
  const light = await colors("밝은 화면");
  const space = await gaps(graph);
  t.check(
    `펼친 폴더 영역의 머리 줄 띠 아래 끝과 첫 자식 위 끝의 거리가 왼쪽 안쪽 여백 ${FOLDER.pad}px와 같다`,
    spaced(space) && space.every((gap) => near(gap.top, gap.left)),
    gapText(space),
  );
  // 커서를 올린 접힌 폴더 상자는 테두리만 본문 잉크가 되고 채움은 그대로다.
  const folded = await page.evaluate(() => document.querySelector(".react-flow__node > .node-body.node-package").parentElement.dataset.id);
  const label = await rectOf(page, `${face(folded)} .node-label`);
  await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
  await page.waitForSelector(`${node(folded)}.pointed`, { timeout: 3_000 }).catch(() => {});
  const over = await page.evaluate((selector) => {
    const style = getComputedStyle(document.querySelector(`${selector} > .node-body`));
    return { fill: style.backgroundColor, edge: style.borderTopColor };
  }, node(folded));
  t.check(
    "접힌 폴더 상자에 커서를 올리면 테두리가 본문 잉크가 되고 채움은 폴더 색 그대로다",
    sameColor(channels(over.edge), await token("--ink")) && over.fill === light.box.fill,
    `테두리 ${over.edge}, 채움 ${over.fill}`,
  );
  await page.mouse.move(1, 1);
  await page.screenshot({ path: join(OUT, "hf4-folder-se-light.png") });
  await dark();
  const night = await colors("어두운 화면");
  t.check("어두운 화면의 폴더 색은 밝은 화면과 다른 값이다", night.box.fill !== light.box.fill && night.head.text !== light.head.text, `채움 ${light.box.fill} → ${night.box.fill}`);
  await page.screenshot({ path: join(OUT, "hf4-folder-se-dark.png") });

  if (wideUrl === null) {
    t.skip("세 겹으로 펼친 폴더의 가장 안쪽 영역 바탕이 바깥 영역 바탕과 같다", "--wide-url을 주지 않았다");
    return;
  }
  const wide = await api("/api/graph", wideUrl);
  await page.goto(wideUrl);
  await page.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await settle(page);
  /** 가장 깊은 폴더에서 소스 루트까지 올라가는 폴더 id. 바깥 폴더가 앞이다. */
  const depth = (id) => (wide.nodes.find((n) => n.id === id).parent === null ? 1 : 1 + depth(wide.nodes.find((n) => n.id === id).parent));
  const deepest = wide.nodes.filter((n) => n.kind === "package" && !n.test).sort((a, b) => depth(b.id) - depth(a.id) || a.id.localeCompare(b.id))[0];
  const chain = [];
  for (let at = deepest; at !== undefined; at = wide.nodes.find((n) => n.id === at.parent)) {
    chain.unshift(at.id);
  }
  for (const id of chain) {
    await openFolder(page, id);
  }
  await page.getByRole("button", { name: "화면 맞춤" }).click();
  await page.mouse.move(1, 1);
  await rest(page);
  for (const theme of ["밝은 화면", "어두운 화면"]) {
    if (theme === "어두운 화면") {
      await dark();
    }
    const found = await colors(`${chain.join(" > ")}, ${theme}`);
    t.check(
      `${theme}: ${chain.length}겹으로 펼친 폴더의 가장 안쪽 영역 바탕이 바깥 영역 바탕과 같다`,
      chain.length >= 3 && found.regions.length >= chain.length && new Set(found.regions).size === 1 && channels(found.regions[0])[3] === 1,
      `영역 ${found.regions.length}개의 바탕 ${[...new Set(found.regions)].join(", ")}`,
    );
  }
  // 영역의 바탕이 불투명하므로 안쪽 영역은 같은 층의 바깥 영역보다 뒤에 그려야 테두리가 가려지지 않는다.
  const stacked = await page.evaluate((ids) => {
    const wrapper = (id) => document.querySelector(`.react-flow__node[data-id="${id}"]`);
    return ids.slice(1).map((id, i) => {
      const [outer, inner] = [wrapper(ids[i]), wrapper(id)];
      return getComputedStyle(outer).zIndex === getComputedStyle(inner).zIndex && (outer.compareDocumentPosition(inner) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
  }, chain);
  t.check("안쪽 폴더 영역은 바깥 폴더 영역과 같은 층에서 바깥 영역보다 뒤에 그린다", stacked.length >= 2 && stacked.every(Boolean), stacked.join(", "));
  const nested = await gaps(wide);
  t.check(`여러 겹으로 펼친 폴더 영역 ${nested.length}개도 머리 줄 띠 아래의 여백이 ${FOLDER.pad}px 이상이고 선의 통로가 없는 영역은 왼쪽 안쪽 여백과 같다`, spaced(nested) && nested.length >= chain.length, gapText(nested));
}

/**
 * 상자의 줄 수 배지. 파일 상자·폴더·클래스·데이터 클래스의 오른쪽 위 배지가 `/api/graph`에서 계산한 줄 수를 줄여 적은 글이고(폴더는 그 아래
 * 파일의 줄 수 합이고 토글로 숨긴 테스트 코드를 뺀다) 말풍선이 줄이지 않은 줄 수와 안에 든 것의 수를 적는지, 상자와 함수·변수의 이름 옆에
 * 줄 수 숫자가 없는지, 배지가 도는 원·머리 줄의 글자와 겹치지 않는지를 본다. `--wide-url`을 받으면 그 레포에서
 * k 단위로 줄인 배지도 본다. 사진은 `hf6-label-{이름}.png`로 남긴다.
 */
async function badgeLines(t, page) {
  /** 화면의 배지마다 적힌 글과 말풍선, 배지가 놓인 곳, 같은 상자의 이름표·머리 줄 글자·도는 원과 겹치는지 */
  const drawn = () =>
    page.evaluate(() => {
      const crosses = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
      return [...document.querySelectorAll(".react-flow__node > .node-face")].map((element) => {
        const badge = element.querySelector(":scope > .badge-lines");
        const [at, around] = [badge?.getBoundingClientRect(), element.getBoundingClientRect()];
        const texts = [...element.querySelectorAll(".node-label, .node-aside, .change-mark, .badge-busy, .node-field")].map((each) => each.getBoundingClientRect());
        const style = badge && getComputedStyle(badge);
        return {
          id: element.parentElement.dataset.id.replace(/#face$/, ""),
          open: element.classList.contains("node-region") || element.classList.contains("node-module-open"),
          text: badge?.textContent ?? null,
          tip: badge?.dataset.tip ?? null,
          loc: element.querySelector(".loc")?.textContent ?? null,
          fill: style?.backgroundColor ?? null,
          corner: at === undefined ? null : [at.right - around.right, around.top - at.top],
          clear: at === undefined || texts.every((each) => !crosses(at, each)),
        };
      });
    });
  const zoom = () => zoomOf(page);
  const BOXES = ["package", "module", "class", "dataclass"];
  /** 배지를 다는 종류의 상자는 모두 계산한 줄 수의 배지와 말풍선을 달고, 그 밖의 노드는 배지가 없다. 어느 노드도 이름 옆 숫자가 없다 */
  const labeled = (seen, graph, tests) => {
    const kinds = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    return (
      seen.some((each) => each.text !== null) &&
      seen.every((each) =>
        BOXES.includes(kinds.get(each.id))
          ? each.text === kilo(locOf(graph, each.id, tests)) && each.tip === sizeTipOf(graph, each.id, tests) && each.loc === null && each.clear
          : each.text === null && each.loc === null,
      )
    );
  };
  const words = (seen) => seen.filter((each) => each.text !== null).slice(0, 12).map((each) => `${each.id}${each.open ? "(펼침)" : ""} ${each.text}`).join(", ");
  const fit = async () => {
    await page.getByRole("button", { name: "화면 맞춤" }).click();
    await page.mouse.move(1, 1);
    await rest(page);
  };

  // 기준 레포: 접은 채로 연 화면, 폴더를 펼친 화면, 파일을 펼친 화면
  const graph = await api("/api/graph");
  await load(page, url, false);
  const folded = await drawn();
  t.check("접힌 폴더 상자와 접힌 파일 상자의 배지가 줄 수이고 이름 옆에 줄 수 숫자가 없다", labeled(folded, graph, false) && folded.every((each) => !each.open), words(folded));
  await load(page);
  const opened = await drawn();
  const regions = opened.filter((each) => each.open);
  const scale = await zoom();
  t.check(
    "펼친 폴더 영역도 오른쪽 위 모서리에 같은 줄 수 배지를 달고 머리 줄의 폴더 경로와 겹치지 않는다",
    labeled(opened, graph, false) && regions.length > 0 && regions.every((each) => each.text === folded.find((box) => box.id === each.id)?.text && near(each.corner[0] / scale, 6, 0.6) && near(each.corner[1] / scale, 7, 0.6)),
    regions.map((each) => `${each.id} ${each.text}, 오른쪽으로 ${(each.corner[0] / scale).toFixed(1)}px 위로 ${(each.corner[1] / scale).toFixed(1)}px`).join(" / "),
  );
  const tip = await tipOver(page, `${face(regions[0].id)} .badge-lines`);
  t.check("폴더 영역의 배지에 올리면 말풍선이 줄이지 않은 줄 수 합과 안에 든 파일 수를 적는다", tip === sizeTipOf(graph, regions[0].id) && tip.includes("안에 든 파일"), tip);
  await page.screenshot({ path: HF6("label-tip") });
  await page.mouse.move(1, 1);
  await zoomTo(page, 1);
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF6("label-se") });
  await pickFile(page, FILE);
  const inFile = await drawn();
  const own = inFile.find((each) => each.id === FILE);
  const leaves = inFile.filter((each) => ["function", "method", "variable"].includes(graph.nodes.find((n) => n.id === each.id)?.kind));
  const muted = (await colorOf(page, "--muted")).rgb;
  t.check(
    "펼친 파일 상자도 줄 수 배지를 달고 머리 줄의 이름표·함수 수 글자와 겹치지 않는다",
    labeled(inFile, graph, false) && own?.open === true && own.text === kilo(locOf(graph, FILE)) && own.clear,
    `${FILE} ${own?.text}`,
  );
  t.check(
    "함수·변수는 배지도 이름 옆 줄 수 숫자도 없고, 화면에 이름 옆 줄 수 숫자가 하나도 없다",
    leaves.length > 0 && leaves.every((each) => each.text === null && each.loc === null) && (await count(page, ".react-flow__node .loc")) === 0 && own.fill === muted,
    `함수·변수 ${leaves.length}개, 배지 바탕 ${own.fill}`,
  );
  await page.screenshot({ path: HF6("label-file-open") });

  // 테스트 코드를 켜면 폴더의 합이 달라진다.
  const before = new Map(inFile.map((each) => [each.id, each.text]));
  await setToggle(page, "테스트 코드", true);
  await page.waitForFunction((had) => document.querySelectorAll(".react-flow__node > .node-face .badge-lines").length !== had, inFile.filter((each) => each.text !== null).length, { timeout: 30_000 }).catch(() => {});
  await rest(page);
  const tested = await drawn();
  const moved = tested.filter((each) => each.text !== null && graph.nodes.find((n) => n.id === each.id).kind === "package" && before.get(each.id) !== each.text);
  t.check(
    "테스트 코드를 켜면 폴더의 배지가 테스트 파일까지 더한 합이 되고, 합이 달라졌거나 새로 보이는 폴더가 있다",
    labeled(tested, graph, true) && moved.length > 0,
    moved.map((each) => `${each.id} ${before.get(each.id) ?? "없음"} → ${each.text}`).join(", "),
  );
  await setToggle(page, "테스트 코드", false);
  await rest(page);
  await page.getByRole("button", { name: "어두운 화면" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  const night = await drawn();
  const nightMuted = (await colorOf(page, "--muted")).rgb;
  t.check(
    "어두운 화면에서도 배지의 바탕이 muted 잉크다",
    night.filter((each) => each.text !== null).every((each) => each.fill === nightMuted),
    nightMuted,
  );
  await zoomTo(page, 1);
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF6("label-se-dark") });

  if (wideUrl === null) {
    t.skip("수천 줄이 넘는 폴더의 배지를 k 단위로 줄여 적는다", "--wide-url을 주지 않았다");
    return;
  }
  const wide = await api("/api/graph", wideUrl);
  await load(page, wideUrl);
  const outer = await drawn();
  const short = outer.filter((each) => each.text?.endsWith("k"));
  t.check(
    `폴더가 여러 겹인 레포에서 펼친 폴더 영역과 그 안의 상자가 하위 폴더까지 더한 줄 수를 적고, 1,000줄이 넘는 배지 ${short.length}개는 k 단위로 줄여 적으며 말풍선이 줄이지 않은 수를 적는다`,
    labeled(outer, wide, false) && short.length > 0 && short.every((each) => each.tip.startsWith(`줄 수 ${locOf(wide, each.id)}줄`)) && outer.some((each) => each.open && locOf(wide, each.id) >= 10_000),
    words(outer),
  );
  await zoomTo(page, 1);
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF6("label-mdp") });
  const deep = wide.nodes.find((n) => n.kind === "package" && n.parent !== null && !n.test && wide.nodes.some((kid) => kid.parent === n.id && kid.kind === "module" && !kid.test));
  await openFolder(page, deep.id);
  await fit();
  const nested = await drawn();
  t.check(
    "안쪽 폴더를 펼쳐도 바깥 폴더 영역과 안쪽 폴더 영역이 저마다의 합을 적는다",
    labeled(nested, wide, false) && nested.filter((each) => each.open).length >= 2,
    words(nested.filter((each) => each.open)),
  );
  await zoomTo(page, 1);
  await page.mouse.move(1, 1);
  await page.screenshot({ path: HF6("label-region") });
}

/**
 * 탐색 경로 맨 앞의 레포 이름. 고른 노드가 없을 때와 있을 때의 이름 순서, 레포 이름과 소스 루트 폴더 이름을 눌러 선택을 푸는지와
 * 그 단계가 이력에 담기는지, 창 폭 720px에서 앞 이름부터 줄고 마지막 단계가 눌리는지 본다. `--wide-url`을 받으면 소스 루트가
 * 레포 루트인 그 레포에서도 본다. 사진은 `hf4-trail-root-{이름}.png`로 남긴다.
 */
async function trailRoot(t, page) {
  /** 탐색 경로에 그린 이름과 `…`, 마지막 이름이 가운데 점에서 눌리고 상단 줄 안에 있는지 */
  const trailOf = () =>
    page.evaluate(() => {
      const trail = document.querySelector(".toolbar-trail");
      const bar = document.querySelector(".toolbar").getBoundingClientRect();
      const names = [...trail.querySelectorAll(".trail-cut, .trail-root, .trail-step")];
      const last = names.at(-1);
      const rect = last?.getBoundingClientRect();
      const hit = rect === undefined ? null : document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        names: names.map((each) => each.textContent.trim()),
        roots: [...trail.querySelectorAll(".trail-root")].map((each) => ({ text: each.textContent.trim(), button: each.tagName === "BUTTON", tip: each.dataset.tip })),
        cut: trail.querySelector(".trail-cut")?.dataset.tip ?? null,
        pressed: last !== undefined && hit !== null && last.contains(hit) && rect.right <= bar.right,
        clipped: last !== undefined && last.scrollWidth > last.clientWidth,
        header: document.querySelector(".explorer-header")?.textContent ?? null,
      };
    });
  const round = async (name, at, id, shot) => {
    const [repo, graph] = [await api("/api/repo", at), await api("/api/graph", at)];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const roots = [repo.name, ...(repo.source_root === "" ? [] : [repo.source_root])];
    const chain = [];
    for (let n = byId.get(id); n !== undefined; n = n.parent === null ? undefined : byId.get(n.parent)) {
      chain.unshift(n.kind === "module" ? `${n.name}.py` : n.kind === "function" || n.kind === "method" ? `${n.name}()` : n.name);
    }
    await page.setViewportSize({ width: 1700, height: 1000 });
    await load(page, at, false);
    const idle = await trailOf();
    t.check(
      `${name}: 고른 노드가 없으면 탐색 경로는 ${roots.join(" > ")}이고 이름마다 선택을 푸는 버튼이다`,
      same(idle.names, roots) && idle.roots.every((root) => root.button && root.tip === "선택 풀기") && idle.header === repo.name,
      `${idle.names.join(" > ")}, 파일트리 머리 ${idle.header}`,
    );
    await palettePick(page, id.split(":")[1], id);
    await waitSelected(page, id);
    await page.mouse.move(5, 5);
    const picked = await trailOf();
    t.check(`${name}: 함수를 고르면 레포 이름 뒤에 단계가 이어지고 마지막 단계가 눌린다`, same(picked.names, [...roots, ...chain]) && picked.pressed && !picked.clipped, picked.names.join(" > "));
    await page.screenshot({ path: HF4(`trail-root-${shot}`) });
    const backs = () => page.getByRole("button", { name: "뒤로" }).isDisabled();
    for (const [index, root] of roots.entries()) {
      await page.click(`.trail-root >> nth=${index}`);
      await page.mouse.move(5, 5);
      await rest(page);
      const cleared = (await selectedOf(page)) === null && same((await trailOf()).names, roots) && !(await backs());
      await page.keyboard.press("Alt+ArrowLeft");
      await waitSelected(page, id).catch(() => {});
      t.check(`${name}: 탐색 경로의 ${root}를 누르면 선택이 풀리고 뒤로 가면 그 함수로 돌아온다`, cleared && (await selectedOf(page)) === id, `선택 ${await selectedOf(page)}`);
    }

    // 좁은 창. 앞 이름부터 `…`로 줄고 마지막 단계는 눌린다.
    await page.setViewportSize({ width: 720, height: 1000 });
    await page.waitForTimeout(400);
    const narrow = await trailOf();
    t.check(
      `${name}: 창 폭 720px에서 탐색 경로는 앞 이름부터 줄이고 줄인 이름을 …의 말풍선에 적으며 마지막 단계가 상단 줄 안에서 눌린다`,
      narrow.names.at(-1) === chain.at(-1) && narrow.pressed && (narrow.cut === null ? same(narrow.names, [...roots, ...chain]) : narrow.names[0] === "…" && narrow.cut.startsWith(repo.name)),
      `${narrow.names.join(" > ")}, 줄인 이름 "${narrow.cut ?? "없음"}"${narrow.clipped ? ", 마지막 단계 말줄임" : ""}`,
    );
    if (shot === "se") {
      await page.screenshot({ path: HF4("trail-root-narrow") });
    }
    await page.keyboard.press("Escape");
    await rest(page);
    const bare = await trailOf();
    t.check(`${name}: 창 폭 720px에서 고른 노드가 없으면 마지막 이름이 상단 줄 안에서 눌린다`, bare.names.at(-1) === roots.at(-1) && bare.pressed && (await selectedOf(page)) === null, `${bare.names.join(" > ")}${bare.clipped ? ", 마지막 이름 말줄임" : ""}`);
    if (shot === "mdp") {
      await page.screenshot({ path: HF4("trail-root-mdp-narrow") });
    }
    await page.setViewportSize({ width: 1700, height: 1000 });
  };
  await round("sync-engine", url, FUNCTION, "se");
  if (wideUrl === null) {
    t.skip("소스 루트가 레포 루트인 레포의 탐색 경로", "--wide-url을 주지 않았다");
  } else {
    const graph = await api("/api/graph", wideUrl);
    const deep = graph.nodes.filter((n) => n.kind === "function" && !n.test).sort((a, b) => b.id.split(".").length - a.id.split(".").length || a.id.localeCompare(b.id))[0];
    await round("폴더가 여러 겹인 레포", wideUrl, deep.id, "mdp");
  }
}

// ── 모듈 변수 노드 ────────────────────────────────────────────────

/** 변수 노드의 이름표 뒤에 적는 값의 종류와 원소 수(`graph/names.ts`의 `valueAside`) */
const asideOf = (n) => (n.value.size === null ? n.value.kind : `${n.value.kind} · ${n.value.size}개`);

/**
 * 변수 시나리오가 쓰는 파일과 노드를 그래프에서 고른다.
 * - file: 토글이 꺼진 화면에서 손잡이에 든 변수가 가장 많고 외부 값 변수도 있는 파일
 * - read: 같은 파일의 함수가 안쪽 자식인 변수를 읽는 선 가운데 읽은 곳이 가장 많은 선
 * - write: 테스트 코드가 아닌 함수가 변수를 바꾸는 선. 같은 두 노드 사이에 다른 선이 없는 선을 먼저 고른다(종류가 다른 선은 따로 그려 겹친다)
 * - held: 값이 레포의 정의를 생성하거나 부르는 변수 가운데 들어오는 읽음이 가장 많은 변수
 */
function variableCase(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const variable = (id) => nodes.get(id).kind === "variable" && !veiled(nodes.get(id));
  const files = packedFiles(graph)
    .map((file) => ({ ...file, inside: file.inner.filter(variable), external: graph.nodes.filter((n) => n.parent === file.id && n.external_value && !n.test).map((n) => n.id) }))
    .sort((a, b) => Math.sign(b.external.length) - Math.sign(a.external.length) || b.inside.length - a.inside.length);
  const file = files.find((each) => each.inside.length > 0);
  const callable = (id) => ["function", "method"].includes(nodes.get(id).kind) && !nodes.get(id).test;
  const reads = graph.edges.filter((e) => e.kind === "read" && callable(e.source) && variable(e.target)).sort((a, b) => b.sites.length - a.sites.length);
  const read = reads.find((e) => file !== undefined && file.inside.includes(e.target) && nodes.get(e.source).parent === file.id && file.outer.includes(e.source)) ?? reads[0];
  const writes = graph.edges.filter((e) => e.kind === "write" && callable(e.source) && variable(e.target));
  const alone = (edge) => graph.edges.filter((e) => e.source === edge.source && e.target === edge.target).length === 1;
  const write = writes.find(alone) ?? writes[0];
  const incoming = (id) => graph.edges.filter((e) => e.target === id && e.kind === "read" && !veiled(nodes.get(e.source))).reduce((sum, e) => sum + e.sites.length, 0);
  const held = graph.edges
    .filter((e) => (e.kind === "construct" || e.kind === "call") && variable(e.source) && !veiled(nodes.get(e.target)))
    .map((e) => e.source)
    .sort((a, b) => incoming(b) - incoming(a))[0];
  return { nodes, file, read, write, held };
}

/** 화면에 그린 변수 노드의 id */
const variablesDrawn = (page) =>
  page.evaluate(() => [...document.querySelectorAll(".react-flow__node > .node-body.node-variable")].map((body) => body.closest(".react-flow__node").dataset.id));

/**
 * from에서 to로 가는 그린 선에 마우스를 올린 말풍선의 줄과 그 선의 요소가 담은 지점 수, 선 위의 수. 두 노드 사이에 종류가 다른 선이
 * 여럿이면 종류 kind의 선을 본다. 누를 점이 없으면 null이다.
 */
async function lineOver(page, from, to, kind) {
  const found = await hittable(page, (await linesOf(page)).filter((line) => same(endsOfKey(line.key), [from, to]) && (line.key.startsWith("agg|") || line.key.endsWith(`|${kind}`))));
  if (found === null) {
    return null;
  }
  const bubble = await bubbleOver(page, found.at);
  const drawn = await page.evaluate((key) => {
    const edge = [...document.querySelectorAll(".react-flow__edge .edge[data-key]:not(.edge-trunk)")].find((e) => e.dataset.key === key);
    return { sites: Number(edge.dataset.sites), weight: edge.querySelector(".edge-weight")?.textContent ?? null };
  }, found.line.key);
  await page.mouse.move(1, 1);
  return { row: bubble?.rows.find((row) => same(row.nodes, [from, to])) ?? null, ...drawn };
}

/** 파일을 고른 펼침 단계와 전부 펼침 단계에서 변수 노드와 손잡이의 수, 접힌 상자의 배지 말풍선을 본다. */
async function varFile(t, page) {
  const graph = await api("/api/graph");
  const { nodes, file } = variableCase(graph);
  await load(page, url, false);
  await page.click(`.tree-row.tree-file[data-node="${file.id}"]`);
  await waitSelected(page, file.id);
  await page.click(`.tree-row.tree-file[data-node="${file.id}"]`);
  await rest(page);
  const tip = await tipOver(page, `${face(file.id)} .badge-lines`);
  t.check(
    `접힌 ${file.id}의 배지 말풍선이 변수까지 센 수 ${insideOf(graph, file.id)}개를 적는다`,
    tip === sizeTipOf(graph, file.id) && tip.endsWith(`안에 든 함수·클래스·변수 ${insideOf(graph, file.id)}개`),
    tip,
  );
  await pickFile(page, file.id);
  const variable = (id) => nodes.get(id).kind === "variable";
  const [pack, staged] = [await packOf(page, file.id), await variablesDrawn(page)];
  t.check(
    `펼침 단계에는 밖과 이어진 변수 ${file.outer.filter(variable).length}개만 보이고 손잡이가 "${packWords(graph, file.inner)}"로 변수 ${file.inside.length}개를 센다`,
    same(staged, file.outer.filter(variable)) && pack !== null && !pack.open && pack.text.startsWith(packWords(graph, file.inner)),
    `그린 변수 ${staged.length}개, 손잡이 "${pack?.text ?? "없음"}"`,
  );
  await clickPack(page, file.id);
  const [all, boxesNow] = [await drawnIn(page, graph, file.id), await flowBoxes(page)];
  const shownVariables = file.kids.filter(variable);
  t.check(
    `전부 펼침 단계에는 외부 값이 아닌 변수 ${shownVariables.length}개가 다른 정의와 함께 보이고 외부 값 변수 ${file.external.length}개는 없다`,
    same(all, file.kids) && same(await variablesDrawn(page), shownVariables) && file.external.every((id) => !all.includes(id)),
    `그린 정의 ${all.length}/${file.kids.length}개, 그린 변수 ${(await variablesDrawn(page)).length}개`,
  );
  const columnsNow = [...new Set(all.map((id) => boxesNow[id].x))];
  t.check(
    "같은 열의 변수와 다른 정의는 소스 정의 순서대로 위에서 아래로 놓인다",
    columnsNow.every((x) => {
      const column = all.filter((id) => boxesNow[id].x === x);
      return same([...column].sort((a, b) => boxesNow[a].y - boxesNow[b].y), column);
    }) && columnsNow.some((x) => all.filter((id) => boxesNow[id].x === x && variable(id)).length > 0),
    `열 ${columnsNow.length}개`,
  );
  const shape = await page.evaluate((id) => {
    const wrapper = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}#face"]`);
    return { diamond: document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] .node-diamond polygon`) !== null, text: [...wrapper.querySelectorAll(".node-label, .node-aside")].map((e) => e.textContent) };
  }, shownVariables[0]);
  const first = nodes.get(shownVariables[0]);
  t.check(
    "변수 노드는 마름모와 괄호 없는 이름, 값의 종류와 원소 수를 그린다",
    shape.diamond && same(shape.text, [first.name, asideOf(first)]),
    shape.text.join(" | "),
  );
}

/** 외부 노드 토글이 외부 값 변수를 그래프, 검색, 파일트리에서 보이고 숨기는지 본다. */
async function varExternal(t, page) {
  const graph = await api("/api/graph");
  const { nodes, file } = variableCase(graph);
  const outside = graph.edges.filter((e) => nodes.get(e.source).kind === "variable" && nodes.get(e.target).kind === "external");
  t.check("변수에서 외부 노드로 가는 선이 분석 결과에 없다", outside.length === 0, `${outside.length}개`);
  const hiddenOne = nodes.get(file.external[0]);
  await load(page, url, false);
  await pickFile(page, file.id);
  /** 검색 팔레트와 파일트리의 고른 파일 아래 목록에 외부 값 변수가 있는지 */
  const listed = async () => {
    await page.keyboard.press(`${MOD}+p`);
    await page.waitForSelector(".palette-input", { timeout: 5_000 });
    await page.keyboard.type(hiddenOne.name);
    await page.waitForTimeout(300);
    const found = { palette: (await count(page, `.palette-option[data-node="${hiddenOne.id}"]`)) > 0, tree: (await count(page, `.tree-row.tree-symbol[data-node="${hiddenOne.id}"]`)) > 0 };
    await page.keyboard.press("Escape");
    await page.waitForSelector(".palette", { state: "detached", timeout: 3_000 }).catch(() => {});
    return found;
  };
  const off = await listed();
  t.check(`토글이 꺼져 있으면 Mod+P 검색과 파일트리에 외부 값 변수 ${hiddenOne.name}이 없다`, !off.palette && !off.tree, JSON.stringify(off));
  await setToggle(page, "외부 노드", true);
  await rest(page);
  const wide = stagesOf(graph, file.id, true);
  if ((await packOf(page, file.id))?.open === false) {
    await clickPack(page, file.id);
  }
  const drawnNow = await variablesDrawn(page);
  const lines = (await linesOf(page)).map((line) => endsOfKey(line.key)).filter(([from, to]) => file.external.includes(from) && nodes.get(to)?.kind === "external");
  t.check(
    `외부 노드를 켜고 ${file.id}를 전부 펼치면 외부 값 변수 ${file.external.length}개가 보이고 그 변수에서 외부 노드로 가는 선은 없다`,
    file.external.every((id) => drawnNow.includes(id)) && same(await drawnIn(page, graph, file.id), wide.kids) && lines.length === 0 && (await count(page, ".node-body.node-external")) > 0,
    `그린 변수 ${drawnNow.length}개, 외부 노드로 가는 선 ${lines.length}개`,
  );
  const on = await listed();
  t.check("토글을 켜면 Mod+P 검색과 파일트리에 그 변수가 있다", on.palette && on.tree, JSON.stringify(on));
  await t.shot();
  // 외부 값 변수가 가장 많은 다른 파일
  const most = graph.nodes
    .filter((n) => n.kind === "module" && !n.test && n.id !== file.id)
    .map((n) => ({ id: n.id, external: graph.nodes.filter((each) => each.parent === n.id && each.external_value).map((each) => each.id) }))
    .sort((a, b) => b.external.length - a.external.length)[0];
  if (most === undefined || most.external.length === 0) {
    t.skip("외부 값 변수가 든 다른 파일을 고르면 그 변수가 보인다", "외부 값 변수가 든 다른 파일이 없다");
  } else {
    await palettePick(page, nodes.get(most.id).path.split("/").at(-1), most.id);
    await waitSelected(page, most.id);
    await rest(page);
    if ((await packOf(page, most.id))?.open === false) {
      await clickPack(page, most.id);
    }
    const seen = await variablesDrawn(page);
    t.check(`${most.id}를 고르면 외부 값 변수 ${most.external.length}개가 보인다`, most.external.every((id) => seen.includes(id)), `그린 변수 ${seen.length}개`);
  }
  await setToggle(page, "외부 노드", false);
  await rest(page);
  t.check("토글을 끄면 외부 값 변수가 그래프에서 사라진다", (await variablesDrawn(page)).every((id) => !nodes.get(id).external_value));
}

/** 값이 레포의 정의를 생성하는 변수를 골랐을 때의 그래프, 정보 패널, 코드 뷰어를 본다. --wide-url을 받으면 그 레포에서 본다. */
async function varSelect(t, page) {
  const at = wideUrl ?? url;
  const graph = await api("/api/graph", at);
  const { nodes, held } = variableCase(graph);
  if (held === undefined) {
    t.skip("값이 레포의 정의를 생성하는 변수를 고른다", `그런 변수가 없다${wideUrl === null ? "(--wide-url을 주지 않았다)" : ""}`);
    return;
  }
  const target = nodes.get(held);
  const off = hiddenOf(graph);
  await load(page, at, false);
  await palettePick(page, target.name, held);
  await waitSelected(page, held);
  await rest(page);
  const links = crossing(graph, held);
  const readers = [...new Set(links.into.map((e) => e.source))];
  /** 접힌 폴더 안의 노드는 꺼내 그리지 않으므로, 읽는 노드마다 그 노드가 보이거나 그 노드를 품은 접힌 폴더가 보이는지 본다. */
  const drawnReaders = await page.evaluate(
    ([ids, parents]) =>
      ids.filter((id) => {
        const shownId = (at) => document.querySelector(`.react-flow__node[data-id="${CSS.escape(at)}"]`) !== null;
        for (let at = id; at != null; at = parents[at]) {
          if (shownId(at)) {
            return at === id || document.querySelector(`.react-flow__node[data-id="${CSS.escape(at)}"] > .node-package`) !== null;
          }
        }
        return false;
      }),
    [readers, Object.fromEntries(graph.nodes.map((n) => [n.id, n.parent]))],
  );
  const trunk = (await trunksOf(page)).find((each) => each.target === held);
  const total = countedSites(links.into);
  t.check(
    `${target.name}를 고르면 읽는 노드 ${readers.length}개가 각자의 파일 상자나 접힌 폴더에 보이고 줄기의 합계가 들어오는 지점 수 ${total}이다`,
    same(drawnReaders, readers) && (readers.length < 2 || trunk?.sum === total),
    `그린 노드 ${drawnReaders.length}개, 합계 ${trunk?.sum ?? "없음"}`,
  );
  const facts = await factsOf(page);
  const want = [
    ["크기", `${asideOf(target)} · ${target.loc}줄 (${target.range[0]}~${target.range[1]})`],
    ["나가는 연결", linksWords(links.out).text],
    ["들어오는 연결", linksWords(links.into).text],
  ];
  t.check(
    `정보 패널의 이름 줄이 ${target.path}::${target.name}, 종류 칩이 변수이고 크기와 연결 줄이 읽음·생성을 센다`,
    facts.path === `${target.path}::` && facts.name === target.name && same(facts.chips, ["변수"]) && same(facts.rows.map((row) => [row.topic, row.text]), want),
    `${facts.path}${facts.name} [${facts.chips.join(", ")}] ${facts.rows.map((row) => `${row.topic}: ${row.text}`).join(" / ")}`,
  );
  t.check("변수의 정보 패널에는 요약 구역이 없다", (await count(page, ".info-panel-summary")) === 0);
  await page.waitForFunction((name) => document.querySelector(".info-panel .monaco-editor .view-lines")?.textContent.includes(name), target.name, { timeout: 10_000 }).catch(() => {});
  const code = await page.evaluate((name) => {
    const lines = [...document.querySelectorAll(".info-panel .monaco-editor .view-lines .view-line")];
    const line = lines.find((each) => each.textContent.replaceAll(" ", " ").trimStart().startsWith(name));
    return { shown: line !== undefined, colors: new Set([...(line?.querySelectorAll("span span") ?? [])].map((span) => getComputedStyle(span).color)).size };
  }, target.name);
  t.check("코드 뷰어가 대입문을 문법 색으로 그린다", code.shown && code.colors > 1, `대입문 ${code.shown ? "보임" : "안 보임"}, 글자색 ${code.colors}가지`);
  await t.shot();
  await clickNode(page, held);
  await rest(page);
  t.check("고른 변수를 다시 눌러도 선택이 유지된다", (await selectedOf(page)) === held, `${await selectedOf(page)}`);
  t.check("숨긴 노드에서 들어오는 읽음은 세지 않는다", links.into.every((e) => !off.has(e.source)));
}

/** 손잡이에 든 변수를 Mod+P로 고르면 그 파일 상자가 전부 펼침 단계가 되고 뒤로·앞으로에서 유지되는지 본다. */
async function varInner(t, page) {
  const graph = await api("/api/graph");
  const { nodes, file } = variableCase(graph);
  const inner = file.inside[0];
  await load(page, url, false);
  const full = async () => {
    const [pack, drawnNow] = [await packOf(page, file.id), await drawnIn(page, graph, file.id)];
    return { ok: pack?.open === true && same(drawnNow, file.kids) && (await selectedOf(page)) === inner, text: `선택 ${await selectedOf(page)}, 그린 정의 ${drawnNow.length}/${file.kids.length}개, 손잡이 "${pack?.text ?? "없음"}"` };
  };
  await palettePick(page, nodes.get(inner).name, inner);
  await waitSelected(page, inner);
  await rest(page);
  const picked = await full();
  t.check(`Mod+P로 안쪽 변수 ${inner}를 고르면 ${file.id}가 전부 펼침 단계가 된다`, picked.ok, picked.text);
  await t.shot();
  await page.keyboard.press("Alt+ArrowLeft");
  await rest(page);
  const before = await selectedOf(page);
  await page.keyboard.press("Alt+ArrowRight");
  await waitSelected(page, inner).catch(() => {});
  await rest(page);
  const again = await full();
  t.check("뒤로 갔다가 앞으로 오면 선택과 전부 펼침이 그대로다", before !== inner && again.ok, `뒤로 ${before}, 앞으로 ${again.text}`);
}

/** 변수를 읽는 함수를 골랐을 때 그 선의 말풍선과 선 위의 수를 본다. */
async function varLine(t, page) {
  const graph = await api("/api/graph");
  const { nodes, read } = variableCase(graph);
  const kinds = kindsOf([read]);
  await load(page, url, false);
  await palettePick(page, nodes.get(read.source).name, read.source);
  await waitSelected(page, read.source);
  await rest(page);
  const over = await lineOver(page, read.source, read.target, "read");
  const want = `${nodes.get(read.source).name}() → ${nodes.get(read.target).name} · ${relationWords(kinds)}`;
  t.check(
    `${read.source}를 고르면 ${nodes.get(read.target).name}로 가는 선의 말풍선 줄이 "${want}"다`,
    over?.row != null && rowText(over.row).endsWith(want) && relationWords(kinds).includes(`읽음 ${kinds.read}곳`),
    over?.row == null ? "말풍선의 줄 없음" : rowText(over.row),
  );
  const sites = COUNTED.reduce((sum, kind) => sum + (kinds[kind] ?? 0), 0);
  t.check(`선이 담은 지점 수와 선 위의 수가 ${sites}다`, over !== null && over.sites === sites && (over.weight === null ? sites === 1 : Number(over.weight) === sites), `지점 ${over?.sites}, 선 위의 수 ${over?.weight ?? "없음"}`);
  await t.shot();
}

/** 변수를 바꾸는 함수의 g 배지와 그 변수로 가는 선을 본다. --wide-url을 받으면 그 레포에서 본다. */
async function varWrite(t, page) {
  const pickedIn = async (at) => ({ at, graph: await api("/api/graph", at) });
  let { at, graph } = await pickedIn(url);
  if (variableCase(graph).write === undefined && wideUrl !== null) {
    ({ at, graph } = await pickedIn(wideUrl));
  }
  const { nodes, write } = variableCase(graph);
  if (write === undefined) {
    t.skip("변수를 바꾸는 함수에 g 배지가 달린다", `함수가 바꾸는 변수가 없다${wideUrl === null ? "(--wide-url을 주지 않았다)" : ""}`);
    return;
  }
  const names = [...new Set(graph.edges.filter((e) => e.kind === "write" && e.source === write.source).map((e) => nodes.get(e.target).name))];
  await load(page, at, false);
  await palettePick(page, nodes.get(write.source).name, write.source);
  await waitSelected(page, write.source);
  await rest(page);
  const tip = (await count(page, `${face(write.source)} .badge-global`)) === 0 ? "" : await tipOver(page, `${face(write.source)} .badge-global`);
  t.check(`${write.source}에 g 배지가 있고 말풍선이 바꾸는 변수 ${names.join(", ")}을 적는다`, tip === `모듈 변수 변경: ${names.join(", ")}을 바꾼다`, tip);
  await page.mouse.move(1, 1);
  const kinds = kindsOf([write]);
  const over = await lineOver(page, write.source, write.target, "write");
  t.check(
    `${nodes.get(write.target).name}로 가는 선의 말풍선 관계 칸이 "${relationWords(kinds)}"다`,
    over?.row?.relation === relationWords(kinds) && relationWords(kinds).includes(`바꿈 ${kinds.write}곳`),
    over === null ? "바꿈 선에 누를 점이 없다" : over.row == null ? "말풍선의 줄 없음" : rowText(over.row),
  );
  const badges = await page.evaluate(() => [...document.querySelectorAll(".node-face .badge-global")].map((badge) => badge.closest(".react-flow__node").dataset.id.replace(/#face$/, "")));
  const writers = new Set(graph.edges.filter((e) => e.kind === "write").map((e) => e.source));
  t.check("g 배지는 바꿈 선이 나가는 함수·메서드에만 달린다", badges.length > 0 && badges.every((id) => writers.has(id)), badges.join(", "));
  await t.shot();
}

/** 변수 노드의 말풍선과 커서를 올린 모양, 우클릭 메뉴, 파일의 "모두 요약" 수를 본다. */
async function varTip(t, page) {
  const graph = await api("/api/graph");
  const { nodes, file } = variableCase(graph);
  const id = file.inside.find((each) => nodes.get(each).value.text !== "") ?? file.inside[0];
  const variable = nodes.get(id);
  await load(page, url, false);
  await palettePick(page, variable.name, id);
  await waitSelected(page, id);
  await rest(page);
  const other = file.inside.find((each) => each !== id) ?? id;
  const diamond = `${node(other)} .node-diamond`;
  const before = { rect: await rectOf(page, diamond), opacity: await page.evaluate((sel) => Number(document.querySelector(sel).style.opacity), node(other)) };
  const wanted = nodes.get(other);
  const tip = await tipOver(page, `${face(other)} .node-label`);
  await page.waitForTimeout(300);
  const want = wanted.value.text === "" ? asideOf(wanted) : `${asideOf(wanted)} · ${wanted.value.text}`;
  t.check("변수 노드의 말풍선이 값의 종류·원소 수와 값의 글을 적는다", tip === want, tip);
  const after = { rect: await rectOf(page, diamond), opacity: await page.evaluate((sel) => Number(document.querySelector(sel).style.opacity), node(other)), pointed: await page.evaluate((sel) => document.querySelector(sel).classList.contains("pointed"), node(other)) };
  t.check(
    "커서를 올리면 진하기가 한 단계 오르고 마름모가 찌그러지지 않고 커진다",
    after.pointed && after.opacity >= before.opacity && after.rect.width > before.rect.width + 1 && near(after.rect.width, after.rect.height, 0.2) && near(before.rect.width, before.rect.height, 0.2),
    `불투명도 ${before.opacity} → ${after.opacity}, 마름모 ${before.rect.width.toFixed(1)}×${before.rect.height.toFixed(1)} → ${after.rect.width.toFixed(1)}×${after.rect.height.toFixed(1)}`,
  );
  await t.shot();
  await clickNode(page, other, 1, "right");
  await page.waitForTimeout(300);
  t.check("변수 노드를 우클릭해도 메뉴가 열리지 않는다", (await count(page, ".menu")) === 0);
  await page.mouse.move(1, 1);
  await page.click(`.tree-row.tree-file[data-node="${file.id}"]`, { button: "right" });
  await page.waitForSelector(".menu", { timeout: 5_000 }).catch(() => {});
  const items = await page.evaluate(() => [...document.querySelectorAll(".menu .menu-item")].map((item) => item.textContent));
  const summarized = 1 + definedIn(graph, file.id).filter((n) => !n.test && n.kind !== "variable").length;
  t.check(
    `${file.id}의 "이 파일과 안에 든 정의 모두 요약"의 수 ${summarized}는 변수를 세지 않는다`,
    items.includes(`이 파일과 안에 든 정의 모두 요약 (${summarized}개)`),
    items.join(" / "),
  );
  await page.keyboard.press("Escape");
}

/** 경로 탐색 창의 검색 칸과 정보 패널의 출발로·도착으로 버튼이 변수를 받지 않는지 본다. */
async function varFinder(t, page) {
  const graph = await api("/api/graph");
  const { nodes, file, read } = variableCase(graph);
  const variable = nodes.get(file.inside[0]);
  await load(page, url, false);
  await openFinder(page);
  if ((await count(page, '.finder-field[data-end="from"] .finder-input')) === 0) {
    await page.click('.finder-field[data-end="from"] .finder-value');
  }
  await page.click('.finder-field[data-end="from"] .finder-input');
  await page.keyboard.type(variable.name);
  await page.waitForTimeout(400);
  const hits = await page.evaluate(() => [...document.querySelectorAll(".finder-hit")].map((hit) => hit.dataset.node));
  t.check(
    `출발 칸에 ${variable.name}를 넣으면 검색 결과에 변수가 없다`,
    hits.every((id) => nodes.get(id)?.kind !== "variable"),
    `결과 ${hits.length}개: ${hits.slice(0, 5).join(", ")}`,
  );
  await t.shot();
  await page.keyboard.press("Escape");
  await palettePick(page, variable.name, variable.id);
  await waitSelected(page, variable.id);
  await rest(page);
  const onVariable = await count(page, ".info-panel-end");
  await palettePick(page, nodes.get(read.source).name, read.source);
  await waitSelected(page, read.source);
  await rest(page);
  t.check("변수를 고른 정보 패널에는 출발로·도착으로 버튼이 없고 함수를 고르면 있다", onVariable === 0 && (await count(page, ".info-panel-end")) === 2, `변수 ${onVariable}개, 함수 ${await count(page, ".info-panel-end")}개`);
}

/** 코드 뷰어에서 변수 이름을 Mod+클릭하면 그 변수 노드를 고르는지 본다. */
async function varJump(t, page) {
  const graph = await api("/api/graph");
  const { nodes, read } = variableCase(graph);
  const name = nodes.get(read.target).name;
  await load(page, url, false);
  await palettePick(page, nodes.get(read.source).name, read.source);
  await waitSelected(page, read.source);
  await rest(page);
  await page.waitForFunction((text) => document.querySelector(".info-panel .monaco-editor .view-lines")?.textContent.includes(text), name, { timeout: 10_000 }).catch(() => {});
  const word = await callRect(page, name);
  if (word === null) {
    t.check(`코드 뷰어에 ${name}를 읽는 줄이 보인다`, false, "보이지 않는다");
    return;
  }
  await page.keyboard.down(MOD);
  await page.mouse.move(word.x + word.width / 2 - 6, word.y + word.height / 2);
  await page.mouse.move(word.x + word.width / 2, word.y + word.height / 2, { steps: 3 });
  await page.waitForSelector(".info-panel .code-link", { timeout: 3_000 }).catch(() => {});
  await page.mouse.click(word.x + word.width / 2, word.y + word.height / 2);
  await page.keyboard.up(MOD);
  await waitSelected(page, read.target).catch(() => {});
  await page.mouse.move(5, 5);
  await rest(page);
  t.check(`코드 뷰어에서 ${name}를 Mod+클릭하면 변수 노드 ${read.target}를 고른다`, (await selectedOf(page)) === read.target, `${await selectedOf(page)}`);
  const facts = await factsOf(page);
  t.check("정보 패널이 그 변수를 보인다", facts.name === name && same(facts.chips, ["변수"]), `${facts.path}${facts.name} [${facts.chips.join(", ")}]`);
}

const SCENARIOS = [
  ["open", open],
  ["file", file],
  ["function", functionScenario],
  ["trail-root", trailRoot],
  ["body", body],
  ["panel", panel],
  ["code-scope", codeScope],
  ["hover", hover],
  ["edge", edge],
  ["badge-tip", badgeTip],
  ["entry-mark", entryMark],
  ["entry", entry],
  ["menu", menu],
  ["folder-sum", folderSum],
  ["summary-queue", summaryQueue],
  ["keys-code", keysCode],
  ["tips", tips],
  ["minimap", minimap],
  ["region", region],
  ["folder", folder],
  ["folder-tint", folderTint],
  ["badge-lines", badgeLines],
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
  ["reload-key", reloadKey],
  ["unused", unusedScenario],
  ["finder-overlay", finderOverlay],
  ["overlay-dark", overlayDark],
  ["cycles", cyclesScenario],
  ["cycles-change", cyclesChange],
  ["cycles-pin", cyclesPin],
  ["start", start],
  ["arranging", arranging],
  ["node-hover", nodeHover],
  ["hover-step", hoverStep],
  ["node-grow", nodeGrow],
  ["dim", dim],
  ["merge", merge],
  ["merge-out", mergeOut],
  ["merge-hover", mergeHover],
  ["merge-click", mergeClick],
  ["merge-select", mergeSelect],
  ["merge-pin", mergePin],
  ["badge", badge],
  ["pack-place", packPlace],
  ["pack-file", packFile],
  ["pack-flow", packFlow],
  ["pack-folder", packFolder],
  ["pack-find", packFind],
  ["pack-pin", packPin],
  ["pack-overlay", packOverlay],
  ["pack-history", packHistory],
  ["pack-toggle", packToggle],
  ["inner-pick", innerPick],
  ["lanes", lanes],
  ["numbers", numbers],
  ["overlap", overlap],
  ["line-folder", lineFolder],
  ["line-bubble", lineBubble],
  ["panel-head", panelHead],
  ["facts-list", factsList],
  ["motion", motion],
  ["folder-hold", folderHold],
  ["progress", progress],
  ["progress-failed", progressFailed],
  ["stale", staleScenario],
  ["var-file", varFile],
  ["var-external", varExternal],
  ["var-select", varSelect],
  ["var-inner", varInner],
  ["var-line", varLine],
  ["var-write", varWrite],
  ["var-tip", varTip],
  ["var-finder", varFinder],
  ["var-jump", varJump],
];

/** 3단계 시나리오. 스크린샷 이름이 s3-로 시작한다. */
const STAGE3 = new Set(SCENARIOS.slice(SCENARIOS.findIndex(([name]) => name === "finder-open")).map(([name]) => name));
/** 4단계 시나리오. 스크린샷 이름이 s4-로 시작한다. */
const STAGE4 = new Set([
  "start",
  "arranging",
  "node-hover",
  "hover-step",
  "node-grow",
  "dim",
  "merge",
  "merge-out",
  "merge-hover",
  "merge-click",
  "merge-select",
  "merge-pin",
  "badge",
  "pack-place",
  "pack-file",
  "pack-flow",
  "pack-folder",
  "pack-find",
  "pack-pin",
  "pack-overlay",
  "pack-history",
  "pack-toggle",
  "inner-pick",
  "lanes",
  "numbers",
  "overlap",
  "line-folder",
  "line-bubble",
  "panel-head",
  "facts-list",
  "motion",
  "folder-hold",
  "progress",
  "progress-failed",
  "stale",
]);
/** 모듈 변수 노드의 시나리오. 스크린샷 이름이 mv-로 시작한다. */
const VARIABLES = new Set(SCENARIOS.filter(([name]) => name.startsWith("var-")).map(([name]) => name));
/** 순환이 있는 고정 레포를 연 서버에서 도는 시나리오 */
const CYCLE = new Set(["cycles", "cycles-change", "cycles-pin"]);

// ── 실행 ─────────────────────────────────────────────────────────

async function run(browser, name, scenario) {
  if (CYCLE.has(name) && cycleUrl === null) {
    console.log(`[${name}]\n  건너뜀  순환이 있는 고정 레포로 연 화면 — --cycle-url을 주지 않았다`);
    return [{ label: name, ok: null, actual: "" }];
  }
  if ((name === "reload" || name === "reload-key" || name === "stale") && reloadUrl === null) {
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
  const path = join(OUT, `${VARIABLES.has(name) ? "mv" : STAGE4.has(name) ? "s4" : STAGE3.has(name) ? "s3" : "s2"}-${name}.png`);
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
