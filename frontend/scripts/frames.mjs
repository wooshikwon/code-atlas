// `frames.js`의 시나리오를 Chromium이나 앱 창(WKWebView)에서 돌려 단계마다 JSON 한 줄을 출력한다.
// 사용:
//   node scripts/frames.mjs chromium <주소> --plan <plan.json> [--view 1440x872] [--headless]
//   node scripts/frames.mjs app <Atlas.app 경로> --plan <plan.json> --home <HOME으로 줄 폴더> [--path <앱에 줄 PATH>]
// plan.json은 `frames.js`가 읽는 값이다. 앱은 `--features probe`로 빌드한 것이어야 하고, plan의 repo.path를 앱이 연다.
// 앱은 `open -n`으로 띄워 창이 맨 앞에 오게 한다. 창이 가려지면 WKWebView가 타이머와 그리기를 늦추므로, 단계마다 적히는
// visible·focused와 idle(가만히 있을 때의 프레임 간격)이 정상인 실행만 쓴다. 앱에는 --home, --path, CODE_ATLAS_NO_CLAUDE=1만 넘긴다.
// Chromium은 CHROMIUM_PATH의 실행 파일을 쓰고, 창을 띄워(GPU로 그리게) 화면 배율 2로 연다.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, target, ...rest] = process.argv.slice(2);
const option = (name) => (rest.includes(name) ? (rest[rest.indexOf(name) + 1] ?? null) : null);
if (!["chromium", "app"].includes(mode) || target === undefined || option("--plan") === null) {
  console.error("사용: node scripts/frames.mjs chromium <주소> --plan <plan.json> [--view 폭x높이] [--headless]\n      node scripts/frames.mjs app <Atlas.app> --plan <plan.json> --home <폴더> [--path <PATH>]");
  process.exit(2);
}
const plan = JSON.parse(readFileSync(option("--plan"), "utf8"));
const scenario = `window.__framesPlan = ${JSON.stringify(plan)};\n${readFileSync(join(dirname(fileURLToPath(import.meta.url)), "frames.js"), "utf8")}`;

if (mode === "chromium") {
  const { chromium } = await import("playwright");
  const [width, height] = (option("--view") ?? "1440x872").split("x").map(Number);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: rest.includes("--headless") });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: "light" });
  await context.route((at) => at.pathname === "/api/summary" || at.pathname === "/api/explanation", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  const page = await context.newPage();
  const done = new Promise((finish) =>
    page.exposeFunction("__framesOut", (line) => {
      console.log(line);
      if (JSON.parse(line).step === "done") finish();
    }),
  );
  await page.addInitScript(scenario);
  await page.goto(target);
  await page.bringToFront();
  await done;
  await browser.close();
} else {
  const home = option("--home");
  if (home === null) {
    console.error("--home이 필요하다");
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), "atlas-frames-"));
  const out = join(dir, "out.jsonl");
  const script = join(dir, "scenario.js");
  writeFileSync(script, scenario);
  writeFileSync(out, "");
  const env = {
    HOME: resolve(home),
    CFFIXED_USER_HOME: resolve(home),
    CODE_ATLAS_NO_CLAUDE: "1",
    PATH: option("--path") ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    CODE_ATLAS_PROBE: out,
    CODE_ATLAS_PROBE_SCRIPT: script,
  };
  spawn("/usr/bin/open", ["-n", ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), resolve(target)], { stdio: "inherit" });
  let printed = 0;
  const limit = Date.now() + (plan.limit ?? 900_000) + 60_000;
  for (;;) {
    await new Promise((wait) => setTimeout(wait, 500));
    const lines = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : [];
    lines.slice(printed).forEach((line) => console.log(line));
    printed = lines.length;
    if (lines.some((line) => line.includes('"step":"done"')) || Date.now() > limit) break;
  }
  // 시나리오가 `probe.done`으로 앱을 끝낸다. 시간 안에 끝나지 않았으면 이 실행 파일로 뜬 프로세스만 끝낸다.
  if (Date.now() > limit) {
    try {
      execFileSync("/usr/bin/pkill", ["-f", join(resolve(target), "Contents/MacOS/")]);
    } catch {}
    process.exit(1);
  }
}
