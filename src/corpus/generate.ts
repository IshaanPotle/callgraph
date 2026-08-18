/**
 * Corpus generation: latent facts -> messy transcript.
 *
 * The direction of this arrow is the whole trick. Because every call is
 * *rendered from* a `CallFacts` object, the gold labels exist before the text
 * does. That buys a 240-call labeled eval set for zero labeling cost, which is
 * what lets this repo report accuracy at all.
 *
 * The honest caveat, stated up front and repeated in the README: synthetic
 * ground truth measures a system against a generator, not against reality.
 * It catches regressions, calibration drift and critic failures. It does not
 * tell you how the system does on your actual audio.
 */

import { Rng, hashString } from '../core/rng.js';
import type { CallFacts, Outcome, Sentiment, Transcript, Turn, Vertical } from '../core/types.js';
import { VERTICALS } from '../core/types.js';
import { degrade, drawNoiseProfile, reportedAsrConfidence } from './noise.js';
import { SPECS, type Utterance } from './vocab.js';

export interface CorpusOptions {
  seed: number;
  size: number;
  /** First day of the window calls are drawn from. */
  startDate?: string;
}

export interface GeneratedCall {
  transcript: Transcript;
  facts: CallFacts;
}

const OUTCOME_WEIGHTS: Record<Vertical, [Outcome, number][]> = {
  hvac: [
    ['follow_up_scheduled', 34],
    ['resolved', 22],
    ['sale_closed', 14],
    ['escalated', 11],
    ['no_action', 12],
    ['churn_risk', 7],
  ],
  claims: [
    ['follow_up_scheduled', 30],
    ['escalated', 21],
    ['resolved', 20],
    ['no_action', 14],
    ['churn_risk', 11],
    ['sale_closed', 4],
  ],
  saas: [
    ['follow_up_scheduled', 28],
    ['resolved', 21],
    ['sale_closed', 16],
    ['churn_risk', 15],
    ['escalated', 11],
    ['no_action', 9],
  ],
};

const SENTIMENT_BY_OUTCOME: Record<Outcome, [Sentiment, number][]> = {
  resolved: [
    ['positive', 55],
    ['neutral', 38],
    ['negative', 7],
  ],
  sale_closed: [
    ['positive', 62],
    ['neutral', 32],
    ['negative', 6],
  ],
  follow_up_scheduled: [
    ['neutral', 55],
    ['positive', 22],
    ['negative', 23],
  ],
  no_action: [
    ['neutral', 66],
    ['negative', 22],
    ['positive', 12],
  ],
  escalated: [
    ['negative', 74],
    ['neutral', 24],
    ['positive', 2],
  ],
  churn_risk: [
    ['negative', 81],
    ['neutral', 17],
    ['positive', 2],
  ],
};

export function generateCorpus(opts: CorpusOptions): GeneratedCall[] {
  const rng = new Rng(opts.seed);
  const start = new Date(opts.startDate ?? '2026-05-04T00:00:00Z');
  const calls: GeneratedCall[] = [];

  for (let i = 0; i < opts.size; i++) {
    const vertical = VERTICALS[i % VERTICALS.length]!;
    const callId = `call_${vertical}_${String(i).padStart(4, '0')}`;
    // Per-call RNG seeded from the id: regenerating one call never shifts
    // any other call, so the corpus is stable under size changes.
    const callRng = new Rng(hashString(callId) ^ opts.seed);
    calls.push(generateCall(callId, vertical, callRng, start, rng.int(0, 55)));
  }

  return calls;
}

function generateCall(
  callId: string,
  vertical: Vertical,
  rng: Rng,
  start: Date,
  dayOffset: number,
): GeneratedCall {
  const spec = SPECS[vertical];

  const capturedAt = addDays(start, dayOffset);
  const outcome = rng.weighted(OUTCOME_WEIGHTS[vertical]);
  const sentiment = rng.weighted(SENTIMENT_BY_OUTCOME[outcome]);

  const reason = rng.pick(spec.reasons);
  const productLine = rng.pick(spec.productLines);

  // Objections cluster with bad outcomes. This correlation is what makes the
  // activation layer's findings non-trivial: it has to notice it.
  const objectionOdds =
    outcome === 'churn_risk' ? 0.92 : outcome === 'escalated' ? 0.78 : outcome === 'no_action' ? 0.6 : 0.3;
  const objection = rng.bool(objectionOdds) ? rng.pick(spec.objections) : null;

  const competitorOdds = outcome === 'churn_risk' ? 0.66 : objection ? 0.28 : 0.09;
  const competitor = rng.bool(competitorOdds) ? rng.pick(spec.competitors) : null;

  const escalationRequested =
    outcome === 'escalated' ? rng.bool(0.85) : sentiment === 'negative' ? rng.bool(0.3) : rng.bool(0.05);

  // Deliberately imperfect: ~1 in 6 agents forgets the disclosure. That gap is
  // the compliance signal the activation layer surfaces.
  const disclosureGiven = rng.bool(0.83);

  const wantsAmount = rng.bool(
    outcome === 'sale_closed' || reason.code.includes('quote') || reason.code.includes('invoice') ? 0.85 : 0.4,
  );
  const dollarAmount = wantsAmount ? drawAmount(vertical, rng) : null;

  const wantsCommitment = outcome === 'follow_up_scheduled' || rng.bool(0.35);
  const commitmentDate = wantsCommitment ? addDays(capturedAt, rng.int(1, 21)) : null;

  const facts: CallFacts = {
    callId,
    vertical,
    reason: reason.code,
    productLine: productLine.code,
    outcome,
    objection: objection?.code ?? null,
    competitor,
    commitmentDate: commitmentDate ? iso(commitmentDate) : null,
    dollarAmount,
    sentiment,
    disclosureGiven,
    escalationRequested,
  };

  // ---- render ----------------------------------------------------------

  const script: Utterance[] = [];
  const agentName = rng.pick(spec.agentNames);

  script.push(...pick1(spec.greeting(agentName), rng));
  script.push(pickOne(reason.lines, rng));
  script.push(...rng.sample(spec.filler, rng.int(1, 2)));

  if (disclosureGiven) script.push(pickOne(spec.disclosure, rng));

  script.push(pickOne(productLine.lines, rng));

  if (rng.bool(0.5)) script.push(pickOne(spec.filler, rng));
  if (dollarAmount !== null) script.push(pickOne(spec.amount(spokenAmount(dollarAmount, rng)), rng));
  if (objection) script.push(pickOne(objection.lines, rng));
  if (competitor) script.push(pickOne(spec.competitorLines(competitor), rng));
  if (escalationRequested) script.push(pickOne(spec.escalation, rng));

  script.push(pickOne(spec.sentiment[sentiment], rng));

  const outcomeSpec = spec.outcomes.find((o) => o.code === outcome)!;
  script.push(pickOne(outcomeSpec.lines, rng));

  if (commitmentDate) {
    script.push(pickOne(spec.commitment(spokenDate(commitmentDate, capturedAt, rng)), rng));
  }

  script.push(...spec.closing);

  // ---- to turns, then degrade -----------------------------------------

  let t = rng.int(2, 6);
  const clean: Turn[] = script.map((utt) => {
    const turn: Turn = { t, speaker: utt.speaker, text: utt.text };
    t += Math.max(2, Math.round(utt.text.length / 11) + rng.int(0, 4));
    return turn;
  });

  if (rng.bool(0.35)) {
    clean.unshift({
      t: 0,
      speaker: 'IVR',
      text: 'Your call may be monitored. Please hold for the next available representative.',
    });
  }

  const profile = drawNoiseProfile(rng);
  const turns = degrade(clean, profile, rng);

  const transcript: Transcript = {
    callId,
    vertical,
    capturedAt: iso(capturedAt),
    durationSec: turns.length > 0 ? turns[turns.length - 1]!.t + rng.int(3, 12) : 0,
    asrConfidence: round(reportedAsrConfidence(rng, profile), 2),
    turns,
  };

  return { transcript, facts };
}

// ---------------------------------------------------------------------------
// Surface forms — the same fact, spoken however people actually speak it
// ---------------------------------------------------------------------------

function drawAmount(vertical: Vertical, rng: Rng): number {
  if (vertical === 'hvac') return rng.bool(0.4) ? rng.int(180, 1400) : rng.int(3200, 14500);
  if (vertical === 'claims') return rng.bool(0.5) ? rng.int(500, 6500) : rng.int(8000, 42000);
  return rng.bool(0.5) ? rng.int(4800, 38000) : rng.int(42000, 260000);
}

function spokenAmount(amount: number, rng: Rng): string {
  const withCommas = amount.toLocaleString('en-US');
  return rng.weighted([
    [`$${withCommas}`, 40],
    [`${withCommas} dollars`, 22],
    [`about ${roundish(amount)}`, 18],
    [`${withCommas}, even`, 10],
    [`right around $${withCommas}`, 10],
  ]);
}

function roundish(amount: number): string {
  if (amount >= 10000) return `$${Math.round(amount / 1000)}k`;
  if (amount >= 1000) return `$${(Math.round(amount / 100) / 10).toFixed(1)}k`;
  return `$${Math.round(amount / 10) * 10}`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Spoken dates are relative, partial, or both. Resolving them back to an ISO
 * date is a real part of the extraction job, so the gold label stays ISO and
 * the transcript never contains one.
 */
function spokenDate(target: Date, capturedAt: Date, rng: Rng): string {
  const day = DAYS[target.getUTCDay()]!;
  const dom = target.getUTCDate();
  const month = MONTHS[target.getUTCMonth()]!;
  const deltaDays = Math.round((target.getTime() - capturedAt.getTime()) / 86_400_000);

  const options: [string, number][] = [
    [`${day} the ${ordinal(dom)}`, 26],
    [`the ${ordinal(dom)}`, 20],
    [`${month} ${ordinal(dom)}`, 18],
  ];
  if (deltaDays === 1) options.push(['tomorrow', 30]);
  if (deltaDays >= 2 && deltaDays <= 6) options.push([`this ${day}`, 24]);
  if (deltaDays >= 7 && deltaDays <= 13) options.push([`next ${day}`, 24]);
  if (deltaDays >= 14) options.push([`the week of the ${ordinal(dom - target.getUTCDay())}`, 12]);

  return rng.weighted(options);
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

// ---------------------------------------------------------------------------

function pickOne(lines: Utterance[], rng: Rng): Utterance {
  return rng.pick(lines);
}

function pick1(lines: Utterance[], rng: Rng): Utterance[] {
  return [rng.pick(lines)];
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round(x: number, places: number): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------
// Rendering — one function, used by the agents AND the UI
// ---------------------------------------------------------------------------

/**
 * The single rendering of a transcript that agents ever see.
 *
 * It matters that this is shared: the critic's grounding check compares a
 * quoted span against `turns[i].text` literally, so if the UI and the agents
 * rendered transcripts differently, evidence highlighting would drift out of
 * sync with validation and the demo would lie about what was checked.
 */
export function renderTranscript(t: Transcript): string {
  const header = `CALL ${t.callId} | captured ${t.capturedAt} | ASR confidence ${t.asrConfidence}`;
  const body = t.turns
    .map((turn, i) => `[${i}] ${mmss(turn.t)} ${turn.speaker}: ${turn.text}`)
    .join('\n');
  return `${header}\n${body}`;
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
