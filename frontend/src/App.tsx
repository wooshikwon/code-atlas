import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { useEffect } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { GraphView } from "./graph/GraphView";
import { fitPadding, FRAME_ZOOM, stageOf } from "./graph/viewport";
import { Entries } from "./nav/Entries";
import { bind } from "./nav/keys";
import { Trail } from "./nav/Trail";
import { InfoPanel } from "./panel/InfoPanel";
import { useOpened } from "./panel/opened";
import { Palette } from "./search/Palette";
import { useBranch, useStaleCount, watch } from "./state/changes";
import { useAtlas, type Depth } from "./state/store";
import { FileTree } from "./tree/FileTree";

function Toolbar() {
  const stats = useAtlas((s) => s.repo?.stats);
  const stale = useStaleCount();
  const branch = useBranch();
  const functionView = useAtlas((s) => s.view.kind === "function");
  const canBack = useAtlas((s) => s.history.index > 0);
  const canForward = useAtlas((s) => s.history.index < s.history.entries.length - 1);
  const depth = useAtlas((s) => s.depth);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const autoSummary = useAtlas((s) => s.autoSummary);
  const theme = useAtlas((s) => s.theme);
  const back = useAtlas((s) => s.back);
  const forward = useAtlas((s) => s.forward);
  const setDepth = useAtlas((s) => s.setDepth);
  const toggleTests = useAtlas((s) => s.toggleTests);
  const toggleExternal = useAtlas((s) => s.toggleExternal);
  const toggleAutoSummary = useAtlas((s) => s.toggleAutoSummary);
  const setTheme = useAtlas((s) => s.setTheme);
  const { fitView } = useReactFlow();

  const rate = stats === undefined || stats.call_sites === 0 ? "-" : `${Math.round((stats.resolved / stats.call_sites) * 1000) / 10}%`;
  const summary =
    stats === undefined
      ? null
      : `파일 ${stats.files} · 노드 ${stats.nodes} · 선 ${stats.edges} · 호출 확인 ${rate}` +
        ((stats.timed_out ?? 0) > 0 ? ` · 응답 없음 ${stats.timed_out}` : "");

  /** 정보 패널이 가리지 않는 영역에 그래프 전체를 맞춘다. 함수 시점 뷰에서는 확대 비율을 100%보다 키우지 않는다. */
  const fit = () => {
    const graph = document.querySelector(".graph");
    if (graph !== null) {
      void fitView({ padding: fitPadding(stageOf(graph)), maxZoom: functionView ? FRAME_ZOOM : undefined });
    }
  };

  return (
    <div className="toolbar">
      <button className="toolbar-button" onClick={back} disabled={!canBack} title="뒤로" aria-label="뒤로">
        ←
      </button>
      <button className="toolbar-button" onClick={forward} disabled={!canForward} title="앞으로" aria-label="앞으로">
        →
      </button>
      <Trail />
      {summary !== null && (
        <span className="toolbar-stats" title={summary}>
          {summary}
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
          onChange={(event) => setDepth(Number(event.target.value) as Depth)}
        />
        {depth}
      </label>
      <label className="toolbar-toggle">
        <input type="checkbox" checked={showTests} onChange={toggleTests} />
        테스트 코드
      </label>
      <label className="toolbar-toggle">
        <input type="checkbox" checked={showExternal} onChange={toggleExternal} />
        외부 노드
      </label>
      <label className="toolbar-toggle" title="노드를 고르면 캐시에 없는 LLM 요약을 만든다">
        <input type="checkbox" checked={autoSummary} onChange={toggleAutoSummary} />
        자동 요약
      </label>
      <button className="toolbar-button" onClick={fit}>
        화면 맞춤
      </button>
      <button className="toolbar-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
        {theme === "light" ? "어두운 화면" : "밝은 화면"}
      </button>
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
