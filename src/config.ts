/**
 * Run configuration. Everything that would otherwise be a magic number
 * buried in an agent lives here, because these are the knobs you actually
 * turn when the system is wrong in production.
 */

export const CONFIG = {
  corpus: {
    seed: 20_260_817,
    size: 240,
    startDate: '2026-05-04T00:00:00Z',
  },

  discovery: {
    /**
     * Calls read during discovery. The point of the layer is that this stays
     * ~10% of the corpus and would stay a fixed cost against a corpus of
     * millions — you sample to find structure, you don't read everything.
     */
    sampleSize: 24,
    /** Independent proposers, each on a disjoint slice of the sample. */
    proposers: 4,
    /** A field needs this many independent proposers to enter the schema. */
    minSupport: 2,
    /** Below this prevalence in the sample, a field is optional not required. */
    requiredPrevalence: 0.55,
  },

  extraction: {
    /** Values below this go straight to human review, critic or no critic. */
    confidenceFloor: 0.45,
    /** One repair attempt after a critic rejection, then a human gets it. */
    maxRepairAttempts: 1,
  },

  validation: {
    /**
     * A field that passed every deterministic check and came back this
     * confident is accepted without a critic call.
     *
     * This is the cost lever of the validation layer. Critiquing all 14
     * columns on all 240 calls is 3,360 model calls to confirm what string
     * comparison already confirmed; the gate spends the critic where the
     * extractor was unsure or the grounding was odd. The share of fields the
     * critic actually saw is reported in the run summary, and the eval
     * measures what the gate let through.
     */
    skipCriticAbove: 0.85,

    /**
     * Calibration pass: calls per column the critic reads unconditionally
     * before any sampling policy is applied.
     *
     * The confidence gate alone is not enough, because confidence is a
     * property of a single extraction and the thing worth knowing is a
     * property of a *column*. `product_line` comes back around 0.68 confident
     * and is almost never wrong; the gate cannot tell those apart and pays for
     * a critic on nearly every row. At 240 calls that is an annoyance. At the
     * volume this is aimed at it is most of the bill.
     *
     * So the critic reads a fixed sample of each column first, and what it
     * finds there sets the budget for the rest. Nothing here needs labels —
     * the signal is the critic's own rejection rate.
     */
    calibrationCalls: 60,

    /**
     * Post-calibration coverage is the estimated rejection rate times this.
     * Spend on a column in proportion to what the critic actually finds there.
     */
    coverageMultiplier: 3,

    /**
     * Beta prior on a column's rejection rate, as (rejects, accepts) of
     * imagined prior evidence. The estimate is smoothed:
     *
     *     rate = (rejects + priorRejects) / (calls + priorRejects + priorAccepts)
     *
     * Without this the policy is fooled by small samples in the direction that
     * costs the most. Eligibility varies enormously by column — most
     * `amount_usd` fields are either confident enough to skip the gate or odd
     * enough to be forced to the critic — so 60 calibration calls can yield
     * one clean read of it. A raw rate says 0/1 = never wrong, buys the 5%
     * floor, and stops looking at the one column where the critic reliably
     * finds something: three of the five real catches in this corpus are
     * retracted dollar figures.
     *
     * The prior is deliberately pessimistic (mean 1/5) and weak (worth five
     * observations). A column with fifty clean reads overwhelms it and drops
     * to the floor as it should; a column with one clean read stays under
     * review until it has earned its way out. Being slow to trust is the
     * correct asymmetry here — the cost of over-sampling is a few dollars,
     * and the cost of under-sampling is a wrong answer nobody ever looked at.
     */
    priorRejects: 1,
    priorAccepts: 4,

    /**
     * Floor coverage for a column the critic never rejects anything in.
     *
     * Not zero, and the reason is drift: a column that was clean for a month
     * is not thereby clean forever, and a policy that stops looking cannot
     * notice when that changes. This is the standing cost of being able to
     * find out.
     */
    minCoverage: 0.05,
  },

  activation: {
    /** Minimum calls behind a signal before it is allowed to be shown. */
    minCallsPerSignal: 6,
    /** Lift over baseline needed to call something a pattern. */
    minLift: 1.4,

    /**
     * Benjamini-Hochberg false-discovery rate.
     *
     * The enumeration takes thousands of shots at a few hundred calls, and at
     * that ratio support-and-lift alone will produce a full page of confident
     * findings from noise alone. This is the knob that decides how much of the
     * output is allowed to be wrong: at 0.05, roughly one reported signal in
     * twenty is expected to be spurious, and the run reports how many
     * hypotheses were tested so that claim can be checked rather than trusted.
     */
    fdrQ: 0.05,

    /** Signals shown. Ranked by q-value; the rest stay in the artifact. */
    maxSignals: 8,
  },

  eval: {
    /** Reliability-diagram bin edges. */
    calibrationBins: 10,
    /** Human-review budgets swept for the routing curve. */
    routingShares: [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5],
  },
} as const;
