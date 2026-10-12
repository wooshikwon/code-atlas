// probe.rs가 화면의 스크립트보다 먼저 실행한다. __API__는 probe.rs가 CODE_ATLAS_PROBE_API의 값으로 바꾼다.
(() => {
  if (window.top !== window) return;
  const api = __API__;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  window.__probe = {
    api,
    report: (entry) => invoke("probe_report", { line: JSON.stringify({ at: Date.now(), ...entry }) }),
    done: (code = 0) => invoke("probe_done", { code }),
  };
  if (api) {
    const send = window.fetch.bind(window);
    window.fetch = (input, init) => send(typeof input === "string" && input.startsWith("/api/") ? api + input : input, init);
  }
})();
