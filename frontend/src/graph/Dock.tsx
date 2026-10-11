// 그래프 왼쪽 아래에 모은 칸. 아랫줄에 미니맵 버튼, 범례 버튼, 경로 찾기 버튼을 나란히 두고, 그 위에 펼친 미니맵과 범례,
// 경로 탐색 창을 아래 끝을 맞춰 나란히 둔다. 세 칸을 나란히 둘 폭이 없으면 오른쪽 칸부터 위로 올라간다.
import { Finder, FinderButton } from "../route/Finder";
import { Legend, LegendButton } from "./Legend";
import { Minimap, MinimapButton } from "./Minimap";

export function Dock() {
  return (
    <div className="dock">
      <div className="dock-panels">
        <Minimap />
        <Legend />
        <Finder />
      </div>
      <div className="dock-buttons">
        <MinimapButton />
        <LegendButton />
        <FinderButton />
      </div>
    </div>
  );
}
