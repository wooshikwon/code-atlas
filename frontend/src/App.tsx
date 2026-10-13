import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { usePick } from "./graph/aim";
import { useFlight } from "./graph/flight";
import { GraphView } from "./graph/GraphView";
import { Progress } from "./graph/Progress";
import { SummaryQueue } from "./graph/SummaryQueue";
import { Tooltip } from "./graph/Tooltip";
import { autoView, fitIn, stageOf } from "./graph/viewport";
import { host } from "./host";
import { Entries } from "./nav/Entries";
import { Filters } from "./nav/Filters";
import { Reload } from "./nav/Reload";
import { bind, dismiss, historyName } from "./nav/keys";
import { judge } from "./nav/layout";
import { LayoutButton } from "./nav/LayoutButton";
import { NodeMenu, SummaryNotice } from "./nav/NodeMenu";
import { Trail } from "./nav/Trail";
import { Asks } from "./open/Asks";
import { Tools } from "./open/Tools";
import { Starting, useBackend, Welcome } from "./open/Welcome";
import { Docked } from "./panel/Docked";
import { Floating } from "./panel/Floating";
import { useOpened } from "./panel/opened";
import { MIN_HEIGHT, MIN_WIDTH } from "./panel/rect";
import { Palette } from "./search/Palette";
import { watch } from "./state/changes";
import { useCompare } from "./state/compare";
import { asking, useOpening } from "./state/opening";
import { busy, reload } from "./state/reload";
import { useStatus } from "./state/status";
import { litOf, pinned, useAtlas, type Mode } from "./state/store";
import { asked, useSummaries } from "./state/summaries";
import { useTools } from "./state/tools";
import { FileTree } from "./tree/FileTree";

function Toolbar({ mode }: { mode: Mode }) {
  const canBack = useAtlas((s) => s.history.index > 0);
  const canForward = useAtlas((s) => s.history.index < s.history.entries.length - 1);
  /** 경로 고정 중에는 뒤로·앞으로 버튼을 누를 수 없다. */
  const pin = useAtlas((s) => pinned(s.finder));
  const theme = useAtlas((s) => s.theme);
  const back = useAtlas((s) => s.back);
  const forward = useAtlas((s) => s.forward);
  const setTheme = useAtlas((s) => s.setTheme);
  const resetView = useAtlas((s) => s.resetView);
  const { fit, fly } = useFlight();
  const { getNodes, getNodesBounds } = useReactFlow();

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

  // 모드를 바꾸면 관계 그래프 영역의 크기가 바뀐다. 전체 맞춤 상태였으면 새 영역에서 코드가 스스로 맞추는 화면(`autoView`)으로 다시 맞춘다.
  // 새 칸 묶음이 영역의 크기를 정한 뒤(ResizeObserver), 그 크기를 받은 정보 패널이 다시 그려진 다음 프레임에 영역을 읽는다.
  useEffect(() => {
    const graph = document.querySelector(".graph");
    const { fitted, view } = useAtlas.getState();
    if (graph === null || !fitted || view.kind !== "structure") {
      return;
    }
    let frame = 0;
    const sized = new ResizeObserver(() => {
      sized.disconnect();
      frame = requestAnimationFrame(() => {
        const { free } = stageOf(graph);
        const bounds = getNodesBounds(getNodes());
        fly(autoView(fitIn(bounds, free), bounds, free), free);
      });
    });
    sized.observe(graph);
    return () => {
      sized.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [mode, fly, getNodes, getNodesBounds]);

  return (
    <div className="toolbar">
      <div className="toolbar-nav">
        <button className="toolbar-button" onClick={back} disabled={!canBack || pin} data-tip={`뒤로 ${historyName("back")}`} aria-label="뒤로">
          ←
        </button>
        <button className="toolbar-button" onClick={forward} disabled={!canForward || pin} data-tip={`앞으로 ${historyName("forward")}`} aria-label="앞으로">
          →
        </button>
        <Entries />
        <Trail />
      </div>
      <div className="toolbar-tools">
        <LayoutButton mode={mode} />
        <Filters />
        <Reload />
        <button className="toolbar-button toolbar-texts" aria-label="화면 맞춤" onClick={fitGraph}>
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

/** 창의 크기 */
const windowSize = () => ({ width: window.innerWidth, height: window.innerHeight });

export function App() {
  const main = useDefaultLayout({ id: "main-v2", storage: localStorage });
  const rows = useDefaultLayout({ id: "portrait-v1", storage: localStorage });
  const bottom = useDefaultLayout({ id: "portrait-bottom-v1", storage: localStorage });
  const opened = useAtlas((s) => s.repo !== null);
  const epoch = useAtlas((s) => s.epoch);
  const backend = useBackend();
  /** 서버의 상태를 받았는지와, 받았으면 연 레포가 없는지 */
  const known = useStatus((s) => s.status !== null);
  const idle = useStatus((s) => s.status?.phase === "idle");
  const layout = useAtlas((s) => s.layout);
  /** 창의 크기로 판정한 모드. 창 크기가 바뀔 때마다 다시 판정한다. */
  const [judged, setJudged] = useState(() => judge(windowSize()));
  const mode = layout ?? judged;
  /**
   * 작업 영역(상단 줄, 관계 그래프 영역, 팔레트)을 그리는 DOM 요소. 모드를 바꾸면 칸 묶음을 새로 그리므로, 작업 영역은 이 요소에 그려 두고
   * 요소를 새 칸으로 옮겨 붙인다. 관계 그래프와 그 화면 위치, 배치가 모드를 바꿔도 그대로 남는다.
   */
  const [workspace] = useState(() => Object.assign(document.createElement("div"), { className: "workspace" }));
  /** 작업 영역의 칸에 넣는 ref. `Panel`은 내용을 칸 요소 안의 요소 하나에 그리므로 그 요소에 붙인다. */
  const seat = useCallback((panel: HTMLDivElement | null) => void panel?.firstElementChild?.appendChild(workspace), [workspace]);

  useEffect(() => {
    const read = () => setJudged(judge(windowSize()));
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  useEffect(() => (opened ? watch() : undefined), [opened]);

  // 레포를 여는 동안 뜬 창이 있으면 Esc는 그 창만 닫고, 환경 점검 화면이 떠 있으면 그 화면만 닫는다. 팔레트가 열려 있으면 Esc는 팔레트 입력이 받아 팔레트만 닫는다. 비교 창이 펴져 있으면 그 창만 접는다. 되돌릴 느린 배치가 있으면 그 배치만 취소하고,
  // 정보 패널에 연 파일이 있으면 그 파일만 닫는다. 함수 시점 뷰에서는 구조 뷰로 돌아가고, 구조 뷰에서는 선택을 푼다.
  // 새로고침 단축키는 새로고침 버튼을 누른 것과 같다. 팔레트와 펼친 메뉴, 필터 창, 고정한 선의 말풍선을 닫고 새로고침한다.
  // 요약 단축키는 정보 패널의 LLM 요약 칸에 보이는 버튼("요약 생성", "다시 시도", "다시 생성")을 누른 것과 같고, 접힌 요약 칸은 편다.
  useEffect(
    () =>
      bind({
        back: () => useAtlas.getState().back(),
        forward: () => useAtlas.getState().forward(),
        escape: () => {
          const state = useAtlas.getState();
          if (asking(useOpening.getState())) {
            useOpening.getState().cancel();
            return;
          }
          if (useTools.getState().shown) {
            useTools.getState().hide();
            return;
          }
          if (state.paletteOpen) {
            return;
          }
          if (state.legendOpen) {
            state.toggleLegend();
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
        summarize: () => {
          const node = document.querySelector<HTMLElement>(".info-panel-summary")?.dataset.node;
          const refresh = node === undefined ? null : asked(useSummaries.getState().states[node]);
          if (node === undefined || refresh === null) {
            return;
          }
          if (!useAtlas.getState().summaryOpen) {
            useAtlas.getState().toggleSummary();
          }
          useSummaries.getState().make(node, refresh);
        },
      }),
    [],
  );

  // 앱은 백엔드가 떠서 첫 상태를 줄 때까지 칸 묶음을 그리지 않는다. 연 레포가 없으면 칸 묶음 대신 레포 열기 화면을 그린다.
  if (host.app && (backend.phase !== "ready" || !known)) {
    return <Starting backend={backend} />;
  }
  if (idle) {
    return (
      <>
        <Welcome />
        <Tools />
        <Asks />
        <Tooltip />
      </>
    );
  }

  return (
    <>
      {mode === "landscape" ? (
        <Group
          key="main"
          id="main"
          className="app"
          orientation="horizontal"
          defaultLayout={main.defaultLayout}
          onLayoutChanged={main.onLayoutChanged}
        >
          <Panel id="explorer" defaultSize={208} minSize={160} maxSize="40">
            <FileTree />
          </Panel>
          <Separator className="separator" />
          <Panel id="workspace" minSize="30" elementRef={seat} />
        </Group>
      ) : (
        <Group key="portrait" id="portrait" className="app" orientation="vertical" defaultLayout={rows.defaultLayout} onLayoutChanged={rows.onLayoutChanged}>
          <Panel id="workspace" defaultSize="60" minSize="30" elementRef={seat} />
          <Separator className="separator" />
          <Panel id="lower" defaultSize="40" minSize={MIN_HEIGHT}>
            <Group id="portrait-bottom" orientation="horizontal" defaultLayout={bottom.defaultLayout} onLayoutChanged={bottom.onLayoutChanged}>
              <Panel id="explorer" defaultSize={208} minSize={160} maxSize="40">
                <FileTree />
              </Panel>
              <Separator className="separator" />
              <Panel id="info" minSize={MIN_WIDTH}>
                {opened && <Docked key={epoch} />}
              </Panel>
            </Group>
          </Panel>
        </Group>
      )}
      {createPortal(
        <ReactFlowProvider>
          <Toolbar mode={mode} />
          <div className="stage">
            {opened ? <GraphView /> : <Progress />}
            {opened && mode === "landscape" && <Floating key={epoch} />}
            <SummaryNotice />
            <SummaryQueue />
          </div>
          <Palette />
        </ReactFlowProvider>,
        workspace,
      )}
      <NodeMenu />
      <Tools />
      <Asks />
      <Tooltip />
    </>
  );
}
