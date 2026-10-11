// 배치 계산 하나를 지켜본다. 계산이 길어지면 저장소에 알려 그래프 위에 표시를 띄우고, 버린 계산은 worker에서 끝낸다.
// 구조 뷰와 함수 시점 뷰가 함께 쓴다.
import { undoable, useAtlas } from "../state/store";
import { stopElk } from "./layout";
import { MOVE_MS } from "./motion";

/**
 * 배치 계산 work의 결과가 오면 done을, 실패하면 failed를 부른다. 계산이 펼치기·접기의 움직임 시간(`MOVE_MS`)을 넘기면 저장소의
 * arranging을 켜고 끝나면 끈다. 그 시간 안에 끝난 계산은 앞 배치에서 새 배치로 가는 움직임이 곧바로 이어지므로 표시하지 않는다.
 * 결과가 오면 계산을 시작한 때의 탐색 이력을 저장소의 arranged에 적는다. 느린 배치를 취소하면 그 이력으로 돌아간다.
 * 돌려주는 함수는 계산을 버린다. 버린 계산의 결과는 done에 가지 않고, arranging이 켜진 계산이면 worker를 끝낸다.
 */
export function watchLayout<T>(work: Promise<T>, done: (result: T) => void, failed: (message: string) => void): () => void {
  const history = useAtlas.getState().history;
  let pending = true;
  let slow = false;
  const timer = window.setTimeout(() => {
    slow = true;
    useAtlas.setState({ arranging: true });
  }, MOVE_MS);
  const settle = () => {
    pending = false;
    window.clearTimeout(timer);
    if (slow) {
      useAtlas.setState({ arranging: false });
    }
  };
  work.then(
    (result) => {
      if (pending) {
        settle();
        useAtlas.setState({ arranged: history });
        done(result);
      }
    },
    (caught: unknown) => {
      if (pending) {
        settle();
        failed(caught instanceof Error ? caught.message : String(caught));
      }
    },
  );
  return () => {
    if (pending) {
      settle();
      if (slow) {
        stopElk();
      }
    }
  };
}

/** 입력이 화면에 그린 배치의 입력과 같아 다시 계산하지 않을 때 부른다. 지금의 탐색 이력을 저장소의 arranged에 적는다. */
export function keepLayout(): void {
  useAtlas.setState({ arranged: useAtlas.getState().history });
}

/** 느린 배치의 표시. 그래프 영역 위쪽 가운데에 띄우고, 취소해 되돌릴 조작이 있으면 취소하는 키를 함께 적는다. */
export function Arranging() {
  const arranging = useAtlas((s) => s.arranging);
  const cancels = useAtlas(undoable);
  if (!arranging) {
    return null;
  }
  return (
    <div className="arranging" role="status">
      <span className="reload-spin" aria-hidden />
      {cancels ? "배치 계산 중 · Esc로 취소" : "배치 계산 중"}
    </div>
  );
}
