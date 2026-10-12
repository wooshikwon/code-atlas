// probe.rs가 화면의 스크립트보다 먼저 실행한다.
(() => {
  if (window.top !== window) return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  window.__probe = {
    report: (entry) => invoke("probe_report", { line: JSON.stringify({ at: Date.now(), ...entry }) }),
    done: (code = 0) => invoke("probe_done", { code }),
    window: (rect = null) => invoke("probe_window", { rect }),
    close: () => invoke("probe_close"),
    menu: (id) => invoke("probe_menu", { id }),
  };
})();
