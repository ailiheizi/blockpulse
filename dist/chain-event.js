/** Busy-block event: how many of the next blocks carry at least BUSY_TX_MIN transactions.
 * Pure helpers shared by the engine and the block feed; no I/O here.
 */
export const EVENT_WINDOW_BLOCKS = 180;
export const EVENT_LOCK_BLOCKS = 165;
export const EVENT_TOLERANCE = 3;
export const BUSY_TX_MIN = 3;
export const BASELINE_BLOCKS = 600;
export const MIN_BASELINE_BLOCKS = 300;
// Virtual clock: one observed block advances the round by this many nominal ms.
export const CHAIN_BLOCK_MS = 300;
const MIN_RATE = 0.05;
const MAX_RATE = 0.95;

export const isBusy = txCount => Number.isInteger(txCount) && txCount >= BUSY_TX_MIN;

/** Baseline from the most recent blocks: clamped busy rate and the expected busy count. */
export function baselineFromBlocks(blocks, windowBlocks = EVENT_WINDOW_BLOCKS) {
  const sample = blocks.slice(-BASELINE_BLOCKS);
  if (sample.length < MIN_BASELINE_BLOCKS) return null;
  const busyBlocks = sample.filter(block => isBusy(block.tx)).length;
  const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, busyBlocks / sample.length));
  return { sampleBlocks: sample.length, busyBlocks, rate, expected: Math.round(rate * windowBlocks) };
}

/** Binomial(n, rate) probability mass for 0..n. The rate is clamped, so no term underflows. */
export function busyPmf(n, rate) {
  const p = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
  const pmf = new Array(n + 1);
  pmf[0] = (1 - p) ** n;
  for (let k = 0; k < n; k += 1) pmf[k + 1] = pmf[k] * (n - k) / (k + 1) * p / (1 - p);
  const total = pmf.reduce((sum, value) => sum + value, 0);
  return pmf.map(value => value / total);
}
