// 가로창 모드와 세로창 모드 가운데 쓸 모드를 창의 크기로 판정하고, 상단 줄의 모드 버튼에 적는 글을 정한다.
import type { Mode } from "../state/store";

/** 창의 크기로 판정한 모드. 창의 높이가 폭보다 크면 세로창 모드다. */
export function judge(size: { width: number; height: number }): Mode {
  return size.height > size.width ? "portrait" : "landscape";
}

/** 모드 버튼을 누르면 바뀌는 모드 */
export function other(mode: Mode): Mode {
  return mode === "landscape" ? "portrait" : "landscape";
}

/** 모드 버튼의 말풍선 글이자 접근성 이름. 지금 쓰는 모드 mode에서 누르면 바뀌는 모드를 적는다. */
export function layoutTip(mode: Mode): string {
  return mode === "landscape" ? "세로창 모드로 바꾸기" : "가로창 모드로 바꾸기";
}
