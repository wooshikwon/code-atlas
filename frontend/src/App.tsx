import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { useEffect } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { GraphView } from "./graph/GraphView";
import { fitTarget, FRAME_ZOOM, stageOf } from "./graph/viewport";
import { Filters } from "./nav/Filters";
import { bind } from "./nav/keys";
import { Trail } from "./nav/Trail";
import { InfoPanel } from "./panel/InfoPanel";
import { useOpened } from "./panel/opened";
import { Palette } from "./search/Palette";
import { useStaleCount, watch } from "./state/changes";
import { litOf, pinned, useAtlas } from "./state/store";
import { FileTree } from "./tree/FileTree";

function Toolbar() {
  const stale = useStaleCount();
  const functionView = useAtlas((s) => s.view.kind === "function");
  const canBack = useAtlas((s) => s.history.index > 0);
  const canForward = useAtlas((s) => s.history.index < s.history.entries.length - 1);
  /** 경로 고정 중에는 뒤로·앞으로 버튼을 누를 수 없다. */
  const pin = useAtlas((s) => pinned(s.finder));
  const theme = useAtlas((s) => s.theme);
  const back = useAtlas((s) => s.back);
  const forward = useAtlas((s) => s.forward);
  const setTheme = useAtlas((s) => s.setTheme);
  const { fitView } = useReactFlow();

  /**
   * 정보 패널이 가리지 않는 영역에 그래프 전체를 맞춘다. 함수 시점 뷰에서는 확대 비율을 100%보다 키우지 않는다.
   * 경로 고정 중에는 강조하는 경로를 맞춘다.
   */
  const fitGraph = () => {
    const graph = document.querySelector(".graph");
    if (graph !== null) {
      const path = litOf(useAtlas.getState().finder)?.path ?? null;
      void fitView({ maxZoom: functionView ? FRAME_ZOOM : undefined, ...fitTarget(stageOf(graph), path) });
    }
  };

  return (
    <div className="toolbar">
      <div className="toolbar-nav">
        <button className="toolbar-button" onClick={back} disabled={!canBack || pin} title="뒤로" aria-label="뒤로">
          ←
        </button>
        <button className="toolbar-button" onClick={forward} disabled={!canForward || pin} title="앞으로" aria-label="앞으로">
          →
        </button>
        <Trail />
      </div>
      <div className="toolbar-tools">
        <Filters />
        <button className="toolbar-button" onClick={fitGraph}>
          화면 맞춤
        </button>
        <button className="toolbar-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          {theme === "light" ? "어두운 화면" : "밝은 화면"}
        </button>
        {stale > 0 && (
          <span className="toolbar-stale" title="그래프의 노드와 줄 범위는 레포를 열 때 분석한 값이다">
            분석 뒤 바뀐 파일 {stale}개
          </span>
        )}
      </div>
    </div>
  );
}

export function App() {
  const main = useDefaultLayout({ id: "main", storage: localStorage });
  const opened = useAtlas((s) => s.repo !== null);

  useEffect(() => (opened ? watch() : undefined), [opened]);

  // 팔레트가 열려 있으면 Esc는 팔레트 입력이 받아 팔레트만 닫는다. 정보 패널에 연 파일이 있으면 그 파일만 닫는다.
  useEffect(
    () =>
      bind({
        back: () => useAtlas.getState().back(),
        forward: () => useAtlas.getState().forward(),
        escape: () => {
          const state = useAtlas.getState();
          if (state.paletteOpen) {
            return;
          }
          if (useOpened.getState().path !== null) {
            useOpened.getState().close();
          } else {
            state.select(null);
          }
        },
        palette: () => useAtlas.getState().setPalette(true),
      }),
    [],
  );

  return (
    <Group
      id="main"
      className="app"
      orientation="horizontal"
      defaultLayout={main.defaultLayout}
      onLayoutChanged={main.onLayoutChanged}
    >
      <Panel id="explorer" defaultSize={260} minSize={160} maxSize="40">
        <FileTree />
      </Panel>
      <Separator className="separator" />
      <Panel id="workspace" minSize="30">
        <ReactFlowProvider>
          <div className="workspace">
            <Toolbar />
            <div className="stage">
              <GraphView />
              <InfoPanel />
            </div>
            <Palette />
          </div>
        </ReactFlowProvider>
      </Panel>
    </Group>
  );
}
