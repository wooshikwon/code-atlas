// LLM 요약 호출의 토큰 사용량을 더하고 화면에 적는 글로 바꾼다. 토큰 수는 `graph/names.ts`의 `kilo`로 줄여 적는다. 진행 칸과 정보 패널의 요약 칸이 같은 글을 적는다.
import type { Usage } from "../api/types";
import { kilo } from "../graph/names";

/** 사용량 둘을 더한다. 한쪽이 없으면 다른 쪽이고, 둘 다 없으면 null이다. */
export function added(sum: Usage | null, usage: Usage | null): Usage | null {
  if (sum === null || usage === null) {
    return sum ?? usage;
  }
  return {
    input: sum.input + usage.input,
    cache_write: sum.cache_write + usage.cache_write,
    cache_read: sum.cache_read + usage.cache_read,
    output: sum.output + usage.output,
  };
}

/** `입력 21k · 출력 9k`. 입력은 캐시에서 읽지 않은 입력(`input`과 캐시에 새로 넣은 `cache_write`의 합)이다. */
export function usageText(usage: Usage): string {
  return `입력 ${kilo(usage.input + usage.cache_write)} · 출력 ${kilo(usage.output)}`;
}

/** 사용량 글의 말풍선. 호출마다 캐시에서 읽는 공통 지시문의 토큰 수를 따로 적는다. */
export function cacheTip(usage: Usage): string {
  return `캐시에서 읽은 입력 ${kilo(usage.cache_read)}`;
}
