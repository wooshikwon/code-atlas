// 항목을 세로로 늘어놓은 메뉴. 상단 줄의 진입점 목록과 노드의 우클릭 메뉴가 함께 쓴다. 문서 최상위에 화면 좌표로 그리고,
// 화면 끝을 넘으면 안으로 당기며 길면 메뉴 안에서 스크롤한다. 화살표·Home·End로 항목을 옮기고 Enter·Space로 고르며,
// Esc, Tab, 메뉴 밖 클릭, 창 크기 변화에 닫힌다. 닫히면 열기 전에 초점이 있던 요소로 초점을 돌려준다.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  key: string;
  label: ReactNode;
  /** 고를 수 없는 항목. 흐리게 그리고 화살표가 건너뛴다. */
  disabled?: boolean;
  /** 항목이 가리키는 노드 id */
  node?: string;
  /** 항목의 글자가 잘렸을 때 말풍선이 적는 줄이지 않은 이름 */
  full?: string;
  tip?: string;
  run(): void;
}

interface MenuListProps {
  /** 접근성 이름 */
  label: string;
  id?: string;
  items: MenuItem[];
  /** 메뉴 왼쪽 위 모서리의 화면 좌표 */
  at: { x: number; y: number };
  /** 키보드로 열었으면 참. 첫 항목을 활성 항목으로 두고 연다. */
  first: boolean;
  /** 메뉴를 연 버튼. 이 요소를 누른 것은 메뉴 밖 클릭으로 세지 않는다. */
  anchor?: RefObject<HTMLElement | null>;
  onClose(): void;
}

/** 화면 끝과 메뉴 사이에 남기는 폭 */
const EDGE = 8;

export function MenuList({ label, id, items, at, first, anchor, onClose }: MenuListProps) {
  const list = useRef<HTMLUListElement | null>(null);
  const enabled = items.flatMap((item, index) => (item.disabled === true ? [] : [index]));
  const [active, setActive] = useState(first ? (enabled[0] ?? -1) : -1);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const element = list.current!;
    const left = Math.max(EDGE, Math.min(at.x, window.innerWidth - EDGE - element.offsetWidth));
    const top = Math.max(EDGE, Math.min(at.y, window.innerHeight - EDGE - element.offsetHeight));
    element.style.transform = `translate(${left}px, ${top}px)`;
  }, [at.x, at.y, items.length]);

  useEffect(() => {
    const opener = document.activeElement;
    list.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (list.current?.contains(target) !== true && anchor?.current?.contains(target) !== true) {
        close.current();
      }
    };
    const resized = () => close.current();
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", resized);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", resized);
      if (opener instanceof HTMLElement && opener.isConnected && (document.activeElement === document.body || document.activeElement === null)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [anchor]);

  useEffect(() => {
    list.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: MenuItem) => {
    if (item.disabled !== true) {
      onClose();
      item.run();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const at = enabled.indexOf(active);
    /** 활성 항목이 없으면 아래 화살표는 첫 항목으로, 위 화살표는 마지막 항목으로 간다. 끝에서는 반대쪽 끝으로 넘어간다. */
    const step = (by: 1 | -1) => setActive(enabled[at < 0 ? (by === 1 ? 0 : enabled.length - 1) : (at + by + enabled.length) % enabled.length] ?? -1);
    switch (event.key) {
      case "ArrowDown":
        step(1);
        break;
      case "ArrowUp":
        step(-1);
        break;
      case "Home":
        setActive(enabled[0] ?? -1);
        break;
      case "End":
        setActive(enabled.at(-1) ?? -1);
        break;
      case "Enter":
      case " ":
        if (active >= 0) {
          choose(items[active]);
        }
        break;
      case "Escape":
      case "Tab":
        onClose();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const itemId = (index: number) => `${id ?? "menu"}-item-${index}`;
  return createPortal(
    <ul
      ref={list}
      id={id}
      className="menu"
      role="menu"
      aria-label={label}
      aria-activedescendant={active < 0 ? undefined : itemId(active)}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setActive(-1)}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <li
          key={item.key}
          id={itemId(index)}
          className="menu-item"
          role="menuitem"
          aria-disabled={item.disabled === true ? true : undefined}
          data-active={index === active ? "" : undefined}
          data-key={item.key}
          data-node={item.node}
          data-full={item.full}
          data-tip={item.tip}
          onMouseMove={() => item.disabled !== true && index !== active && setActive(index)}
          onClick={() => choose(item)}
        >
          {item.label}
        </li>
      ))}
    </ul>,
    document.body,
  );
}
