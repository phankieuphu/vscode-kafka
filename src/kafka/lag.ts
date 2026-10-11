/**
 * Messages a consumer still has to read on one partition.
 *
 * - No committed offset (`-1`): everything still retained, `high - low`.
 *   Counting from 0 would include messages retention already deleted.
 * - A commit below `low` (retention passed it): the consumer can only resume
 *   at `low`, so the same `high - low`.
 * - A commit above `high` (topic truncated or recreated): 0, never negative.
 */
export function partitionLag(committed: string, low: string, high: string): bigint {
  const lo = BigInt(low);
  const hi = BigInt(high);
  const retained = hi > lo ? hi - lo : 0n;
  const offset = BigInt(committed);
  if (offset < 0n) {
    return retained;
  }
  const lag = hi - offset;
  return lag < 0n ? 0n : lag > retained ? retained : lag;
}
