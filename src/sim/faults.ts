/**
 * Deliberate, recorded corruption of simulated extractions.
 *
 * This exists to answer a question the eval harness cannot answer about itself:
 * does it actually detect errors, or does it merely produce numbers?
 *
 * Against a real model that question is unanswerable. You never learn what the
 * true error was — only what your gold labels say, which is the very thing under
 * test. Against a simulator you can inject a known error at a known rate in a
 * known place, run the eval blind, and check whether the number that comes back
 * is the number you put in. An eval nobody has validated is just more code that
 * agrees with itself, and this is the one setup where validating it is possible.
 *
 * The corruptions are modelled on how extractors actually fail rather than on
 * random noise, because the failures have to be the kind the harness would meet
 * in production:
 *
 *   substitute — a plausible wrong value from the same column. The confusion a
 *                model makes between `churn_risk` and `escalated`, not between
 *                `churn_risk` and `qgx`.
 *   drop       — a value that was there, missed. Silent, and the expensive one.
 *   digit      — a transposed or altered digit in a number. Invisible to every
 *                check that treats a value as a token rather than a quantity.
 *
 * Confidence is deliberately left untouched. A wrong extraction that announces
 * itself with low confidence is the easy case, already handled by the gate; the
 * case worth measuring is the one that is wrong and sure of itself. Evidence
 * spans are also left pointing where they were, which means the grounding
 * checks get a fair chance to catch the substitution on their own — and whether
 * they do is precisely what the eval is for.
 */

import { hashString } from '../core/rng.js';
import type { DiscoveredField, FieldExtraction } from '../core/types.js';

export type FaultKind = 'substitute' | 'drop' | 'digit';

export interface InjectedFault {
  callId: string;
  field: string;
  kind: FaultKind;
  from: string;
  to: string | null;
}

export interface FaultOptions {
  /** Share of eligible (non-null) extracted values to corrupt. */
  rate: number;
  seed: number;
}

export class FaultInjector {
  readonly injected: InjectedFault[] = [];

  private rate: number;
  private seed: number;
  /** Null until `arm`, and inert until then. */
  private fields: Map<string, DiscoveredField> | null = null;

  constructor(opts: FaultOptions) {
    this.rate = opts.rate;
    this.seed = opts.seed;
  }

  /**
   * Enable injection, once the schema is known.
   *
   * Discovery therefore runs clean, which is intentional: the claim being tested
   * is that the eval detects *extraction* error. Corrupting the schema proposals
   * too would change which columns exist, and then a missing column and a wrong
   * value would be indistinguishable in the final score — the harness would be
   * measuring two things and reporting one number.
   */
  arm(fields: DiscoveredField[]): void {
    this.fields = new Map(fields.map((f) => [f.name, f]));
  }

  get armed(): boolean {
    return this.fields !== null;
  }

  /** Corrupt a share of one call's extracted values, in place. */
  corrupt(callId: string, extracted: Record<string, FieldExtraction>): void {
    if (!this.fields) return;

    for (const [name, extraction] of Object.entries(extracted)) {
      const field = this.fields.get(name);
      if (!field || extraction.value === null) continue;

      // Hashed rather than drawn from a generator: extraction runs concurrently,
      // and a shared RNG would hand out different numbers depending on which
      // call finished first. The injected set has to be reproducible, or the
      // thing it is validating is not.
      if (draw(`fault:${this.seed}:${callId}:${name}`) >= this.rate) continue;

      const from = String(extraction.value);
      const to = this.pick(field, callId, from);
      if (to === undefined) continue;

      extraction.value = to;
      this.injected.push({ callId, field: name, kind: kindOf(field, to), from, to: asText(to) });
    }
  }

  /** `undefined` means "no realistic corruption available; leave it alone". */
  private pick(
    field: DiscoveredField,
    callId: string,
    from: string,
  ): string | number | boolean | null | undefined {
    const d = draw(`fault-kind:${this.seed}:${callId}:${field.name}`);

    // A fifth of corruptions are drops regardless of type. Every column can be
    // missed, and a missed value is the failure mode that no downstream check
    // can see, so it must be represented in every column's error mix.
    if (d < 0.2) return null;

    if (field.type === 'number') {
      const n = Number(from);
      if (!Number.isFinite(n)) return null;
      return perturbDigits(n, `fault-digit:${this.seed}:${callId}:${field.name}`);
    }

    if (field.type === 'boolean') return from !== 'true';

    const alternatives = (field.enumValues ?? []).filter((v) => v !== from);
    if (alternatives.length === 0) return undefined;
    return alternatives[Math.floor(d * alternatives.length) % alternatives.length]!;
  }
}

/**
 * Alter one digit, preserving magnitude.
 *
 * $12,329 becoming $12,829 is the error that survives review, because it is
 * still obviously a quote for this job. $12,329 becoming $3 is caught by anyone
 * glancing at it, and an injected error that is trivially catchable inflates the
 * harness's apparent detection rate without testing anything.
 */
function perturbDigits(n: number, key: string): number {
  const digits = String(Math.trunc(Math.abs(n))).split('');
  if (digits.length < 2) return n + 1;

  // Never the leading digit — that is a magnitude change by another name.
  const at = 1 + Math.floor(draw(`${key}:pos`) * (digits.length - 1));
  const was = Number(digits[at]);
  digits[at] = String((was + 1 + Math.floor(draw(`${key}:val`) * 8)) % 10);

  const out = Number(digits.join(''));
  return Number.isFinite(out) ? Math.sign(n || 1) * out : n;
}

function kindOf(field: DiscoveredField, to: unknown): FaultKind {
  if (to === null) return 'drop';
  return field.type === 'number' ? 'digit' : 'substitute';
}

function asText(v: unknown): string | null {
  return v === null ? null : String(v);
}

/** Uniform [0, 1) from a string key. */
function draw(key: string): number {
  return hashString(key) / 2 ** 32;
}
