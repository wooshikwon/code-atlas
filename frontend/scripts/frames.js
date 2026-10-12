// 화면 안에서 도는 프레임 시간 측정 시나리오. 같은 파일을 Chromium(Playwright의 addInitScript)과 앱 창(WKWebView, `--features probe` 빌드의
// CODE_ATLAS_PROBE_SCRIPT)에 넣어 같은 조작을 같은 방식으로 재므로 두 엔진의 값을 견줄 수 있다. 띄우는 쪽은 `frames.mjs`다.
// 조작은 화면 안에서 만든 마우스·휠 이벤트로 한다(프레임마다 이벤트 하나). 값은 `window.__framesPlan`에서 읽는다:
//   { repo?: {path, python?}, window?: [x, y, w, h], tests?: boolean, folders: [폴더 id], select?: boolean, files?: [파일 id],
//     experiments?: boolean | [실험 이름], lineage?: 함수 id, zoomStep?: 휠 한 번의 양, limit?: ms }
// 결과는 단계마다 JSON 한 줄이다. 프레임 통계 {n, p50, p95, max, fps, script, layout}에서 script는 이벤트 처리기와 React 반영이 쓴 시간의
// 가운데 값, layout은 그 뒤 스타일·배치 계산을 강제로 시켜 잰 시간의 가운데 값이고, 프레임 간격에서 둘을 뺀 나머지가 그리기·합성과 대기다.
// 폴더 id를 store로 펼치는 길과 리니지 뷰는 `window.__atlas`(zustand store)가 있을 때만 쓴다. 제품 빌드에는 없으므로 그 단계는 건너뛴다.
(() => {
  if (window.top !== window || window.__framesPlan === undefined) return;
  const plan = window.__framesPlan;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const report = (entry) => (window.__probe ? window.__probe.report(entry) : window.__framesOut(JSON.stringify({ at: Date.now(), ...entry })));
  const finish = (code) => report({ step: "done", code }).then(() => window.__probe?.done(code));
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const until = async (read, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(100);
    }
  };

  // ELK worker의 layout 요청마다 보낸 때와 응답이 온 때를 적는다.
  const elk = [];
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(script, options) {
      super(script, options);
      const sent = new Map();
      const post = this.postMessage.bind(this);
      this.postMessage = (message, ...more) => {
        if (message?.cmd === "layout") sent.set(message.id, performance.now());
        return post(message, ...more);
      };
      this.addEventListener("message", (event) => {
        const started = sent.get(event.data?.id);
        if (started !== undefined) {
          sent.delete(event.data.id);
          elk.push({ sent: started, back: performance.now() });
        }
      });
    }
  };

  const round = (value) => Number(value.toFixed(1));
  const pick = (values, share) => (values.length === 0 ? 0 : round([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))]));
  const stat = (gaps, scripts = [], layouts = []) => ({
    n: gaps.length,
    p50: pick(gaps, 0.5),
    p95: pick(gaps, 0.95),
    max: pick(gaps, 1),
    fps: gaps.length === 0 ? 0 : round(1000 / (gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length)),
    script: pick(scripts, 0.5),
    layout: pick(layouts, 0.5),
  });

  /** ms 동안 프레임마다 act(i)를 부르며 프레임 간격, act와 React 반영의 시간, 그 뒤 강제한 스타일·배치 계산의 시간을 잰다. */
  const frames = (ms, act = null) =>
    new Promise((resolve) => {
      const gaps = [];
      const scripts = [];
      const layouts = [];
      const began = performance.now();
      let last = began;
      let i = 0;
      const tick = (now) => {
        if (i > 0) gaps.push(now - last);
        last = now;
        if (now - began >= ms) return resolve(stat(gaps, scripts, layouts));
        if (act !== null) {
          const started = performance.now();
          act(i);
          // React는 처리기 밖에서 바뀐 상태를 마이크로태스크에서 반영하므로 그 뒤에 잰다.
          queueMicrotask(() =>
            queueMicrotask(() => {
              const reacted = performance.now();
              void document.body.offsetHeight;
              scripts.push(reacted - started);
              layouts.push(performance.now() - reacted);
            }),
          );
        }
        i += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  const graphRect = () => $(".graph").getBoundingClientRect();
  const mouse = (target, type, x, y, more = {}) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1, detail: 1, ...more }));

  /** 그래프 바탕을 잡아 ms 동안 끌어 옮긴다. */
  const pan = async (ms = 1500) => {
    const rect = graphRect();
    const [cx, cy] = [rect.left + rect.width / 2, rect.top + rect.height / 2];
    const pane = $(".react-flow__pane");
    mouse(pane, "mousedown", cx, cy);
    const result = await frames(ms, (i) => mouse(window, "mousemove", cx + Math.sin(i / 10) * 250, cy + Math.cos(i / 10) * 160));
    mouse(window, "mouseup", cx, cy);
    return result;
  };

  /** ms의 앞 절반은 휠로 확대하고 뒤 절반은 같은 양만큼 축소한다. */
  const wheel = async (ms = 1500, step = 12) => {
    const rect = graphRect();
    const [cx, cy] = [rect.left + rect.width / 2, rect.top + rect.height / 2];
    const pane = $(".react-flow__pane");
    const half = Math.round(ms / 2);
    const turn = (deltaY) => () => pane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, deltaY }));
    const before = zoomNow();
    const into = await frames(half, turn(-step));
    const peak = zoomNow();
    const out = await frames(half, turn(step));
    const end = zoomNow();
    // 확대 비율의 끝에 닿으면 돌아온 비율이 처음과 다르다. 처음 비율로 되돌려 다음 측정이 같은 화면에서 시작하게 한다.
    for (let i = 0; i < 6 && before > 0 && Math.abs(zoomNow() / before - 1) > 0.01; i += 1) {
      turn(-Math.log2(before / zoomNow()) / 0.002)();
      await frame();
      await frame();
    }
    return { ...stat([], [], []), n: into.n + out.n, p50: Math.max(into.p50, out.p50), p95: Math.max(into.p95, out.p95), max: Math.max(into.max, out.max), fps: round((into.fps + out.fps) / 2), script: Math.max(into.script, out.script), layout: Math.max(into.layout, out.layout), zoom: [before, peak, end] };
  };

  const zoomNow = () => Number(Number(/scale\(([^)]+)\)/.exec($(".react-flow__viewport")?.style.transform ?? "")?.[1] ?? 0).toFixed(3));
  const inView = (element) => {
    const rect = graphRect();
    const box = element.getBoundingClientRect();
    return box.right > rect.left && box.left < rect.right && box.bottom > rect.top && box.top < rect.bottom;
  };
  const drawnNodes = () => $$(".react-flow__node").filter((node) => !node.dataset.id?.endsWith("#face"));

  /** 화면에 보이는 노드를 세 프레임마다 하나씩 옮겨 가며 커서를 올린다. */
  const hover = async (ms = 1200) => {
    const nodes = drawnNodes().filter(inView).slice(0, 200);
    if (nodes.length === 0) return null;
    let last = null;
    let pointed = 0;
    const result = await frames(ms, (i) => {
      const node = nodes[Math.floor(i / 3) % nodes.length];
      const box = node.getBoundingClientRect();
      const [x, y] = [box.left + Math.min(box.width / 2, 12), box.top + Math.min(box.height / 2, 8)];
      const target = node.firstElementChild ?? node;
      if (node !== last) {
        if (last !== null) mouse(last.firstElementChild ?? last, "mouseout", x, y, { buttons: 0, relatedTarget: target });
        mouse(target, "mouseover", x, y, { buttons: 0, relatedTarget: last?.firstElementChild ?? null });
        last = node;
      }
      mouse(target, "mousemove", x, y, { buttons: 0 });
      pointed += $(".react-flow__node.pointed") !== null ? 1 : 0;
    });
    if (last !== null) mouse(last.firstElementChild ?? last, "mouseout", 0, 0, { buttons: 0, relatedTarget: document.body });
    return { ...result, pointed };
  };

  /** 화면이 멈출 때까지 기다린다: 배치 움직임과 화면 이동이 끝나고 노드 수와 화면 위치가 quiet 동안 그대로다. */
  const settle = async (quiet = 400, limit = 120_000) => {
    const began = performance.now();
    let seen = null;
    let since = began;
    for (;;) {
      const graph = $(".graph");
      const busy = graph === null || graph.hasAttribute("data-moving") || graph.hasAttribute("data-flying") || $(".arranging") !== null || $(".graph-empty") !== null;
      const now = [busy, $(".react-flow__viewport")?.style.transform, document.querySelectorAll(".react-flow__node").length].join("|");
      if (now !== seen) {
        seen = now;
        since = performance.now();
      } else if (!busy && performance.now() - since >= quiet) {
        return since - began;
      }
      if (performance.now() - began > limit) return -1;
      await frame();
    }
  };

  /** 화면에 있는 요소의 수. out은 그래프 영역 밖에 있는데 그려진 수다. */
  const counts = () => {
    const nodes = drawnNodes();
    const edges = $$(".react-flow__edge");
    const kinds = {};
    nodes.forEach((node) => {
      const kind = /react-flow__node-(\w+)/.exec(node.className)?.[1] ?? "?";
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    });
    const shades = {};
    $$(".react-flow__edge > .edge").forEach((edge) => {
      const shade = edge.style.getPropertyValue("--shade") || edge.style.opacity || "1";
      shades[shade] = (shades[shade] ?? 0) + 1;
    });
    return {
      nodes: nodes.length,
      kinds,
      nodes_out: nodes.filter((node) => !inView(node)).length,
      edges: edges.length,
      trunks: document.querySelectorAll(".edge-trunk").length,
      edges_out: edges.filter((edge) => !inView(edge)).length,
      edge_svgs: document.querySelectorAll(".react-flow__edges > svg").length,
      // 묶음 전체에 불투명도가 걸려 묶음을 덮는 크기의 버퍼를 따로 만드는 선 묶음의 수와, 장식만 든 작은 묶음의 수
      shade_layers: $$(".react-flow__edge > .edge").filter((edge) => Number(getComputedStyle(edge).opacity) < 1).length,
      shade_parts: document.querySelectorAll(".edge-part").length,
      paths: document.querySelectorAll(".react-flow__edges path").length,
      edge_texts: document.querySelectorAll(".react-flow__edges text").length,
      edge_shades: shades,
      dimmed_nodes: nodes.filter((node) => node.style.opacity !== "" && node.style.opacity !== "1").length,
      flow_elements: document.querySelectorAll(".react-flow *").length,
      dom: document.querySelectorAll("*").length,
      minimap: document.querySelectorAll(".graph-minimap *").length,
      zoom: zoomNow(),
      heap_mb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    };
  };

  /** act를 한 뒤 화면이 멈추기까지를 잰다. 그동안의 프레임 간격, ELK 요청, 배치 움직임(data-moving)의 구간을 함께 적는다. */
  const operate = async (act) => {
    const from = elk.length;
    const gaps = [];
    let running = true;
    let moved = null;
    let stopped = null;
    let last = performance.now();
    const began = last;
    const tick = (now) => {
      gaps.push({ at: now - began, gap: now - last });
      last = now;
      const moving = $(".graph")?.hasAttribute("data-moving") === true;
      if (moving && moved === null) moved = now - began;
      if (!moving && moved !== null && stopped === null) stopped = now - began;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const started = performance.now();
    act();
    const acted = performance.now() - started;
    await frame();
    const settled = await settle();
    running = false;
    const end = settled < 0 ? performance.now() - began : performance.now() - began - 400;
    const spans = elk.slice(from).map((one) => ({ sent: round(one.sent - began), ms: round(one.back - one.sent) }));
    const lastBack = elk.slice(from).reduce((latest, one) => Math.max(latest, one.back - began), 0);
    const within = (lo, hi) => gaps.filter((one) => one.at > lo && one.at <= hi).map((one) => one.gap);
    return {
      total_ms: round(end),
      handler_ms: round(acted),
      elk: spans,
      // ELK의 마지막 응답 뒤 첫 프레임까지: 받은 배치를 React가 DOM에 반영하고 첫 그림을 그리는 시간
      commit_ms: lastBack === 0 ? null : round((gaps.find((one) => one.at > lastBack)?.at ?? lastBack) - lastBack),
      moving: moved === null ? null : { from: round(moved), to: round(stopped ?? end), frames: stat(within(moved, stopped ?? end)) },
      long: gaps.filter((one) => one.gap > 50 && one.at <= end).map((one) => ({ at: round(one.at), gap: round(one.gap) })).slice(0, 12),
      frames: stat(within(0, end)),
      timed_out: settled < 0,
    };
  };

  const click = (element) => {
    const box = element.getBoundingClientRect();
    mouse(element, "click", box.left + Math.min(box.width / 2, 12), box.top + Math.min(box.height / 2, 8), { buttons: 0 });
  };
  const store = () => window.__atlas?.getState() ?? null;
  const nodeOf = (id) => $(`.react-flow__node[data-id="${CSS.escape(id)}"]`);

  /** 그 상태에서 가만히 있을 때, 끌어 옮길 때, 확대·축소할 때, 커서를 올릴 때의 프레임을 잰다. */
  const motions = async (name, more = {}) => {
    const idle = await frames(1000);
    if (plan.trace) await report({ step: "trace", name, idle, visible: document.visibilityState, focused: document.hasFocus() });
    const entry = { step: "state", name, ...more, visible: document.visibilityState, focused: document.hasFocus(), counts: counts(), idle, pan: await pan() };
    await settle(200);
    if (plan.trace) await report({ step: "trace", name, pan: entry.pan });
    entry.wheel = await wheel();
    if (plan.trace) await report({ step: "trace", name, wheel: entry.wheel });
    await settle(200);
    entry.hover = await hover();
    // 휠을 크게 돌려 확대 비율의 끝까지 갔다 온다. 큰 층을 새 배율로 다시 그리는 멈춤은 max에 드러난다.
    await settle(200);
    entry.zoom = await wheel(3000, plan.zoomStep ?? 40);
    await settle(200);
    await report(entry);
    return entry;
  };

  /** 노드 하나를 눌러 고른다. 누른 때부터 DOM이 바뀐 뒤 두 프레임이 지나기까지를 반응 시간으로 적는다. */
  const choose = async (name, element) => {
    let changed = null;
    const began = performance.now();
    const observer = new MutationObserver(() => (changed ??= performance.now() - began));
    observer.observe($(".graph"), { subtree: true, childList: true, attributes: true });
    const result = await operate(() => click(element));
    observer.disconnect();
    const first = result.long[0] ?? null;
    await report({ step: "select", name, id: element.dataset.id, changed_ms: changed === null ? null : round(changed), first_long: first, ...result, counts: counts() });
  };

  const EXPERIMENTS = [
    ["baseline", ""],
    ["no-transition", ".react-flow__node,.edge,.react-flow__node *{transition:none!important;animation:none!important}"],
    ["shade-1", ".react-flow__edge>.edge{--shade:1!important}"],
    ["node-opacity-1", ".react-flow__node{opacity:1!important}"],
    ["no-markers", ".edge-line{marker-end:none!important}"],
    ["no-edge-text", ".react-flow__edges text{display:none!important}"],
    ["no-edge-hit", ".edge-hit{display:none!important}"],
    ["no-joints", ".edge-joint{display:none!important}"],
    ["no-shadow-filter", ".react-flow *{box-shadow:none!important;filter:none!important;backdrop-filter:none!important}"],
    ["edges-hidden", ".react-flow__edges{display:none!important}"],
    ["nodes-hidden", ".react-flow__nodes{display:none!important}"],
    ["node-insides-hidden", ".react-flow__node>*{display:none!important}"],
    ["minimap-hidden", ".graph-minimap{display:none!important}"],
    ["edges-one-layer", ".react-flow__edges{will-change:transform}"],
    ["viewport-layer", ".react-flow__viewport{will-change:transform}"],
    ["edges-contain", ".react-flow__edges>svg{contain:strict}"],
  ];

  const experiments = async () => {
    for (const [name, css] of EXPERIMENTS.filter(([name]) => !Array.isArray(plan.experiments) || plan.experiments.includes(name))) {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
      await frame();
      await sleep(300);
      const entry = { step: "experiment", name, idle: await frames(600), pan: await pan(1200) };
      await settle(200);
      entry.wheel = await wheel(1200);
      await settle(200);
      entry.hover = await hover(900);
      await settle(200);
      entry.zoom = await wheel(2400, plan.zoomStep ?? 40);
      await settle(200);
      style.remove();
      await report(entry);
    }
    // 미니맵을 컴포넌트째 끈다(닫으면 React Flow의 MiniMap이 노드마다 그리는 요소가 사라진다).
    const button = $(".minimap-button");
    if (button !== null && $(".graph-minimap") !== null && (!Array.isArray(plan.experiments) || plan.experiments.includes("minimap-closed"))) {
      button.click();
      await sleep(400);
      const entry = { step: "experiment", name: "minimap-closed", idle: await frames(600), pan: await pan(1200) };
      await settle(200);
      entry.wheel = await wheel(1200);
      await settle(200);
      entry.hover = await hover(900);
      await report(entry);
      button.click();
      await sleep(400);
    }
  };

  /** 대화상자의 응답을 대신 줘서 앱의 레포 열기 화면에서 폴더를 고른다. 화면이 다시 읽힌다. */
  const openRepo = async (target) => {
    const answers = [target.path];
    const send = window.fetch.bind(window);
    window.fetch = (input, init) =>
      decodeURIComponent(String(input)).endsWith("/plugin:dialog|open")
        ? Promise.resolve(new Response(JSON.stringify(answers.shift() ?? null), { headers: { "Content-Type": "application/json", "Tauri-Response": "ok" } }))
        : send(input, init);
    $(".welcome-pick").click();
    if (target.python) {
      const asked = await until(() => $(".ask-title"), 15_000);
      if (asked) {
        answers.push(target.python);
        $(".ask-buttons .toolbar-button").click();
      }
    }
  };

  const run = async () => {
    setTimeout(() => report({ step: "timeout" }).then(() => finish(2)), plan.limit ?? 900_000);
    await until(() => document.readyState !== "loading", 10_000);
    const landed = await until(() => $(".react-flow__node") ?? $(".welcome-pick"), 300_000);
    if (landed === null) return finish(3);
    if (landed.classList.contains("welcome-pick")) {
      if (!plan.repo || sessionStorage.getItem("frames:opened")) return finish(4);
      sessionStorage.setItem("frames:opened", "1");
      return openRepo(plan.repo);
    }
    // 웹 콘텐츠 프로세스가 죽어 화면이 다시 읽히면 처음부터 다시 돌지 않고 끝낸다.
    if (sessionStorage.getItem("frames:started")) {
      await report({ step: "reloaded" });
      return finish(6);
    }
    sessionStorage.setItem("frames:started", "1");
    await settle();
    await report({ step: "page", engine: navigator.userAgent, view: [innerWidth, innerHeight], dpr: devicePixelRatio, hook: store() !== null });
    if (plan.window && window.__probe) await report({ step: "window", rect: await window.__probe.window(plan.window) });
    await motions("first");
    if (plan.tests && store() !== null && !store().showTests) {
      store().toggleTests();
      await settle();
    }

    for (const [i, id] of (plan.folders ?? []).entries()) {
      const row = $(`.tree-row.tree-dir[data-node="${CSS.escape(id)}"][aria-expanded="false"]`);
      if (row === null && !(store()?.collapsed.has(id) ?? false)) {
        await report({ step: "expand", id, skipped: true });
        continue;
      }
      const result = await operate(() => (row !== null ? row.click() : store().toggleFolder(id)));
      await report({ step: "expand", order: i + 1, id, ...result });
      await motions(`folders-${i + 1}`, { id });
      const target = drawnNodes().filter(inView).find((node) => /react-flow__node-(function|class|method)/.test(node.className)) ?? drawnNodes().filter(inView).find((node) => node.className.includes("react-flow__node-module"));
      if (target && plan.select !== false) {
        await choose(`folders-${i + 1}`, target);
        await motions(`folders-${i + 1}-selected`, { id: target.dataset.id });
        store()?.select(null);
        if (store() === null) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
      }
    }

    // 파일 상자를 열고 `내부 함수 k개` 손잡이를 눌러 그 파일의 정의를 모두 그린다. 전부 펼친 파일 상자는 다른 파일을 열어도 남는다.
    for (const [i, id] of (plan.files ?? []).entries()) {
      const box = nodeOf(id);
      if (box === null) {
        await report({ step: "file", id, skipped: true });
        continue;
      }
      await report({ step: "file", order: i + 1, id, ...(await operate(() => click(box.querySelector(".node-module-head") ?? box.firstElementChild ?? box))) });
      const handle = $$(".react-flow__node-pack").find((pack) => pack.dataset.id?.startsWith(id)) ?? null;
      if (handle !== null) {
        await report({ step: "unpack", order: i + 1, id, ...(await operate(() => click(handle))) });
      }
      await motions(`files-${i + 1}`, { id, unpacked: handle !== null });
    }
    if ((plan.files ?? []).length > 0) {
      store()?.select(null);
      await settle();
      await motions("files-unselected");
    }

    if (plan.experiments) await experiments();

    // 접기와 다시 펼치기
    const last = (plan.folders ?? []).at(-1);
    if (last !== undefined && store() !== null) {
      await report({ step: "collapse", id: last, ...(await operate(() => store().toggleFolder(last))) });
      await report({ step: "re-expand", id: last, ...(await operate(() => store().toggleFolder(last))) });
    }

    // 코드 뷰어 스크롤
    const code = await until(() => $(".code .monaco-scrollable-element"), 500);
    const pickable = drawnNodes().filter(inView).find((node) => /react-flow__node-(function|method|class)/.test(node.className));
    if (code === null && pickable) {
      click(pickable);
      await settle();
    }
    const scroller = await until(() => $(".code .monaco-scrollable-element"), 8_000);
    if (scroller !== null) {
      const box = scroller.getBoundingClientRect();
      const scroll = await frames(1500, (i) => scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, view: window, clientX: box.left + 80, clientY: box.top + 80, deltaY: i < 45 ? 60 : -60 })));
      await report({ step: "code-scroll", ...scroll, lines: document.querySelectorAll(".code .view-line").length });
    } else {
      await report({ step: "code-scroll", skipped: true });
    }

    // 리니지 뷰
    if (plan.lineage && store() !== null) {
      await report({ step: "lineage-enter", id: plan.lineage, ...(await operate(() => store().enterFunction(plan.lineage))) });
      await motions("lineage");
      await report({ step: "lineage-leave", ...(await operate(() => store().leaveFunction())) });
    }
    return finish(0);
  };
  run().catch((error) => report({ step: "error", message: String(error), stack: String(error?.stack).slice(0, 600) }).then(() => finish(5)));
})();
