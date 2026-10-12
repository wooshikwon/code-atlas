// LLM 요약 호출의 토큰 사용량을 더하고 화면에 적는 글로 바꾼다. 진행 칸과 정보 패널의 요약 칸이 같은 글을 적는다.
import type { Usage } from "../api/types";

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

/** 토큰 수를 적는 글. 1,000 미만은 그대로 적고, 그 이상은 k 단위로 10k 미만은 소수 한 자리까지, 10k부터는 정수로 반올림해 적는다. */
export function kilo(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }
  const k = tokens / 1000;
  return `${k < 9.95 ? k.toFixed(1) : Math.round(k)}k`;
}

/** `입력 21k · 출력 9k`. 입력은 캐시에서 읽지 않은 입력(`input`과 캐시에 새로 넣은 `cache_write`의 합)이다. */
export function usageText(usage: Usage): string {
  return `입력 ${kilo(usage.input + usage.cache_write)} · 출력 ${kilo(usage.output)}`;
}

/** 사용량 글의 말풍선. 호출마다 캐시에서 읽는 공통 지시문의 토큰 수를 따로 적는다. */
export function cacheTip(usage: Usage): string {
  return `캐시에서 읽은 입력 ${kilo(usage.cache_read)}`;
}
