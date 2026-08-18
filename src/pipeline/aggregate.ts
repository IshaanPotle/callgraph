/**
 * The statistics behind layer 4. No model is called in this file, on purpose.
 *
 * Asking a model to "find the patterns in this data" is the single most common
 * way an analytics demo becomes a liar. The model will produce a paragraph
 * containing numbers, the numbers will be plausible, and roughly none of them
 * will be the numbers. So the arithmetic happens here, exactly, and the model's
 * job downstream is strictly to phrase a finding it is handed — a task where
 * being wrong is visible rather than invisible.
 *
 * Three families of hypothesis, because they answer different questions:
 *
 *   association — does one column's value predict another's? ("customers who
 *                 raise price also churn")
 *   vertical    — is a value concentrated in one line of business?
 *   trend       — is a value's rate moving across the window?
 *
 * All three reduce to the same shape: a condition, an outcome, a rate under the
 * condition, and a baseline rate. That means one significance test covers all
 * of them, which matters, because the multiple-comparisons problem here is not
 * hypothetical — the enumeration below tests thousands of hypotheses against a
 * few hundred calls, and at that ratio "lift above 1.4 on six calls" will
 * produce a page of confident findings from pure noise.
 */

import { CONFIG } from '../config.js';
import type { DiscoveredSchema, Transcript, ValidatedCall, Vertical } from '../core/types.js';

export type Family = 'association' | 'vertical' | 'trend';

/**
 * What a statistically valid result actually is.
 *
 * Significance is necessary and nowhere near sufficient, and the gap between
 * those two is where analytics products lose their credibility. Every one of
 * these verdicts describes a result that passed support, lift and
 * false-discovery control — they differ in whether the thing they established
 * is about the calls or about the schema:
 *
 *   finding   — worth a human's attention.
 *   taxonomy  — true by construction. "SaaS calls discuss the API tier" is not
 *               a discovery, it is the definition of a product line, and a
 *               surface that reports twenty of these has buried its four real
 *               findings under its own filing system.
 *   redundant — the two columns carry the same information, so the result is
 *               that a column predicts itself. That says nothing about the
 *               calls and something quite important about layer 1, which is
 *               why it is surfaced rather than dropped.
 *   confounded— real, but borrowed. The condition predicts the outcome only
 *               because both track the line of business. "Renters policies get
 *               ID checks" is the claims vertical's finding wearing a costume,
 *               and shipping five costumes of one fact is how a findings page
 *               becomes five wrong roadmap items.
 */
export type Verdict = 'finding' | 'taxonomy' | 'redundant' | 'confounded';

export interface Hypothesis {
  family: Family;
  /** Human-readable condition, e.g. `blocker = price_objection`. */
  condition: string;
  /** Human-readable outcome, e.g. `end_state = churn_risk`. */
  outcome: string;
  conditionField: string;
  outcomeField: string;
  outcomeValue: string;
  /** Calls where the condition holds and the outcome column was resolved. */
  n: number;
  /** Of those, calls where the outcome holds. This is the signal's support. */
  k: number;
  conditionalRate: number;
  baselineRate: number;
  lift: number;
  /** P(X >= k) under the baseline rate. Exact binomial, not an approximation. */
  pValue: number;
  /** Benjamini-Hochberg adjusted. Null until the correction has been applied. */
  qValue: number | null;
  /**
   * Share of all occurrences of the outcome value that sit under the
   * condition. At 1.0 the condition does not predict the outcome, it contains
   * it — and containment is a fact about the taxonomy, not about the calls.
   */
  exclusivity: number;
  /**
   * Lift recomputed within each vertical and pooled by direct standardisation.
   * Null where the question does not apply — see `stratify`.
   */
  stratifiedLift: number | null;
  /** Null until classification has run. */
  verdict: Verdict | null;
  callIds: string[];
}

export interface PatternReport {
  /** Every hypothesis the enumeration produced, before any filtering. */
  tested: number;
  /** Survived support and lift gates. */
  passedGates: number;
  /** Survived the false-discovery-rate correction too. */
  survivedFdr: number;
  /** Everything that survived, classified. Findings first. */
  hypotheses: Hypothesis[];
  /** Pairs of columns that turned out to carry the same information. */
  redundantColumns: { a: string; b: string; agreement: number }[];
  /** Rows that contributed. See `buildRows` for why this is not `calls.length`. */
  rows: number;
  /** Field values dropped for being too rare to support any claim. */
  rareValuesDropped: number;
  fdrQ: number;
}

/**
 * One row per call, holding only the values the pipeline actually stands
 * behind.
 *
 * A field sitting in `human_review` is not a value, it is an open question, and
 * rolling open questions into a denominator is how a dashboard reports a rate
 * for something nobody ever confirmed. Excluding them costs some support and
 * buys the property that every number downstream is made of resolved records.
 */
interface Row {
  callId: string;
  vertical: Vertical;
  capturedAt: number;
  values: Map<string, string>;
}

export function findPatterns(
  calls: ValidatedCall[],
  corpus: Transcript[],
  schema: DiscoveredSchema,
): PatternReport {
  const capturedAt = new Map(corpus.map((t) => [t.callId, Date.parse(t.capturedAt)]));
  const rows = buildRows(calls, capturedAt, schema);

  const { domains, rareValuesDropped } = buildDomains(rows);
  const observed = observationCounts(rows);

  const hypotheses = [
    ...associations(rows, domains, observed),
    ...verticalConcentrations(rows, domains, observed),
    ...trends(rows, domains),
  ];

  const passed = hypotheses.filter(
    (h) => h.k >= CONFIG.activation.minCallsPerSignal && h.lift >= CONFIG.activation.minLift,
  );

  // The correction is applied over *everything enumerated*, not just what
  // passed the gates. Correcting over the survivors would be counting only the
  // coins that came up heads — the gates are themselves a selection step, and
  // the number of chances taken is what the p-values have to be judged against.
  const surviving = dedupe(benjaminiHochberg(passed, hypotheses.length, CONFIG.activation.fdrQ));

  const redundantColumns = findRedundantColumns(rows, [...domains.keys()]);
  const redundant = new Set(redundantColumns.flatMap((p) => [`${p.a}|${p.b}`, `${p.b}|${p.a}`]));

  const classified = surviving.map((h) => {
    const stratifiedLift = stratify(h, rows);
    return { ...h, stratifiedLift, verdict: classify(h, redundant, stratifiedLift) };
  });
  const rank = { finding: 0, confounded: 1, redundant: 2, taxonomy: 3 } as const;

  return {
    tested: hypotheses.length,
    passedGates: passed.length,
    survivedFdr: surviving.length,
    hypotheses: classified.sort(
      (a, b) => rank[a.verdict!] - rank[b.verdict!] || a.qValue! - b.qValue! || b.lift - a.lift,
    ),
    redundantColumns,
    rows: rows.length,
    rareValuesDropped,
    fdrQ: CONFIG.activation.fdrQ,
  };
}

/**
 * The condition explains the outcome's *existence* rather than its rate.
 *
 * A rule rather than a threshold sweep: at exclusivity 1.0 every single call
 * carrying the outcome value also carries the condition, which means the
 * outcome cannot occur without it. `product_line = API Tier` never appears
 * outside SaaS calls because API Tier is a SaaS product. There is no rate to
 * act on there, only a filing system, and the lift is high precisely because
 * the categories nest.
 *
 * The threshold sits just below 1.0 rather than at it so that a single
 * misextracted call — an HVAC transcript that picked up "API tier" from noise —
 * cannot promote a taxonomy fact into a finding. That is not hypothetical: at
 * this pipeline's error rate roughly one call in fifty would do it.
 */
function classify(h: Hypothesis, redundant: Set<string>, stratifiedLift: number | null): Verdict {
  if (redundant.has(`${h.conditionField}|${h.outcomeField}`)) return 'redundant';
  if (h.exclusivity >= 0.97) return 'taxonomy';
  if (stratifiedLift !== null && stratifiedLift < CONFIG.activation.minLift) return 'confounded';
  return 'finding';
}

/**
 * Does the association survive being told which line of business the call was?
 *
 * This is the failure the rest of the layer cannot catch, because the numbers
 * are real. `product_line = Renters → identity_check = true` at 2.13× is a
 * correct calculation; Renters is a claims product, claims calls verify
 * identity, and the association is the vertical's, borrowed. So is
 * `call_reason = deductible_dispute`, and `= coverage_question`, and every other
 * claims-shaped column. One fact arrives as five findings, each pointing at a
 * different and wrong thing to go fix.
 *
 * Direct standardisation answers it: compute what the outcome count *would* have
 * been if the condition group had the vertical's own base rate, and compare that
 * to what was actually observed. If a condition only ever selects a vertical,
 * expected equals observed and the ratio collapses to 1. What is left is the
 * part the condition explains that the vertical does not.
 *
 * Null for the vertical family, where the answer is a tautology — those
 * hypotheses are *about* the vertical, and stratifying by it would leave one
 * stratum and no comparison. Findings like "claims calls verify identity, HVAC
 * calls do not" are the real story here, and they are exactly what the borrowed
 * associations were shadowing.
 */
function stratify(h: Hypothesis, rows: Row[]): number | null {
  if (h.family === 'vertical') return null;

  const [condField, condValue] = splitTerm(h.condition);
  if (!condField) return null;

  let expected = 0;
  let observed = 0;

  for (const v of new Set(rows.map((r) => r.vertical))) {
    const inV = rows.filter((r) => r.vertical === v && r.values.has(h.outcomeField));
    if (inV.length === 0) continue;

    const baseline = inV.filter((r) => r.values.get(h.outcomeField) === h.outcomeValue).length / inV.length;
    const hits = inV.filter((r) => r.values.get(condField) === condValue);

    observed += hits.filter((r) => r.values.get(h.outcomeField) === h.outcomeValue).length;
    expected += hits.length * baseline;
  }

  // Nothing to compare against: the outcome never occurs in any vertical the
  // condition appears in, so within-stratum lift is undefined rather than
  // infinite. Returning null routes it to the unstratified verdict instead of
  // manufacturing a number.
  return expected > 0 ? observed / expected : null;
}

/** `blocker = price_objection` -> `['blocker', 'price_objection']`. */
function splitTerm(term: string): [string, string] {
  const at = term.indexOf(' = ');
  return at < 0 ? ['', ''] : [term.slice(0, at), term.slice(at + 3)];
}

/**
 * Column pairs that carry the same information, detected without being told
 * which columns those might be.
 *
 * Layer 1 proposes columns from a sample and merges the ones that look alike by
 * name. It cannot catch two columns that were named differently and described
 * differently but happen to mean the same thing — in this corpus, `line_quality`
 * and `audio_gap`, which are both "the ASR dropped audio". Nothing upstream will
 * ever notice, because from inside the extractor they are two columns that
 * happen to agree.
 *
 * From the aggregates it is obvious: if the modal value of B given A explains
 * essentially every row in both directions, the two columns are one column.
 * Both directions matter — one-way containment is a taxonomy, and it is only
 * mutual containment that makes them the same measurement.
 */
function findRedundantColumns(rows: Row[], fields: string[]): { a: string; b: string; agreement: number }[] {
  const out: { a: string; b: string; agreement: number }[] = [];

  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const a = fields[i]!;
      const b = fields[j]!;
      const both = rows.filter((r) => r.values.has(a) && r.values.has(b));
      if (both.length < 4 * CONFIG.activation.minCallsPerSignal) continue;

      const ab = modalAgreement(both, a, b);
      const ba = modalAgreement(both, b, a);
      const agreement = Math.min(ab, ba);
      if (agreement >= 0.97) out.push({ a, b, agreement });
    }
  }

  return out.sort((x, y) => y.agreement - x.agreement);
}

/** Share of rows explained by mapping each value of `from` to its modal `to`. */
function modalAgreement(rows: Row[], from: string, to: string): number {
  const table = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = r.values.get(from)!;
    const m = table.get(key) ?? new Map<string, number>();
    const v = r.values.get(to)!;
    m.set(v, (m.get(v) ?? 0) + 1);
    table.set(key, m);
  }

  let explained = 0;
  for (const m of table.values()) explained += Math.max(...m.values());
  return explained / rows.length;
}

// ---------------------------------------------------------------------------
// Building the table
// ---------------------------------------------------------------------------

function buildRows(
  calls: ValidatedCall[],
  capturedAt: Map<string, number>,
  schema: DiscoveredSchema,
): Row[] {
  const byType = (t: string) =>
    new Set(schema.fields.filter((f) => f.type === t).map((f) => f.name));
  const numericFields = byType('number');
  const dateFields = byType('date');

  const rows: Row[] = calls.map((c) => ({
    callId: c.callId,
    vertical: c.vertical,
    capturedAt: capturedAt.get(c.callId) ?? 0,
    values: new Map(
      Object.values(c.fields)
        .filter((f) => f.disposition !== 'human_review' && f.value !== null)
        .map((f) => [f.field, String(f.value)] as const),
    ),
  }));

  // A dollar amount takes a different value on every call, so as a raw string
  // it can never support a claim about anything. Bucketing into terciles of the
  // observed distribution is what makes "big-ticket calls churn more" a
  // question this layer can answer at all — and terciles specifically, because
  // fixed thresholds would encode an assumption about deal size that belongs to
  // whichever vertical happened to be loudest in the corpus.
  for (const field of numericFields) {
    bucketByTercile(rows, field, (r) => Number(r.values.get(field)), ['low', 'mid', 'high']);
  }

  // Dates are worse than amounts, because they look categorical. Left alone,
  // `followup_date = 2026-06-23` is a category with four members and a baseline
  // rate of zero everywhere else, which is how a calendar coincidence becomes
  // the most significant result in the run. What a follow-up date actually
  // carries is a horizon — how far out the commitment was made — so that is
  // what gets measured. "Callbacks are being booked further out this month" is
  // a finding; "six calls mentioned the 23rd" is not.
  for (const field of dateFields) {
    bucketByTercile(
      rows,
      field,
      (r) => {
        const t = Date.parse(r.values.get(field)!);
        return Number.isFinite(t) ? (t - r.capturedAt) / 86_400_000 : NaN;
      },
      ['near', 'mid', 'far'],
    );
  }

  return rows;
}

/**
 * Replace a continuous field with which third of the observed range it fell in.
 *
 * Labels are passed in rather than fixed, because they end up verbatim in a
 * sentence a human reads. `amount_usd = high` and `followup_date = far` both say
 * something; `followup_date = high` says nothing, and a finding nobody can parse
 * is indistinguishable from no finding.
 */
function bucketByTercile(
  rows: Row[],
  field: string,
  project: (r: Row) => number,
  labels: [string, string, string],
): void {
  const measured = rows
    .filter((r) => r.values.has(field))
    .map((r) => ({ r, x: project(r) }))
    .filter((m) => Number.isFinite(m.x));

  if (measured.length < 3 * CONFIG.activation.minCallsPerSignal) return;

  const sorted = measured.map((m) => m.x).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length / 3)]!;
  const hi = sorted[Math.floor((2 * sorted.length) / 3)]!;

  // Degenerate terciles happen when a distribution is mostly one value, and
  // relabelling everything 'low' would invent a constant column that then
  // correlates with everything. Better to leave the field out of the analysis
  // than to manufacture a variable.
  if (!(lo < hi)) {
    for (const { r } of measured) r.values.delete(field);
    return;
  }

  for (const { r, x } of measured) {
    r.values.set(field, x < lo ? labels[0] : x < hi ? labels[1] : labels[2]);
  }
}

function buildDomains(rows: Row[]): {
  domains: Map<string, string[]>;
  rareValuesDropped: number;
} {
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    for (const [field, value] of r.values) {
      const m = counts.get(field) ?? new Map<string, number>();
      m.set(value, (m.get(value) ?? 0) + 1);
      counts.set(field, m);
    }
  }

  const domains = new Map<string, string[]>();
  let rareValuesDropped = 0;

  for (const [field, m] of counts) {
    const kept: string[] = [];
    for (const [value, n] of m) {
      // A value seen fewer times than the support threshold cannot back a
      // signal even if every occurrence agreed, so enumerating it only inflates
      // the multiple-comparisons penalty for the values that can.
      if (n >= CONFIG.activation.minCallsPerSignal) kept.push(value);
      else rareValuesDropped++;
    }
    if (kept.length > 0) domains.set(field, kept.sort());
  }

  return { domains, rareValuesDropped };
}

/** How many rows resolved each field at all. The honest denominator. */
function observationCounts(rows: Row[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) for (const field of r.values.keys()) out.set(field, (out.get(field) ?? 0) + 1);
  return out;
}

// ---------------------------------------------------------------------------
// The three families
// ---------------------------------------------------------------------------

function associations(
  rows: Row[],
  domains: Map<string, string[]>,
  observed: Map<string, number>,
): Hypothesis[] {
  const out: Hypothesis[] = [];
  const fields = [...domains.keys()];

  for (const condField of fields) {
    for (const condValue of domains.get(condField)!) {
      const matching = rows.filter((r) => r.values.get(condField) === condValue);

      for (const outField of fields) {
        if (outField === condField) continue;

        // Both rates are computed over rows where the outcome column was
        // actually resolved. Using every row would let a column that is often
        // unresolved look rare rather than unmeasured, and the lift would then
        // be reporting the coverage of the extractor rather than anything about
        // the calls.
        const pool = matching.filter((r) => r.values.has(outField));
        if (pool.length < CONFIG.activation.minCallsPerSignal) continue;
        const baseN = observed.get(outField) ?? 0;
        if (baseN === 0) continue;

        for (const outValue of domains.get(outField)!) {
          const hits = pool.filter((r) => r.values.get(outField) === outValue);
          const baseK = rows.filter((r) => r.values.get(outField) === outValue).length;
          push(
            out,
            build(
              'association',
              `${condField} = ${condValue}`,
              `${outField} = ${outValue}`,
              condField,
              outField,
              outValue,
              pool.length,
              hits,
              baseK / baseN,
              baseK,
            ),
          );
        }
      }
    }
  }

  return out;
}

function verticalConcentrations(
  rows: Row[],
  domains: Map<string, string[]>,
  observed: Map<string, number>,
): Hypothesis[] {
  const out: Hypothesis[] = [];
  const verticals = [...new Set(rows.map((r) => r.vertical))].sort();

  for (const vertical of verticals) {
    const matching = rows.filter((r) => r.vertical === vertical);

    for (const [field, values] of domains) {
      const pool = matching.filter((r) => r.values.has(field));
      if (pool.length < CONFIG.activation.minCallsPerSignal) continue;
      const baseN = observed.get(field) ?? 0;
      if (baseN === 0) continue;

      for (const value of values) {
        const hits = pool.filter((r) => r.values.get(field) === value);
        const baseK = rows.filter((r) => r.values.get(field) === value).length;
        push(
          out,
          build(
            'vertical',
            `vertical = ${vertical}`,
            `${field} = ${value}`,
            'vertical',
            field,
            value,
            pool.length,
            hits,
            baseK / baseN,
            baseK,
          ),
        );
      }
    }
  }

  return out;
}

function trends(rows: Row[], domains: Map<string, string[]>): Hypothesis[] {
  const out: Hypothesis[] = [];
  const dated = [...rows].filter((r) => r.capturedAt > 0).sort((a, b) => a.capturedAt - b.capturedAt);
  if (dated.length < 4 * CONFIG.activation.minCallsPerSignal) return out;

  const mid = Math.floor(dated.length / 2);
  const early = dated.slice(0, mid);
  const late = dated.slice(mid);

  for (const [field, values] of domains) {
    const latePool = late.filter((r) => r.values.has(field));
    const earlyPool = early.filter((r) => r.values.has(field));
    if (latePool.length < CONFIG.activation.minCallsPerSignal) continue;
    if (earlyPool.length < CONFIG.activation.minCallsPerSignal) continue;

    for (const value of values) {
      const hits = latePool.filter((r) => r.values.get(field) === value);
      const earlyK = earlyPool.filter((r) => r.values.get(field) === value).length;

      // The baseline for a trend is the *earlier half*, not the whole window.
      // Comparing the back half against an average that already contains the
      // back half damps every real movement toward nothing.
      //
      // Exclusivity is against the whole window rather than the late half,
      // because the question a trend has to survive is the same one: did the
      // rate move, or does this value simply not exist outside this period.
      const total = dated.filter((r) => r.values.get(field) === value).length;
      push(
        out,
        build(
          'trend',
          `second half of the window`,
          `${field} = ${value}`,
          'capturedAt',
          field,
          value,
          latePool.length,
          hits,
          earlyK / earlyPool.length,
          total,
        ),
      );
    }
  }

  return out;
}

function push(out: Hypothesis[], h: Hypothesis | null): void {
  if (h) out.push(h);
}

function build(
  family: Family,
  condition: string,
  outcome: string,
  conditionField: string,
  outcomeField: string,
  outcomeValue: string,
  n: number,
  hits: Row[],
  baselineRate: number,
  outcomeTotal: number,
): Hypothesis | null {
  // A zero baseline makes lift infinite and the binomial tail exactly zero, so
  // the hypothesis sorts to the top of every ranking on the strength of having
  // been untestable. What it actually means is that the comparison group never
  // had a chance to show the outcome — which is a reason to say nothing, not a
  // reason to shout.
  if (!(baselineRate > 0)) return null;

  const k = hits.length;
  const conditionalRate = n > 0 ? k / n : 0;
  return {
    family,
    condition,
    outcome,
    conditionField,
    outcomeField,
    outcomeValue,
    n,
    k,
    conditionalRate,
    baselineRate,
    lift: conditionalRate / baselineRate,
    pValue: binomialTail(k, n, baselineRate),
    qValue: null,
    exclusivity: outcomeTotal > 0 ? k / outcomeTotal : 0,
    stratifiedLift: null,
    verdict: null,
    callIds: hits.map((r) => r.callId),
  };
}

// ---------------------------------------------------------------------------
// Significance
// ---------------------------------------------------------------------------

/**
 * P(X >= k) for X ~ Binomial(n, p), summed exactly.
 *
 * Exact rather than a normal approximation because the interesting cases here
 * are precisely the ones the approximation handles worst: small n, small p, and
 * a tail. "9 of 11 calls, against a 12% base rate" is the shape of a real
 * finding in this data, and the normal approximation is off by an order of
 * magnitude there. Terms are computed with a running ratio rather than
 * factorials, which would overflow well before n = 240.
 */
function binomialTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (p <= 0) return k > 0 ? 0 : 1;
  if (p >= 1) return 1;
  if (k > n) return 0;

  let term = Math.pow(1 - p, n);
  let total = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) total += term;
    term *= ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.min(1, total);
}

/**
 * Benjamini-Hochberg, rather than Bonferroni.
 *
 * Both control for having taken thousands of shots at the target. Bonferroni
 * controls the chance of *any* false finding, which is the right guarantee when
 * one wrong answer is a catastrophe; here it is not, and paying for it means
 * discarding most of the true signals in a corpus this size. BH instead bounds
 * the expected share of reported findings that are false at `q` — so "roughly
 * one in twenty of these is noise" is a claim the surface can actually make.
 *
 * `mTested` is the full enumeration, not `passed.length`. See the caller.
 */
function benjaminiHochberg(passed: Hypothesis[], mTested: number, q: number): Hypothesis[] {
  const sorted = [...passed].sort((a, b) => a.pValue - b.pValue);

  let cutoff = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.pValue <= ((i + 1) / mTested) * q) cutoff = i;
  }
  if (cutoff < 0) return [];

  // Step-up: everything at or below the largest passing rank is accepted, even
  // if its own p-value would have failed the individual comparison.
  return sorted.slice(0, cutoff + 1).map((h, i) => ({
    ...h,
    qValue: Math.min(1, (h.pValue * mTested) / (i + 1)),
  }));
}

/**
 * `A → B` and `B → A` are one finding stated twice. Keep the direction with the
 * stronger lift, which is also the more actionable phrasing: the rarer
 * condition is the one worth acting on.
 */
function dedupe(hypotheses: Hypothesis[]): Hypothesis[] {
  const best = new Map<string, Hypothesis>();

  for (const h of hypotheses) {
    const key =
      h.family === 'association'
        ? [h.family, ...[h.condition, h.outcome].sort()].join('|')
        : [h.family, h.condition, h.outcome].join('|');
    const prior = best.get(key);
    if (!prior || h.lift > prior.lift) best.set(key, h);
  }

  return [...best.values()];
}
