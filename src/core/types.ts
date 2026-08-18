/**
 * Domain types for the whole system.
 *
 * The one structural idea worth knowing before reading anything else:
 * `CallFacts` is the *latent* truth a call was generated from. It is never
 * visible to any agent — the agents only ever see `Transcript`. That asymmetry
 * is what makes the eval harness possible without a labeling budget.
 */

// Type-only, and only for `RunArtifact` at the bottom of the file. The arrow
// normally points the other way — those modules import these types — but the
// artifact is the one thing that has to name everything the run produced, and a
// type-only edge creates no runtime cycle.
import type { PatternReport } from '../pipeline/aggregate.js';
import type { ValidationStats } from '../agents/validate.js';

export type Vertical = 'hvac' | 'claims' | 'saas';

export const VERTICALS: Vertical[] = ['hvac', 'claims', 'saas'];

export const VERTICAL_LABEL: Record<Vertical, string> = {
  hvac: 'Field service dispatch',
  claims: 'Insurance claims intake',
  saas: 'SaaS renewal & support',
};

// ---------------------------------------------------------------------------
// Layer 0 — the corpus
// ---------------------------------------------------------------------------

export type Speaker = 'AGENT' | 'CUSTOMER' | 'IVR' | 'UNKNOWN';

export interface Turn {
  /** Seconds from call start. */
  t: number;
  speaker: Speaker;
  text: string;
}

export interface Transcript {
  callId: string;
  vertical: Vertical;
  capturedAt: string;
  durationSec: number;
  /** Word error rate the ASR layer reported. Real ASR gives you this; use it. */
  asrConfidence: number;
  turns: Turn[];
}

/**
 * The latent state a call was rendered from. This is the gold label set.
 * Nothing downstream of the generator is allowed to read this except the
 * eval harness.
 */
export interface CallFacts {
  callId: string;
  vertical: Vertical;
  /** Canonical reason the customer called. */
  reason: string;
  /** Product / policy / plan line involved. */
  productLine: string;
  outcome: Outcome;
  /** Canonical objection raised, if any. */
  objection: string | null;
  competitor: string | null;
  /** ISO date the agent committed to something, if they did. */
  commitmentDate: string | null;
  dollarAmount: number | null;
  sentiment: Sentiment;
  /** Did the agent read the required disclosure? Compliance cares. */
  disclosureGiven: boolean;
  escalationRequested: boolean;
}

export type Outcome =
  | 'resolved'
  | 'follow_up_scheduled'
  | 'escalated'
  | 'churn_risk'
  | 'sale_closed'
  | 'no_action';

export type Sentiment = 'positive' | 'neutral' | 'negative';

/** The gold field names the eval harness scores against. */
export const GOLD_FIELDS = [
  'reason',
  'productLine',
  'outcome',
  'objection',
  'competitor',
  'commitmentDate',
  'dollarAmount',
  'sentiment',
  'disclosureGiven',
  'escalationRequested',
] as const;

export type GoldField = (typeof GOLD_FIELDS)[number];

// ---------------------------------------------------------------------------
// Layer 1 — discovery
// ---------------------------------------------------------------------------

export type FieldType = 'string' | 'enum' | 'number' | 'date' | 'boolean';

/** One proposer agent's opinion, from one bounded sample of calls. */
export interface FieldProposal {
  name: string;
  description: string;
  type: FieldType;
  /** Observed values, for enum induction downstream. */
  exampleValues: string[];
  /** Calls in this proposer's sample where the field was present. */
  evidenceCallIds: string[];
  /** Proposer's own estimate of how often this appears corpus-wide, 0..1. */
  estimatedPrevalence: number;
}

/** A field that survived synthesis across proposers. */
export interface DiscoveredField {
  name: string;
  description: string;
  type: FieldType;
  enumValues?: string[];
  /** How many independent proposers converged on this field. */
  support: number;
  /** Names the proposers used before merging — the audit trail. */
  mergedFrom: string[];
  /** Fraction of sampled calls where this field was observed. */
  prevalence: number;
  /** Fields below the prevalence floor are kept but marked optional. */
  required: boolean;
}

export interface DiscoveredSchema {
  fields: DiscoveredField[];
  sampling: {
    corpusSize: number;
    sampleSize: number;
    strategy: string;
    /** Calls actually read, so the cost claim is auditable. */
    sampledCallIds: string[];
  };
  proposerCount: number;
  /** Proposals that were dropped at synthesis, and why. Kept for the UI. */
  rejected: { name: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Layer 2 — extraction
// ---------------------------------------------------------------------------

export interface Evidence {
  /** Verbatim span from the transcript. Checked literally, not vibes. */
  quote: string;
  turnIndex: number;
}

export interface FieldExtraction {
  field: string;
  /** null means "the extractor looked and this call genuinely has no value". */
  value: string | number | boolean | null;
  /** Extractor's self-reported confidence, 0..1. Calibration is measured. */
  confidence: number;
  evidence: Evidence[];
}

export interface CallExtraction {
  callId: string;
  fields: Record<string, FieldExtraction>;
  attempt: number;
}

// ---------------------------------------------------------------------------
// Layer 3 — validation
// ---------------------------------------------------------------------------

export type Verdict = 'accept' | 'reject';

/**
 * Cheap deterministic checks run before the critic model is ever called.
 * Roughly a third of bad extractions die here for free.
 */
export interface GroundingChecks {
  /** Did the quoted span actually appear in the cited turn? */
  quoteFound: boolean;
  /** Did the quote appear anywhere in the transcript, if not that turn? */
  quoteFoundElsewhere: boolean;
  /**
   * Are the quote's words a subsequence of some turn's words?
   *
   * This separates the two failure modes a literal check collapses together:
   * an extractor that tidied the ASR's mess out of its quote (grounded, just
   * not verbatim) and an extractor that invented the span (not grounded at
   * all). Only the second is a fabrication, and only the second is safe to
   * reject without reading the call.
   */
  quoteIsSubsequence: boolean;
  /** Enum value inside the discovered value space? */
  valueInSchema: boolean;
  /** Non-null value with zero evidence spans is always a reject. */
  hasEvidence: boolean;
}

export interface FieldVerdict {
  field: string;
  verdict: Verdict;
  reason: string;
  /**
   * 'deterministic' and 'sampling' verdicts never cost a token, but they are
   * not the same claim and the eval has to be able to tell them apart.
   * 'deterministic' means a check was run and passed; 'sampling' means no
   * check was run at all, because the budget said this column did not warrant
   * one. The share of final errors carrying a 'sampling' verdict is the price
   * of the cost saving, and it is not defensible unless it is measured.
   */
  decidedBy: 'deterministic' | 'sampling' | 'critic';
  checks: GroundingChecks;
}

export type Disposition = 'accepted' | 'repaired' | 'human_review';

export interface ValidatedField {
  field: string;
  value: string | number | boolean | null;
  confidence: number;
  evidence: Evidence[];
  disposition: Disposition;
  verdicts: FieldVerdict[];
  attempts: number;
}

export interface ValidatedCall {
  callId: string;
  vertical: Vertical;
  fields: Record<string, ValidatedField>;
}

// ---------------------------------------------------------------------------
// Layer 4 — activation
// ---------------------------------------------------------------------------

export interface Signal {
  id: string;
  title: string;
  /** What the aggregate actually says, in one line. */
  finding: string;
  severity: 'info' | 'watch' | 'urgent';
  /** Calls backing the claim. Every signal is clickable down to raw audio-text. */
  callIds: string[];
  metric: { label: string; value: string; baseline?: string };
  recommendedAction: string;
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export interface Span {
  id: string;
  /** Which agent made the call: 'discovery.proposer', 'validate.critic', ... */
  agent: string;
  callId?: string;
  model: string;
  provider: 'anthropic' | 'stub';
  startedAt: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** How many times this logical call was retried before it stuck. */
  retries: number;
  ok: boolean;
  error?: string;
}

export interface RunMeta {
  runId: string;
  startedAt: string;
  finishedAt: string;
  provider: 'anthropic' | 'stub';
  model: string;
  corpusSeed: number;
  corpusSize: number;
  /** Wall-clock, not summed span time. */
  wallMs: number;
}

// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------

/** Discovered field name -> gold field name, plus how the mapping was made. */
export interface FieldAlignment {
  discovered: string;
  gold: GoldField | null;
  method: 'exact' | 'alias' | 'similarity' | 'model' | 'unmapped';
  score: number;
}

export interface FieldScore {
  gold: GoldField;
  discovered: string | null;
  support: number;
  correct: number;
  /** Predicted a value where gold had none. */
  falsePositive: number;
  /** Predicted null where gold had a value. */
  falseNegative: number;
  /** Predicted a value, gold had one, they disagree. */
  wrongValue: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  meanConfidence: number;
  accuracy: number;
}

export interface CriticScore {
  /** Critic rejected AND the extraction was genuinely wrong. */
  truePositive: number;
  /** Critic rejected a correct extraction. Expensive: burns a retry. */
  falsePositive: number;
  /** Critic accepted a wrong extraction. Expensive: ships a bad record. */
  falseNegative: number;
  trueNegative: number;
  precision: number;
  recall: number;
  /** Share of rejections decided without spending a token. */
  deterministicShare: number;
}

/** One point on the "route the least-confident X% to humans" curve. */
export interface RoutingPoint {
  reviewShare: number;
  errorsCaught: number;
  errorsTotal: number;
  autoAccuracy: number;
}

export interface EvalReport {
  runId: string;
  provider: 'anthropic' | 'stub';
  callsScored: number;
  alignment: FieldAlignment[];
  perField: FieldScore[];
  macroF1: number;
  microAccuracy: number;
  /** Accuracy before the critic ran, so the critic's lift is legible. */
  preValidationAccuracy: number;
  postValidationAccuracy: number;
  calibration: { bins: CalibrationBin[]; ece: number };
  critic: CriticScore;
  routing: RoutingPoint[];
}

// ---------------------------------------------------------------------------
// The bundle the UI reads
// ---------------------------------------------------------------------------

export interface RunArtifact {
  meta: RunMeta;
  schema: DiscoveredSchema;
  proposals: { proposer: number; proposals: FieldProposal[] }[];
  calls: ValidatedCall[];
  signals: Signal[];
  spans: Span[];
  evalReport: EvalReport;
  /**
   * Everything layer 4 tested, including what it threw out.
   *
   * The discarded hypotheses are the more interesting half. A findings page
   * showing eight results looks the same whether it tested nine candidates or
   * four thousand, and those are completely different products — so the counts,
   * the verdicts and the rejected claims all ship, and the UI shows them.
   */
  patterns: PatternReport;
  /** Where the validation budget went, and which columns it declined to cover. */
  validation: ValidationStats;
  /**
   * The raw calls, carried along so a finding stays clickable down to the words
   * somebody actually said. A claim a user cannot audit is a claim they have to
   * take on faith, and this whole pipeline is an argument against doing that.
   */
  transcripts: Transcript[];
}
