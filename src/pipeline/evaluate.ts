/**
 * The eval harness. Everything the pipeline claims, checked against the latent
 * facts each transcript was rendered from.
 *
 * The corpus is generated from `CallFacts` objects and only then turned into
 * text, so ground truth exists before the words do and no labelling budget is
 * needed. That is the one advantage a synthetic corpus has, and it is the whole
 * reason this harness can exist at all — it is also the thing that most limits
 * what these numbers mean, which the README says in the first screen rather
 * than a footnote.
 *
 * Alignment is the part that had to be earned rather than declared. The
 * pipeline invents its own column names, so before anything can be scored,
 * `end_state` has to be recognised as `outcome` and `amount_usd` as
 * `dollarAmount`. Writing that mapping by hand would be writing the answer key:
 * the eval would then be measuring a table I typed, and any column discovery got
 * subtly wrong would be quietly corrected on its way to being graded. So the
 * mapping is measured instead — see `alignFields`.
 */

import { CONFIG } from '../config.js';
import type { InjectedFault } from '../sim/faults.js';
import type {
  CalibrationBin,
  CallFacts,
  CriticScore,
  DiscoveredSchema,
  EvalReport,
  CallExtraction,
  FieldAlignment,
  FieldScore,
  GoldField,
  RoutingPoint,
  ValidatedCall,
} from '../core/types.js';
import { GOLD_FIELDS } from '../core/types.js';

export interface EvalInput {
  runId: string;
  provider: 'anthropic' | 'stub';
  gold: Map<string, CallFacts>;
  /** Raw layer-2 output, before the critic touched anything. */
  extractions: CallExtraction[];
  /** Layer-3 output, after gating, critique and repair. */
  validated: ValidatedCall[];
  schema: DiscoveredSchema;
}

export function runEval(input: EvalInput): EvalReport {
  const { gold, extractions, validated, schema } = input;

  const alignment = alignFields(schema, extractions, gold);
  const toGold = new Map(
    alignment.filter((a) => a.gold !== null).map((a) => [a.discovered, a.gold!] as const),
  );

  const perField = scoreFields(alignment, validated, gold);
  const scored = perField.filter((f) => f.support > 0);

  return {
    runId: input.runId,
    provider: input.provider,
    callsScored: validated.length,
    alignment,
    perField,
    macroF1: mean(scored.map((f) => f.f1)),
    microAccuracy: ratio(
      sum(perField.map((f) => f.correct)),
      sum(perField.map((f) => f.support)),
    ),
    preValidationAccuracy: rawAccuracy(extractions, toGold, gold),
    postValidationAccuracy: validatedAccuracy(validated, toGold, gold),
    calibration: calibrate(validated, toGold, gold),
    critic: scoreCritic(validated, toGold, gold),
    routing: routingCurve(validated, toGold, gold),
  };
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/**
 * Which discovered column is which gold field, decided by evidence.
 *
 * Name matching alone cannot do this. Half the real mappings here are semantic
 * rather than lexical — `end_state`/`outcome`, `blocker`/`objection`,
 * `followup_date`/`commitmentDate` — and no edit distance will ever connect
 * those. What does connect them is that they carry the same information across
 * 240 calls, so that is what gets measured.
 *
 * Normalised mutual information rather than raw agreement, for two reasons.
 * Agreement is meaningless across differently-labelled categories — a column
 * that perfectly predicts the gold value while spelling it differently should
 * score 1.0, and under agreement it scores 0. And on booleans, two unrelated
 * columns agree about half the time by luck, so an absolute threshold would
 * either admit noise or reject real matches depending on the column's marginal
 * distribution. NMI is corrected for both.
 *
 * Matching is greedy over descending score and one-to-one, because two
 * discovered columns claiming the same gold field is a genuine outcome worth
 * seeing — the loser is reported unmapped rather than silently double-counted.
 */
export function alignFields(
  schema: DiscoveredSchema,
  extractions: CallExtraction[],
  gold: Map<string, CallFacts>,
): FieldAlignment[] {
  const pairs: { discovered: string; gold: GoldField; score: number }[] = [];

  for (const field of schema.fields) {
    for (const g of GOLD_FIELDS) {
      const joint: [string, string][] = [];
      for (const e of extractions) {
        const facts = gold.get(e.callId);
        if (!facts) continue;
        joint.push([
          norm(e.fields[field.name]?.value ?? null),
          norm((facts as unknown as Record<string, unknown>)[g] ?? null),
        ]);
      }
      pairs.push({ discovered: field.name, gold: g, score: normalizedMutualInformation(joint) });
    }
  }

  pairs.sort((a, b) => b.score - a.score);

  const takenGold = new Set<string>();
  const assigned = new Map<string, { gold: GoldField; score: number }>();

  // Name identity is settled first, ahead of any evidence.
  //
  // This is the one place a name is allowed to decide a mapping, and the reason
  // is that identity is not a judgement call: `disclosure_given` and
  // `disclosureGiven` are the same string once case and separators are gone, and
  // I did not get to pick a threshold that made that true. Fuzzy similarity
  // would be a different matter entirely — every cutoff I could choose is one I
  // would have chosen by looking at whether the mappings I expected came out,
  // which is writing the answer key with extra steps.
  //
  // It matters because MI alone cannot tell a column with no gold counterpart
  // apart from a column whose extractor is performing at chance, and those are
  // opposite findings. `disclosure_given` scores below the floor here — the
  // detector genuinely is near-random — and left unmapped it would be reported
  // as a gold field discovery never found, missing on all 240 calls. Discovery
  // found it. Extraction is what failed, the score says so, and `method: exact`
  // against a low `score` is precisely that diagnosis on the page.
  for (const f of schema.fields) {
    const hit = pairs.find((p) => p.discovered === f.name && slug(p.discovered) === slug(p.gold));
    if (!hit || takenGold.has(hit.gold)) continue;
    assigned.set(f.name, { gold: hit.gold, score: hit.score });
    takenGold.add(hit.gold);
  }

  for (const p of pairs) {
    if (p.score < ALIGNMENT_FLOOR) break;
    if (assigned.has(p.discovered) || takenGold.has(p.gold)) continue;
    assigned.set(p.discovered, { gold: p.gold, score: p.score });
    takenGold.add(p.gold);
  }

  return schema.fields.map((f) => {
    const hit = assigned.get(f.name);
    if (!hit) return { discovered: f.name, gold: null, method: 'unmapped' as const, score: 0 };
    return {
      discovered: f.name,
      gold: hit.gold,
      // `exact` is reported when the names *also* agree once case and
      // separators are stripped. It changes nothing about the mapping — the
      // evidence already decided that — but it distinguishes the columns
      // discovery happened to name conventionally from the ones it earned.
      method: slug(f.name) === slug(hit.gold) ? ('exact' as const) : ('similarity' as const),
      score: hit.score,
    };
  });
}

/**
 * Below this, a column is calling itself unmapped rather than guessing.
 *
 * Set where it is because the pipeline genuinely discovers columns with no gold
 * counterpart at all — call quality, hold events, identity verification — and
 * the correct answer for those is "nothing", not the least-bad match. A harness
 * that always finds a partner for every column would report a schema-discovery
 * score that cannot go down.
 */
const ALIGNMENT_FLOOR = 0.2;

/**
 * I(X;Y) / sqrt(H(X)·H(Y)) — 1.0 when either column determines the other,
 * 0 when they are independent, regardless of how the categories are labelled
 * or how lopsided the marginals are.
 */
function normalizedMutualInformation(joint: [string, string][]): number {
  if (joint.length === 0) return 0;

  const n = joint.length;
  const px = new Map<string, number>();
  const py = new Map<string, number>();
  // Nested rather than keyed on a joined string. The obvious delimiter is a
  // NUL byte, and a NUL byte is exactly what the null sentinel starts with, so
  // every joint cell containing a missing value split into three parts, missed
  // both lookups and came back NaN — which sorts as neither greater nor less
  // than anything and so quietly scrambled the whole alignment. Nesting removes
  // the delimiter, and with it the question of which byte is safe.
  const pxy = new Map<string, Map<string, number>>();

  for (const [x, y] of joint) {
    px.set(x, (px.get(x) ?? 0) + 1);
    py.set(y, (py.get(y) ?? 0) + 1);
    const row = pxy.get(x) ?? new Map<string, number>();
    row.set(y, (row.get(y) ?? 0) + 1);
    pxy.set(x, row);
  }

  const hx = entropy([...px.values()], n);
  const hy = entropy([...py.values()], n);
  // A column with one distinct value carries no information, so it cannot be
  // matched to anything. Returning 0 rather than dividing by zero.
  if (hx === 0 || hy === 0) return 0;

  let mi = 0;
  for (const [x, row] of pxy) {
    for (const [y, c] of row) {
      mi += (c / n) * Math.log2((c / n) / ((px.get(x)! / n) * (py.get(y)! / n)));
    }
  }

  return Math.max(0, Math.min(1, mi / Math.sqrt(hx * hy)));
}

function entropy(counts: number[], n: number): number {
  let h = 0;
  for (const c of counts) {
    if (c > 0) h -= (c / n) * Math.log2(c / n);
  }
  return h;
}

// ---------------------------------------------------------------------------
// Field-level scoring
// ---------------------------------------------------------------------------

/**
 * Precision and recall per gold field, splitting the ways an extraction can be
 * wrong rather than pooling them.
 *
 * A missed value, an invented value and a wrong value have different causes and
 * different fixes — recall problems live in the extractor's coverage, precision
 * problems in its eagerness, and `wrongValue` is usually a vocabulary gap. One
 * F1 number hides which of the three you have.
 */
function scoreFields(
  alignment: FieldAlignment[],
  validated: ValidatedCall[],
  gold: Map<string, CallFacts>,
): FieldScore[] {
  const byGold = new Map(
    alignment.filter((a) => a.gold).map((a) => [a.gold!, a.discovered] as const),
  );

  return GOLD_FIELDS.map((g) => {
    const discovered = byGold.get(g) ?? null;
    const s = {
      gold: g,
      discovered,
      support: 0,
      correct: 0,
      falsePositive: 0,
      falseNegative: 0,
      wrongValue: 0,
    };

    for (const call of validated) {
      const facts = gold.get(call.callId);
      if (!facts) continue;

      const truth = norm((facts as unknown as Record<string, unknown>)[g] ?? null);
      // A gold field discovery never found is scored as a miss on every call it
      // occurs in. Skipping it would let the pipeline raise its own F1 by
      // finding fewer columns.
      const got = discovered ? norm(call.fields[discovered]?.value ?? null) : NULL;

      const truthPresent = truth !== NULL;
      if (truthPresent) s.support++;

      if (truthPresent && got === truth) s.correct++;
      else if (truthPresent && got === NULL) s.falseNegative++;
      else if (truthPresent) s.wrongValue++;
      else if (got !== NULL) s.falsePositive++;
    }

    const predicted = s.correct + s.wrongValue + s.falsePositive;
    const precision = ratio(s.correct, predicted);
    const recall = ratio(s.correct, s.support);
    return {
      ...s,
      precision,
      recall,
      f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Does a stated confidence of 0.8 mean right eight times in ten?
 *
 * This is the number the whole routing story rests on. Every cost lever in
 * layer 3 — the gate, the sampling budget, the human-review floor — is a
 * threshold on confidence, and a threshold on an uncalibrated score is a
 * threshold on nothing. Expected calibration error is the weighted average gap
 * between stated confidence and observed accuracy across bins.
 */
function calibrate(
  validated: ValidatedCall[],
  toGold: Map<string, GoldField>,
  gold: Map<string, CallFacts>,
): { bins: CalibrationBin[]; ece: number } {
  const points = judgements(validated, toGold, gold);
  const width = 1 / CONFIG.eval.calibrationBins;

  const bins: CalibrationBin[] = [];
  for (let i = 0; i < CONFIG.eval.calibrationBins; i++) {
    const lo = i * width;
    const hi = lo + width;
    // Closed at the top only in the last bin, so confidence 1.0 lands somewhere.
    const inBin = points.filter(
      (p) => p.confidence >= lo && (i === CONFIG.eval.calibrationBins - 1 ? p.confidence <= hi : p.confidence < hi),
    );
    bins.push({
      lo,
      hi,
      count: inBin.length,
      meanConfidence: mean(inBin.map((p) => p.confidence)),
      accuracy: ratio(inBin.filter((p) => p.correct).length, inBin.length),
    });
  }

  const total = points.length;
  const ece = sum(bins.map((b) => (b.count / (total || 1)) * Math.abs(b.accuracy - b.meanConfidence)));
  return { bins, ece };
}

// ---------------------------------------------------------------------------
// The critic
// ---------------------------------------------------------------------------

/**
 * Was the critic right to reject?
 *
 * The two error types cost very different things and are worth separating. A
 * false positive burns a repair attempt on an answer that was already correct —
 * annoying, bounded, and visible in the cost line. A false negative ships a
 * wrong record to a customer-facing surface, and nothing downstream will ever
 * catch it. A critic tuned to look good on precision is usually a critic that
 * has quietly stopped catching things.
 */
function scoreCritic(
  validated: ValidatedCall[],
  toGold: Map<string, GoldField>,
  gold: Map<string, CallFacts>,
): CriticScore {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  let flagged = 0;
  let flaggedWithoutToken = 0;

  for (const call of validated) {
    const facts = gold.get(call.callId);
    if (!facts) continue;

    for (const f of Object.values(call.fields)) {
      const g = toGold.get(f.field);
      if (!g) continue;

      // Judged against the *pre-repair* value: the question is whether the
      // critic was right to object, not whether the repair afterwards worked.
      const original = f.verdicts.length > 0 ? f.verdicts : [];
      const rejected = original.some((v) => v.verdict === 'reject');
      const wrong = norm(f.value) !== norm((facts as unknown as Record<string, unknown>)[g] ?? null);

      if (rejected) {
        flagged++;
        if (original.every((v) => v.decidedBy !== 'critic')) flaggedWithoutToken++;
      }

      // `repaired` means the critic objected and the objection was acted on, so
      // it counts as a catch even where the field now matches gold.
      const objected = rejected || f.disposition === 'repaired';
      if (objected && (wrong || f.disposition === 'repaired')) truePositive++;
      else if (objected) falsePositive++;
      else if (wrong) falseNegative++;
      else trueNegative++;
    }
  }

  return {
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision: ratio(truePositive, truePositive + falsePositive),
    recall: ratio(truePositive, truePositive + falseNegative),
    deterministicShare: ratio(flaggedWithoutToken, flagged),
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * If a human reviews the least-confident X% of fields, what share of the actual
 * errors do they see?
 *
 * This is the curve an operator actually buys against — not accuracy, which
 * they cannot change, but the exchange rate between review hours and errors
 * caught. A steep left end means confidence is doing real work and a small
 * review budget goes a long way; a diagonal means it is ranking at chance and
 * the review queue may as well be random.
 */
function routingCurve(
  validated: ValidatedCall[],
  toGold: Map<string, GoldField>,
  gold: Map<string, CallFacts>,
): RoutingPoint[] {
  const points = judgements(validated, toGold, gold).sort((a, b) => a.confidence - b.confidence);
  const errorsTotal = points.filter((p) => !p.correct).length;

  return CONFIG.eval.routingShares.map((reviewShare) => {
    const cut = Math.round(reviewShare * points.length);
    const reviewed = points.slice(0, cut);
    const auto = points.slice(cut);
    return {
      reviewShare,
      errorsCaught: reviewed.filter((p) => !p.correct).length,
      errorsTotal,
      autoAccuracy: ratio(auto.filter((p) => p.correct).length, auto.length),
    };
  });
}

// ---------------------------------------------------------------------------
// Validating the harness itself
// ---------------------------------------------------------------------------

export interface FaultRecovery {
  injected: number;
  /** Injected into a column no gold field aligns to, so unscoreable either way. */
  unscored: number;
  /** Landed on a value that was already wrong. Corrupting it creates no new error. */
  alreadyWrong: number;
  /** Was correct, was corrupted, and the eval counts it wrong. */
  surfaced: number;
  /** Was correct, was corrupted, and layer 3 put it back. */
  repaired: number;
  /** Was correct, was corrupted, and the eval still calls it correct. Must be 0. */
  lost: number;
  detectable: number;
  /** `surfaced + repaired === detectable`, with nothing in `lost`. */
  accounted: boolean;
}

/**
 * Does the eval detect errors, or does it merely produce numbers?
 *
 * Nothing else in this file can answer that. Every metric above is computed
 * against gold labels, so a harness that silently dropped half its errors would
 * report a clean, plausible, entirely wrong accuracy and no amount of staring at
 * it would say so. The usual response is to trust the harness, because against a
 * real model there is no alternative: you never learn what the true error was,
 * only what your labels claim, and that is the thing under test.
 *
 * A simulator removes that circularity. Corrupt a known value on a known call at
 * a known rate, run the eval blind, and every injected fault must come out
 * somewhere. There are only three honest destinations — the eval reports it, the
 * pipeline repaired it, or it was landing on an already-wrong value and never
 * changed anything. A fault that arrives at none of those has been lost, which
 * means the accuracy number is not counting errors it should be counting.
 *
 * So the assertion is an identity rather than a rate: `surfaced + repaired ===
 * detectable`, `lost === 0`. Rates invite tuning until they look convincing. An
 * identity either holds or names the faults that went missing.
 */
export function recoverFaults(
  clean: EvalInput,
  faulted: EvalInput,
  injected: InjectedFault[],
): FaultRecovery {
  const toGold = new Map(
    alignFields(clean.schema, clean.extractions, clean.gold)
      .filter((a) => a.gold !== null)
      .map((a) => [a.discovered, a.gold!] as const),
  );

  const index = (input: EvalInput): Map<string, boolean> =>
    new Map(
      judgements(input.validated, toGold, input.gold).map(
        (j) => [`${j.callId}/${j.field}`, j.correct] as const,
      ),
    );
  const before = index(clean);
  const after = index(faulted);

  const r: FaultRecovery = {
    injected: injected.length,
    unscored: 0,
    alreadyWrong: 0,
    surfaced: 0,
    repaired: 0,
    lost: 0,
    detectable: 0,
    accounted: false,
  };

  for (const f of injected) {
    const key = `${f.callId}/${f.field}`;
    const wasCorrect = before.get(key);
    // A field routed to human review drops out of both runs and is scored in
    // neither, so it is unscored rather than lost.
    if (wasCorrect === undefined || !after.has(key)) {
      r.unscored++;
      continue;
    }
    if (!wasCorrect) {
      r.alreadyWrong++;
      continue;
    }

    r.detectable++;
    if (after.get(key) === false) r.surfaced++;
    else r.repaired++;
  }

  // `repaired` is inferred rather than observed — the value came back correct,
  // so something restored it. That is the only way it could have, but it is
  // worth being explicit that this is the residual, not a measurement.
  r.lost = r.detectable - r.surfaced - r.repaired;
  r.accounted = r.lost === 0;
  return r;
}

// ---------------------------------------------------------------------------
// Pricing the cost lever
// ---------------------------------------------------------------------------

export interface PolicyChannel {
  decidedBy: 'deterministic' | 'sampling' | 'critic';
  shipped: number;
  errors: number;
  errorRate: number;
  /** This channel's share of every error that shipped. */
  shareOfErrors: number;
}

export interface PolicyAudit {
  channels: PolicyChannel[];
  shipped: number;
  errors: number;
  /**
   * Errors that shipped through `sampling` — nothing looked at them — scaled by
   * the critic's measured recall. This is the number of additional errors full
   * critic coverage would plausibly have caught, and therefore the actual price
   * of the saving.
   */
  recoverableByFullCoverage: number;
  criticRecall: number;
}

/**
 * What did the validation budget cost in accuracy?
 *
 * `skipCriticAbove` and the per-column coverage policy exist to avoid paying a
 * model to confirm what string comparison already confirmed, and both are easy
 * to justify with the cost line alone: 1,708 of 3,360 fields decided for free
 * is a real number and it is the one that gets put on the slide. It is also not
 * an answer to the question anyone should ask, which is what came through the
 * gap.
 *
 * The answer on this corpus is not the one the framing implies. Splitting
 * shipped errors by what settled them:
 *
 *     deterministic   1160 shipped   197 errors   17.0%   78.5% of all errors
 *     sampling         310 shipped    22 errors    7.1%    8.8%
 *     critic           605 shipped    32 errors    5.3%   12.7%
 *
 * The uninspected channel is the *cleanest* one. Four fifths of everything
 * wrong shipped with a deterministic check's blessing, at more than double the
 * error rate of the fields nothing looked at — because those checks verify
 * grounding, not correctness. A quote that really does appear in the transcript
 * says the extractor was reading; it says nothing about whether the value it
 * wrote down is the right reading of it. `sentiment` and `disclosure_given`
 * pass grounding on nearly every call and are wrong on a quarter of them.
 *
 * That reframes the cost lever entirely. The saving is defensible, and the
 * reason is not that the skipped work was cheap — it is that the cheap check
 * standing in for it was never doing the job it was credited with.
 *
 * `recoverableByFullCoverage` is the bottom line, and it deliberately does not
 * assume the critic would have caught what it never saw. It scales the
 * uninspected errors by the critic's *measured* recall on the fields it did
 * see. That recall is 0.022, so the answer is well under one error — which
 * makes the policy look excellent for a second unflattering reason: the critic
 * is barely finding anything anywhere, so skipping it costs almost nothing.
 * Both of these are things a cost slide would have hidden and an eval has to
 * say out loud.
 */
export function auditPolicy(input: EvalInput, critic: CriticScore): PolicyAudit {
  const toGold = new Map(
    alignFields(input.schema, input.extractions, input.gold)
      .filter((a) => a.gold !== null)
      .map((a) => [a.discovered, a.gold!] as const),
  );

  const tally = new Map<string, { shipped: number; errors: number }>();

  for (const call of input.validated) {
    const facts = input.gold.get(call.callId);
    if (!facts) continue;
    for (const f of Object.values(call.fields)) {
      // Only what shipped. A field sent to a human is not an error the system
      // made, it is a question the system declined to answer, and folding those
      // together would let the policy look good by routing more away.
      if (f.disposition === 'human_review') continue;
      const g = toGold.get(f.field);
      if (!g) continue;

      // The last verdict is the one that settled it: a field can be cleared
      // deterministically, sent to the critic anyway on a low confidence, and
      // the critic's word is what shipped.
      const decidedBy = f.verdicts.at(-1)?.decidedBy ?? 'sampling';
      const t = tally.get(decidedBy) ?? { shipped: 0, errors: 0 };
      t.shipped++;
      if (norm(f.value) !== norm((facts as unknown as Record<string, unknown>)[g] ?? null)) {
        t.errors++;
      }
      tally.set(decidedBy, t);
    }
  }

  const shipped = sum([...tally.values()].map((t) => t.shipped));
  const errors = sum([...tally.values()].map((t) => t.errors));

  const channels = (['deterministic', 'sampling', 'critic'] as const).map((decidedBy) => {
    const t = tally.get(decidedBy) ?? { shipped: 0, errors: 0 };
    return {
      decidedBy,
      shipped: t.shipped,
      errors: t.errors,
      errorRate: ratio(t.errors, t.shipped),
      shareOfErrors: ratio(t.errors, errors),
    };
  });

  const uninspected = tally.get('sampling')?.errors ?? 0;

  return {
    channels,
    shipped,
    errors,
    recoverableByFullCoverage: uninspected * critic.recall,
    criticRecall: critic.recall,
  };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

interface Judgement {
  callId: string;
  field: string;
  confidence: number;
  correct: boolean;
}

/** Every aligned field on every call, with its confidence and whether it is right. */
function judgements(
  validated: ValidatedCall[],
  toGold: Map<string, GoldField>,
  gold: Map<string, CallFacts>,
): Judgement[] {
  const out: Judgement[] = [];
  for (const call of validated) {
    const facts = gold.get(call.callId);
    if (!facts) continue;
    for (const f of Object.values(call.fields)) {
      const g = toGold.get(f.field);
      if (!g) continue;
      out.push({
        callId: call.callId,
        field: f.field,
        confidence: f.confidence,
        correct: norm(f.value) === norm((facts as unknown as Record<string, unknown>)[g] ?? null),
      });
    }
  }
  return out;
}

function rawAccuracy(
  extractions: CallExtraction[],
  toGold: Map<string, GoldField>,
  gold: Map<string, CallFacts>,
): number {
  let correct = 0;
  let total = 0;
  for (const e of extractions) {
    const facts = gold.get(e.callId);
    if (!facts) continue;
    for (const [name, extraction] of Object.entries(e.fields)) {
      const g = toGold.get(name);
      if (!g) continue;
      total++;
      if (norm(extraction.value) === norm((facts as unknown as Record<string, unknown>)[g] ?? null)) {
        correct++;
      }
    }
  }
  return ratio(correct, total);
}

function validatedAccuracy(
  validated: ValidatedCall[],
  toGold: Map<string, GoldField>,
  gold: Map<string, CallFacts>,
): number {
  const points = judgements(validated, toGold, gold);
  return ratio(points.filter((p) => p.correct).length, points.length);
}

const NULL = ' null';

/**
 * One canonical string per value, so that `12329`, `"12329"` and `"$12,329"`
 * compare equal while `2026-07-05` and `2026-07-09` do not.
 *
 * Dates are compared to the day and numbers to the cent, both deliberately
 * strict: a follow-up promised four days late is a wrong answer, and normalising
 * that away would be the harness declining to see the errors it exists to
 * count.
 */
function norm(v: unknown): string {
  if (v === null || v === undefined || v === '') return NULL;
  if (typeof v === 'boolean') return v ? 'true' : 'false';

  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : NULL;

  const s = String(v).trim().toLowerCase();
  if (s === '' || s === 'null' || s === 'none' || s === 'n/a') return NULL;

  const asNumber = Number(s.replace(/[$,\s]/g, ''));
  if (s !== '' && Number.isFinite(asNumber) && /^[$\s,\d.+-]+$/.test(s)) return String(asNumber);

  const asDate = Date.parse(s);
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(asDate)) {
    return new Date(asDate).toISOString().slice(0, 10);
  }

  return s.replace(/[\s_-]+/g, ' ');
}

/** `product_line` and `productLine` collapse to the same key. */
function slug(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[\s_-]+/g, '').toLowerCase();
}

function ratio(num: number, den: number): number {
  return den > 0 ? num / den : 0;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function mean(xs: number[]): number {
  return xs.length > 0 ? sum(xs) / xs.length : 0;
}
