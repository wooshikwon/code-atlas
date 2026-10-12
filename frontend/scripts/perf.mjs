// 떠 있는 서버의 화면에서 처음 배치, 폴더 하나 펼침, 노드 하나 선택의 시간과 화면 이동·확대의 프레임 간격을 재서 JSON 한 줄로 출력한다.
// 사용: node scripts/perf.mjs <주소> [--expand 폴더id] [--pick 검색어] [--compare 기준,대상] [--shot 경로 접두어]
// 떠 있는 서버의 주소를 받고 서버를 띄우지 않는다. --expand는 처음 화면에서 그 id의 폴더를 파일트리의 폴더 행으로 펼치고,
// --pick은 새로 연 화면에서 Mod+P 팔레트에 검색어를 넣어 첫 행을 고르고 그 노드가 그려지기를 기다린다. 화면마다 아래 값을 낸다.
//   ms        조작부터 배치 움직임이 끝나 화면이 멈추기까지의 시간에서 멈춤을 확인하는 시간(QUIET)을 뺀 값
//   elk_ms    그 조작이 보낸 ELK worker 요청마다 응답이 오기까지의 시간
//   arranging 느린 배치 표시(.arranging)가 떴는지
//   boxes, lines, trunks, zoom  보이는 상자, 선, 줄기의 수와 확대 비율
//   pan, wheel  화면을 끌어 옮기는 2초와 휠로 확대·축소하는 2초의 프레임 간격(p50·p95 ms, fps)
//   fly       --pick이 고른 노드로 가는 화면 이동(.graph[data-flying])의 프레임 간격과 걸린 시간(ms)
// --compare는 새로 연 화면에서 비교 창을 펴 두 줄(커밋 해시의 앞 글자나 worktree)을 골라 비교를 켠다. compare에 아래 값을 낸다.
//   window_ms  비교 버튼을 누른 때부터 커밋 그래프의 첫 줄이 보이기까지
//   stat_ms    둘째 줄을 누른 때부터 아래 줄에 줄 수가 적히기까지
//   response_ms 확인을 누른 때부터 POST /api/compare의 응답이 오기까지
//   on         응답이 온 때부터 비교의 배치가 멈추기까지(ms)와 그 화면의 값, pan, wheel
//   expand     --expand를 함께 주면 비교가 켜진 채 그 폴더를 펼친 화면의 값
//   hover      커서를 그래프 영역 위로 2초 동안 가로질러 움직이는 동안의 프레임 간격
//   gone, dots 흐린 단계로 그린 노드와 빨강 점의 수
// first_box_ms는 페이지를 열기 시작한 때부터 첫 상자가 그려지기까지다. 요약을 만드는 요청은 서버로 보내지 않는다.
import { chromium } from "playwright";

const VIEW = { width: 1700, height: 1000 };
const MOD = process.platform === "darwin" ? "Meta" : "Control";
/** 노드 수와 화면 위치가 이 시간 동안 그대로면 화면이 멈춘 것으로 본다. */
const QUIET = 500;

const [url, ...rest] = process.argv.slice(2);
const option = (name) => (rest.includes(name) ? (rest[rest.indexOf(name) + 1] ?? null) : null);
const [expand, query, shot] = [option("--expand"), option("--pick"), option("--shot")];
const compare = option("--compare")?.split(",") ?? null;
if (url === undefined || url.startsWith("--")) {
  console.error("사용: node scripts/perf.mjs <주소> [--expand 폴더id] [--pick 검색어] [--compare 기준,대상] [--shot 경로 접두어]");
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
  window.__perfFlight = () =>
    new Promise((resolve) => {
      const gaps = [];
      const began = performance.now();
      let last = null;
      const tick = (now) => {
        const flying = document.querySelector(".graph[data-flying]") !== null;
        if (flying && last !== null) {
          gaps.push(now - last);
        }
        if ((!flying && last !== null) || now - began > 60_000) {
          resolve(gaps);
          return;
        }
        last = flying ? now : null;
        requestAnimationFrame(tick);
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
      const busy = graph === null || graph.hasAttribute("data-moving") || graph.hasAttribute("data-flying") || document.querySelector(".arranging") !== null;
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
  const flight = page.evaluate(() => window.__perfFlight());
  out.pick = {
    query,
    id: picked,
    ...(await step(page, "pick", async () => {
      await page.click(".palette-option");
      await page.waitForFunction((id) => document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`) !== null, picked, { timeout: 240_000 });
    })),
  };
  const gaps = await flight;
  out.pick.fly = gaps.length === 0 ? null : { ...stat(gaps), ms: Math.round(gaps.reduce((sum, gap) => sum + gap, 0)) };
  await page.context().close();
}
if (compare !== null) {
  const page = await fresh(browser);
  await open(page, false);
  await page.waitForSelector(".compare-button", { timeout: 30_000 });
  let started = Date.now();
  await page.click(".compare-button");
  await page.waitForSelector(".compare-row", { timeout: 30_000 });
  const windowMs = Date.now() - started;
  await page.waitForFunction(() => document.querySelector(".compare-bar .compare-lines, .compare-bar .compare-hint") !== null, null, { timeout: 30_000 });
  while ((await page.locator('.compare-row[aria-selected="true"]').count()) > 0) {
    await page.locator('.compare-row[aria-selected="true"]').first().click();
  }
  let statMs = 0;
  for (const id of compare) {
    const row = page.locator(id === "worktree" ? ".compare-row[data-worktree]" : `.compare-row[data-id^="${id}"]`).first();
    // 줄은 보이는 것만 그려지므로 목록을 맨 위로 올린 뒤 그 커밋의 줄이 그려질 때까지 내린다.
    for (let i = 0; i < 2_000 && (i === 0 || (await row.count()) === 0); i += 1) {
      await page.evaluate((top) => {
        let list = document.querySelector(".compare-row").parentElement;
        while (list !== null && list.scrollHeight <= list.clientHeight) {
          list = list.parentElement;
        }
        if (list !== null) {
          list.scrollTop = top ? 0 : list.scrollTop + 240;
        }
      }, i === 0);
      await page.waitForTimeout(30);
    }
    started = Date.now();
    await row.click();
    if (id === compare[1]) {
      await page.waitForSelector(".compare-bar .compare-lines", { timeout: 30_000 });
      statMs = Date.now() - started;
    }
  }
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/compare", { timeout: 600_000 });
  started = Date.now();
  let responseMs = 0;
  const on = await step(page, "compare", async () => {
    await page.click(".compare-confirm");
    await (await answered).finished();
    responseMs = Date.now() - started;
    started = Date.now();
    await page.waitForFunction(() => document.querySelector(".graph")?.dataset.overlay === "compare", null, { timeout: 60_000 });
  });
  out.compare = { picks: compare, window_ms: windowMs, stat_ms: statMs, response_ms: responseMs, on: { ...on, ms: on.ms - responseMs } };
  if (expand !== null) {
    out.compare.expand = {
      id: expand,
      ...(await step(page, "compare-expand", async () => {
        await page.click(`.tree-row.tree-dir[data-node="${expand}"]`);
        await page.waitForSelector(`.react-flow__node[data-id="${expand}"] > .node-region`, { timeout: 240_000 });
      })),
    };
  }
  const frames = page.evaluate(() => window.__perfFrames(2000));
  for (let i = 0; i < 80; i += 1) {
    await page.mouse.move(300 + ((i * 17) % 760), 150 + ((i * 29) % 700));
    await page.waitForTimeout(25);
  }
  out.compare.hover = stat(await frames);
  out.compare.gone = await page.evaluate(() => document.querySelectorAll('.react-flow__node:not([data-id$="#face"])[data-gone], .react-flow__node:not([data-id$="#face"]) > [data-gone]').length);
  out.compare.dots = await page.evaluate(() => document.querySelectorAll(".react-flow .edge-gone").length);
  await page.context().close();
}
await browser.close();
console.log(JSON.stringify(out));
