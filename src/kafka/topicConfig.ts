import { TopicConfigEntry } from "./types";

/** New value per setting; `null` resets it to the broker default. */
export type ConfigChanges = Record<string, string | null>;

/**
 * The complete set of topic overrides to send to `admin.alterConfigs`, which
 * (unlike IncrementalAlterConfigs) replaces every override on the topic: any
 * setting left out reverts to its default. So this starts from the current
 * topic-level overrides and applies `changes` on top.
 */
export function mergeTopicOverrides(
  current: TopicConfigEntry[],
  changes: ConfigChanges,
): Array<{ name: string; value: string }> {
  const byName = new Map(current.map((e) => [e.name, e]));
  for (const name of Object.keys(changes)) {
    const entry = byName.get(name);
    if (entry?.readOnly) {
      throw new Error(`"${name}" is read-only.`);
    }
  }
  const overrides = new Map<string, string>();
  for (const e of current) {
    if (!e.isTopicOverride) {
      continue;
    }
    if (e.isSensitive && !(e.name in changes)) {
      // The broker never returns sensitive values, so they can't be carried over.
      throw new Error(`"${e.name}" is a sensitive override that would be lost; change it with kafka-configs instead.`);
    }
    overrides.set(e.name, e.value);
  }
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) {
      overrides.delete(name);
    } else {
      overrides.set(name, value);
    }
  }
  return [...overrides].map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Human-readable before → after lines for the confirmation dialog. */
export function describeChanges(current: TopicConfigEntry[], changes: ConfigChanges): string[] {
  return Object.entries(changes).map(([name, value]) => {
    const before = current.find((e) => e.name === name)?.value ?? "(unset)";
    return value === null ? `${name}: ${before} → default` : `${name}: ${before} → ${value}`;
  });
}
