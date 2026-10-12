// 선을 그리는 층. React Flow는 선마다 `<svg>`를 따로 만들므로 선을 React Flow에 넘기지 않고, 화면 이동과 확대를 함께 받는 뷰포트 안에
// `<svg>` 두 장을 두어 직접 그린다. `<svg>`의 수는 선의 수와 무관하다. 선의 묶음(`.edge`)과 그 안의 경로는
// 선 컴포넌트(`OrthogonalEdge.tsx`, `Trunk.tsx`)가 그리고, 이 층은 겹침 순서와 마우스 처리기를 맡는다.
import { ViewportPortal } from "@xyflow/react";
import { memo, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { LAYER } from "../layers";
import { OrthogonalEdge, type FlowEdge } from "./OrthogonalEdge";
import { Trunk } from "./Trunk";

/** 진하기가 바뀌는 시간. `styles.css`의 `.edge`의 전환 시간과 같다. */
const FADE_MS = 200;

type Handler = (event: ReactMouseEvent) => void;

interface Handlers {
  onClick: Handler;
  onEnter: Handler;
  onMove: Handler;
  onLeave: Handler;
}

const drawing = (edge: FlowEdge, clone: boolean) => (edge.type === "trunk" ? <Trunk data={edge.data} clone={clone} /> : <OrthogonalEdge data={edge.data} clone={clone} />);

/**
 * 선 하나. 마우스를 올린 선도 이 요소가 마우스를 받고, 그리는 것만 숨긴 채 위층의 `Raised`가 대신 그린다. 마우스 밑의 요소를 다른
 * `<svg>`로 옮기면 브라우저가 마우스가 나갔다 들어온 것으로 알리기 때문이다. shades에는 위층에 그리지 않을 때의 진하기를 적어 둔다.
 */
const EdgeItem = memo(function EdgeItem({ edge, shades, onClick, onEnter, onMove, onLeave }: { edge: FlowEdge; shades: Map<string, number> } & Handlers) {
  const raised = edge.zIndex === LAYER.pointed;
  const shade = edge.data.opacity;
  useLayoutEffect(() => {
    if (!raised) {
      shades.set(edge.id, shade);
    }
  }, [shades, edge.id, shade, raised]);
  return (
    <g className="react-flow__edge nopan" data-id={edge.id} data-raised={raised ? "" : undefined} onClick={onClick} onMouseEnter={onEnter} onMouseMove={onMove} onMouseLeave={onLeave}>
      {drawing(edge, false)}
    </g>
  );
});

/**
 * 마우스를 올린 선을 다른 선 위의 층에 그린 것. 마우스를 받지 않는다. 같은 요소에서는 CSS 전환으로 바뀌는 진하기를, 새로 만들어지는
 * 이 요소에서는 올리기 전의 진하기부터 같은 시간과 곡선으로 한 번 움직인다.
 */
const Raised = memo(function Raised({ edge, shades }: { edge: FlowEdge; shades: Map<string, number> }) {
  const element = useRef<SVGGElement>(null);
  useLayoutEffect(() => {
    const before = shades.get(edge.id);
    const group = element.current?.querySelector<SVGGElement>(".edge");
    if (before !== undefined && before !== edge.data.opacity && group != null && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      group.animate({ "--shade": [String(before), String(edge.data.opacity)] }, { duration: FADE_MS, easing: "ease-out" });
    }
    // 처음 그릴 때만 올리기 전의 진하기와 견준다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <g ref={element} className="edge-raised" data-of={edge.id}>
      {drawing(edge, true)}
    </g>
  );
});

/**
 * edges를 `<svg>` 두 장에 그린다. 아래 장은 모든 선을 edges의 순서대로 그려 뒤의 선이 위에 놓이고, 위 장은 마우스를 올린 선
 * (`zIndex`가 `LAYER.pointed`)만 한 번 더 그린다.
 */
export function EdgeLayer({ edges, ...handlers }: { edges: FlowEdge[] } & Handlers) {
  const shades = useRef(new Map<string, number>()).current;
  useLayoutEffect(() => {
    const drawn = new Set(edges.map((edge) => edge.id));
    [...shades.keys()].filter((id) => !drawn.has(id)).forEach((id) => shades.delete(id));
  }, [edges, shades]);
  return (
    <ViewportPortal>
      <div className="react-flow__edges">
        <svg style={{ zIndex: LAYER.edge }}>
          {edges.map((edge) => (
            <EdgeItem key={edge.id} edge={edge} shades={shades} {...handlers} />
          ))}
        </svg>
        <svg style={{ zIndex: LAYER.pointed }}>
          {edges
            .filter((edge) => edge.zIndex === LAYER.pointed)
            .map((edge) => (
              <Raised key={edge.id} edge={edge} shades={shades} />
            ))}
        </svg>
      </div>
    </ViewportPortal>
  );
}
