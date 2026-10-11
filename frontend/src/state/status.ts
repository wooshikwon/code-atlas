// 분석 상태. 서버의 `/api/status`를 주기마다 받아 분석의 단계와 진행 수, 분석 뒤 바뀐 파일을 담고, 서버의 판 번호가 화면이 그린
// 판 번호와 달라지면 분석 결과를 받아 그린다. 분석 단계가 무엇을 하는지는 모르고 단계의 이름과 수만 적는다.
import { create } from "zustand";
import { forgetFiles, getGraph, getRepo, getStatus, getTree } from "../api/client";
import type { Phase, Status } from "../api/types";
import { useOpened } from "../panel/opened";
import { useChanges } from "./changes";
import { useExplanations } from "./explanations";
import { useOverlay } from "./overlay";
import { useAtlas } from "./store";
import { useSummaries } from "./summaries";

/** 분석하는 동안 상태를 다시 받는 간격(ms). 진행 수가 1초에 두 번 바뀌고, 분석이 끝난 뒤 그래프를 받기까지 기다리는 시간이 0.5초를 넘지 않는다. */
const RUNNING_INTERVAL = 500;
/**
 * 분석이 끝난 뒤 상태를 다시 받는 간격(ms). 서버가 분석 뒤 바뀐 파일을 센 값을 1초 동안 기억하므로, 2초마다 받으면 파일을 저장한 뒤
 * 3초 안에 새로고침 버튼의 표시가 바뀐다.
 */
const WATCH_INTERVAL = 2_000;

const PHASE_NAMES: Record<Phase, string> = {
  collect: "파일 수집",
  extract: "구조 추출",
  resolve: "호출 대상 확인",
  build: "그래프 조립",
  ready: "분석 끝",
  failed: "분석하지 못했다",
};

/** 서버가 분석하는 중이다. 상태를 아직 받지 못했으면 거짓이다. */
export function running(status: Status | null): boolean {
  return status !== null && status.phase !== "ready" && status.phase !== "failed";
}

/** 단계의 이름. */
export function phaseName(status: Status): string {
  return PHASE_NAMES[status.phase];
}

/** 단계의 이름과 진행 수. 수를 세지 않는 단계는 이름만 적는다. */
export function phaseText(status: Status): string {
  const name = phaseName(status);
  return status.total > 0 ? `${name} ${status.done.toLocaleString("en-US")} / ${status.total.toLocaleString("en-US")}` : name;
}

/** 진행률(0~1). 수를 세지 않는 단계는 null이다. */
export function progressOf(status: Status): number | null {
  return status.total > 0 ? Math.min(status.done / status.total, 1) : null;
}

/** 분석 뒤 바뀐 파일을 적는 말풍선의 줄. 경로를 한 줄에 하나씩 적고 서버가 싣지 않은 나머지는 "외 k개"로 줄인다. */
export function staleLines(stale: Status["stale"]): string[] {
  if (stale.count === 0) {
    return [];
  }
  const rest = stale.count - stale.paths.length;
  return [`분석 뒤 바뀐 파일 ${stale.count}개`, ...stale.paths.map((path) => `  ${path}`), ...(rest > 0 ? [`  외 ${rest}개`] : [])];
}

export interface StatusStore {
  /** 아직 받지 못했으면 null이다. */
  status: Status | null;
  /** 화면이 그린 분석 결과의 판 번호. 아직 그리지 않았으면 0이다. */
  shown: number;
  /**
   * 상태를 받고, 서버의 판 번호가 shown과 다르면 분석 결과를 받아 그린 뒤에 끝난다. 받는 중에 다시 부르면 앞의 일이 끝난 뒤에
   * 한 번 더 받는다. 받지 못하면 직전 값을 그대로 둔다.
   */
  load(): Promise<void>;
  /**
   * 상태를 받고, 분석하는 동안에는 0.5초마다, 그 밖에는 2초마다 다시 받는다. 창이 보이지 않으면 멈추고 다시 보이면 바로 받는다.
   * 돌려주는 함수가 다시 받기를 멈춘다.
   */
  watch(): () => void;
}

export const useStatus = create<StatusStore>()((set, get) => {
  let last: Promise<void> = Promise.resolve();

  /**
   * 분석 결과를 받아 그린다. 처음에는 저장해 둔 보기 설정대로 레포를 열고, 그 뒤에는 화면 상태를 레포를 처음 연 상태로 되돌린다.
   * 그리지 못하면 거짓을 돌려준다.
   */
  const draw = async (first: boolean): Promise<boolean> => {
    if (first) {
      await useAtlas.getState().load();
      if (useAtlas.getState().repo === null) {
        return false;
      }
      useOverlay.getState().load();
      return true;
    }
    const [repo, graph, tree] = await Promise.all([getRepo(), getGraph(), getTree()]);
    forgetFiles();
    useOpened.getState().close();
    useSummaries.getState().forget();
    useExplanations.getState().forget();
    useAtlas.getState().reopen(repo, graph, tree);
    useOverlay.getState().load();
    await useChanges.getState().load();
    return true;
  };

  const follow = async (): Promise<void> => {
    try {
      const status = await getStatus();
      if (JSON.stringify(status) !== JSON.stringify(get().status)) {
        set({ status });
      }
      if (status.revision > 0 && status.revision !== get().shown && (await draw(get().shown === 0))) {
        set({ shown: status.revision });
      }
    } catch {
      // 받지 못하면 직전 값을 그대로 두고 다음 주기에 다시 받는다.
    }
  };

  return {
    status: null,
    shown: 0,
    load: () => (last = last.then(follow)),
    watch: () => {
      let timer: number | null = null;
      let stopped = false;
      const pause = () => {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
      };
      const tick = () => {
        pause();
        void get()
          .load()
          .then(() => {
            if (!stopped && !document.hidden && timer === null) {
              const status = get().status;
              timer = window.setTimeout(tick, status === null || running(status) ? RUNNING_INTERVAL : WATCH_INTERVAL);
            }
          });
      };
      const seen = () => (document.hidden ? pause() : tick());
      document.addEventListener("visibilitychange", seen);
      tick();
      return () => {
        stopped = true;
        pause();
        document.removeEventListener("visibilitychange", seen);
      };
    },
  };
});
