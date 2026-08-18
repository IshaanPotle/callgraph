/**
 * Bounded sampling.
 *
 * The discovery layer's entire cost argument rests on this file. Against a
 * corpus of millions of calls you cannot read everything to work out what the
 * columns should be — and you don't need to, because schema structure
 * saturates fast. What you do need is a sample that isn't accidentally all
 * easy calls.
 *
 * So the sample is stratified on the two axes that actually move extraction
 * difficulty: which vertical the call came from, and how badly the ASR
 * mangled it. A naive random sample of 24 would, at this corpus's noise
 * distribution, routinely miss the worst decile entirely and produce a schema
 * tuned to clean audio.
 */

import { Rng } from '../core/rng.js';
import type { Transcript } from '../core/types.js';

export interface Sample {
  callIds: string[];
  strategy: string;
  /** Per-stratum counts, so the sample is auditable rather than asserted. */
  strata: { key: string; pool: number; drawn: number }[];
}

const QUALITY_BANDS = [
  { key: 'clean', lo: 0.85, hi: 1.01 },
  { key: 'mixed', lo: 0.7, hi: 0.85 },
  { key: 'degraded', lo: 0, hi: 0.7 },
] as const;

export function stratifiedSample(corpus: Transcript[], size: number, seed: number): Sample {
  const rng = new Rng(seed ^ 0x5a17);

  const buckets = new Map<string, Transcript[]>();
  for (const t of corpus) {
    const band = QUALITY_BANDS.find((b) => t.asrConfidence >= b.lo && t.asrConfidence < b.hi);
    const key = `${t.vertical}/${band?.key ?? 'clean'}`;
    buckets.set(key, [...(buckets.get(key) ?? []), t]);
  }

  const keys = [...buckets.keys()].sort();
  const base = Math.floor(size / keys.length);
  const remainder = size - base * keys.length;

  // Spread the remainder over the largest strata rather than the first ones,
  // so a stratum with two calls in it doesn't get over-drawn.
  const order = [...keys].sort((a, b) => (buckets.get(b)!.length - buckets.get(a)!.length) || a.localeCompare(b));
  const quota = new Map(keys.map((k) => [k, base]));
  for (let i = 0; i < remainder; i++) {
    const k = order[i % order.length]!;
    quota.set(k, quota.get(k)! + 1);
  }

  const callIds: string[] = [];
  const strata: Sample['strata'] = [];

  for (const key of keys) {
    const pool = buckets.get(key)!;
    const want = Math.min(quota.get(key)!, pool.length);
    const drawn = rng.sample(pool, want);
    callIds.push(...drawn.map((t) => t.callId));
    strata.push({ key, pool: pool.length, drawn: drawn.length });
  }

  // Deficits in small strata (a vertical with few degraded calls) get topped
  // up from whatever's left, so the sample size is the size you asked for.
  if (callIds.length < size) {
    const taken = new Set(callIds);
    const rest = corpus.filter((t) => !taken.has(t.callId));
    for (const t of rng.sample(rest, size - callIds.length)) callIds.push(t.callId);
  }

  return {
    callIds,
    strategy: 'stratified by vertical × ASR-confidence band, proportional with largest-remainder top-up',
    strata,
  };
}

/** Split a sample into disjoint slices, one per proposer. */
export function slice<T>(items: T[], parts: number): T[][] {
  const out: T[][] = Array.from({ length: parts }, () => []);
  items.forEach((item, i) => out[i % parts]!.push(item));
  return out;
}
