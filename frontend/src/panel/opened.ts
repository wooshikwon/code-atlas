// 그래프 선택과 무관하게 정보 패널에 연 파일. 그래프 노드가 없는 `__init__.py`를 파일트리에서 누르면 여기에 담는다.
// 탐색 이력에 넣지 않고, 그래프의 선택이나 뷰가 바뀌면 비운다.
import { create } from "zustand";
import { useAtlas } from "../state/store";

interface OpenedStore {
  /** 레포 루트 기준 파일 경로. 연 파일이 없으면 null이다. */
  path: string | null;
  /** 파일을 연다. 이미 연 파일이면 닫는다. */
  toggle(path: string): void;
  close(): void;
}

export const useOpened = create<OpenedStore>()((set, get) => ({
  path: null,
  toggle: (path) => set({ path: get().path === path ? null : path }),
  close: () => set({ path: null }),
}));

useAtlas.subscribe((state, before) => {
  if (state.selection !== before.selection || state.view !== before.view) {
    useOpened.getState().close();
  }
});
