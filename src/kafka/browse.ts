import { StartPosition } from "./types";

export interface Watermark {
  partition: number;
  low: string;
  high: string;
}

/** Offsets [from, to) to read from one partition. */
export interface ReadRange {
  partition: number;
  from: bigint;
  to: bigint;
}

function clamp(value: bigint, low: bigint, high: bigint): bigint {
  return value < low ? low : value > high ? high : value;
}

/**
 * Where to read on each partition for a browse request. Pure so the paging
 * rules can be tested without a broker. `byTimestamp` holds the
 * `fetchTopicOffsetsByTimestamp` result for timestamp positions ("-1" when no
 * message is that recent). Empty ranges are dropped.
 */
export function planRanges(
  watermarks: Watermark[],
  position: StartPosition,
  limit: number,
  partition?: number,
  byTimestamp?: Map<number, string>,
): ReadRange[] {
  const count = BigInt(Math.max(1, Math.trunc(limit)));
  const ranges: ReadRange[] = [];
  for (const w of watermarks) {
    if (partition !== undefined && w.partition !== partition) {
      continue;
    }
    const low = BigInt(w.low);
    const high = BigInt(w.high);
    let from: bigint;
    let to: bigint;
    switch (position.kind) {
      case "newest":
        to = high;
        from = clamp(high - count, low, high);
        break;
      case "oldest":
        from = low;
        to = clamp(low + count, low, high);
        break;
      case "offset":
        from = clamp(BigInt(position.offset), low, high);
        to = clamp(from + count, low, high);
        break;
      case "timestamp": {
        const found = byTimestamp?.get(w.partition);
        from = found === undefined || BigInt(found) < 0n ? high : clamp(BigInt(found), low, high);
        to = clamp(from + count, low, high);
        break;
      }
      case "before": {
        // Paging backwards: the `count` offsets just before the oldest one loaded.
        const edge = position.offsets[w.partition];
        if (edge === undefined) {
          continue;
        }
        to = clamp(BigInt(edge), low, high);
        from = clamp(to - count, low, high);
        break;
      }
      case "after": {
        // Paging forwards: the `count` offsets just after the newest one loaded.
        const edge = position.offsets[w.partition];
        if (edge === undefined) {
          continue;
        }
        from = clamp(BigInt(edge) + 1n, low, high);
        to = clamp(from + count, low, high);
        break;
      }
    }
    if (to > from) {
      ranges.push({ partition: w.partition, from, to });
    }
  }
  return ranges.sort((a, b) => a.partition - b.partition);
}

/** Widens each range to `scanLimit` offsets for a search, keeping its start (or its end, when paging backwards). */
export function widenForSearch(
  ranges: ReadRange[],
  watermarks: Watermark[],
  scanLimit: number,
  backwards: boolean,
): ReadRange[] {
  const span = BigInt(Math.max(1, Math.trunc(scanLimit)));
  return ranges.map((r) => {
    const w = watermarks.find((x) => x.partition === r.partition);
    const low = BigInt(w?.low ?? "0");
    const high = BigInt(w?.high ?? "0");
    return backwards
      ? { partition: r.partition, from: clamp(r.to - span, low, high), to: r.to }
      : { partition: r.partition, from: r.from, to: clamp(r.from + span, low, high) };
  });
}

/** Case-insensitive substring match on key, value and header values. */
export function matchesSearch(
  query: string,
  message: { key: string | null; value: string | null; headers: Record<string, string> },
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return [message.key, message.value, ...Object.values(message.headers)].some(
    (text) => text !== null && text.toLowerCase().includes(q),
  );
}
