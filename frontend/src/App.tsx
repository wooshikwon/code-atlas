import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { FIT_PADDING, GraphView } from "./graph/GraphView";
import { InfoPanel } from "./panel/InfoPanel";
import { Palette } from "./search/Palette";
import { useAtlas, type Depth } from "./state/store";
import { FileTree } from "./tree/FileTree";

function Toolbar() {
  const stats = useAtlas((s) => s.repo?.stats);
  const canBack = useAtlas((s) => s.history.index > 0);
  const canForward = useAtlas((s) => s.history.index < s.history.entries.length - 1);
  const depth = useAtlas((s) => s.depth);
  const showTests = useAtlas((s) => s.showTests);
  const showExternal = useAtlas((s) => s.showExternal);
  const theme = useAtlas((s) => s.theme);
  const back = useAtlas((s) => s.back);
  const forward = useAtlas((s) => s.forward);
  const setDepth = useAtlas((s) => s.setDepth);
  const toggleTests = useAtlas((s) => s.toggleTests);
  const toggleExternal = useAtlas((s) => s.toggleExternal);
  const setTheme = useAtlas((s) => s.setTheme);
  const { fitView } = useReactFlow();

  return (
    <div className="toolbar">
      <button className="toolbar-button" onClick={back} disabled={!canBack} title="뒤로" aria-label="뒤로">
        ←
      </button>
      <button className="toolbar-button" onClick={forward} disabled={!canForward} title="앞으로" aria-label="앞으로">
        →
      </button>
      <div className="toolbar-trail" />
      {stats !== undefined && (
        <span className="toolbar-stats">
          파일 {stats.files} · 노드 {stats.nodes} · 선 {stats.edges} · 호출 확인{" "}
          {stats.call_sites === 0 ? "-" : `${Math.round((stats.resolved / stats.call_sites) * 1000) / 10}%`}
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
      <button className="toolbar-button" onClick={() => void fitView({ padding: FIT_PADDING })}>
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
