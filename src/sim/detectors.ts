/**
 * Surface detectors — the offline simulator's "cognition".
 *
 * THIS DIRECTORY IS NOT THE PRODUCTION PATH. In live mode Claude reads the
 * transcript and does this work. These detectors exist so the pipeline, the
 * critic, the eval harness and the UI can run end-to-end with no API key.
 *
 * They are written to be a *plausibly competent, genuinely fallible*
 * extractor, not an oracle:
 *
 *   - Cue vocabularies are derived from the corpus's own utterance templates,
 *     then IDF-weighted, so overlapping phrasing between two categories
 *     produces real confusion rather than a hand-tuned error rate.
 *   - Detectors read only the rendered transcript. They have no access to the
 *     latent `CallFacts`. Nothing in this file may import them.
 *   - Every failure is mechanical: ASR substitutions, word dropout, filler
 *     injection and interruption-splitting break the cues, and the detector
 *     misses or picks the runner-up. The error distribution is a consequence
 *     of the noise model, not a parameter.
 *
 * The number-parsing detector deliberately does NOT special-case the
 * "52,329— no sorry, 12,329" self-correction pattern. It takes the first
 * number, which is wrong, exactly as a naive implementation would. That is
 * one of the failure modes the critic is there to catch.
 */

import type { FieldType, Transcript, Turn, Vertical } from '../core/types.js';
import { SPECS, type Utterance } from '../corpus/vocab.js';

export interface DetectorMatch {
  value: string | number | boolean | null;
  quote: string;
  turnIndex: number;
  /** 0..1 match quality, before confidence shaping. */
  strength: number;
  /** Second-best category, if any. Used by the repair pass. */
  runnerUp: string | null;
  /** Margin between best and runner-up — the main calibration signal. */
  margin: number;
}

export interface Detector {
  id: string;
  /**
   * Names independent proposers plausibly give the same concept, one per
   * proposer. How divergent these are is not arbitrary — it tracks what
   * signal is actually available to merge on:
   *
   *   - Enum fields carry distinctive values (`churn_risk`, `ArcticAire`), so
   *     synthesis can merge them on value overlap no matter what they're
   *     called. Their aliases are deliberately divergent to make synthesis
   *     earn it.
   *   - Booleans share a value space of {true, false} with every other
   *     boolean, and high-cardinality fields (dates, amounts) share no values
   *     at all across disjoint slices. Name and description are the only
   *     signal, so their aliases converge on a head noun — which is also what
   *     real proposers do.
   */
  aliases: string[];
  /** One per proposer. Independent proposers do not write the same sentence. */
  descriptions: string[];
  type: FieldType;
  enumValues?: string[];
  match(t: Transcript): DetectorMatch | null;
  /**
   * Categorical detectors expose their cue sets so the critic can re-score a
   * quoted span in isolation. See `probeSpan`.
   */
  candidates?: Candidate[];
}

// ---------------------------------------------------------------------------
// Cue vocabulary
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'for', 'you', 'your', 'was', 'were', 'have', 'has', 'had',
  'not', 'but', 'they', 'them', 'their', 'there', 'here', 'what', 'when', 'which', 'who', 'about',
  'from', 'into', 'out', 'get', 'got', 'can', 'cant', 'dont', 'just', 'like', 'know', 'yeah', 'okay',
  'right', 'well', 'said', 'says', 'say', 'going', 'gonna', 'want', 'need', 'really', 'thing',
  'things', 'something', 'anything', 'because', 'been', 'being', 'its', 'ive', 'im', 'thats',
  'were', 'weve', 'youre', 'theyre', 'would', 'could', 'should', 'much', 'more', 'some', 'any',
  'one', 'two', 'now', 'then', 'than', 'over', 'all', 'how', 'why', 'still', 'even', 'sure',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9$'\-\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ''))
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

export interface Candidate {
  value: string;
  /** token -> IDF weight */
  cues: Map<string, number>;
}

/** Build IDF-weighted cue sets so words shared across categories carry less. */
function buildCandidates(groups: { value: string; lines: Utterance[] }[]): Candidate[] {
  const docTokens = groups.map((g) => new Set(g.lines.flatMap((l) => tokenize(l.text))));
  const df = new Map<string, number>();
  for (const set of docTokens) {
    for (const tok of set) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  const n = groups.length;

  return groups.map((g, i) => {
    const cues = new Map<string, number>();
    for (const tok of docTokens[i]!) {
      // Classic smoothed IDF. A token in every category is worth ~nothing.
      cues.set(tok, Math.log((n + 1) / ((df.get(tok) ?? 1) + 0.5)));
    }
    return { value: g.value, cues };
  });
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Literal substring of the turn, windowed around the strongest hit. */
function windowQuote(text: string, token: string, radiusWords = 7): string {
  const idx = text.toLowerCase().indexOf(token);
  if (idx < 0) return text.slice(0, 160);

  let start = idx;
  let wordsBack = 0;
  while (start > 0 && wordsBack < radiusWords) {
    start--;
    if (text[start] === ' ') wordsBack++;
  }
  if (text[start] === ' ') start++;

  let end = idx + token.length;
  let wordsFwd = 0;
  while (end < text.length && wordsFwd < radiusWords) {
    if (text[end] === ' ') wordsFwd++;
    end++;
  }

  return text.slice(start, end).trim();
}

/** Noise markers visibly present in the quoted span — a confidence penalty. */
function noisePenalty(text: string): number {
  let p = 0;
  if (/\[(inaudible|crosstalk|static|unintelligible|background noise)\]/i.test(text)) p += 0.22;
  if (/—/.test(text)) p += 0.08;
  if (/\bno sorry\b/i.test(text)) p += 0.1;
  return Math.min(0.4, p);
}

/**
 * Where in a call a fact is normally stated.
 *
 * This is domain knowledge, not a tuning knob. Why the caller rang is said in
 * the first thirty seconds; how the call ended is said at the end, after any
 * objection, competitor threat or escalation request has already been aired.
 * An extractor without that prior scores the whole transcript as a bag of
 * cues, and on `outcome` it loses to the loudest mid-call line: a customer who
 * says "cancel the coverage" in turn six and is then talked down still reads
 * as churn_risk. That is not a hard-domain finding, it is a naive reader, and
 * a real LLM given the whole call does not make that mistake.
 *
 * The prior is deliberately gentle — a 25% tilt, not a hard window. Facts do
 * turn up out of position, and a prior strong enough to enforce call structure
 * would just be a different way of ignoring the text.
 */
type Position = 'early' | 'late' | 'anywhere';

function positionWeight(position: Position, index: number, total: number): number {
  if (position === 'anywhere' || total < 2) return 1;
  const frac = index / (total - 1);
  return position === 'early' ? 1.25 - 0.5 * frac : 0.75 + 0.5 * frac;
}

function scoreCategorical(
  t: Transcript,
  candidates: Candidate[],
  threshold: number,
  position: Position = 'anywhere',
): DetectorMatch | null {
  let best = { value: '', score: 0, turnIndex: -1, token: '', mass: 0 };
  let second = { value: '', score: 0 };

  for (let i = 0; i < t.turns.length; i++) {
    const turn = t.turns[i]!;
    const tokens = new Set(tokenize(turn.text));
    if (tokens.size === 0) continue;
    const positional = positionWeight(position, i, t.turns.length);

    for (const cand of candidates) {
      let hit = 0;
      let total = 0;
      let strongest = { tok: '', w: 0 };
      for (const [tok, w] of cand.cues) {
        total += w;
        if (tokens.has(tok)) {
          hit += w;
          if (w > strongest.w) strongest = { tok, w };
        }
      }
      if (total === 0) continue;
      const score = (hit / total) * positional;

      if (score > best.score) {
        if (best.value && best.value !== cand.value) second = { value: best.value, score: best.score };
        best = { value: cand.value, score, turnIndex: i, token: strongest.tok, mass: hit };
      } else if (score > second.score && cand.value !== best.value) {
        second = { value: cand.value, score };
      }
    }
  }

  if (best.turnIndex < 0 || best.score < threshold) return null;

  const turnText = t.turns[best.turnIndex]!.text;
  const quote = windowQuote(turnText, best.token);
  const margin = best.score - second.score;

  return {
    value: best.value,
    quote,
    turnIndex: best.turnIndex,
    strength: clamp01(saturate(best.mass, 4) - noisePenalty(quote)),
    runnerUp: second.value || null,
    margin,
  };
}

/**
 * Coverage (`hit/total`) is the right way to *rank* candidates against each
 * other — every candidate is judged on the same footing, so the comparison is
 * fair. It is the wrong way to report *strength*, because the denominator is
 * the candidate's entire cue vocabulary, and vocabularies differ wildly in
 * size. `outcome`'s categories carry roughly twice the cue mass of
 * `sentiment`'s, so an outcome match reports about half the strength for the
 * same quality of evidence. That is a property of how the phrasebook was
 * written, not of what the call said.
 *
 * Absolute matched mass has no such bias: five points of matched IDF weight is
 * five points of evidence whether the category had eight cue tokens or eighty.
 * Saturating it turns a similarity into something that behaves like a
 * probability — the first few matched tokens move it a lot, the tenth barely
 * at all.
 */
function saturate(mass: number, half: number): number {
  return mass / (mass + half);
}

/** Boolean concepts: any cue phrase anywhere flips it true. */
function scoreBoolean(t: Transcript, phrases: string[]): DetectorMatch {
  for (let i = 0; i < t.turns.length; i++) {
    const turn = t.turns[i]!;
    const lower = turn.text.toLowerCase();
    for (const phrase of phrases) {
      if (lower.includes(phrase)) {
        const quote = windowQuote(turn.text, phrase);
        return {
          value: true,
          quote,
          turnIndex: i,
          strength: clamp01(0.9 - noisePenalty(quote)),
          runnerUp: 'false',
          margin: 0.6,
        };
      }
    }
  }
  // Absence of evidence. Reported with modest confidence on purpose: the cue
  // may simply have been mangled by the ASR, which happens constantly.
  return { value: false, quote: '', turnIndex: -1, strength: 0.62, runnerUp: 'true', margin: 0.2 };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ---------------------------------------------------------------------------
// Detector construction
// ---------------------------------------------------------------------------

const ALL_VERTICALS: Vertical[] = ['hvac', 'claims', 'saas'];

function unionGroups(
  select: (v: Vertical) => { value: string; lines: Utterance[] }[],
): { value: string; lines: Utterance[] }[] {
  const merged = new Map<string, Utterance[]>();
  for (const v of ALL_VERTICALS) {
    for (const g of select(v)) {
      merged.set(g.value, [...(merged.get(g.value) ?? []), ...g.lines]);
    }
  }
  return [...merged].map(([value, lines]) => ({ value, lines }));
}

const REASON_GROUPS = unionGroups((v) => SPECS[v].reasons.map((r) => ({ value: r.code, lines: r.lines })));
const OBJECTION_GROUPS = unionGroups((v) =>
  SPECS[v].objections.map((o) => ({ value: o.code, lines: o.lines })),
);
const PRODUCT_GROUPS = unionGroups((v) =>
  SPECS[v].productLines.map((p) => ({ value: p.code, lines: p.lines })),
);
const OUTCOME_GROUPS = unionGroups((v) => SPECS[v].outcomes.map((o) => ({ value: o.code, lines: o.lines })));
const SENTIMENT_GROUPS = unionGroups((v) =>
  (['positive', 'neutral', 'negative'] as const).map((s) => ({ value: s, lines: SPECS[v].sentiment[s] })),
);

const COMPETITORS = [...new Set(ALL_VERTICALS.flatMap((v) => SPECS[v].competitors))];

const REASON_CANDIDATES = buildCandidates(REASON_GROUPS);
const OBJECTION_CANDIDATES = buildCandidates(OBJECTION_GROUPS);
const PRODUCT_CANDIDATES = buildCandidates(PRODUCT_GROUPS);
const OUTCOME_CANDIDATES = buildCandidates(OUTCOME_GROUPS);
const SENTIMENT_CANDIDATES = buildCandidates(SENTIMENT_GROUPS);

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const MONEY_RE = /\$?\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k\b|dollars\b)?/i;

function matchMoney(t: Transcript): DetectorMatch | null {
  for (let i = 0; i < t.turns.length; i++) {
    const turn = t.turns[i]!;
    if (!/\$|dollar|\bk\b/i.test(turn.text)) continue;
    const m = turn.text.match(MONEY_RE);
    if (!m) continue;

    // Naive on purpose: takes the FIRST number in the turn. When the speaker
    // self-corrects ("52,329— no sorry, 12,329") this is the wrong one.
    const raw = m[1]!.replace(/,/g, '');
    let value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) continue;
    if (m[2]?.toLowerCase() === 'k') value *= 1000;
    if (value < 20) continue; // "one sec", "2014", stray digits

    const quote = windowQuote(turn.text, m[0].trim().toLowerCase());
    return {
      value: Math.round(value),
      quote,
      turnIndex: i,
      strength: clamp01(0.88 - noisePenalty(quote)),
      runnerUp: null,
      margin: 0.5,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dates — spoken forms resolved against the capture date
// ---------------------------------------------------------------------------

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function matchDate(t: Transcript): DetectorMatch | null {
  const captured = new Date(`${t.capturedAt}T00:00:00Z`);

  for (let i = 0; i < t.turns.length; i++) {
    const turn = t.turns[i]!;
    const lower = turn.text.toLowerCase();
    const resolved = resolveSpokenDate(lower, captured);
    if (!resolved) continue;

    const quote = windowQuote(turn.text, resolved.token);
    return {
      value: resolved.iso,
      quote,
      turnIndex: i,
      strength: clamp01(resolved.confidence - noisePenalty(quote)),
      runnerUp: null,
      margin: resolved.confidence - 0.4,
    };
  }
  return null;
}

function resolveSpokenDate(
  text: string,
  captured: Date,
): { iso: string; token: string; confidence: number } | null {
  const monthDay = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(st|nd|rd|th)?\b/,
  );
  if (monthDay) {
    const month = MONTH_NAMES.indexOf(monthDay[1]!);
    const day = Number.parseInt(monthDay[2]!, 10);
    const d = new Date(Date.UTC(captured.getUTCFullYear(), month, day));
    // Explicit month + day is the least ambiguous form there is.
    return { iso: d.toISOString().slice(0, 10), token: monthDay[0], confidence: 0.94 };
  }

  if (/\btomorrow\b/.test(text)) {
    return { iso: shiftIso(captured, 1), token: 'tomorrow', confidence: 0.9 };
  }

  // "week of the 5th" — a range spoken as a point. Resolving it to the named
  // day is a guess, and the confidence says so.
  const weekOf = text.match(/\bweek of the (\d{1,2})(st|nd|rd|th)?\b/);
  if (weekOf) {
    const day = Number.parseInt(weekOf[1]!, 10);
    return { iso: sameOrNextMonth(captured, day), token: weekOf[0], confidence: 0.52 };
  }

  const dayThe = text.match(
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+the\s+(\d{1,2})(st|nd|rd|th)?\b/,
  );
  if (dayThe) {
    const day = Number.parseInt(dayThe[2]!, 10);
    return { iso: sameOrNextMonth(captured, day), token: dayThe[0], confidence: 0.88 };
  }

  const bareThe = text.match(/\bthe (\d{1,2})(st|nd|rd|th)\b/);
  if (bareThe) {
    const day = Number.parseInt(bareThe[1]!, 10);
    return { iso: sameOrNextMonth(captured, day), token: bareThe[0], confidence: 0.78 };
  }

  const relDay = text.match(
    /\b(this|next)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
  );
  if (relDay) {
    const target = DAY_NAMES.indexOf(relDay[2]!);
    const cur = captured.getUTCDay();
    let delta = (target - cur + 7) % 7;
    if (delta === 0) delta = 7;
    // "next Thursday" is famously ambiguous — a week later, or the coming one?
    // Assume a week later, and price the ambiguity into the confidence.
    if (relDay[1] === 'next') delta += 7;
    return {
      iso: shiftIso(captured, delta),
      token: relDay[0],
      confidence: relDay[1] === 'next' ? 0.61 : 0.8,
    };
  }

  return null;
}

function shiftIso(d: Date, days: number): string {
  return new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A bare day-of-month means the next occurrence of it. */
function sameOrNextMonth(captured: Date, day: number): string {
  const sameMonth = new Date(Date.UTC(captured.getUTCFullYear(), captured.getUTCMonth(), day));
  if (sameMonth.getTime() >= captured.getTime()) return sameMonth.toISOString().slice(0, 10);
  return new Date(Date.UTC(captured.getUTCFullYear(), captured.getUTCMonth() + 1, day))
    .toISOString()
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

export const DETECTORS: Detector[] = [
  {
    id: 'reason',
    aliases: ['call_reason', 'reason_for_call', 'contact_driver', 'primary_issue'],
    descriptions: [
      'Why the customer called, as a canonical category.',
      "The customer's presenting problem or request at the start of the call.",
      'Primary driver for the contact, normalized to a fixed set.',
      'What prompted this call.',
    ],
    type: 'enum',
    enumValues: REASON_GROUPS.map((g) => g.value),
    match: (t) => scoreCategorical(t, REASON_CANDIDATES, 0.16, 'early'),
    candidates: REASON_CANDIDATES,
  },
  {
    id: 'productLine',
    aliases: ['product_line', 'product_or_service', 'covered_asset', 'line_of_business'],
    descriptions: [
      'Which product, policy or service line the call concerns.',
      'The specific plan, policy or equipment under discussion.',
      'Asset or subscription tier referenced by the caller.',
      'Business line the account sits on.',
    ],
    type: 'enum',
    enumValues: PRODUCT_GROUPS.map((g) => g.value),
    match: (t) => scoreCategorical(t, PRODUCT_CANDIDATES, 0.16),
    candidates: PRODUCT_CANDIDATES,
  },
  {
    id: 'outcome',
    aliases: ['call_outcome', 'disposition', 'resolution_state', 'end_state'],
    descriptions: [
      'How the call ended and what state the account was left in.',
      'Final disposition of the interaction.',
      'Resolution status when the call closed.',
      'Where things stood at hang-up.',
    ],
    type: 'enum',
    enumValues: OUTCOME_GROUPS.map((g) => g.value),
    match: (t) => scoreCategorical(t, OUTCOME_CANDIDATES, 0.15, 'late'),
    candidates: OUTCOME_CANDIDATES,
  },
  {
    id: 'objection',
    aliases: ['objection_raised', 'customer_objection', 'blocker', 'friction_point'],
    descriptions: [
      'The principal objection or resistance the customer voiced, if any.',
      'What the customer pushed back on.',
      'Blocker preventing agreement, if one surfaced.',
      'Source of friction raised by the caller.',
    ],
    type: 'enum',
    enumValues: OBJECTION_GROUPS.map((g) => g.value),
    match: (t) => scoreCategorical(t, OBJECTION_CANDIDATES, 0.2),
    candidates: OBJECTION_CANDIDATES,
  },
  {
    id: 'sentiment',
    aliases: ['customer_sentiment', 'caller_tone', 'sentiment', 'satisfaction_signal'],
    descriptions: [
      'Overall customer sentiment across the call.',
      'Emotional tone of the caller.',
      'How satisfied the customer sounded.',
      "Net affect of the customer's contributions.",
    ],
    type: 'enum',
    enumValues: ['positive', 'neutral', 'negative'],
    match: (t) => scoreCategorical(t, SENTIMENT_CANDIDATES, 0.14),
    candidates: SENTIMENT_CANDIDATES,
  },
  {
    id: 'competitor',
    // High-cardinality like dates and amounts: two proposers reading disjoint
    // slices see entirely different competitor names, so value overlap is
    // structurally zero and the names have to carry the merge.
    aliases: ['competitor_mentioned', 'competitor_named', 'competing_vendor', 'rival_or_competitor'],
    descriptions: [
      'A competing provider the customer named, if one came up.',
      'Rival vendor referenced during the call.',
      'Named alternative the customer is considering.',
      'Third-party provider mentioned by the caller.',
    ],
    type: 'enum',
    enumValues: COMPETITORS,
    match: (t) => {
      for (let i = 0; i < t.turns.length; i++) {
        const turn = t.turns[i]!;
        for (const c of COMPETITORS) {
          if (turn.text.toLowerCase().includes(c.toLowerCase())) {
            const quote = windowQuote(turn.text, c.toLowerCase());
            return {
              value: c,
              quote,
              turnIndex: i,
              strength: clamp01(0.93 - noisePenalty(quote)),
              runnerUp: null,
              margin: 0.7,
            };
          }
        }
      }
      return { value: null, quote: '', turnIndex: -1, strength: 0.7, runnerUp: null, margin: 0.3 };
    },
  },
  {
    id: 'commitmentDate',
    aliases: ['committed_date', 'promised_date', 'followup_date', 'commitment_date'],
    descriptions: [
      'The date the agent committed to, resolved to a calendar date.',
      'Next promised follow-up date.',
      'Calendar date the agent said something would happen by.',
      'Scheduled date arising from the call.',
    ],
    type: 'date',
    match: matchDate,
  },
  {
    id: 'dollarAmount',
    aliases: ['amount_discussed', 'dollar_amount', 'quoted_amount', 'amount_usd'],
    descriptions: [
      'The principal dollar figure discussed on the call.',
      'Monetary amount quoted or disputed.',
      'Dollar value referenced by either party.',
      'Currency figure central to the call.',
    ],
    type: 'number',
    match: matchMoney,
  },
  {
    id: 'disclosureGiven',
    aliases: ['disclosure_given', 'recording_disclosure', 'disclosure_stated', 'compliance_disclosure'],
    descriptions: [
      'Whether the agent stated the call was recorded or monitored.',
      'Did the agent read the recording disclosure.',
      'Presence of a required recording notice.',
      'Compliance: recording disclosure delivered.',
    ],
    type: 'boolean',
    match: (t) => scoreBoolean(t, ['recorded', 'recording', 'monitored', 'disclosure']),
  },
  {
    id: 'escalationRequested',
    aliases: ['escalation_requested', 'supervisor_requested', 'escalation_flag', 'requested_escalation'],
    descriptions: [
      'Whether the customer asked for a supervisor, manager or escalation.',
      'Did the caller request escalation.',
      'Customer asked to speak to a manager.',
      'Escalation demand raised on the call.',
    ],
    type: 'boolean',
    match: (t) => scoreBoolean(t, ['supervisor', 'manager', 'escalate', 'escalated', 'leadership']),
  },

  // --- concepts that are real, observable, and probably not worth a column --
  // Nothing here is flagged as junk. Synthesis has to work that out from the
  // value distributions, the same way it would on a corpus it had never seen.
  {
    id: 'holdEvent',
    aliases: ['hold_occurred', 'hold_event', 'dead_air', 'wait_event'],
    descriptions: [
      'Whether the call included a hold or a pause.',
      'Hold or wait event during the conversation.',
      'Dead air or a stated pause.',
      'Caller was asked to wait at some point.',
    ],
    type: 'boolean',
    match: (t) => scoreBoolean(t, ['hold', 'one sec', 'bear with me', 'hang on']),
  },
  {
    id: 'identityVerification',
    aliases: ['identity_verified', 'account_verified', 'verification_performed', 'identity_check'],
    descriptions: [
      'Whether the agent performed an account or identity lookup.',
      'Account verification step occurred.',
      'Agent asked for identifying account details.',
      'Identity or account check performed on the call.',
    ],
    type: 'boolean',
    match: (t) => scoreBoolean(t, ['verify', 'last four', 'account name', 'claim number', 'policy']),
  },
  {
    id: 'audioQualityFlag',
    aliases: ['audio_quality_issue', 'audio_gap', 'transcription_gap', 'line_quality'],
    descriptions: [
      'Whether the transcript contains audibility gaps.',
      'Audio gap or unintelligible span present.',
      'Transcription contains dropped segments.',
      'Line quality degraded during the call.',
    ],
    type: 'boolean',
    match: (t) => scoreBoolean(t, ['[inaudible]', '[static]', '[crosstalk]', '[unintelligible]']),
  },
];

export const DETECTOR_BY_ID = new Map(DETECTORS.map((d) => [d.id, d]));

/**
 * Re-derive a value from one quoted span, with the rest of the call hidden.
 *
 * This is the critic's whole job, and the isolation is the point: an
 * extractor that picked the right answer for the wrong reason usually cites a
 * span that does not actually contain the reason. Scoring that span alone
 * surfaces it.
 *
 * The corpus-tuned threshold is dropped to zero here. A fifteen-word window
 * carries a fraction of the cue mass of a full turn, so the absolute score is
 * meaningless — what matters is which category wins on this text and by how
 * much. The critic asks a relative question, so it gets a relative answer.
 */
export function probeSpan(detector: Detector, span: string, ctx: Transcript): DetectorMatch | null {
  const single: Transcript = { ...ctx, turns: [{ t: 0, speaker: 'AGENT', text: span }] };
  return detector.candidates
    ? scoreCategorical(single, detector.candidates, 0)
    : detector.match(single);
}

/**
 * Crude suffix stripping. Not linguistics — just enough that "recorded",
 * "recording" and "records" land on the same token, which is what makes
 * name/description overlap usable as a merge signal at synthesis.
 */
export function stem(word: string): string {
  for (const suffix of ['ations', 'ation', 'ing', 'ies', 'ed', 'es', 's']) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) {
      const base = word.slice(0, -suffix.length);
      return suffix === 'ies' ? `${base}y` : base;
    }
  }
  return word;
}

/**
 * Resolve a discovered field back to a detector by name/description overlap.
 *
 * Deliberately *not* an id lookup. In live mode the extractor gets a field
 * name and description and has to work out what to look for; the simulator
 * has to do the same, so a synthesis step that produces a garbled field name
 * genuinely degrades extraction instead of being silently repaired.
 */
export function resolveDetector(fieldName: string, description: string): Detector | null {
  const target = new Set([...normalizeName(fieldName), ...tokenize(description)].map(stem));
  let best: { d: Detector; score: number } | null = null;

  for (const d of DETECTORS) {
    const pool = new Set(
      [
        ...[d.id, ...d.aliases].flatMap(normalizeName),
        ...d.descriptions.flatMap(tokenize),
      ].map(stem),
    );
    const overlap = [...target].filter((t) => pool.has(t)).length;
    const score = overlap / Math.max(1, target.size);
    if (!best || score > best.score) best = { d, score };
  }

  return best && best.score >= 0.34 ? best.d : null;
}

export function normalizeName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export { tokenize };
export type { Turn };
