/**
 * Offline simulation of the validation layer.
 *
 * The critic is simulated as what it actually is: a second reading of the
 * *span*, with the rest of the call taken away. `probeSpan` re-scores the
 * quoted text in isolation and reports which category it supports. If that
 * disagrees with what the extractor claimed, the span does not say what the
 * extractor said it says.
 *
 * The critic is given exactly one capability the extractor lacks, mirroring
 * the difference between the two prompts: it is told to look for retraction.
 * The extractor's number parser takes the first number in a turn, which is
 * wrong whenever a speaker corrects themselves — "that'll be 52,329— no
 * sorry, 12,329". A critic sharing that blind spot would rubber-stamp the
 * error, which is the standard way self-critique fails. Here it doesn't,
 * because the two agents are asked different questions.
 *
 * The repair agent is simulated as strictly weaker than the extractor, which
 * is the honest default: when it cannot find a better reading it withdraws
 * the claim rather than re-asserting it, and a withdrawn claim falls below
 * the confidence floor and reaches a human.
 */

import type {
  DiscoveredField,
  FieldExtraction,
  GroundingChecks,
  Transcript,
} from '../core/types.js';
import { probeSpan, resolveDetector } from './detectors.js';

export interface Critique {
  verdict: 'accept' | 'reject';
  reason: string;
  /** The reading the critic thinks the span actually supports. */
  corrected: string | number | boolean | null;
}

/** "52,329— no sorry, 12,329" — the retracted number and the real one. */
const RETRACTION_RE = /(\d[\d,]*(?:\.\d+)?)\s*—?\s*no sorry,?\s*(\d[\d,]*(?:\.\d+)?)/i;

export function simulateCritique(
  field: DiscoveredField,
  extraction: FieldExtraction,
  transcript: Transcript,
  checks: GroundingChecks,
  /**
   * The cited turn plus its neighbours — the same window the live critic is
   * given. The span alone is what gets re-scored; the window exists so a
   * retraction or negation that straddles a turn boundary is visible.
   */
  context: string,
): Critique {
  const detector = resolveDetector(field.name, field.description);
  const span = extraction.evidence[0]?.quote ?? '';

  // Guard, not a branch the pipeline exercises: validate.ts routes absence
  // claims on confidence and never reaches the critic with one. Kept so the
  // simulator stays total over its own input type.
  if (extraction.value === null || extraction.value === false) {
    return { verdict: 'accept', reason: 'no span to re-read', corrected: extraction.value };
  }

  if (!detector || !span) {
    return {
      verdict: 'reject',
      reason: 'no span to re-read; the value cannot be traced to anything in the call',
      corrected: null,
    };
  }

  // Retraction check — the extractor does not do this, so it is the critic's
  // to catch. Scanned over the window rather than the span, because "that'll
  // be 52,329—" and "— no sorry, 12,329" routinely land in different turns
  // once the interruption splitter has been through the call.
  const retraction = context.match(RETRACTION_RE);
  if (retraction) {
    const retracted = parseNumber(retraction[1]!);
    const corrected = parseNumber(retraction[2]!);
    if (retracted !== null && numericallyEqual(extraction.value, retracted)) {
      return {
        verdict: 'reject',
        reason: `the speaker retracted ${retraction[1]} and corrected it to ${retraction[2]}; the extracted value is the retracted one`,
        corrected,
      };
    }
  }

  const probe = probeSpan(detector, span, transcript);

  if (probe == null || probe.value === null) {
    return {
      verdict: 'reject',
      reason: 'read on its own, the quoted span carries no signal for this column',
      corrected: null,
    };
  }

  if (!sameValue(probe.value, extraction.value)) {
    return {
      verdict: 'reject',
      reason: `the span reads as "${String(probe.value)}", not "${String(extraction.value)}"`,
      corrected: probe.value,
    };
  }

  // Agreement. The one remaining reservation worth voicing is a span that was
  // clearly the right one but was won narrowly — the critic saw the same
  // near-tie the extractor did.
  const shaky = probe.margin < 0.03;
  return {
    verdict: 'accept',
    reason: shaky
      ? `the span supports the value, but only just — "${String(probe.runnerUp ?? 'another reading')}" is nearly as well supported`
      : checks.quoteFound
        ? 'the span supports the value on its own reading'
        : 'the span was tidied up but its content is in the call and supports the value',
    corrected: extraction.value,
  };
}

/**
 * The repair pass. It gets the critic's reading and nothing the extractor did
 * not already have, so it can only do two things: adopt the correction, or
 * concede.
 */
export function simulateRepair(
  extraction: FieldExtraction,
  critique: Critique,
): { value: string | number | boolean | null; confidence: number; evidence: FieldExtraction['evidence'] } {
  if (critique.corrected === null) {
    // Conceding is the right move and it is also the expensive one: a null
    // here is a false negative unless a human picks it up, which is precisely
    // why it is emitted below the confidence floor.
    return { value: null, confidence: 0.3, evidence: [] };
  }

  // The span was right; the reading of it was wrong. Keep the span — it is
  // what a reviewer will want to look at — and take the second reading, at a
  // confidence that says "second attempt".
  return { value: critique.corrected, confidence: 0.66, evidence: extraction.evidence };
}

// ---------------------------------------------------------------------------

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return numericallyEqual(a, b);
  return String(a) === String(b);
}

function numericallyEqual(a: unknown, b: unknown): boolean {
  const x = typeof a === 'number' ? a : parseNumber(String(a));
  const y = typeof b === 'number' ? b : parseNumber(String(b));
  return x !== null && y !== null && Math.abs(x - y) < 0.005;
}

function parseNumber(s: string): number | null {
  const n = Number.parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
