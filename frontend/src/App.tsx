import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { CodeView } from "./code/CodeView";
import { GraphView } from "./graph/GraphView";
import { useAtlas } from "./state/AtlasProvider";
import { FileTree } from "./tree/FileTree";

function Toolbar() {
  const { repo, showTests, theme, toggleTests, setTheme } = useAtlas();
  const stats = repo?.stats;

  return (
    <div className="toolbar">
      {stats !== undefined && (
        <span className="toolbar-stats">
          파일 {stats.files} · 노드 {stats.nodes} · 선 {stats.edges} · 호출 확인{" "}
          {stats.call_sites === 0 ? "-" : `${Math.round((stats.resolved / stats.call_sites) * 1000) / 10}%`}
        </span>
      )}
      <span className="toolbar-spacer" />
      <label className="toolbar-toggle">
        <input type="checkbox" checked={showTests} onChange={toggleTests} />
        테스트 코드
      </label>
      <button className="toolbar-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
        {theme === "light" ? "어두운 화면" : "밝은 화면"}
      </button>
    </div>
  );
}

export function App() {
  const main = useDefaultLayout({ id: "main", storage: localStorage });
  const views = useDefaultLayout({ id: "views", storage: localStorage });

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
        <div className="workspace">
          <Toolbar />
          <Group
            id="views"
            className="views"
            orientation="vertical"
            defaultLayout={views.defaultLayout}
            onLayoutChanged={views.onLayoutChanged}
          >
            <Panel id="graph" defaultSize="65" minSize="20">
              <GraphView />
            </Panel>
            <Separator className="separator separator-horizontal" />
            <Panel id="code" minSize="10">
              <CodeView />
            </Panel>
          </Group>
        </div>
      </Panel>
    </Group>
  );
}
