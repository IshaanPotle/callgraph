/**
 * Deterministic RNG. Everything that touches randomness in this repo goes
 * through here, so a run is reproducible from a single integer seed — which
 * is the only reason "regenerate the corpus and get the same eval numbers"
 * is a true statement.
 */

/** mulberry32 — small, fast, good enough, and identical across platforms. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  float(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() on empty array');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Weighted pick. Weights need not sum to 1. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, w] of entries) {
      r -= w;
      if (r <= 0) return item;
    }
    return entries[entries.length - 1]![0];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  sample<T>(items: readonly T[], n: number): T[] {
    return this.shuffle(items).slice(0, Math.min(n, items.length));
  }

  /** Stable id: seedable, human-readable, no uuid dependency. */
  id(prefix: string): string {
    const hex = Math.floor(this.next() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
    return `${prefix}_${hex}`;
  }
}

/** Deterministic 32-bit hash — used to seed per-call generators from a string. */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
