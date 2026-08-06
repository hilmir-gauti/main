/**
 * Interval arithmetic over epoch-millisecond ranges.
 *
 * The availability engine is built entirely from these four operations:
 * merge overlapping windows, subtract busy time, intersect two sets of
 * windows, and slice a window into candidate slots. Keeping the maths here
 * (and pure) makes it straightforward to test exhaustively.
 *
 * Every interval is half-open: `[start, end)`. Two appointments where one ends
 * exactly when the next begins do not overlap.
 */

export interface Interval {
  start: number;
  end: number;
}

export function isValid(interval: Interval): boolean {
  return Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

export function durationMs(interval: Interval): number {
  return Math.max(0, interval.end - interval.start);
}

/**
 * Sorts, drops empty intervals, and merges any that overlap or touch.
 * Touching intervals are merged so that two back-to-back busy blocks do not
 * leave a phantom zero-length gap between them.
 */
export function merge(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(isValid).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const current of sorted) {
    const last = out[out.length - 1];
    if (last && current.start <= last.end) {
      if (current.end > last.end) last.end = current.end;
    } else {
      out.push({ start: current.start, end: current.end });
    }
  }
  return out;
}

/** Removes `blockers` from `base`, returning the remaining free windows. */
export function subtract(base: readonly Interval[], blockers: readonly Interval[]): Interval[] {
  const busy = merge(blockers);
  const out: Interval[] = [];

  for (const window of merge(base)) {
    let cursor = window.start;
    for (const block of busy) {
      if (block.end <= cursor) continue; // entirely before the remaining window
      if (block.start >= window.end) break; // busy list is sorted; nothing else can overlap
      if (block.start > cursor) out.push({ start: cursor, end: block.start });
      cursor = Math.max(cursor, block.end);
      if (cursor >= window.end) break;
    }
    if (cursor < window.end) out.push({ start: cursor, end: window.end });
  }
  return out;
}

/** Windows present in both sets. */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const left = merge(a);
  const right = merge(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const x = left[i]!;
    const y = right[j]!;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end });
    if (x.end < y.end) i++;
    else j++;
  }
  return out;
}

/** Total covered time in milliseconds, counting overlaps once. */
export function totalMs(intervals: readonly Interval[]): number {
  return merge(intervals).reduce((sum, i) => sum + durationMs(i), 0);
}

/**
 * Slices a free window into candidate start times.
 *
 * @param window     the free window to slice
 * @param durationMsNeeded total time the appointment occupies (service + buffers)
 * @param stepMs     spacing between candidate starts (slot granularity)
 * @param alignTo    optional anchor so slots land on clean clock times
 *                   (e.g. the day's opening minute) rather than on whatever
 *                   ragged boundary the previous booking happened to end at
 */
export function sliceSlots(
  window: Interval,
  durationMsNeeded: number,
  stepMs: number,
  alignTo?: number,
): number[] {
  if (durationMsNeeded <= 0 || stepMs <= 0) return [];

  let cursor = window.start;
  if (alignTo !== undefined && stepMs > 0) {
    const offset = ((window.start - alignTo) % stepMs + stepMs) % stepMs;
    if (offset !== 0) cursor = window.start + (stepMs - offset);
  }

  const starts: number[] = [];
  // Guard against pathological inputs producing an unbounded loop.
  const maxSlots = 5000;
  while (cursor + durationMsNeeded <= window.end && starts.length < maxSlots) {
    starts.push(cursor);
    cursor += stepMs;
  }
  return starts;
}

/** Clamps intervals to `bounds`, dropping anything fully outside. */
export function clampAll(intervals: readonly Interval[], bounds: Interval): Interval[] {
  return intervals
    .map((i) => ({ start: Math.max(i.start, bounds.start), end: Math.min(i.end, bounds.end) }))
    .filter(isValid);
}
