import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { useEffect, useRef } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { GraphView } from "./graph/GraphView";
import { fitPadding, FRAME_ZOOM, stageOf } from "./graph/viewport";
import { Entries } from "./nav/Entries";
import { useFit } from "./nav/fit";
import { bind } from "./nav/keys";
import { Toggles } from "./nav/Toggles";
import { Trail } from "./nav/Trail";
import { InfoPanel } from "./panel/InfoPanel";
import { useOpened } from "./panel/opened";
import { Palette } from "./search/Palette";
import { useBranch, useStaleCount, watch } from "./state/changes";
import { pinned, useAtlas, type Depth } from "./state/store";
import { FileTree } from "./tree/FileTree";

function Toolbar() {
  const stats = useAtlas((s) => s.repo?.stats);
  const stale = useStaleCount();
  const branch = useBranch();
  const functionView = useAtlas((s) => s.view.kind === "function");
  const canBack = useAtlas((s) => s.history.index > 0);
  const canForward = useAtlas((s) => s.history.index < s.history.entries.length - 1);
  const depth = useAtlas((s) => s.depth);
  /** 경로 고정 중에는 뒤로·앞으로 버튼과 흐름 단계 슬라이더를 누를 수 없다. */
  const pin = useAtlas((s) => pinned(s.finder));
  const theme = useAtlas((s) => s.theme);
  const back = useAtlas((s) => s.back);
  const forward = useAtlas((s) => s.forward);
  const setDepth = useAtlas((s) => s.setDepth);
  const setTheme = useAtlas((s) => s.setTheme);
  const { fitView } = useReactFlow();

  const rate = stats === undefined || stats.call_sites === 0 ? "-" : `${Math.round((stats.resolved / stats.call_sites) * 1000) / 10}%`;
  /** 통계 문구의 뒤쪽. 줄 폭이 모자라면 이 문구만 적는다. */
  const brief =
    stats === undefined ? null : `호출 확인 ${rate}` + ((stats.timed_out ?? 0) > 0 ? ` · 응답 없음 ${stats.timed_out}` : "");
  const summary = stats === undefined ? null : `파일 ${stats.files} · 노드 ${stats.nodes} · 선 ${stats.edges} · ${brief}`;

  /** 정보 패널이 가리지 않는 영역에 그래프 전체를 맞춘다. 함수 시점 뷰에서는 확대 비율을 100%보다 키우지 않는다. */
  const fitGraph = () => {
    const graph = document.querySelector(".graph");
    if (graph !== null) {
      void fitView({ padding: fitPadding(stageOf(graph)), maxZoom: functionView ? FRAME_ZOOM : undefined });
    }
  };

  const bar = useRef<HTMLDivElement | null>(null);
  const tools = useRef<HTMLDivElement | null>(null);
  const fit = useFit(bar, tools, `${summary}|${branch}|${stale}`);

  return (
    <div className="toolbar" data-fit={fit} ref={bar}>
      <div className="toolbar-nav">
        <button className="toolbar-button" onClick={back} disabled={!canBack || pin} title="뒤로" aria-label="뒤로">
          ←
        </button>
        <button className="toolbar-button" onClick={forward} disabled={!canForward || pin} title="앞으로" aria-label="앞으로">
          →
        </button>
        <Trail fit={fit} />
      </div>
      <div className="toolbar-tools" ref={tools}>
        {summary !== null && (
          <span className="toolbar-stats" title={summary}>
            <span className="toolbar-stats-full">{summary}</span>
            <span className="toolbar-stats-brief">{brief}</span>
          </span>
        )}
        <Entries />
        {branch !== null && (
          <span className="toolbar-branch" title="현재 git 브랜치">
            브랜치 {branch}
          </span>
        )}
        {stale > 0 && (
          <span className="toolbar-stale" title="그래프의 노드와 줄 범위는 레포를 열 때 분석한 값이다">
            분석 뒤 바뀐 파일 {stale}개
          </span>
        )}
        <label className="toolbar-toggle">
          흐름 단계
          <input
            type="range"
            min={1}
            max={3}
            value={depth}
            disabled={pin}
            onChange={(event) => setDepth(Number(event.target.value) as Depth)}
          />
          {depth}
        </label>
        <Toggles />
        <button className="toolbar-button" onClick={fitGraph}>
          화면 맞춤
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
