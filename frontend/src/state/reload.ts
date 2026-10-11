// 새로고침. 서버가 레포를 다시 분석하게 한 뒤 분석 상태를 받아, 새 판의 분석 결과로 화면을 레포를 처음 연 상태로 되돌린다(`state/status.ts`).
// 분석하는 동안에는 앞의 그래프를 그대로 쓰고, 분석하지 못하면 화면을 바꾸지 않고 까닭을 저장소에 적는다.
import { postReload } from "../api/client";
import { running, useStatus } from "./status";
import { useAtlas } from "./store";

/** 새로고침하는 중이거나 서버가 분석하는 중에 부르면 아무것도 하지 않는다. */
export async function reload(): Promise<void> {
  if (useAtlas.getState().reloading || running(useStatus.getState().status)) {
    return;
  }
  useAtlas.setState({ reloading: true, reloadError: null });
  try {
    await postReload();
  } catch (caught) {
    useAtlas.setState({ reloadError: caught instanceof Error ? caught.message : String(caught) });
  }
  await useStatus.getState().load();
  useAtlas.setState({ reloading: false });
}
