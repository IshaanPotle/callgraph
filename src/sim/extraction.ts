/**
 * Offline simulation of the extraction layer.
 *
 * The detectors in `detectors.ts` supply the values. This file supplies the
 * two things a *reporting* extractor adds on top of a matching one, and both
 * of them are where real systems go wrong:
 *
 *   1. A confidence number. It is a self-report, computed here from evidence
 *      quality alone — match strength and the margin over the runner-up. It
 *      is deliberately NOT computed from correctness, because the extractor
 *      does not know whether it is correct. Miscalibration therefore emerges
 *      from the gap between "the cue was loud" and "the answer was right",
 *      which is the same gap a model's self-reported confidence has.
 *
 *   2. An evidence span. Asked to quote the text it used, an extractor quotes
 *      what it *understood*, not the bytes the ASR emitted — fillers dropped,
 *      [inaudible] dropped, stutter repaired. That is a paraphrase, and under
 *      a literal-substring grounding check it fails. Reproducing that here is
 *      the only way the validation layer's most common false alarm shows up
 *      in the eval instead of being assumed away.
 */

import { Rng, hashString } from '../core/rng.js';
import type { DiscoveredField, Evidence, FieldExtraction, Transcript } from '../core/types.js';
import { probeSpan, resolveDetector, type Detector, type DetectorMatch } from './detectors.js';

export function simulateExtraction(
  t: Transcript,
  fields: DiscoveredField[],
): { fields: Record<string, FieldExtraction> } {
  const out: Record<string, FieldExtraction> = {};

  for (const field of fields) {
    const rng = new Rng(hashString(`extract:${t.callId}:${field.name}`));
    const detector = resolveDetector(field.name, field.description);

    // A field whose name and description the extractor cannot operationalize
    // produces a null with low confidence, not a guess. Synthesis producing a
    // vague column is a real cost, and it should be visible in the numbers.
    if (!detector) {
      out[field.name] = { field: field.name, value: null, confidence: 0.2, evidence: [] };
      continue;
    }

    const m = detector.match(t);
    if (m == null || m.value === null) {
      out[field.name] = {
        field: field.name,
        value: null,
        confidence: absenceConfidence(t),
        evidence: [],
      };
      continue;
    }

    out[field.name] = {
      field: field.name,
      value: m.value,
      confidence: shapeConfidence(m, t),
      evidence: buildEvidence(detector, m, t, rng),
    };
  }

  return { fields: out };
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * Two inputs, both available to a model reading the same transcript:
 *
 *   - `strength`: how loudly the cue fired, already net of a penalty for
 *     [inaudible] markers and self-corrections inside the span.
 *   - `margin`: how far ahead the winner was. A field that beat its runner-up
 *     by a hair is a coin flip dressed as an answer, however loud the cue —
 *     and this is the signal that carries most of the calibration.
 *
 * Plus a discount for a transcript the ASR itself flagged. Real ASR hands you
 * a confidence; ignoring it and then being surprised by the error rate on bad
 * audio is a self-inflicted wound.
 */
function shapeConfidence(m: DetectorMatch, t: Transcript): number {
  // Saturating rather than linear: the difference between a 0.02 and a 0.08
  // margin matters a lot; between 0.3 and 0.4 it matters not at all.
  const decisiveness = m.margin / (m.margin + 0.06);

  // Both factors are centred near 1 rather than capped at it. Beating the
  // runner-up decisively, on a call the ASR was happy with, is corroborating
  // evidence — it should be able to raise a confidence, not merely fail to
  // lower one. Three multiplied sub-unit factors is not a model of anything;
  // it is a guarantee of systematic underconfidence, which is both wrong and
  // the opposite of how real extractors fail.
  const marginFactor = 0.8 + 0.34 * decisiveness;
  const asrFactor = 0.9 + 0.15 * clamp01((t.asrConfidence - 0.42) / 0.57);

  return round2(clamp(m.strength * marginFactor * asrFactor, 0.05, 0.97));
}

/**
 * "I looked and there is nothing here" is a claim with its own confidence,
 * and on a badly transcribed call it should be a weak one — the cue may
 * simply have been dropped. This is what makes low-confidence nulls route to
 * human review rather than silently becoming false negatives.
 */
function absenceConfidence(t: Transcript): number {
  return round2(clamp(0.34 + 0.42 * clamp01((t.asrConfidence - 0.42) / 0.57), 0.3, 0.8));
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const FILLER_RE = /\b(um|uh|you know|i mean|sort of|kind of|like)\b[,]?\s*/gi;
const MARKER_RE = /\[(inaudible|crosstalk|static|unintelligible|background noise)\]\s*/gi;
const STUTTER_RE = /\b([a-z']+)—\s+/gi;

function buildEvidence(detector: Detector, m: DetectorMatch, t: Transcript, rng: Rng): Evidence[] {
  if (m.turnIndex < 0 || !m.quote) return [];

  const turn = t.turns[m.turnIndex]!;
  let quote = m.quote;
  let turnIndex = m.turnIndex;

  // An interrupted turn was split into three by the noise model: "...the
  // furnace—", "mm-hm", "—is blowing cold". The extractor read it as one
  // sentence and cites where the sentence started, which is two turns back.
  // The quote is real; the citation is off. Exactly the case a grounding
  // check must not treat as fabrication.
  if (turn.text.startsWith('—') && turnIndex >= 2) turnIndex -= 2;

  // Cleaning up the span is what makes a quote readable and what makes it
  // stop being a literal substring. An extractor is inconsistent about it,
  // so this fires on a little over half of the spans that have anything to
  // clean — the condition is mechanical, the coin flip is a simulator knob.
  if (isNoisy(quote) && rng.bool(0.55)) {
    const cleaned = cleanQuote(quote);

    // But what counts as noise is a property of the column, not of the text.
    // "[inaudible]" is debris in a span cited for `call_reason` and it is the
    // entire finding in a span cited for `audio_gap`. An extractor does not
    // delete the thing it is pointing at, so the tidy-up is only kept if the
    // cleaned span still carries the value.
    //
    // Without this the audio-quality columns self-destruct: the extractor
    // strips the marker, the critic re-reads a span with no marker in it,
    // correctly reports "no gap", and the repair pass overwrites a right
    // answer with a wrong one. A validation layer that reliably converts
    // correct extractions into incorrect ones is worse than no layer at all,
    // and it is worth being precise about whose bug that is: the critic was
    // reasoning correctly about a span the extractor had already ruined.
    const survives = probeSpan(detector, cleaned, t);
    if (survives != null && String(survives.value) === String(m.value)) quote = cleaned;
  }

  return [{ quote, turnIndex }];
}

function isNoisy(quote: string): boolean {
  FILLER_RE.lastIndex = 0;
  MARKER_RE.lastIndex = 0;
  STUTTER_RE.lastIndex = 0;
  return FILLER_RE.test(quote) || MARKER_RE.test(quote) || STUTTER_RE.test(quote);
}

function cleanQuote(quote: string): string {
  return quote
    .replace(MARKER_RE, '')
    .replace(STUTTER_RE, '')
    .replace(FILLER_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.?!])/g, '$1')
    .trim();
}

// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
