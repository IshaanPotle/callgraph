/**
 * Layer 4 — activation.
 *
 * The division of labour here is the whole point of the layer, and it is the
 * opposite of the obvious one. The obvious design hands a model the extracted
 * table and asks it to find what matters. That design produces a page of
 * confident, well-written, unfalsifiable claims — "customers are increasingly
 * frustrated with onboarding" — because a model asked to find patterns will
 * always find patterns, and the ones it invents read exactly like the ones it
 * doesn't.
 *
 * So the model gets no say in *what* is true. `findPatterns` enumerates every
 * hypothesis the schema admits, tests each with an exact binomial tail,
 * controls the false discovery rate across all of them, and throws out the ones
 * that are tautological, redundant or borrowed from the vertical. By the time
 * anything reaches this file the numbers are settled. A model cannot inflate a
 * lift here, because it is never asked for one.
 *
 * What it is asked for is the sentence. Turning `blocker = price_objection →
 * end_state = lost, 2.4x baseline, n=31, q=0.004` into something an operations
 * lead reads on a Monday is a language problem, and it is a real one — the
 * statistics are worthless if nobody can act on them. That is the job: phrase a
 * measured result, name the action it implies, and rank the severity. Every
 * number in the output is copied through from the hypothesis, and the schema
 * makes that structural rather than aspirational.
 *
 * The failure mode this guards against is the expensive one. A wrong number in
 * a findings surface is not a bug users file — it is a roadmap item somebody
 * funds.
 */

import { z } from 'zod';

import { CONFIG } from '../config.js';
import type { LlmProvider } from '../core/llm/provider.js';
import type { Signal } from '../core/types.js';
import type { Hypothesis, PatternReport } from '../pipeline/aggregate.js';
import { simulateActivation } from '../sim/activation.js';

const SignalSchema = z.object({
  title: z
    .string()
    .describe(
      'Eight words or fewer. What is true, not what it is about. Name the column ' +
        'as well as the value — "true" and "high" mean nothing on their own.',
    ),
  finding: z
    .string()
    .describe(
      'One or two sentences stating the measured result in plain language. ' +
        'Must be consistent with the numbers given. Do not add numbers of your own.',
    ),
  severity: z
    .enum(['info', 'watch', 'urgent'])
    .describe('How much of a hurry a human should be in.'),
  recommendedAction: z
    .string()
    .describe('One concrete next step a specific person could take this week.'),
});

const ResponseSchema = z.object({
  signals: z.array(SignalSchema),
});

export const ACTIVATION_SYSTEM = `You write the findings page for a call-analytics product. Your readers run
contact-center operations. They are busy, they are numerate, and they have been
burned before by dashboards that dressed up noise as insight.

You will be given results that have ALREADY been established. Each one has been
tested against a null hypothesis, corrected for multiple comparisons across
thousands of candidates, and checked for whether it is merely restating the
line of business. The statistics are not your department and not up for
revision.

Your department is the sentence.

Rules, in order of how badly it goes when you break them:

1. Never state a number that was not given to you. Not a rounded one, not a
   "roughly", not a derived percentage. If you want to say something is common,
   say the measured rate you were given or say nothing.

2. Never generalize past the population. A result measured on claims calls is
   about claims calls. "Customers are frustrated" is a claim about customers;
   you were given a claim about 31 calls.

3. The title is a finding, not a topic. "Price objections lose deals" is a
   title. "Pricing" is a filing label and tells the reader nothing they can act
   on.

4. Severity means how fast, not how interesting. \`urgent\` is for things
   costing money right now — lost deals, unhandled escalations, compliance
   gaps. \`watch\` is for a real pattern with no immediate bleeding. \`info\` is
   for structure worth knowing. Most findings are \`watch\`. A page where
   everything is urgent has told the reader nothing.

5. The recommended action must be doable by a person. "Improve the sales
   process" is not an action. "Pull the 31 lost calls with price objections and
   check whether the discount authority was actually available" is.

If a result seems thin to you, say so plainly in the finding. Reporting a weak
result as weak is more useful than reporting it as strong, and much more useful
than dropping it silently.`;

export interface ActivationResult {
  signals: Signal[];
  /** Hypotheses that qualified but exceeded the cap, so the cut is visible. */
  omitted: number;
}

/**
 * Write the findings page.
 *
 * One call for all signals rather than one per signal, which is the cheaper
 * option but not why it is done. Severity is comparative — `urgent` only means
 * something relative to the rest of the page — and a model ranking each finding
 * in isolation has no way to know whether it is looking at the worst thing here
 * or the mildest. Ranking is the task, so the page is the unit.
 */
export async function runActivation(
  provider: LlmProvider,
  report: PatternReport,
): Promise<ActivationResult> {
  // Only `finding` reaches the page. The other three verdicts survived every
  // statistical gate and are still not things to tell a human: taxonomy is the
  // schema describing itself, redundant is a column predicting its own twin,
  // confounded is the vertical's result wearing a costume. They stay in the
  // artifact — the UI shows what was filtered and why, because "we tested 4145
  // hypotheses and 18 of the survivors were definitional" is itself worth
  // seeing — but they are not findings.
  const eligible = report.hypotheses.filter((h) => h.verdict === 'finding');
  const chosen = eligible.slice(0, CONFIG.activation.maxSignals);

  if (chosen.length === 0) {
    return { signals: [], omitted: 0 };
  }

  const result = await provider.generate({
    agent: 'activate.narrate',
    system: ACTIVATION_SYSTEM,
    user: renderHypotheses(chosen),
    schema: ResponseSchema,
    maxTokens: 4000,
    simulate: () => simulateActivation(chosen),
  });

  // Zip by position. The model is asked for one signal per result in order, and
  // if it returns a different count the extras are dropped and the shortfall
  // goes unwritten rather than being paired with the wrong statistics. Silently
  // mismatching prose to numbers is the exact failure this layer exists to
  // prevent, so it is better to ship fewer signals than mislabelled ones.
  const signals = chosen.slice(0, result.signals.length).map((h, i) => {
    const written = result.signals[i]!;
    return {
      id: signalId(h),
      title: written.title,
      finding: written.finding,
      severity: written.severity,
      recommendedAction: written.recommendedAction,
      callIds: h.callIds,
      metric: {
        label: `${h.outcomeField} = ${h.outcomeValue}`,
        value: `${(100 * h.conditionalRate).toFixed(0)}% of ${h.n} calls`,
        baseline: `${(100 * h.baselineRate).toFixed(0)}% overall`,
      },
    } satisfies Signal;
  });

  return { signals, omitted: eligible.length - chosen.length };
}

/**
 * A stable handle for a finding, derived from the claim rather than its rank.
 *
 * Position would be easier and wrong: the UI links to signals and a rerun that
 * reorders the page must not silently repoint every link at a different claim.
 * The condition and outcome are what the finding *is*, so they are what names
 * it.
 */
function signalId(h: Hypothesis): string {
  return `sig-${`${h.condition}->${h.outcome}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * The hypotheses as the model sees them.
 *
 * Rendered rather than serialized as JSON, because the model's job is to write
 * English about these and the format it reads primes the format it writes. The
 * numbers are labelled with what they mean rather than with their variable
 * names — `q` is not self-explanatory and a model guessing at it is a model
 * guessing.
 */
function renderHypotheses(hypotheses: Hypothesis[]): string {
  const blocks = hypotheses.map((h, i) => {
    const lines = [
      `## Result ${i + 1}`,
      `Among calls where ${h.condition}, ${h.outcomeField} was ${h.outcomeValue}.`,
      `- Happened on ${h.k} of ${h.n} such calls (${(100 * h.conditionalRate).toFixed(0)}%).`,
      `- Across all calls the rate is ${(100 * h.baselineRate).toFixed(0)}%.`,
      `- That is ${h.lift.toFixed(2)} times the overall rate.`,
      `- False-discovery-adjusted significance: q = ${h.qValue!.toExponential(1)}.`,
    ];

    if (h.stratifiedLift !== null) {
      lines.push(
        `- Holding the line of business constant, the effect is ${h.stratifiedLift.toFixed(2)} times` +
          ` — so this is not just a restatement of which vertical the calls came from.`,
      );
    }

    return lines.join('\n');
  });

  return [
    `${hypotheses.length} results, already tested and ranked. Write one signal for each,`,
    `in the same order. Return exactly ${hypotheses.length} signals.`,
    '',
    ...blocks,
  ].join('\n');
}
