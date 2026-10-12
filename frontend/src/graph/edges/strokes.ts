// 선의 기하. 직각 경로의 모서리를 둥글린 SVG 경로와, 경로를 긴 선과 장식 밑의 토막으로 가르는 계산이다. 그리는 층(`EdgeLayer.tsx`)과
// 선 컴포넌트가 이 값을 받아 그리고, 이 파일은 DOM을 모른다.
//
// 선 묶음 하나에는 긴 선과 장식(화살촉, 숫자, 합류점과 갈림점의 원, 빨강 점)이 겹쳐 있다. 묶음 전체에 불투명도를 주면 브라우저가 그 묶음을
// 덮는 크기의 버퍼를 따로 만들어 합성하므로, 긴 선은 선의 불투명도(`stroke-opacity`)로 긋고 장식만 작은 묶음에 넣어 묶음의 불투명도를 준다.
// 장식 밑을 지나는 선 토막을 그 작은 묶음으로 옮기면 겹치는 부분이 한 번만 합성돼 묶음 전체에 불투명도를 준 모습과 같다.
import type { Box, Point } from "../layout";

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

function toward(from: Point, to: Point, length: number): Point {
  const span = distance(from, to);
  return span === 0 ? from : { x: from.x + ((to.x - from.x) * length) / span, y: from.y + ((to.y - from.y) * length) / span };
}

/** 점 here의 모서리를 반지름 r로 둥글린 2차 곡선의 길이. 곡선 위의 속력을 심프슨 공식으로 더한다. */
function curveLength(prev: Point, here: Point, next: Point, r: number): number {
  const [a, b] = [toward(here, prev, r), toward(here, next, r)];
  const speed = (t: number) => 2 * Math.hypot((1 - t) * (here.x - a.x) + t * (b.x - here.x), (1 - t) * (here.y - a.y) + t * (b.y - here.y));
  const steps = 16;
  let sum = speed(0) + speed(1);
  for (let i = 1; i < steps; i++) {
    sum += speed(i / steps) * (i % 2 === 1 ? 4 : 2);
  }
  return sum / (3 * steps);
}

/** 점마다 둥글리는 반지름. 꺾이는 점은 radius이고 선분이 짧으면 선분 절반으로 줄인다. 두 끝점은 0이다. */
export function cornerRadii(points: Point[], radius: number): number[] {
  return points.map((here, i) => (i === 0 || i === points.length - 1 ? 0 : Math.min(radius, distance(points[i - 1], here) / 2, distance(here, points[i + 1]) / 2)));
}

/** 점을 잇고 점마다 반지름 radii의 2차 곡선으로 둥글린 SVG 경로 */
export function pathOf(points: Point[], radii: number[]): string {
  if (points.length === 0) {
    return "";
  }
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = toward(points[i], points[i - 1], radii[i]);
    const b = toward(points[i], points[i + 1], radii[i]);
    d += ` L${a.x},${a.y} Q${points[i].x},${points[i].y} ${b.x},${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

/** 장식 하나가 선을 덮는 범위. box는 그 사각형 안을 지나는 선이고, tail은 묶음 piece의 끝에서 그 길이만큼(화살촉)이다. */
export type Cover = { box: Box } | { piece: number; tail: number };

/** 장식 묶음 하나. covers는 함께 묶인 장식의 번호(`split`에 넘긴 순서)이고, d는 그 밑을 지나는 선 토막이다. tip이면 d의 끝에 화살촉을 단다. */
export interface Part {
  covers: number[];
  d: string;
  tip: boolean;
}

/** 긴 선의 경로 d와 장식 묶음 */
export interface Split {
  d: string;
  parts: Part[];
}

/** 선분 a-b가 사각형 box 안에 있는 구간을 선분 위의 비율 [0, 1]로 돌려준다. 지나지 않으면 null이다. */
function within(a: Point, b: Point, box: Box): [number, number] | null {
  let [lo, hi] = [0, 1];
  for (const [from, delta, min, max] of [
    [a.x, b.x - a.x, box.x, box.x + box.width],
    [a.y, b.y - a.y, box.y, box.y + box.height],
  ]) {
    if (delta === 0) {
      if (from < min || from > max) {
        return null;
      }
      continue;
    }
    const [t1, t2] = [(min - from) / delta, (max - from) / delta];
    lo = Math.max(lo, Math.min(t1, t2));
    hi = Math.min(hi, Math.max(t1, t2));
  }
  return lo <= hi ? [lo, hi] : null;
}

/** 묶음 하나의 길이 계산. 위치는 둥글리기 전 꺾은선을 따라 잰 길이로 다루고, 점선의 위상은 둥글린 경로의 길이로 맞춘다. */
function measure(points: Point[], radius: number) {
  const radii = cornerRadii(points, radius);
  const at = points.map((_, i) => points.slice(1, i + 1).reduce((sum, p, j) => sum + distance(points[j], p), 0));
  const total = at[at.length - 1] ?? 0;
  /** 모서리의 곡선이 차지하는 구간. 이 안에서는 선을 가르지 않는다. */
  const curves = points.map((_, i) => [at[i] - radii[i], at[i] + radii[i]] as const).filter((_, i) => radii[i] > 0);
  /** 점마다 둥글린 곡선이 두 변을 따라가는 길(반지름의 2배)보다 짧은 길이 */
  const saved = radii.map((r, i) => (r > 0 ? 2 * r - curveLength(points[i - 1], points[i], points[i + 1], r) : 0));
  /** 꺾은선 위의 위치를 둥글린 경로의 길이로 바꾼다. 곡선 안의 위치는 받지 않는다. */
  const drawn = (s: number) => s - saved.reduce((sum, less, i) => sum + (at[i] < s ? less : 0), 0);
  const free = (s: number) => curves.every(([lo, hi]) => s <= lo || s >= hi);
  /**
   * 위치 s에서 toward(-1은 시작 쪽, 1은 끝 쪽)로 가장 가까운 가를 수 있는 위치. 곡선 밖이고, period가 있으면 둥글린 경로의 길이가
   * period의 배수인 곳이다. 그런 곳이 없으면 묶음의 끝이다.
   */
  const snap = (s: number, toward: -1 | 1, period: number): number => {
    const end = toward < 0 ? 0 : total;
    let here = Math.min(total, Math.max(0, s));
    for (const [lo, hi] of toward < 0 ? [...curves].reverse() : curves) {
      if (here > lo && here < hi) {
        here = toward < 0 ? lo : hi;
      }
    }
    if (period === 0 || here === end) {
      return here;
    }
    const whole = toward < 0 ? Math.floor(drawn(here) / period) : Math.ceil(drawn(here) / period);
    for (let step = whole; toward < 0 ? step > 0 : step * period < drawn(total); step += toward) {
      // 직선 구간에서는 꺾은선의 길이와 둥글린 경로의 길이가 같은 양만큼 는다.
      const run = [0, ...curves.map(([, hi]) => hi)].filter((start) => drawn(start) <= step * period).at(-1)!;
      const spot = run + step * period - drawn(run);
      if (spot >= 0 && spot <= total && free(spot) && (toward < 0 ? spot <= here : spot >= here)) {
        return spot;
      }
    }
    return end;
  };
  /** 꺾은선의 from부터 to까지를 둥글린 경로 */
  const piece = (from: number, to: number): string => {
    if (points.length < 2) {
      return pathOf(points, radii);
    }
    const point = (s: number) => {
      const i = Math.max(1, at.findIndex((length) => length >= s));
      return toward(points[i - 1], points[i], s - at[i - 1]);
    };
    const inner = points.map((_, i) => i).filter((i) => at[i] > from && at[i] < to);
    return pathOf([point(from), ...inner.map((i) => points[i]), point(to)], [0, ...inner.map((i) => radii[i]), 0]);
  };
  return { points, at, total, snap, piece };
}

/**
 * 선분 묶음 pieces를 긴 선과 장식 묶음으로 가른다. covers는 장식이 선을 덮는 범위다. 덮는 구간이 겹치거나 한 장식이 여러 묶음을 덮으면
 * 그 장식을 한 묶음으로 합친다. 가르는 위치는 모서리의 곡선 밖이고, 점선이면(period는 점선 한 주기의 길이, 실선은 0) 주기의 배수여서
 * 갈라 그린 토막의 점선이 가르기 전과 같은 위상으로 시작한다.
 */
export function split(pieces: Point[][], covers: Cover[], period: number, radius: number): Split {
  const measured = pieces.map((points) => measure(points, radius));
  /** 묶음마다 덮인 구간과 그 구간을 덮는 장식 */
  const cuts = measured.map((one, index) => {
    const spans: { from: number; to: number; covers: number[] }[] = [];
    covers.forEach((cover, id) => {
      let [from, to] = [Infinity, -Infinity];
      if ("tail" in cover) {
        if (cover.piece === index) {
          [from, to] = [one.total - cover.tail, one.total];
        }
      } else {
        one.points.slice(1).forEach((b, i) => {
          const inside = within(one.points[i], b, cover.box);
          if (inside !== null) {
            const length = one.at[i + 1] - one.at[i];
            from = Math.min(from, one.at[i] + inside[0] * length);
            to = Math.max(to, one.at[i] + inside[1] * length);
          }
        });
      }
      if (from <= to) {
        spans.push({ from: one.snap(from, -1, period), to: one.snap(to, 1, period), covers: [id] });
      }
    });
    spans.sort((a, b) => a.from - b.from);
    return spans.reduce<typeof spans>((merged, span) => {
      const last = merged.at(-1);
      if (last !== undefined && span.from <= last.to) {
        last.to = Math.max(last.to, span.to);
        last.covers.push(...span.covers);
      } else {
        merged.push({ ...span, covers: [...span.covers] });
      }
      return merged;
    }, []);
  });

  // 같은 구간을 덮거나 같은 장식을 나눠 가진 구간을 한 장식 묶음으로 모은다.
  const group = covers.map((_, id) => id);
  const root = (id: number): number => (group[id] === id ? id : (group[id] = root(group[id])));
  cuts.flat().forEach((span) => span.covers.forEach((id) => (group[root(id)] = root(span.covers[0]))));

  const long: string[] = [];
  const stubs = new Map<number, { d: string; tip: boolean }[]>();
  measured.forEach((one, index) => {
    let from = 0;
    for (const span of cuts[index]) {
      if (span.from > from) {
        long.push(one.piece(from, span.from));
      }
      const tip = span.covers.some((id) => "tail" in covers[id]);
      stubs.set(root(span.covers[0]), [...(stubs.get(root(span.covers[0])) ?? []), { d: one.piece(span.from, span.to), tip }]);
      from = span.to;
    }
    if (one.total > from || one.total === 0) {
      long.push(one.piece(from, one.total));
    }
  });
  const parts = [...new Set(covers.map((_, id) => root(id)))].map((lead): Part => {
    // 화살촉은 경로의 끝에 달리므로 화살촉을 다는 토막을 마지막에 둔다.
    const mine = [...(stubs.get(lead) ?? [])].sort((a, b) => Number(a.tip) - Number(b.tip));
    return { covers: covers.map((_, id) => id).filter((id) => root(id) === lead), d: mine.map((stub) => stub.d).join(" "), tip: mine.some((stub) => stub.tip) };
  });
  return { d: long.join(" "), parts };
}
