// 앱 껍데기가 백엔드를 띄우고, 레포를 열고 바꾸고, 멈춘 백엔드를 다시 띄우는지 확인하는 시나리오. 결과는 단계마다 한 줄이다.
// 값은 이 파일 앞에 붙인 `window.__plan`에서 읽는다: { first: {path, python?}, second: {path, python?}, rect?: [x, y, w, h],
// end: "done" | "close" | "stay", only?: "window" | "first" }. 대화상자는 누를 수 없으므로 dialog 플러그인의 `open` 응답을 여기서 대신 준다.
// 화면이 레포를 열 때마다 페이지를 다시 읽으므로 어디까지 했는지를 sessionStorage에 둔다.
(async () => {
  const probe = window.__probe;
  const plan = window.__plan;
  if (!probe || !plan) return;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (read, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(200);
    }
  };
  const kept = (key, value) => (value === undefined ? JSON.parse(sessionStorage.getItem(`probe:${key}`) ?? "null") : sessionStorage.setItem(`probe:${key}`, JSON.stringify(value)));
  const step = async (name, ok, facts) => {
    if (!ok) kept("failed", true);
    await probe.report({ step: name, ok, ...facts });
  };
  const finish = async () => {
    const code = kept("failed") ? 1 : 0;
    if (plan.end === "stay") return probe.report({ step: "stay", code });
    await probe.report({ step: "end", code, how: plan.end });
    return plan.end === "close" ? probe.close() : probe.done(code);
  };
  const blocked = [];
  document.addEventListener("securitypolicyviolation", (event) => blocked.push({ directive: event.effectiveDirective, uri: event.blockedURI }));
  setTimeout(() => probe.report({ step: "timeout", stage: kept("stage"), blocked }).then(() => probe.done(2)), plan.limit ?? 400_000);

  // Tauri의 `invoke`는 바꿔 쓰지 못하므로 그 아래의 `fetch`에서 dialog 플러그인의 요청만 가로챈다. 이 시나리오에서는 실제 대화상자가 뜨지 않는다.
  const answers = [];
  const send = window.fetch.bind(window);
  window.fetch = (input, init) =>
    decodeURIComponent(String(input)).endsWith("/plugin:dialog|open")
      ? Promise.resolve(new Response(JSON.stringify(answers.shift() ?? null), { headers: { "Content-Type": "application/json", "Tauri-Response": "ok" } }))
      : send(input, init);
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const backend = () => invoke("backend_state");
  const text = (selector) => document.querySelector(selector)?.textContent ?? null;
  const called = (url) => performance.getEntriesByType("resource").filter((entry) => entry.name.startsWith(`${url}/api/`)).length;
  const graph = (ms) => until(() => document.querySelectorAll(".react-flow__node").length, ms);
  /** 레포 열기 화면에서 폴더를 고른다. 인터프리터를 묻는 창이 뜨면 파일 고르기로 답한다. */
  const open = async (target) => {
    answers.push(target.path);
    document.querySelector(".welcome-pick").click();
    if (target.python) {
      const title = await until(() => text(".ask-title"), 20_000);
      await probe.report({ step: "ask-python", ok: Boolean(title), title });
      answers.push(target.python);
      document.querySelector(".ask-buttons .toolbar-button").click();
    }
  };

  await until(() => document.readyState !== "loading", 10_000);
  const stage = kept("stage") ?? 0;
  if (stage === 0) {
    await step("page", location.origin === "tauri://localhost", { origin: location.origin, stored: Object.keys(localStorage), window: await probe.window() });
    const ready = await until(async () => ((await backend()).phase === "ready" ? backend() : null), 60_000);
    await step("backend", Boolean(ready), { state: ready ?? (await backend()) });
    const welcome = await until(() => document.querySelector(".welcome-pick"), 30_000);
    await step("welcome", Boolean(welcome), { title: text(".welcome-title"), recent: document.querySelectorAll(".recent-row").length, calls: ready ? called(ready.url) : 0 });
    if (plan.only === "window") return finish();
    kept("url", ready?.url);
    kept("stage", 1);
    await open(plan.first);
    return;
  }
  if (stage === 1) {
    const nodes = await graph(120_000);
    await step("graph-first", Boolean(nodes), { nodes, repo: text(".toolbar-trail"), tree: document.querySelectorAll(".tree-row").length });
    if (plan.only === "first") return finish();
    kept("stage", 2);
    answers.push(plan.second.path);
    await probe.menu("open"); // 앱 메뉴의 `폴더 열기…`를 고른 것과 같은 알림
    return;
  }
  if (stage === 2) {
    const nodes = await graph(300_000);
    await step("graph-second", Boolean(nodes), { nodes, repo: text(".toolbar-trail"), calls: called(kept("url")) });
    kept("stage", 3);
    await probe.report({ step: "kill-backend" }); // 밖에서 백엔드를 죽인다
    const stopped = await until(() => text(".progress[role=alert] .progress-phase"), 60_000);
    await step("stopped", Boolean(stopped), { title: stopped, detail: text(".progress-error"), state: await backend() });
    document.querySelector(".progress-retry")?.click();
  }
  if (stage === 2 || stage === 3) {
    const welcome = await until(() => document.querySelector(".welcome-pick"), 60_000);
    const state = await backend();
    await step("restarted", Boolean(welcome) && state.phase === "ready" && state.url !== kept("url"), { state, before: kept("url"), recent: document.querySelectorAll(".recent-row").length });
    const refused = await invoke("claude_login", { path: "/nonexistent/claude" }).then(() => null, String);
    await step("login-refused", Boolean(refused), { error: refused });
    kept("stage", 4);
    // 웹뷰가 폴더를 끌어다 놓았을 때 내는 알림을 흉내 낸다. Finder에서 끌어다 놓는 동작은 사람이 확인한다.
    await invoke("plugin:event|emit", { event: "tauri://drag-drop", payload: { paths: [plan.first.path], position: { x: 40, y: 40 } } });
    return;
  }
  if (stage === 4) {
    const nodes = await graph(120_000);
    await step("drop", Boolean(nodes), { nodes, repo: text(".toolbar-trail") });
    await step("blocked", blocked.length === 0, { blocked });
    if (plan.rect) await probe.report({ step: "window", rect: await probe.window(plan.rect) });
    await sleep(500);
    return finish();
  }
})();
