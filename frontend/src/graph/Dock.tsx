// 그래프 왼쪽 아래에 모은 칸. 아랫줄에 미니맵 버튼과 범례 버튼을 나란히 두고, 그 위에 펼친 미니맵과 범례를 나란히 둔다.
// 두 칸을 나란히 둘 폭이 없으면 범례가 미니맵 위로 올라간다.
import { Legend, LegendButton } from "./Legend";
import { Minimap, MinimapButton } from "./Minimap";

export function Dock() {
  return (
    <div className="dock">
      <div className="dock-panels">
        <Minimap />
        <Legend />
      </div>
      <div className="dock-buttons">
        <MinimapButton />
        <LegendButton />
      </div>
    </div>
  );
}
