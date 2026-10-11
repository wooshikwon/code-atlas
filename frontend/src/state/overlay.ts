// 켠 분석 덮개와 미사용 후보. 탐색 이력과 무관하므로 화면 상태 저장소와 따로 두고, 켠 덮개는 저장하지 않는다.
import { create } from "zustand";
import { getUnused } from "../api/client";

export type OverlayKind = "cycles" | "unused";

export interface OverlayStore {
  /** 켠 덮개. 덮개가 없으면 null이다. */
  kind: OverlayKind | null;
  /** 미사용 후보의 노드 id. 아직 받지 못했으면 비어 있다. */
  unused: Set<string>;
  /** 미사용 판정 대상 정의 수 */
  definitions: number;
  /** 미사용 후보를 받는다. 받지 못하면 직전 값을 그대로 둔다. */
  load(): void;
  /** 덮개를 켜거나 바꾼다. null이면 끈다. */
  set(kind: OverlayKind | null): void;
}

export const useOverlay = create<OverlayStore>()((put) => ({
  kind: null,
  unused: new Set(),
  definitions: 0,
  load: () => {
    getUnused().then(
      (unused) => put({ unused: new Set(unused.candidates), definitions: unused.definitions }),
      () => undefined,
    );
  },
  set: (kind) => put({ kind }),
}));
