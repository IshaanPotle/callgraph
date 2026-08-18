/**
 * Layer 3 — validation.
 *
 * The layer exists because an extractor's confidence is its own opinion of
 * its own work, and a system that ships on that alone has no way to tell a
 * confident right answer from a confident wrong one. So every field goes
 * through a funnel, cheapest stage first:
 *
 *   1. Deterministic grounding. String operations, zero tokens. Catches
 *      unverifiable values and fabricated spans outright.
 *   2. A confidence gate. A field that passed every check and came back very
 *      confident is accepted without a model call. This is what keeps the
 *      layer from doubling the cost of the pipeline; the share of fields that
 *      reach the critic is reported, not assumed.
 *   3. The critic. Given the span, a narrow window around it, and the claimed
 *      value — deliberately NOT the whole call. The question is "does this
 *      span say that", and handing over the full transcript invites the
 *      critic to re-derive the answer from scratch and agree with itself.
 *   4. One repair attempt, seeded with the critic's reading.
 *   5. A human, for anything still unresolved or below the confidence floor.
 *
 * Step 5 is the point of steps 1–4. Human review is the expensive resource,
 * and every earlier stage exists to spend less of it on things that were
 * already fine.
 */

import { z } from 'zod';

import { CONFIG } from '../config.js';
import { mapLimit } from '../core/async.js';
import type { LlmProvider } from '../core/llm/provider.js';
import { hashString } from '../core/rng.js';
import type {
  CallExtraction,
  Disposition,
  DiscoveredField,
  DiscoveredSchema,
  FieldExtraction,
  FieldVerdict,
  Transcript,
  ValidatedCall,
  ValidatedField,
} from '../core/types.js';
import { checkGrounding } from '../pipeline/grounding.js';
import { simulateCritique, simulateRepair, type Critique } from '../sim/validation.js';

const CritiqueSchema = z.object({
  verdict: z.enum(['accept', 'reject']),
  reason: z.string().describe('One sentence. What the span does or does not establish.'),
  corrected: z
    .union([z.string(), z.number(), z.boolean()])
    .nullable()
    .describe('The reading the span actually supports, or null if it supports nothing.'),
});

const RepairSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.object({ quote: z.string(), turnIndex: z.number().int() })),
});

const CRITIC_SYSTEM = `You are checking one extracted field against the evidence cited for it.

You will be given: the column and what it means, the value an extractor
produced, the exact span the extractor quoted as its evidence, and a few turns
of surrounding context from the call.

You are NOT given the full transcript, and that is deliberate. Your job is not
to work out the right answer — it is to decide whether the quoted span
establishes the claimed value. Those are different questions and only the
second one catches an extractor that got the right answer from the wrong place.

Reject when:
- The span reads as something else. Say what it reads as.
- The span is generic and would support half the values this column can take.
- The speaker retracted what the span relies on. "That'll be 52,329— no sorry,
  12,329" retracts 52,329. Check for this specifically; extractors take the
  first number they see and this is the most common way they are wrong.
- The span is negated, conditional or hypothetical, and the value treats it as
  a fact. "If this happens again I'll switch to ArcticAire" is not a switch.

Accept when the span establishes the value, even if:
- The quote is not character-for-character identical to the transcript. An
  extractor that dropped "um" and [inaudible] out of its quote tidied it up;
  that is not a fabrication and the content is what matters.
- The cited turn index is off by a turn or two. Calls get split mid-sentence
  by interruptions and the sentence a span belongs to often starts earlier.
- The value is outside the list of values seen before. The list came from a
  small sample. A genuinely new category is a finding, not an error.

When you reject, put your own reading of the span in "corrected", or null if
the span supports nothing at all. That reading is what the repair pass gets,
so a wrong guess there is worse than an honest null.`;

const REPAIR_SYSTEM = `You are re-extracting one field that failed validation.

You will be given the column, the value that was rejected, why it was rejected,
the reviewer's own reading of the evidence, and the turns around it.

You have no information the first extractor did not have, apart from the
rejection. So there are only two honest outcomes:

1. The reviewer's reading is right, or you can find the correct value in the
   context you were given. Return it, with a span that supports it.
2. You cannot. Return null with low confidence.

Do not return the rejected value again with a different justification, and do
not return a third value you cannot cite. A null here gets the call routed to a
human, which is the correct outcome when the call is genuinely unclear. A
confident guess here is worse than useless: it looks resolved and it is not.`;

export interface ValidationStats {
  fieldsTotal: number;
  /** Decided by string comparison alone — no token spent. */
  decidedDeterministically: number;
  /**
   * Accepted without any check at all, because the sampling budget declined to
   * spend a critic on the column. Kept separate from `decidedDeterministically`
   * on purpose: one of those numbers is work that was done cheaply, the other
   * is work that was not done. Reporting them as one number would let the
   * funnel look thorough by counting its own blind spots as coverage.
   */
  unreviewed: number;
  criticCalls: number;
  repairs: number;
  humanReview: number;
  /** Critic calls spent establishing per-column rejection rates. */
  calibrationCalls: number;
  /** Fields the sampling policy declined to critique, by column. */
  coverage: ColumnBudget[];
}

/** What the calibration pass learned about one column, and what it bought. */
export interface ColumnBudget {
  field: string;
  calibrationCalls: number;
  calibrationRejects: number;
  /**
   * Null when calibration never got a clean read of this column — every
   * eligible field was already being forced to the critic by suspicion, so
   * there was no unremarkable population to measure.
   *
   * Distinct from zero, and the distinction is the whole point: zero means the
   * critic looked and found nothing, null means nobody looked. They imply
   * opposite budgets, and collapsing them into one number is how a sampling
   * policy ends up rationing a column it knows nothing about.
   */
  rejectionRate: number | null;
  /**
   * The rate the budget is actually set from: the observed rate pulled toward
   * a pessimistic prior by an amount that depends on how little was observed.
   * Reported alongside the raw rate rather than instead of it, so the run
   * summary shows both what the critic saw and what the policy believed.
   */
  smoothedRate: number | null;
  /** Share of post-calibration eligible fields sent to the critic. */
  coverage: number;
  eligible: number;
  sampled: number;
  /** Sent to the critic despite the sampling policy, because grounding was odd. */
  forcedBySuspicion: number;
}

export interface ValidationOptions {
  concurrency: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Where a field goes, decided before any model is called.
 *
 * `skip` is the confidence gate, `force` is targeted suspicion, `sample` is
 * the adaptive budget. Separating them matters: suspicion is evidence about
 * *this* field and must never be sampled away, while the budget is a claim
 * about the column and is exactly what should be rationed.
 */
type Route = 'skip' | 'force' | 'sample' | 'unsampled';

export async function runValidation(
  provider: LlmProvider,
  corpus: Transcript[],
  extractions: CallExtraction[],
  schema: DiscoveredSchema,
  opts: ValidationOptions,
): Promise<{ calls: ValidatedCall[]; stats: ValidationStats }> {
  const byId = new Map(corpus.map((t) => [t.callId, t]));

  // The calibration set is the first N calls in corpus order. Deliberately not
  // random: the run has to be reproducible, and a seeded shuffle here would
  // buy variance-reduction the eval cannot observe anyway.
  const calibrationIds = new Set(
    extractions.slice(0, CONFIG.validation.calibrationCalls).map((e) => e.callId),
  );

  const stats: ValidationStats = {
    fieldsTotal: 0,
    decidedDeterministically: 0,
    unreviewed: 0,
    criticCalls: 0,
    repairs: 0,
    humanReview: 0,
    calibrationCalls: 0,
    coverage: [],
  };

  const budgets = new Map<string, ColumnBudget>(
    schema.fields.map((f) => [
      f.name,
      {
        field: f.name,
        calibrationCalls: 0,
        calibrationRejects: 0,
        rejectionRate: 0,
        smoothedRate: null,
        coverage: 1,
        eligible: 0,
        sampled: 0,
        forcedBySuspicion: 0,
      },
    ]),
  );

  const results = new Map<string, Record<string, ValidatedField>>();
  let done = 0;

  const runPass = (subset: CallExtraction[], phase: 'calibration' | 'policy') =>
    mapLimit(subset, opts.concurrency, async (extraction) => {
      const transcript = byId.get(extraction.callId)!;
      const fields: Record<string, ValidatedField> = {};

      for (const field of schema.fields) {
        const raw = extraction.fields[field.name];
        if (!raw) continue;
        fields[field.name] = await validateField(
          provider,
          transcript,
          field,
          raw,
          stats,
          budgets.get(field.name)!,
          phase,
        );
      }

      results.set(extraction.callId, fields);
      opts.onProgress?.(++done, extractions.length);
    });

  // Pass A — the critic reads every eligible field on the calibration calls,
  // and its rejection rate on each column becomes that column's budget.
  await runPass(
    extractions.filter((e) => calibrationIds.has(e.callId)),
    'calibration',
  );

  for (const b of budgets.values()) {
    if (b.calibrationCalls === 0) {
      // Never measured. Default to full coverage rather than the floor: the
      // safe direction for an unknown is to spend, and a column that arrives
      // here is one where every single field looked odd to the grounding
      // checks, which is not a column to start economising on.
      b.rejectionRate = null;
      b.coverage = 1;
      continue;
    }

    const { priorRejects, priorAccepts } = CONFIG.validation;
    b.rejectionRate = b.calibrationRejects / b.calibrationCalls;
    b.smoothedRate =
      (b.calibrationRejects + priorRejects) / (b.calibrationCalls + priorRejects + priorAccepts);

    b.coverage = Math.min(
      1,
      Math.max(CONFIG.validation.minCoverage, b.smoothedRate * CONFIG.validation.coverageMultiplier),
    );
  }

  // Pass B — the rest, under the budgets just measured.
  await runPass(
    extractions.filter((e) => !calibrationIds.has(e.callId)),
    'policy',
  );

  stats.coverage = [...budgets.values()];

  const calls = extractions.map((e) => ({
    callId: e.callId,
    vertical: byId.get(e.callId)!.vertical,
    fields: results.get(e.callId)!,
  }));

  return { calls, stats };
}

// ---------------------------------------------------------------------------

async function validateField(
  provider: LlmProvider,
  transcript: Transcript,
  field: DiscoveredField,
  extraction: FieldExtraction,
  stats: ValidationStats,
  budget: ColumnBudget,
  phase: 'calibration' | 'policy',
): Promise<ValidatedField> {
  stats.fieldsTotal++;
  const verdicts: FieldVerdict[] = [];

  const grounding = checkGrounding(extraction, field, transcript);

  // Stage 1 — conclusive on string evidence alone.
  if (grounding.fatal) {
    stats.decidedDeterministically++;
    verdicts.push({
      field: field.name,
      verdict: 'reject',
      reason: grounding.fatal,
      decidedBy: 'deterministic',
      checks: grounding.checks,
    });
    stats.humanReview++;
    return finalize(field, extraction, verdicts, 'human_review', 1);
  }

  // Stage 2 — absence claims. There is no span for a critic to re-read, and a
  // critic that can only ever answer "plausible" is a bill, not a check.
  // Deciding whether a missing value is real needs the whole call, which is
  // exactly what the critic is deliberately not given. So absence is routed on
  // confidence — and because the extractor discounts absence claims on
  // degraded audio, the calls where a cue was most likely dropped are the ones
  // that reach a human.
  if (grounding.absenceClaim) {
    stats.decidedDeterministically++;
    const low = extraction.confidence < CONFIG.extraction.confidenceFloor;
    verdicts.push({
      field: field.name,
      verdict: low ? 'reject' : 'accept',
      reason: low
        ? 'claims no value, but not confidently enough on a transcript this degraded to accept the absence'
        : 'claims no value; nothing in the call contradicts that and the transcript is clean enough to trust it',
      decidedBy: 'deterministic',
      checks: grounding.checks,
    });
    if (low) stats.humanReview++;
    return finalize(field, extraction, verdicts, low ? 'human_review' : 'accepted', 1);
  }

  // Stage 3 — routing. Three separate questions, in order of how much they
  // know: is this field individually trustworthy, is it individually odd, and
  // failing both, is this column worth spending on at all.
  const route = routeField(field, extraction, grounding, budget, transcript, phase);

  if (route === 'skip') {
    stats.decidedDeterministically++;
    verdicts.push({
      field: field.name,
      verdict: 'accept',
      reason: 'fully grounded and above the confidence gate; not sent to the critic',
      decidedBy: 'deterministic',
      checks: grounding.checks,
    });
    return finalize(field, extraction, verdicts, 'accepted', 1);
  }

  if (route === 'unsampled') {
    stats.unreviewed++;
    verdicts.push({
      field: field.name,
      verdict: 'accept',
      reason:
        `not reviewed: the critic rejected ${(100 * (budget.rejectionRate ?? 0)).toFixed(1)}% of this column ` +
        `during calibration, so it runs at ${(100 * budget.coverage).toFixed(0)}% coverage`,
      decidedBy: 'sampling',
      checks: grounding.checks,
    });

    // The budget rations the critic. It does not get to overrule the floor:
    // a field this uncertain was going to a human whatever the critic said,
    // and a sampling policy that can silently accept one has stopped being a
    // cost lever and started being a hole.
    const low = extraction.confidence < CONFIG.extraction.confidenceFloor;
    if (low) stats.humanReview++;
    return finalize(field, extraction, verdicts, low ? 'human_review' : 'accepted', 1);
  }

  // Stage 4 — the critic.
  stats.criticCalls++;
  const critique = await critique1(provider, transcript, field, extraction);

  // Calibration measures the population the policy will later be applied to,
  // which is the *unremarkable* fields — the ones nothing but the budget has
  // an opinion about. Counting the forced-by-suspicion reads here would fold
  // the grounding checks' hit rate into the column's rejection rate and buy
  // coverage for work the suspicion route was already going to do.
  if (phase === 'calibration' && route === 'sample') {
    stats.calibrationCalls++;
    budget.calibrationCalls++;
    if (critique.verdict === 'reject') budget.calibrationRejects++;
  }

  verdicts.push({
    field: field.name,
    verdict: critique.verdict,
    reason: critique.reason,
    decidedBy: 'critic',
    checks: grounding.checks,
  });

  if (critique.verdict === 'accept') {
    const low = extraction.confidence < CONFIG.extraction.confidenceFloor;
    if (low) stats.humanReview++;
    return finalize(field, extraction, verdicts, low ? 'human_review' : 'accepted', 1);
  }

  // Stage 5 — one repair, seeded with the critic's reading.
  stats.repairs++;
  const repaired = await repair(provider, transcript, field, extraction, critique);
  const attempt: FieldExtraction = { field: field.name, ...repaired };

  const reground = checkGrounding(attempt, field, transcript);
  if (reground.fatal || attempt.value === null || attempt.confidence < CONFIG.extraction.confidenceFloor) {
    verdicts.push({
      field: field.name,
      verdict: 'reject',
      reason: reground.fatal ?? 'repair could not establish a value it could cite',
      decidedBy: 'deterministic',
      checks: reground.checks,
    });
    stats.humanReview++;
    return finalize(field, attempt, verdicts, 'human_review', 2);
  }

  verdicts.push({
    field: field.name,
    verdict: 'accept',
    reason: `repaired: ${critique.reason}`,
    decidedBy: 'deterministic',
    checks: reground.checks,
  });
  return finalize(field, attempt, verdicts, 'repaired', 2);
}

/**
 * Three questions, asked in order of how much they know about this particular
 * field, and the order is the whole design.
 *
 * The first two are about the field itself and are never overruled by budget.
 * A field that is clean and confident is cheap to be right about; a field whose
 * span could not be located, or whose value is outside every value the column
 * has ever taken, is the case the critic exists for. Rationing *that* would be
 * saving money by not looking where the errors are.
 *
 * Only what is left — unremarkable, middling-confidence, nothing specifically
 * wrong with it — is subject to the budget, and the budget is a claim about the
 * column rather than the row: if the critic rejected nothing in sixty reads of
 * `product_line`, the sixty-first is not where it starts. That is an argument
 * about a rate, so it can only ever justify a rate, which is why what comes
 * back is a coverage share and not a verdict.
 *
 * The draw is a hash of the call and column rather than an RNG, because the
 * two passes run under `mapLimit` and a shared generator would hand out
 * different numbers depending on which call happened to finish first. Same
 * corpus, same decisions, regardless of concurrency.
 */
function routeField(
  field: DiscoveredField,
  extraction: FieldExtraction,
  grounding: { suspicious: boolean },
  budget: ColumnBudget,
  transcript: Transcript,
  phase: 'calibration' | 'policy',
): Route {
  if (!grounding.suspicious && extraction.confidence >= CONFIG.validation.skipCriticAbove) {
    return 'skip';
  }

  budget.eligible++;

  if (grounding.suspicious) {
    budget.forcedBySuspicion++;
    return 'force';
  }

  if (phase === 'calibration') return 'sample';

  const draw = hashString(`critic-sample:${transcript.callId}:${field.name}`) / 2 ** 32;
  if (draw >= budget.coverage) return 'unsampled';

  budget.sampled++;
  return 'sample';
}

function finalize(
  field: DiscoveredField,
  extraction: FieldExtraction,
  verdicts: FieldVerdict[],
  disposition: Disposition,
  attempts: number,
): ValidatedField {
  return {
    field: field.name,
    value: extraction.value,
    confidence: extraction.confidence,
    evidence: extraction.evidence,
    disposition,
    verdicts,
    attempts,
  };
}

// ---------------------------------------------------------------------------

async function critique1(
  provider: LlmProvider,
  transcript: Transcript,
  field: DiscoveredField,
  extraction: FieldExtraction,
): Promise<Critique> {
  const context = window(transcript, extraction);
  const grounding = checkGrounding(extraction, field, transcript);

  return provider.generate({
    agent: 'validate.critic',
    callId: transcript.callId,
    system: CRITIC_SYSTEM,
    user: [
      `COLUMN: ${field.name} (${field.type})`,
      `MEANING: ${field.description}`,
      field.enumValues?.length ? `VALUES SEEN IN THE SAMPLE: ${field.enumValues.join(', ')}` : '',
      ``,
      `EXTRACTED VALUE: ${JSON.stringify(extraction.value)}`,
      `EXTRACTOR CONFIDENCE: ${extraction.confidence}`,
      `CITED SPAN: ${JSON.stringify(extraction.evidence[0]?.quote ?? null)}`,
      `CITED TURN: ${extraction.evidence[0]?.turnIndex ?? 'none'}`,
      ``,
      `CONTEXT (turns ${context.from}–${context.to} of ${transcript.turns.length}, ASR confidence ${transcript.asrConfidence}):`,
      context.text,
    ]
      .filter(Boolean)
      .join('\n'),
    schema: CritiqueSchema,
    maxTokens: 800,
    simulate: () => simulateCritique(field, extraction, transcript, grounding.checks, context.text),
  });
}

async function repair(
  provider: LlmProvider,
  transcript: Transcript,
  field: DiscoveredField,
  extraction: FieldExtraction,
  critique: Critique,
): Promise<{ value: FieldExtraction['value']; confidence: number; evidence: FieldExtraction['evidence'] }> {
  const context = window(transcript, extraction);

  return provider.generate({
    agent: 'extract.repair',
    callId: transcript.callId,
    system: REPAIR_SYSTEM,
    user: [
      `COLUMN: ${field.name} (${field.type})`,
      `MEANING: ${field.description}`,
      ``,
      `REJECTED VALUE: ${JSON.stringify(extraction.value)}`,
      `REASON: ${critique.reason}`,
      `REVIEWER'S READING: ${JSON.stringify(critique.corrected)}`,
      ``,
      `CONTEXT (turns ${context.from}–${context.to}):`,
      context.text,
    ].join('\n'),
    schema: RepairSchema,
    maxTokens: 700,
    simulate: () => simulateRepair(extraction, critique),
  });
}

/**
 * The cited turn plus two either side. Wide enough that a retraction or a
 * negation split across turns is visible; narrow enough that the critic
 * cannot quietly re-derive the answer from the whole call and agree with the
 * extractor for reasons unrelated to the span.
 */
function window(transcript: Transcript, extraction: FieldExtraction): { text: string; from: number; to: number } {
  const cited = extraction.evidence[0]?.turnIndex ?? -1;
  const centre = cited >= 0 && cited < transcript.turns.length ? cited : 0;
  const from = Math.max(0, centre - 2);
  const to = Math.min(transcript.turns.length - 1, centre + 2);

  const text = transcript.turns
    .slice(from, to + 1)
    .map((turn, i) => `[${from + i}] ${turn.speaker}: ${turn.text}`)
    .join('\n');

  return { text, from, to };
}
