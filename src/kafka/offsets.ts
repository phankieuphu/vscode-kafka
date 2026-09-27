import { GroupOffsetEntry, OffsetMove } from "./types";

export type PlannableSpec =
  | { mode: "earliest" | "latest" }
  | { mode: "shift"; by: number };

export interface ResetPreview {
  moves: OffsetMove[];
  lagBefore: string;
  lagAfter: string;
}

function clamp(value: bigint, low: bigint, high: bigint): bigint {
  return value < low ? low : value > high ? high : value;
}

export function planReset(
  entries: GroupOffsetEntry[],
  topic: string,
  spec: PlannableSpec,
): ResetPreview {
  let lagBefore = 0n;
  let lagAfter = 0n;
  const moves: OffsetMove[] = [];
  for (const entry of entries) {
    if (entry.topic !== topic) {
      continue;
    }
    const low = BigInt(entry.low);
    const high = BigInt(entry.high);
    const committed = entry.offset === "-1" ? null : BigInt(entry.offset);
    lagBefore += committed === null ? high : high - committed;

    const target =
      spec.mode === "shift"
        ? clamp((committed ?? low) + BigInt(Math.trunc(spec.by)), low, high)
        : spec.mode === "earliest"
          ? low
          : high;
    lagAfter += high - target;
    moves.push({ partition: entry.partition, from: entry.offset, to: target.toString() });
  }
  moves.sort((a, b) => a.partition - b.partition);
  return { moves, lagBefore: lagBefore.toString(), lagAfter: lagAfter.toString() };
}
