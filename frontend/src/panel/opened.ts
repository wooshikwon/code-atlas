// 그래프 선택과 무관하게 정보 패널에 연 파일. 그래프 노드가 없는 `__init__.py`를 파일트리에서 누르면 여기에 담는다.
// 탐색 이력에 넣지 않고, 그래프의 선택이나 뷰가 바뀌거나 그 파일이 든 폴더를 접거나 경로 고정에 들어가면 비운다.
// 경로 고정 중에는 파일을 열지 않는다.
import { create } from "zustand";
import { barred, pinned, useAtlas } from "../state/store";

interface OpenedStore {
  /** 레포 루트 기준 파일 경로. 연 파일이 없으면 null이다. */
  path: string | null;
  /** 파일을 연다. 이미 연 파일이면 닫는다. */
  toggle(path: string): void;
  close(): void;
}

export const useOpened = create<OpenedStore>()((set, get) => ({
  path: null,
  toggle: (path) => {
    if (!barred()) {
      set({ path: get().path === path ? null : path });
    }
  },
  close: () => set({ path: null }),
}));

useAtlas.subscribe((state, before) => {
  const { path, close } = useOpened.getState();
  if (path === null) {
    return;
  }
  /** 접은 폴더의 레포 루트 기준 경로. 패키지 노드의 path는 폴더이거나 그 폴더의 `__init__.py`다. */
  const folded = () =>
    (state.graph?.nodes ?? [])
      .filter((n) => n.kind === "package" && n.path !== null && state.collapsed.has(n.id))
      .map((n) => n.path!.replace(/\/?__init__\.py$/, ""));
  if (
    state.selection !== before.selection ||
    state.view !== before.view ||
    (pinned(state.finder) && !pinned(before.finder)) ||
    (state.collapsed !== before.collapsed && folded().some((folder) => path.startsWith(`${folder}/`)))
  ) {
    close();
  }
});
