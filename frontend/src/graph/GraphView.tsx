import { useAtlas } from "../state/AtlasProvider";

export function GraphView() {
  const { graph } = useAtlas();

  return (
    <div className="graph">
      <div className="graph-empty">
        {graph === null ? "불러오는 중" : `노드 ${graph.nodes.length}개, 선 ${graph.edges.length}개`}
      </div>
    </div>
  );
}
