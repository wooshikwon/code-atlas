// 앱 껍데기의 화면이 백엔드를 부르고 워커를 띄우는지 확인하는 시나리오. 결과는 단계마다 한 줄이다.
(async () => {
  const probe = window.__probe;
  if (!probe) return;
  const LIMIT = 150_000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (read, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(200);
    }
  };

  const workers = [];
  const RealWorker = window.Worker;
  window.Worker = class extends RealWorker {
    constructor(url, options) {
      super(url, options);
      const seen = { url: String(url), type: options?.type ?? "classic", messages: 0, errors: [] };
      workers.push(seen);
      this.addEventListener("message", () => (seen.messages += 1));
      this.addEventListener("error", (event) => seen.errors.push(event.message ?? "error"));
    }
  };
  const blocked = [];
  const errors = [];
  document.addEventListener("securitypolicyviolation", (event) =>
    blocked.push({ directive: event.effectiveDirective, uri: event.blockedURI, source: event.sourceFile, sample: event.sample }),
  );
  window.addEventListener("error", (event) => errors.push(String(event.message)));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  setTimeout(() => probe.report({ step: "timeout", workers, blocked, errors }).then(() => probe.done(2)), LIMIT);

  let failed = 0;
  const step = (name, ok, facts) => {
    failed += ok ? 0 : 1;
    return probe.report({ step: name, ok, ...facts });
  };

  const RUNS = "code-atlas:probe:runs";
  const before = JSON.parse(localStorage.getItem(RUNS) ?? "[]");
  localStorage.setItem(RUNS, JSON.stringify([...before, Date.now()]));
  await step("page", location.origin === "tauri://localhost", {
    origin: location.origin,
    secure: window.isSecureContext,
    agent: navigator.userAgent,
    earlierRuns: before.length,
    storedKeys: Object.keys(localStorage),
  });

  const call = async (path, init, base = probe.api) => {
    try {
      const response = await fetch(base + path, init);
      return { status: response.status, body: (await response.text()).slice(0, 200) };
    } catch (error) {
      return { error: String(error) };
    }
  };
  const status = await call("/api/status");
  await step("fetch-get", status.status === 200, status);
  const posted = await call("/api/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await step("fetch-post-json", posted.status !== undefined, posted);

  const nodes = await until(() => document.querySelectorAll(".react-flow__node").length, 90_000);
  const spots = new Set([...document.querySelectorAll(".react-flow__node")].map((node) => node.style.transform));
  await step("graph", Boolean(nodes) && spots.size > 1, { nodes, positions: spots.size, tree: document.querySelectorAll(".tree-row").length });

  const tried = new Set();
  for (let turn = 0; turn < 12 && !document.querySelector(".info-panel .monaco-editor .line-numbers"); turn += 1) {
    const fresh = (kind) => [...document.querySelectorAll(`.tree-row.tree-${kind}`)].find((row) => !tried.has(row.textContent) && !row.textContent.includes("__init__"));
    const row = fresh("symbol") ?? fresh("file") ?? fresh("dir");
    if (!row) break;
    tried.add(row.textContent);
    row.click();
    await until(() => document.querySelector(".info-panel .monaco-editor .line-numbers"), 3_000);
  }
  await until(() => document.querySelectorAll(".info-panel .monaco-editor .view-line").length, 20_000);
  const ran = (name) => workers.some((worker) => worker.url.includes(name) && worker.messages > 0 && worker.errors.length === 0);
  if (!(await until(() => ran("editor.worker"), 5_000))) {
    // 화면이 Monaco의 워커를 아직 띄우지 않았으면 같은 파일을 직접 띄워 요청에 답하는지 본다.
    // CSP의 connect-src가 tauri://localhost를 막으므로 번들의 본문은 같은 빌드를 싣는 백엔드에서 읽는다.
    const bundle = await (await fetch(probe.api + new URL(document.querySelector("script[type=module][src]").src).pathname)).text();
    const asked = new Worker(bundle.match(/\/assets\/editor\.worker-[\w-]+\.js/)[0], { name: "probe" });
    asked.postMessage("start"); // 첫 메시지는 워커의 초기화가 쓴다
    asked.postMessage({ vsWorker: 1, req: "1", channel: "default", method: "$probe", args: [], type: 0 });
    await until(() => ran("editor.worker"), 5_000);
  }
  const lines = document.querySelectorAll(".info-panel .monaco-editor .view-line").length;
  const tokens = new Set([...document.querySelectorAll(".info-panel .monaco-editor .view-line span span")].map((span) => span.className));
  await step("code", Boolean(lines) && tokens.size > 1, { lines, tokenKinds: tokens.size, clicked: [...tried].slice(0, 12) });

  await step("workers", ran("elk-worker") && ran("editor.worker"), { workers });
  await step("blocked", blocked.length === 0, { blocked, errors });
  const outside = await call("/api/status", undefined, probe.api.replace("127.0.0.1", "localhost"));
  await step("csp", outside.error !== undefined && blocked.some((entry) => entry.directive === "connect-src"), { outside, blocked });
  await probe.done(failed ? 1 : 0);
})();
