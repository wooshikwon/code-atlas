// 새로고침. 서버가 레포를 다시 분석하게 한 뒤 새 분석 결과를 받아 화면을 레포를 처음 연 상태로 되돌린다.
// 분석하는 동안에는 앞의 그래프를 그대로 쓰고, 분석하지 못하면 화면을 바꾸지 않고 까닭을 저장소에 적는다.
import { forgetFiles, getGraph, getRepo, getTree, postReload } from "../api/client";
import { useOpened } from "../panel/opened";
import { useChanges } from "./changes";
import { useExplanations } from "./explanations";
import { useOverlay } from "./overlay";
import { useAtlas } from "./store";
import { useSummaries } from "./summaries";

/** 새로고침하는 중에 다시 부르면 아무것도 하지 않는다. */
export async function reload(): Promise<void> {
  if (useAtlas.getState().reloading) {
    return;
  }
  useAtlas.setState({ reloading: true, reloadError: null });
  try {
    await postReload();
    const [repo, graph, tree] = await Promise.all([getRepo(), getGraph(), getTree()]);
    forgetFiles();
    useOpened.getState().close();
    useSummaries.getState().forget();
    useExplanations.getState().forget();
    useAtlas.getState().reopen(repo, graph, tree);
    useOverlay.getState().load();
    await useChanges.getState().load();
  } catch (caught) {
    useAtlas.setState({ reloadError: caught instanceof Error ? caught.message : String(caught) });
  } finally {
    useAtlas.setState({ reloading: false });
  }
}
