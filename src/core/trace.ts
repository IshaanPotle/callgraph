/**
 * Tracing + cost accounting.
 *
 * Every model call in the system is wrapped by the tracer. Nothing calls the
 * SDK directly. That single rule is what makes "what did this run cost, and
 * where did the latency go" answerable at the end instead of guessable.
 */

import type { Span } from './types.js';

/** USD per 1M tokens. Cache multipliers follow Anthropic's published ratios. */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache reads bill at a fraction of input. */
  cacheReadMultiplier: number;
  /** Writing a cache entry costs a premium over plain input. */
  cacheWriteMultiplier: number;
}

const PRICING: Record<string, Pricing> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
};

const FALLBACK: Pricing = PRICING['claude-opus-5']!;

export function pricingFor(model: string): Pricing {
  return PRICING[model] ?? FALLBACK;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function costOf(model: string, usage: Usage): number {
  const p = pricingFor(model);
  const uncachedIn = usage.inputTokens;
  return (
    (uncachedIn * p.inputPerMTok +
      usage.cacheReadTokens * p.inputPerMTok * p.cacheReadMultiplier +
      usage.cacheCreationTokens * p.inputPerMTok * p.cacheWriteMultiplier +
      usage.outputTokens * p.outputPerMTok) /
    1_000_000
  );
}

export interface AgentRollup {
  agent: string;
  calls: number;
  failures: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
}

export class Tracer {
  private spans: Span[] = [];
  private seq = 0;

  record(span: Omit<Span, 'id' | 'costUsd'> & { costUsd?: number }): Span {
    const full: Span = {
      ...span,
      id: `span_${(this.seq++).toString().padStart(5, '0')}`,
      costUsd:
        span.costUsd ??
        costOf(span.model, {
          inputTokens: span.inputTokens,
          outputTokens: span.outputTokens,
          cacheReadTokens: span.cacheReadTokens,
          cacheCreationTokens: span.cacheCreationTokens,
        }),
    };
    this.spans.push(full);
    return full;
  }

  all(): Span[] {
    return this.spans;
  }

  totalCost(): number {
    return this.spans.reduce((s, x) => s + x.costUsd, 0);
  }

  totalTokens(): { input: number; output: number; cacheRead: number } {
    return this.spans.reduce(
      (acc, s) => ({
        input: acc.input + s.inputTokens,
        output: acc.output + s.outputTokens,
        cacheRead: acc.cacheRead + s.cacheReadTokens,
      }),
      { input: 0, output: 0, cacheRead: 0 },
    );
  }

  byAgent(): AgentRollup[] {
    const groups = new Map<string, Span[]>();
    for (const s of this.spans) {
      const list = groups.get(s.agent) ?? [];
      list.push(s);
      groups.set(s.agent, list);
    }

    return [...groups.entries()]
      .map(([agent, spans]) => {
        const durations = spans.map((s) => s.durationMs).sort((a, b) => a - b);
        return {
          agent,
          calls: spans.length,
          failures: spans.filter((s) => !s.ok).length,
          retries: spans.reduce((s, x) => s + x.retries, 0),
          inputTokens: spans.reduce((s, x) => s + x.inputTokens, 0),
          outputTokens: spans.reduce((s, x) => s + x.outputTokens, 0),
          cacheReadTokens: spans.reduce((s, x) => s + x.cacheReadTokens, 0),
          costUsd: spans.reduce((s, x) => s + x.costUsd, 0),
          totalMs: spans.reduce((s, x) => s + x.durationMs, 0),
          p50Ms: percentile(durations, 0.5),
          p95Ms: percentile(durations, 0.95),
        };
      })
      .sort((a, b) => b.costUsd - a.costUsd);
  }
}

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}
