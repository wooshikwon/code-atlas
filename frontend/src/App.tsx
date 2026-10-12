import { ReactFlowProvider } from "@xyflow/react";
import { useEffect } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { usePick } from "./graph/aim";
import { useFlight } from "./graph/flight";
import { GraphView } from "./graph/GraphView";
import { Progress } from "./graph/Progress";
import { SummaryQueue } from "./graph/SummaryQueue";
import { Tooltip } from "./graph/Tooltip";
import { Entries } from "./nav/Entries";
import { Filters } from "./nav/Filters";
import { Reload } from "./nav/Reload";
import { bind, dismiss } from "./nav/keys";
import { NodeMenu, SummaryNotice } from "./nav/NodeMenu";
import { Trail } from "./nav/Trail";
import { InfoPanel } from "./panel/InfoPanel";
import { useOpened } from "./panel/opened";
import { Palette } from "./search/Palette";
import { watch } from "./state/changes";
import { useCompare } from "./state/compare";
import { busy, reload } from "./state/reload";
import { litOf, pinned, useAtlas } from "./state/store";
import { FileTree } from "./tree/FileTree";

function Toolbar() {
  const canBack = useAtlas((s) => s.history.index > 0);
  const canForward = useAtlas((s) => s.history.index < s.history.entries.length - 1);
  /** 경로 고정 중에는 뒤로·앞으로 버튼을 누를 수 없다. */
  const pin = useAtlas((s) => pinned(s.finder));
  const theme = useAtlas((s) => s.theme);
  const back = useAtlas((s) => s.back);
  const forward = useAtlas((s) => s.forward);
  const setTheme = useAtlas((s) => s.setTheme);
  const resetView = useAtlas((s) => s.resetView);
  const { fit } = useFlight();

  /**
   * 정보 패널이 가리지 않는 영역에 그래프 전체를 맞추고 확대 비율을 100%보다 키우지 않는다.
   * 경로 고정 중에는 강조하는 경로를 맞춘다. 구조 뷰의 그래프 전체를 맞췄으면 전체 맞춤 상태를 켠다.
   */
  const fitGraph = () => {
    const graph = document.querySelector(".graph");
    if (graph !== null) {
      const { finder, view } = useAtlas.getState();
      const path = litOf(finder)?.path ?? null;
      fit(graph, path);
      if (view.kind === "structure") {
        useAtlas.setState({ fitted: path === null });
      }
    }
  };

  return (
    <div className="toolbar">
      <div className="toolbar-nav">
        <button className="toolbar-button" onClick={back} disabled={!canBack || pin} data-tip="뒤로" aria-label="뒤로">
          ←
        </button>
        <button className="toolbar-button" onClick={forward} disabled={!canForward || pin} data-tip="앞으로" aria-label="앞으로">
          →
        </button>
        <Entries />
        <Trail />
      </div>
      <div className="toolbar-tools">
        <Filters />
        <Reload />
        <button className="toolbar-button" aria-label="화면 맞춤" onClick={fitGraph}>
          <span className="toolbar-wide">화면 </span>맞춤
        </button>
        <button className="toolbar-button" aria-label="화면 초기화" onClick={resetView} disabled={pin}>
          <span className="toolbar-wide">화면 </span>초기화
        </button>
        <button className="toolbar-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          {theme === "light" ? "어두운 화면" : "밝은 화면"}
        </button>
      </div>
    </div>
  );
}

export function App() {
  const main = useDefaultLayout({ id: "main", storage: localStorage });
  const opened = useAtlas((s) => s.repo !== null);
  const epoch = useAtlas((s) => s.epoch);

  useEffect(() => (opened ? watch() : undefined), [opened]);

  // 팔레트가 열려 있으면 Esc는 팔레트 입력이 받아 팔레트만 닫는다. 비교 창이 펴져 있으면 그 창만 접는다. 되돌릴 느린 배치가 있으면 그 배치만 취소하고,
  // 정보 패널에 연 파일이 있으면 그 파일만 닫는다. 함수 시점 뷰에서는 구조 뷰로 돌아가고, 구조 뷰에서는 선택을 푼다.
  // 새로고침 단축키는 새로고침 버튼을 누른 것과 같다. 팔레트와 펼친 메뉴, 필터 창, 고정한 선의 말풍선을 닫고 새로고침한다.
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
          if (useCompare.getState().open) {
            useCompare.getState().toggle();
            return;
          }
          if (usePick.getState().close() || state.cancelArranging()) {
            return;
          }
          if (useOpened.getState().path !== null) {
            useOpened.getState().close();
          } else if (state.view.kind === "function") {
            state.leaveFunction();
          } else {
            state.select(null);
          }
        },
        palette: () => useAtlas.getState().setPalette(true),
        reload: () => {
          const button = document.querySelector(".reload-button");
          if (busy() || button === null) {
            return;
          }
          useAtlas.getState().setPalette(false);
          dismiss(button);
          void reload();
        },
      }),
    [],
  );

  return (
    <>
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
                {opened ? <GraphView /> : <Progress />}
                {opened && <InfoPanel key={epoch} />}
                <SummaryNotice />
                <SummaryQueue />
              </div>
              <Palette />
            </div>
          </ReactFlowProvider>
        </Panel>
      </Group>
      <NodeMenu />
      <Tooltip />
    </>
  );
}
