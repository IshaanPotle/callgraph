/**
 * Deterministic grounding checks.
 *
 * These run on every extracted field before any critic model is invoked, and
 * they cost nothing. That matters more than it sounds: a validation layer
 * that sends every field to a second model doubles the bill of the whole
 * pipeline, and most of what it catches is catchable with string operations.
 *
 * The design rule here is that a deterministic check may only *reject* on
 * evidence that is conclusive without reading the call:
 *
 *   - A non-null value with no evidence span at all is unverifiable by
 *     construction. Reject.
 *   - A quote whose words appear nowhere in the transcript, in any order, in
 *     any turn, was invented. Reject.
 *
 * Everything softer than that — a quote that is real but tidied up, a quote
 * attributed to the wrong turn, an enum value outside the induced vocabulary
 * — is a *reason to look*, not a verdict. Those escalate to the critic with
 * the check results attached, because each of them has a completely ordinary
 * innocent explanation and rejecting them outright is how a validation layer
 * ends up with worse precision than the extractor it was policing.
 */

import type {
  DiscoveredField,
  Evidence,
  FieldExtraction,
  GroundingChecks,
  Transcript,
} from '../core/types.js';

export interface GroundingResult {
  checks: GroundingChecks;
  /** Set when the checks are conclusive on their own. */
  fatal: string | null;
  /** True when the checks are inconclusive but suspicious. */
  suspicious: boolean;
  /**
   * The field claims nothing is there — a null, or a false boolean. There is
   * no span to ground, so grounding has no opinion and the caller decides on
   * confidence alone.
   */
  absenceClaim: boolean;
}

export function checkGrounding(
  extraction: FieldExtraction,
  field: DiscoveredField,
  transcript: Transcript,
): GroundingResult {
  const spans = extraction.evidence ?? [];
  const isNull = extraction.value === null;

  // A false boolean is a claim about absence, and absence has no span. This
  // is the one case where missing evidence is the correct output, and a
  // validation layer that misses it rejects a large and entirely correct
  // slice of every boolean column.
  const absenceClaim = isNull || extraction.value === false;
  const hasEvidence = spans.length > 0 || absenceClaim;

  const located = spans.map((s) => locate(s, transcript));
  const quoteFound = located.length > 0 && located.every((l) => l.exactHere);
  const quoteFoundElsewhere = located.some((l) => !l.exactHere && l.exactTurn >= 0);
  const quoteIsSubsequence = located.length > 0 && located.every((l) => l.subsequenceTurn >= 0);

  const valueInSchema = checkVocabulary(extraction.value, field);

  const checks: GroundingChecks = {
    quoteFound,
    quoteFoundElsewhere,
    quoteIsSubsequence,
    valueInSchema,
    hasEvidence,
  };

  if (!hasEvidence) {
    return {
      checks,
      fatal: 'non-null value with no evidence span — unverifiable',
      suspicious: true,
      absenceClaim,
    };
  }

  const fabricated = located.filter((l) => l.exactTurn < 0 && l.subsequenceTurn < 0);
  if (fabricated.length > 0) {
    return {
      checks,
      fatal: `quoted span does not occur in this transcript: "${truncate(fabricated[0]!.quote)}"`,
      suspicious: true,
      absenceClaim,
    };
  }

  // An absence claim has no span, so `quoteFound` is false for a reason that
  // has nothing to do with whether the claim is sound. Counting that as
  // suspicious would route every null in the corpus to the critic.
  const suspicious = !absenceClaim && (!quoteFound || !valueInSchema);
  return { checks, fatal: null, suspicious, absenceClaim };
}

// ---------------------------------------------------------------------------

interface Located {
  quote: string;
  /** Exact (whitespace-normalized) substring of the *cited* turn. */
  exactHere: boolean;
  /** Index of some turn containing it exactly, or -1. */
  exactTurn: number;
  /** Index of some turn whose words contain the quote's, in order, or -1. */
  subsequenceTurn: number;
}

function locate(span: Evidence, t: Transcript): Located {
  const needle = normalize(span.quote);
  const cited = t.turns[span.turnIndex];

  if (needle.length === 0) {
    return { quote: span.quote, exactHere: false, exactTurn: -1, subsequenceTurn: -1 };
  }

  const exactHere = cited != null && normalize(cited.text).includes(needle);
  const exactTurn = exactHere
    ? span.turnIndex
    : t.turns.findIndex((turn) => normalize(turn.text).includes(needle));

  const words = needle.split(' ').filter(Boolean);
  const subsequenceTurn =
    exactTurn >= 0 ? exactTurn : t.turns.findIndex((turn) => isSubsequence(words, normalize(turn.text).split(' ')));

  return { quote: span.quote, exactHere, exactTurn, subsequenceTurn };
}

/**
 * Whitespace and punctuation only. Case is folded because transcripts are
 * machine-cased and an extractor recasing a sentence start is not a finding;
 * words are left alone, because word-level edits are exactly what this check
 * is trying to detect.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[—–]/g, ' ')
    .replace(/[^a-z0-9$[\]' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Are all of `needle`'s words present in `hay`, in order? */
function isSubsequence(needle: string[], hay: string[]): boolean {
  if (needle.length === 0) return false;
  let i = 0;
  for (const word of hay) {
    if (word === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/**
 * Only meaningful for enums, and only ever advisory. The vocabulary was
 * induced from a sample, so a value outside it may well be a category the
 * sample missed rather than an extractor error.
 */
function checkVocabulary(value: FieldExtraction['value'], field: DiscoveredField): boolean {
  if (value === null) return true;
  if (field.type !== 'enum' || !field.enumValues?.length) return true;
  return field.enumValues.includes(String(value));
}

function truncate(s: string, n = 60): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
