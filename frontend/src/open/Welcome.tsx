// 연 레포가 없을 때 칸 묶음 대신 그리는 레포 열기 화면. 가운데에 폴더를 여는 입구와 최근에 연 레포 목록, 환경 점검 화면을 여는 버튼을 둔다. 앱은 폴더 선택
// 대화상자를 여는 버튼을 그리고 창 어디에 폴더를 끌어다 놓아도 받는다. 브라우저는 경로 입력 칸을 그린다.
// 앱에서 백엔드가 뜨는 동안과 멈췄을 때 화면 가운데에 그리는 표시도 여기에 있다.
import { useEffect, useState } from "react";
import { host, type Backend } from "../host";
import { useOpening } from "../state/opening";
import { useTools } from "../state/tools";
import { Recent } from "./Recent";

/** 브라우저에서 폴더의 경로를 받는 칸. 레포 열기 화면과 경로 입력 창이 함께 쓴다. */
export function PathField({ autoFocus }: { autoFocus?: boolean }) {
  const choose = useOpening((s) => s.choose);
  const [path, setPath] = useState("");
  return (
    <form
      className="open-path"
      onSubmit={(event) => {
        event.preventDefault();
        if (path.trim() !== "") {
          void choose(path.trim());
        }
      }}
    >
      <input
        className="open-input"
        type="text"
        value={path}
        placeholder="레포 폴더의 경로"
        aria-label="레포 폴더의 경로"
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(event) => setPath(event.target.value)}
      />
      <button className="toolbar-button" type="submit" disabled={path.trim() === ""}>
        열기
      </button>
    </form>
  );
}

export function Welcome() {
  const busy = useOpening((s) => s.step.kind === "probing" || s.step.kind === "opening");
  const browse = useOpening((s) => s.browse);

  useEffect(() => {
    void useOpening.getState().list();
    return host.onDrop((paths) => void useOpening.getState().drop(paths));
  }, []);

  return (
    <main className="welcome">
      <div className="welcome-body">
        <h1 className="welcome-title">레포 열기</h1>
        {host.app ? (
          <>
            <button className="toolbar-button welcome-pick" disabled={busy} onClick={() => void browse()}>
              폴더 열기…
            </button>
            <p className="welcome-hint">Python 레포의 폴더를 이 창에 끌어다 놓아도 열립니다</p>
          </>
        ) : (
          <PathField autoFocus />
        )}
        {busy && (
          <p className="welcome-hint" role="status">
            여는 중
          </p>
        )}
        <Recent />
        <button className="welcome-tools" onClick={() => useTools.getState().show()}>
          환경 점검
        </button>
      </div>
    </main>
  );
}

/** 앱 껍데기가 띄운 백엔드의 상태 */
export function useBackend(): Backend {
  const [backend, setBackend] = useState<Backend>({ phase: "starting" });
  useEffect(() => host.onBackend(setBackend), []);
  return backend;
}

/** 백엔드가 뜨는 동안에는 `시작하는 중`을, 멈췄으면 까닭과 다시 시작하는 버튼을 화면 가운데에 그린다. */
export function Starting({ backend }: { backend: Backend }) {
  if (backend.phase === "stopped") {
    return (
      <div className="progress" role="alert">
        <div className="progress-phase">분석이 멈췄습니다{backend.code === null ? "" : ` (종료 코드 ${backend.code})`}</div>
        {backend.detail !== "" && <div className="progress-error">{backend.detail}</div>}
        <button className="toolbar-button progress-retry" onClick={() => void host.restartBackend()}>
          다시 시작
        </button>
      </div>
    );
  }
  return (
    <div className="progress" role="status">
      <div className="progress-phase">시작하는 중</div>
      <div className="progress-bar">
        <div className="progress-fill" />
      </div>
    </div>
  );
}
