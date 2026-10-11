// 떠 있는 서버의 화면에서 처음 배치, 폴더 하나 펼침, 노드 하나 선택의 시간과 화면 이동·확대의 프레임 간격을 재서 JSON 한 줄로 출력한다.
// 사용: node scripts/perf.mjs <주소> [--expand 폴더id] [--pick 검색어] [--shot 경로 접두어]
// 떠 있는 서버의 주소를 받고 서버를 띄우지 않는다. --expand는 처음 화면에서 그 id의 폴더를 파일트리의 폴더 행으로 펼치고,
// --pick은 새로 연 화면에서 Mod+P 팔레트에 검색어를 넣어 첫 행을 고르고 그 노드가 그려지기를 기다린다. 화면마다 아래 값을 낸다.
//   ms        조작부터 배치 움직임이 끝나 화면이 멈추기까지의 시간에서 멈춤을 확인하는 시간(QUIET)을 뺀 값
//   elk_ms    그 조작이 보낸 ELK worker 요청마다 응답이 오기까지의 시간
//   arranging 느린 배치 표시(.arranging)가 떴는지
//   boxes, lines, trunks, zoom  보이는 상자, 선, 줄기의 수와 확대 비율
//   pan, wheel  화면을 끌어 옮기는 2초와 휠로 확대·축소하는 2초의 프레임 간격(p50·p95 ms, fps)
// first_box_ms는 페이지를 열기 시작한 때부터 첫 상자가 그려지기까지다. 요약을 만드는 요청은 서버로 보내지 않는다.
import { chromium } from "playwright";

const VIEW = { width: 1700, height: 1000 };
const MOD = process.platform === "darwin" ? "Meta" : "Control";
/** 노드 수와 화면 위치가 이 시간 동안 그대로면 화면이 멈춘 것으로 본다. */
const QUIET = 500;

const [url, ...rest] = process.argv.slice(2);
const option = (name) => (rest.includes(name) ? (rest[rest.indexOf(name) + 1] ?? null) : null);
const [expand, query, shot] = [option("--expand"), option("--pick"), option("--shot")];
if (url === undefined || url.startsWith("--")) {
  console.error("사용: node scripts/perf.mjs <주소> [--expand 폴더id] [--pick 검색어] [--shot 경로 접두어]");
  process.exit(2);
}

/** 페이지가 만드는 worker의 layout 요청마다 응답까지의 시간을 window.__perfElk에 담고, 프레임 간격을 재는 함수를 둔다. */
function instrument() {
  window.__perfElk = [];
  window.__perfArranging = false;
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(script, options) {
      super(script, options);
      const sent = new Map();
      const post = this.postMessage.bind(this);
      this.postMessage = (message, ...more) => {
        if (message?.cmd === "layout") {
          sent.set(message.id, performance.now());
        }
        return post(message, ...more);
      };
      this.addEventListener("message", (event) => {
        const started = sent.get(event.data?.id);
        if (started !== undefined) {
          sent.delete(event.data.id);
          window.__perfElk.push(Math.round(performance.now() - started));
        }
      });
    }
  };
  window.__perfFrames = (ms) =>
    new Promise((resolve) => {
      const gaps = [];
      const began = performance.now();
      let last = began;
      const tick = (now) => {
        gaps.push(now - last);
        last = now;
        if (now - began < ms) {
          requestAnimationFrame(tick);
        } else {
          resolve(gaps);
        }
      };
      requestAnimationFrame(tick);
    });
  new MutationObserver(() => {
    window.__perfArranging ||= document.querySelector(".arranging") !== null;
  }).observe(document, { childList: true, subtree: true });
}

async function fresh(browser) {
  const context = await browser.newContext({ viewport: VIEW, colorScheme: "light" });
  await context.route((at) => at.pathname === "/api/summary" || at.pathname === "/api/explanation", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await context.addInitScript(instrument);
  return context.newPage();
}

/** 배치 움직임과 화면 이동이 끝나 노드 수와 화면 위치가 QUIET 동안 그대로일 때까지 기다린다. */
async function settle(page) {
  await page.waitForFunction(
    (ms) => {
      const graph = document.querySelector(".graph");
      const busy = graph === null || graph.hasAttribute("data-moving") || document.querySelector(".arranging") !== null;
      const now = [busy, document.querySelector(".react-flow__viewport")?.style.transform, document.querySelectorAll(".react-flow__node").length].join("|");
      if (window.__perfSeen !== now) {
        window.__perfSeen = now;
        window.__perfSince = performance.now();
        return false;
      }
      return !busy && performance.now() - window.__perfSince >= ms;
    },
    QUIET,
    { polling: 50, timeout: 240_000 },
  );
}

function stat(gaps) {
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (share) => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))].toFixed(1));
  return { p50: at(0.5), p95: at(0.95), fps: Number((1000 / (sorted.reduce((sum, gap) => sum + gap, 0) / sorted.length)).toFixed(1)) };
}

/** 그래프 영역의 빈 곳을 잡아 2초 동안 끌어 옮기며 프레임 간격을 잰다. */
async function pan(page) {
  const frames = page.evaluate(() => window.__perfFrames(2000));
  await page.mouse.move(700, 500);
  await page.mouse.down();
  for (let i = 0; i < 60; i += 1) {
    await page.mouse.move(700 + Math.sin(i / 8) * 300, 500 + Math.cos(i / 8) * 200);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  return stat(await frames);
}

/** 2초 동안 휠로 확대했다가 같은 양만큼 축소하며 프레임 간격을 잰다. */
async function wheel(page) {
  const frames = page.evaluate(() => window.__perfFrames(2000));
  await page.mouse.move(700, 500);
  for (let i = 0; i < 40; i += 1) {
    await page.mouse.wheel(0, i < 20 ? -40 : 40);
    await page.waitForTimeout(40);
  }
  return stat(await frames);
}

const seen = (page) =>
  page.evaluate(() => ({
    boxes: document.querySelectorAll('.react-flow__node:not([data-id$="#face"])').length,
    lines: document.querySelectorAll(".react-flow__edge").length - document.querySelectorAll(".edge-trunk").length,
    trunks: document.querySelectorAll(".edge-trunk").length,
    zoom: Number(Number(/scale\(([^)]+)\)/.exec(document.querySelector(".react-flow__viewport")?.style.transform ?? "")?.[1]).toFixed(3)),
  }));

/** act를 조작한 뒤 화면이 멈추기까지의 시간과 그 화면의 값을 잰다. motion이 거짓이면 프레임 간격을 재지 않는다. */
async function step(page, name, act, motion = true) {
  const before = await page.evaluate(() => {
    window.__perfArranging = false;
    window.__perfSeen = undefined;
    return window.__perfElk?.length ?? 0;
  });
  const started = Date.now();
  await act();
  await settle(page);
  const ms = Date.now() - started - QUIET;
  const measured = {
    ms,
    elk_ms: await page.evaluate((from) => window.__perfElk.slice(from), before),
    arranging: await page.evaluate(() => window.__perfArranging),
    ...(await seen(page)),
  };
  if (shot !== null) {
    await page.screenshot({ path: `${shot}-${name}.png` });
  }
  if (motion) {
    measured.pan = await pan(page);
    await settle(page);
    measured.wheel = await wheel(page);
    await settle(page);
  }
  return measured;
}

/** 페이지를 열어 첫 상자가 그려지기까지의 시간(ms)과 처음 화면의 값을 돌려준다. */
async function open(page, motion = true) {
  let firstBox = 0;
  const first = await step(
    page,
    "first",
    async () => {
      const started = Date.now();
      await page.goto(url, { waitUntil: "commit" });
      await page.waitForSelector(".react-flow__node", { timeout: 240_000 });
      firstBox = Date.now() - started;
    },
    motion,
  );
  return { firstBox, first };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const out = { url };
{
  const page = await fresh(browser);
  const { firstBox, first } = await open(page);
  out.first_box_ms = firstBox;
  out.first = first;
  if (expand !== null) {
    out.expand = {
      id: expand,
      ...(await step(page, "expand", async () => {
        await page.click(`.tree-row.tree-dir[data-node="${expand}"]`);
        await page.waitForSelector(`.react-flow__node[data-id="${expand}"] > .node-region`, { timeout: 240_000 });
      })),
    };
  }
  await page.context().close();
}
if (query !== null) {
  const page = await fresh(browser);
  await open(page, false);
  await page.keyboard.press(`${MOD}+p`);
  await page.waitForSelector(".palette-input", { timeout: 5_000 });
  await page.keyboard.type(query);
  await page.waitForSelector(".palette-option", { timeout: 5_000 });
  const picked = await page.evaluate(() => document.querySelector(".palette-option")?.dataset.node ?? null);
  out.pick = {
    query,
    id: picked,
    ...(await step(page, "pick", async () => {
      await page.click(".palette-option");
      await page.waitForFunction((id) => document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`) !== null, picked, { timeout: 240_000 });
    })),
  };
  await page.context().close();
}
await browser.close();
console.log(JSON.stringify(out));
