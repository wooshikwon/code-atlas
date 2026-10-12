// 화면이 도는 곳(데스크톱 앱, 브라우저)의 차이. 화면 컴포넌트와 저장소는 Tauri를 직접 부르지 않고 `host`의 함수만 부른다.
// 앱에서는 앱 껍데기가 띄운 백엔드의 주소와 상태, 운영체제의 대화상자·끌어다 놓기·메뉴를 받고, 브라우저에서는 화면을 내려준
// 서버가 백엔드다. `@tauri-apps/api`는 앱 안에서만 불러온다.

/** 앱 껍데기가 띄운 백엔드의 상태. stopped의 detail은 백엔드가 표준 오류에 남긴 마지막 줄들이다. */
export type Backend = { phase: "starting" } | { phase: "ready"; url: string } | { phase: "stopped"; code: number | null; detail: string };

export interface Host {
  /** Tauri 앱 안이면 참 */
  app: boolean;
  /** API 주소의 앞부분. 브라우저는 빈 글이고, 앱은 백엔드가 뜰 때까지 기다린 뒤 그 주소를 준다. */
  base(): Promise<string>;
  /** 폴더 선택 대화상자. 고르지 않고 닫으면 null이다. 앱에서만 부른다. */
  pickFolder(): Promise<string | null>;
  /** 파일 선택 대화상자. 고르지 않고 닫으면 null이다. 앱에서만 부른다. */
  pickFile(): Promise<string | null>;
  /** 창에 끌어다 놓은 파일과 폴더의 절대 경로를 받는다. 돌려주는 함수가 받기를 멈춘다. */
  onDrop(listen: (paths: string[]) => void): () => void;
  /** 백엔드의 상태를 지금 값부터 받는다. 돌려주는 함수가 받기를 멈춘다. */
  onBackend(listen: (state: Backend) => void): () => void;
  restartBackend(): Promise<void>;
  /** 터미널을 열어 path의 `claude`로 로그인하게 한다. */
  claudeLogin(path: string): Promise<void>;
  /** 앱 메뉴에서 고른 항목을 받는다. 돌려주는 함수가 받기를 멈춘다. */
  onMenu(listen: (item: "open") => void): () => void;
}

const browser: Host = {
  app: false,
  base: () => Promise.resolve(""),
  pickFolder: () => Promise.resolve(null),
  pickFile: () => Promise.resolve(null),
  onDrop: () => () => {},
  onBackend: (listen) => {
    listen({ phase: "ready", url: "" });
    return () => {};
  },
  restartBackend: () => Promise.resolve(),
  claudeLogin: () => Promise.resolve(),
  onMenu: () => () => {},
};

/** 앱 껍데기의 Tauri 명령 `backend_state`·`restart_backend`·`claude_login`과 이벤트 `backend`·`menu`를 쓴다. */
function shell(): Host {
  const core = import("@tauri-apps/api/core");
  const events = import("@tauri-apps/api/event");
  let backend: Backend = { phase: "starting" };
  const watchers = new Set<(state: Backend) => void>();
  const tell = (state: Backend) => {
    backend = state;
    for (const watcher of [...watchers]) {
      watcher(state);
    }
  };
  const onBackend = (listen: (state: Backend) => void) => {
    watchers.add(listen);
    listen(backend);
    return () => void watchers.delete(listen);
  };
  // 이벤트를 먼저 받기 시작한 뒤에 지금 상태를 묻는다. 그 사이에 바뀐 상태를 놓치지 않는다.
  void events
    .then((event) => event.listen<Backend>("backend", (received) => tell(received.payload)))
    .then(() => core)
    .then(({ invoke }) => invoke<Backend>("backend_state"))
    .then(tell);

  return {
    app: true,
    base: () =>
      backend.phase === "ready"
        ? Promise.resolve(backend.url)
        : new Promise((resolve) => {
            const stop = onBackend((state) => {
              if (state.phase === "ready") {
                stop();
                resolve(state.url);
              }
            });
          }),
    pickFolder: async () => (await import("@tauri-apps/plugin-dialog")).open({ directory: true }),
    pickFile: async () => (await import("@tauri-apps/plugin-dialog")).open({}),
    onDrop: (listen) => {
      const stop = import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            listen(event.payload.paths);
          }
        }),
      );
      return () => void stop.then((unlisten) => unlisten());
    },
    onBackend,
    restartBackend: async () => (await core).invoke("restart_backend"),
    claudeLogin: async (path) => (await core).invoke("claude_login", { path }),
    onMenu: (listen) => {
      const stop = events.then((event) => event.listen<"open">("menu", (received) => listen(received.payload)));
      return () => void stop.then((unlisten) => unlisten());
    },
  };
}

export const host: Host = "__TAURI_INTERNALS__" in globalThis ? shell() : browser;
