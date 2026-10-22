import { RawClusterSnapshot } from "./dashboard";
import { partitionLag } from "./lag";

export type IssueLevel = "crit" | "warn" | "info";

/** Every rule dev mode runs; ids are stable so `kafka.devMode.ignoredRules` can turn one off. */
export const ISSUE_RULES = [
  "noController",
  "offlinePartitions",
  "underReplicated",
  "offsetBehindRetention",
  "offsetBeyondLogEnd",
  "orphanedOffsets",
  "lagWithoutMembers",
  "stuckRebalance",
  "growingLag",
  "deadLetterTraffic",
  "similarTopicNames",
] as const;

export type IssueRule = (typeof ISSUE_RULES)[number];

/** A problem found in one scan. `id` is the same across scans while the problem lasts. */
export interface DetectedIssue {
  id: string;
  rule: IssueRule;
  level: IssueLevel;
  topic?: string;
  group?: string;
  text: string;
  /** What it usually means and what to try. */
  hint: string;
}

/** What one scan remembers for the next, to spot trends. In memory only. */
export interface ScanMemory {
  groupStates: Map<string, string>;
  /** Recent total lag readings per group, oldest first. */
  groupLag: Map<string, bigint[]>;
  /** Sum of high watermarks per dead-letter topic: it only grows, even with retention. */
  deadLetterEnds: Map<string, bigint>;
}

/** Consecutive increases before lag counts as growing. */
export const GROWTH_SCANS = 3;
const REBALANCING = new Set(["PreparingRebalance", "CompletingRebalance"]);
const DEAD_LETTER = /(^|[._-])(dlq|dlt|dead[._-]?letters?)$/i;
/** Spring's camel-case suffix: `ordersDLT`. */
const DEAD_LETTER_CAMEL = /[a-z0-9](DLT|DLQ)$/;
/** Pairwise name comparison is quadratic; big clusters skip it. */
const MAX_TOPICS_COMPARED = 500;
const ORDER: Record<IssueLevel, number> = { crit: 0, warn: 1, info: 2 };

export function isDeadLetterTopic(name: string): boolean {
  return !name.startsWith("__") && (DEAD_LETTER.test(name) || DEAD_LETTER_CAMEL.test(name));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function big(value: string | undefined): bigint {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

/** Levenshtein distance, giving up (returning max + 1) once it exceeds `max`. */
export function editDistance(a: string, b: string, max = 1): number {
  if (Math.abs(a.length - b.length) > max) {
    return max + 1;
  }
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > max) {
      return max + 1;
    }
    prev = row;
  }
  return prev[b.length];
}

/** Whether two topic names look like one was meant to be the other (a typo that auto-create turned into a topic). */
export function looksLikeTypo(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[._-]/g, "");
  if (norm(a) === norm(b)) {
    return true;
  }
  if (Math.min(a.length, b.length) < 4 || editDistance(a, b) !== 1) {
    return false;
  }
  // events-1 / events-2, v1 / v2: numbered siblings are deliberate.
  const strip = (s: string) => s.replace(/\d+/g, "#");
  return strip(a) !== strip(b);
}

/**
 * Runs dev mode's rules over one cluster snapshot. Pure: `previous` is the
 * memory returned by the last scan of the same cluster, for trend rules.
 */
export function detectIssues(
  raw: RawClusterSnapshot,
  previous?: ScanMemory,
  ignored: ReadonlySet<string> = new Set(),
): { issues: DetectedIssue[]; memory: ScanMemory } {
  const issues: DetectedIssue[] = [];
  const add = (issue: Omit<DetectedIssue, "id">, key = issue.topic ?? issue.group ?? "") => {
    if (!ignored.has(issue.rule)) {
      issues.push({ ...issue, id: `${issue.rule}:${key}` });
    }
  };
  const memory: ScanMemory = { groupStates: new Map(), groupLag: new Map(), deadLetterEnds: new Map() };
  const topicNames = new Set(raw.topics.map((t) => t.name));

  if (raw.controllerId === null || raw.controllerId < 0) {
    add({
      rule: "noController",
      level: "crit",
      text: "The cluster has no active controller.",
      hint: "Topic creation, leader election and partition moves stall. Check the brokers' (or KRaft controllers') logs and that a quorum is up.",
    });
  }

  for (const topic of raw.topics) {
    const offline = topic.partitions.filter((p) => p.leader < 0).length;
    const under = topic.partitions.filter((p) => p.isr.length < p.replicas.length).length;
    if (offline > 0) {
      add({
        rule: "offlinePartitions",
        level: "crit",
        topic: topic.name,
        text: `${plural(offline, "partition")} of "${topic.name}" have no leader.`,
        hint: "Produce and fetch on those partitions fail. A broker holding their replicas is down; bring it back or check its logs.",
      });
    }
    if (under > 0) {
      add({
        rule: "underReplicated",
        level: "warn",
        topic: topic.name,
        text: `${plural(under, "partition")} of "${topic.name}" are under-replicated.`,
        hint: "A follower fell out of sync, usually because a broker is down, restarting or overloaded. acks=all writes may fail if the ISR drops below min.insync.replicas.",
      });
    }
  }

  for (const group of raw.groups) {
    const behind: string[] = [];
    const beyond: string[] = [];
    const orphaned: string[] = [];
    let lag = 0n;
    for (const { topic, partitions } of group.offsets) {
      const committed = partitions.filter((p) => big(p.offset) >= 0n);
      if (committed.length === 0) {
        continue;
      }
      if (!topicNames.has(topic)) {
        orphaned.push(topic);
        continue;
      }
      const marks = raw.watermarks.get(topic) ?? [];
      let behindCount = 0;
      let beyondCount = 0;
      for (const p of partitions) {
        const mark = marks.find((m) => m.partition === p.partition);
        lag += partitionLag(p.offset, mark?.low ?? "0", mark?.high ?? "0");
        const offset = big(p.offset);
        if (!mark || offset < 0n) {
          continue;
        }
        if (offset < big(mark.low)) {
          behindCount++;
        } else if (offset > big(mark.high)) {
          beyondCount++;
        }
      }
      if (behindCount > 0) {
        behind.push(`${topic} (${plural(behindCount, "partition")})`);
      }
      if (beyondCount > 0) {
        beyond.push(`${topic} (${plural(beyondCount, "partition")})`);
      }
    }

    const g = group.groupId;
    if (behind.length > 0) {
      add({
        rule: "offsetBehindRetention",
        level: "warn",
        group: g,
        text: `"${g}" committed offsets that retention already deleted: ${behind.join(", ")}.`,
        hint: "The consumer will fall back to auto.offset.reset and silently skip (latest) or replay (earliest) messages. Raise retention.ms or keep the consumer running.",
      });
    }
    if (beyond.length > 0) {
      add({
        rule: "offsetBeyondLogEnd",
        level: "warn",
        group: g,
        text: `"${g}" committed offsets past the end of the log: ${beyond.join(", ")}.`,
        hint: "Typical after deleting and recreating a topic in dev. The consumer will reset per auto.offset.reset; reset the group's offsets to earliest to read the new data.",
      });
    }
    if (orphaned.length > 0) {
      add({
        rule: "orphanedOffsets",
        level: "info",
        group: g,
        text: `"${g}" still has offsets for deleted topic${orphaned.length === 1 ? "" : "s"} ${orphaned.map((t) => `"${t}"`).join(", ")}.`,
        hint: "Harmless until a topic with that name is created again; then the group resumes from the old offsets. Delete the group or its offsets if it's no longer used.",
      });
    }
    if (group.state === "Empty" && lag > 0n) {
      add({
        rule: "lagWithoutMembers",
        level: "warn",
        group: g,
        text: `"${g}" is ${lag.toLocaleString()} messages behind and has no running consumers.`,
        hint: "The app consuming this group is stopped or crashed. Start it, or delete the group if it's left over from an old run.",
      });
    }
    if (REBALANCING.has(group.state) && previous?.groupStates.get(g) === group.state) {
      add({
        rule: "stuckRebalance",
        level: "warn",
        group: g,
        text: `"${g}" has been in ${group.state} since the last scan.`,
        hint: "A member is likely slow to rejoin: processing longer than max.poll.interval.ms, a crash loop, or members repeatedly joining and leaving.",
      });
    }

    const readings = [...(previous?.groupLag.get(g) ?? []), lag].slice(-(GROWTH_SCANS + 1));
    memory.groupLag.set(g, readings);
    memory.groupStates.set(g, group.state);
    const growing = readings.length > GROWTH_SCANS && readings.every((v, i) => i === 0 || v > readings[i - 1]);
    if (growing && group.memberCount > 0) {
      add({
        rule: "growingLag",
        level: "warn",
        group: g,
        text: `"${g}" lag grew in each of the last ${GROWTH_SCANS} scans (${readings[0].toLocaleString()} → ${lag.toLocaleString()}).`,
        hint: "Consumers are running but slower than producers. Look for slow processing or retries, or add consumers (up to the partition count).",
      });
    }
  }

  for (const topic of raw.topics) {
    if (!isDeadLetterTopic(topic.name)) {
      continue;
    }
    const marks = raw.watermarks.get(topic.name) ?? [];
    const end = marks.reduce((sum, m) => sum + big(m.high), 0n);
    memory.deadLetterEnds.set(topic.name, end);
    const before = previous?.deadLetterEnds.get(topic.name);
    if (before !== undefined && end > before) {
      // Its own id, so new failures notify even while the "holds messages" note is showing.
      add(
        {
          rule: "deadLetterTraffic",
          level: "warn",
          topic: topic.name,
          text: `${(end - before).toLocaleString()} new message(s) in dead-letter topic "${topic.name}" since the last scan.`,
          hint: "Something is failing to process messages. Open the topic and look at the latest messages and their error headers.",
        },
        `${topic.name}\u0000new`,
      );
    }
    const retained = marks.reduce((sum, m) => sum + (big(m.high) > big(m.low) ? big(m.high) - big(m.low) : 0n), 0n);
    if (retained > 0n) {
      add({
        rule: "deadLetterTraffic",
        level: "info",
        topic: topic.name,
        text: `Dead-letter topic "${topic.name}" holds ${retained.toLocaleString()} message(s).`,
        hint: "Messages that failed processing. Open the topic to see why, then replay or purge them.",
      });
    }
  }

  const userTopics = raw.topics.map((t) => t.name).filter((n) => !n.startsWith("_")).sort();
  if (userTopics.length <= MAX_TOPICS_COMPARED) {
    for (let i = 0; i < userTopics.length; i++) {
      for (let j = i + 1; j < userTopics.length; j++) {
        const [a, b] = [userTopics[i], userTopics[j]];
        if (looksLikeTypo(a, b)) {
          add(
            {
              rule: "similarTopicNames",
              level: "info",
              topic: a,
              text: `Topics "${a}" and "${b}" have nearly the same name.`,
              hint: "Often a typo in a producer or consumer config that auto.create.topics.enable turned into a new topic, so one side never sees the other's messages.",
            },
            `${a}\u0000${b}`,
          );
        }
      }
    }
  }

  issues.sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.id.localeCompare(b.id));
  return { issues, memory };
}

/** Issues in `next` that weren't in `previous`, and ids of those that went away. */
export function diffIssues(
  previous: readonly DetectedIssue[],
  next: readonly DetectedIssue[],
): { added: DetectedIssue[]; resolved: DetectedIssue[] } {
  const before = new Set(previous.map((i) => i.id));
  const after = new Set(next.map((i) => i.id));
  return {
    added: next.filter((i) => !before.has(i.id)),
    resolved: previous.filter((i) => !after.has(i.id)),
  };
}
