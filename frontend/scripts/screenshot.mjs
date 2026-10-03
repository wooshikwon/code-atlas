// 구조 뷰를 밝은 화면, 어두운 화면, 함수 하나를 고른 초점 상태 세 장으로 찍는다.
// 사용: node scripts/screenshot.mjs [주소] [고를 노드 id]
// 기본 주소는 http://127.0.0.1:8766, 기본 노드는 sync-engine의 arbiter:_rebuild_note_sections다.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:8766";
const focusId = process.argv[3] ?? "arbiter:_rebuild_note_sections";
const out = join(homedir(), "data", "code-atlas", "screenshots");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

async function open(colorScheme) {
  const page = await browser.newPage({ colorScheme, viewport: { width: 1600, height: 1000 } });
  page.on("console", (message) => message.text().startsWith("layout ") && console.log(`${colorScheme}: ${message.text()}`));
  page.on("pageerror", (error) => console.error(`${colorScheme}: ${error.message}`));
  await page.goto(url);
  await page.waitForSelector(".react-flow__node", { timeout: 120_000 });
  await page.waitForTimeout(800);
  return page;
}

for (const scheme of ["light", "dark"]) {
  const page = await open(scheme);
  await page.screenshot({ path: join(out, `u5-${scheme}.png`) });
  if (scheme === "light") {
    await page.locator(`.react-flow__node[data-id="${focusId}"]`).click({ force: true });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(out, "u5-focus.png") });
  }
  await page.close();
}

await browser.close();
console.log(`저장: ${out}/u5-{light,dark,focus}.png`);
