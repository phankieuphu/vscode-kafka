import { GroupOffsetEntry } from "./types";

/** Readings kept per watched group (in memory only). */
export const HISTORY_SIZE = 30;

export interface LagSample {
  /** Epoch ms. */
  at: number;
  total: bigint;
  partitions: GroupOffsetEntry[];
}

/** Ring buffer of lag readings per key (cluster + group). */
export class LagHistory {
  private readonly samples = new Map<string, LagSample[]>();

  constructor(private readonly size = HISTORY_SIZE) {}

  push(key: string, sample: LagSample): void {
    const list = this.samples.get(key) ?? [];
    list.push(sample);
    if (list.length > this.size) {
      list.splice(0, list.length - this.size);
    }
    this.samples.set(key, list);
  }

  get(key: string): LagSample[] {
    return this.samples.get(key) ?? [];
  }

  /** Drops keys not in `keep` (alert removed). */
  retain(keep: ReadonlySet<string>): void {
    for (const key of [...this.samples.keys()]) {
      if (!keep.has(key)) {
        this.samples.delete(key);
      }
    }
  }
}

export function toSample(entries: GroupOffsetEntry[], at = Date.now()): LagSample {
  return { at, total: entries.reduce((s, e) => s + BigInt(e.lag), 0n), partitions: entries };
}

export type LagTrend = "growing" | "draining" | "flat" | "spiky" | "unknown";

/**
 * The shape of total lag over the readings:
 * - flat: within 5% of the peak from first to last, with no big swing
 * - growing / draining: most steps go one way and it ends higher / lower
 * - spiky: rose to a peak well above both ends (a burst), or jumps both ways
 */
export function classifyTrend(totals: bigint[]): LagTrend {
  if (totals.length < 3) {
    return "unknown";
  }
  const first = totals[0];
  const last = totals[totals.length - 1];
  const peak = totals.reduce((m, v) => (v > m ? v : m), 0n);
  const floor = totals.reduce((m, v) => (v < m ? v : m), peak);
  if (peak === 0n) {
    return "flat";
  }
  const tolerance = peak / 20n; // 5%
  const swing = peak - floor;
  const diff = last > first ? last - first : first - last;
  if (diff <= tolerance && swing <= tolerance * 2n) {
    return "flat";
  }
  let up = 0;
  let down = 0;
  for (let i = 1; i < totals.length; i++) {
    if (totals[i] > totals[i - 1]) {
      up++;
    } else if (totals[i] < totals[i - 1]) {
      down++;
    }
  }
  const steps = totals.length - 1;
  // A burst: the peak is in the middle, far above where it started and ended.
  const peakIndex = totals.indexOf(peak);
  if (peakIndex > 0 && peakIndex < totals.length - 1 && peak > first * 2n && peak > last * 2n - last / 2n && last < peak) {
    return "spiky";
  }
  if (last > first && up >= steps * 0.6) {
    return "growing";
  }
  if (last < first && down >= steps * 0.6) {
    return "draining";
  }
  return "spiky";
}

export type LagFindingKind =
  | "consumer-down"
  | "stuck-partition"
  | "rebalancing"
  | "producer-burst"
  | "falling-behind"
  | "catching-up"
  | "unassigned";

export interface LagFinding {
  kind: LagFindingKind;
  text: string;
  topic?: string;
  partition?: number;
}

export interface GroupState {
  state: string;
  memberCount: number;
  /** "topic/partition" keys some member owns. */
  assigned?: ReadonlySet<string>;
}

/**
 * What the readings say, without any model: consumer down, a stuck
 * partition (likely a poison message), rebalancing, a producer burst, or
 * consumers that can't keep up.
 */
export function analyzeLag(samples: LagSample[], group?: GroupState): { trend: LagTrend; findings: LagFinding[] } {
  const trend = classifyTrend(samples.map((s) => s.total));
  const findings: LagFinding[] = [];
  const latest = samples[samples.length - 1];

  if (group && /rebalanc/i.test(group.state)) {
    findings.push({ kind: "rebalancing", text: `The group is rebalancing (${group.state}): nothing is consumed until it finishes. Repeated rebalances usually mean consumers exceed max.poll.interval.ms or keep restarting.` });
  }
  if (group && (group.memberCount === 0 || /^(Empty|Dead)$/i.test(group.state))) {
    findings.push({ kind: "consumer-down", text: `The group has no active members (state ${group.state}): no consumer is running, so lag only grows.` });
  }

  if (samples.length >= 3 && latest) {
    const first = samples[0];
    const moved: Array<{ topic: string; partition: number; progressed: boolean; produced: boolean; lag: bigint }> = [];
    for (const p of latest.partitions) {
      const start = first.partitions.find((q) => q.topic === p.topic && q.partition === p.partition);
      if (!start) {
        continue;
      }
      moved.push({
        topic: p.topic,
        partition: p.partition,
        progressed: BigInt(p.offset) > BigInt(start.offset),
        produced: BigInt(p.high) > BigInt(start.high),
        lag: BigInt(p.lag),
      });
    }
    const stuck = moved.filter((m) => !m.progressed && m.produced && m.lag > 0n);
    const anyProgress = moved.some((m) => m.progressed);
    if (stuck.length > 0 && stuck.length === moved.length && !anyProgress) {
      if (!findings.some((f) => f.kind === "consumer-down")) {
        findings.push({ kind: "consumer-down", text: `No partition's committed offset moved in ${samples.length} readings while messages kept arriving: the consumers are stopped, hung, or not committing.` });
      }
    } else if (stuck.length > 0) {
      for (const s of stuck.slice(0, 5)) {
        findings.push({
          kind: "stuck-partition",
          topic: s.topic,
          partition: s.partition,
          text: `${s.topic}/${s.partition} is stuck: its committed offset hasn't moved in ${samples.length} readings while other partitions progress (lag ${s.lag.toLocaleString()}). Often a message the consumer keeps failing on.`,
        });
      }
    }
    if (group?.assigned) {
      const unassigned = latest.partitions.filter((p) => BigInt(p.lag) > 0n && !group.assigned!.has(`${p.topic}/${p.partition}`));
      if (unassigned.length > 0 && group.memberCount > 0) {
        findings.push({ kind: "unassigned", text: `${unassigned.length} partition(s) with lag have no consumer assigned (${unassigned.slice(0, 5).map((p) => `${p.topic}/${p.partition}`).join(", ")}).` });
      }
    }
  }

  if (trend === "spiky") {
    findings.push({ kind: "producer-burst", text: "Lag spiked and is coming back down: most likely a producer burst the consumers are now working through." });
  } else if (trend === "growing" && !findings.some((f) => f.kind === "consumer-down" || f.kind === "stuck-partition")) {
    findings.push({ kind: "falling-behind", text: "Lag grows across readings while consumers still make progress: they consume slower than producers write. Add consumers (up to the partition count) or speed up processing." });
  } else if (trend === "draining") {
    findings.push({ kind: "catching-up", text: "Lag is going down: the consumers are catching up." });
  }
  return { trend, findings };
}

/** One line per reading, oldest first, for prompts. */
export function formatHistory(samples: LagSample[]): string {
  if (samples.length === 0) {
    return "No readings yet.";
  }
  const start = samples[0].at;
  return samples.map((s) => `- +${Math.round((s.at - start) / 1000)}s: total lag ${s.total.toString()}`).join("\n");
}
