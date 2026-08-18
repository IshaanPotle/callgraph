/**
 * Offline simulation of the activation layer.
 *
 * This is the simulator with the least to prove and the most to give away, so
 * it is worth being precise about what it is.
 *
 * Everywhere else in `src/sim/` the simulated agent is doing work: the
 * synthesizer really clusters proposals, the extractor really runs detectors
 * over transcript text, the critic really checks grounding. Here there is no
 * work left. Layer 4 settled every number before this file is reached, and the
 * only remaining task is to put an English sentence around them — which is
 * exactly the task a template can fake and a model cannot be replaced at.
 *
 * So this does not pretend otherwise. It fills slots. The prose is mine, not a
 * model's, and it is flatter and more repetitive than real output would be:
 * every finding in the same family comes out phrased the same way, because
 * that is what templates do. Reading the demo's findings page and noticing the
 * sameness is the correct reaction, and I would rather it be obvious than
 * disguised with a thesaurus.
 *
 * What it does honestly reproduce is the *contract*: one signal per hypothesis,
 * in order, with severity assigned by rule and no number that was not passed
 * in. That is what layer 4 depends on, and a live run swaps this out for
 * something that writes better without changing a single figure.
 */

import type { Hypothesis } from '../pipeline/aggregate.js';

interface WrittenSignal {
  title: string;
  finding: string;
  severity: 'info' | 'watch' | 'urgent';
  recommendedAction: string;
}

export function simulateActivation(hypotheses: Hypothesis[]): { signals: WrittenSignal[] } {
  return { signals: hypotheses.map(write) };
}

function write(h: Hypothesis): WrittenSignal {
  const condition = phrase(h.condition);
  const outcome = phrase(h.outcome);
  const rate = `${(100 * h.conditionalRate).toFixed(0)}%`;
  const baseline = `${(100 * h.baselineRate).toFixed(0)}%`;

  const finding = [
    `On calls where ${condition}, ${outcome} on ${h.k} of ${h.n} (${rate}),`,
    `against ${baseline} across all calls — ${h.lift.toFixed(1)}x the overall rate.`,
    h.stratifiedLift !== null
      ? `The effect holds at ${h.stratifiedLift.toFixed(1)}x within lines of business, so it is not the vertical restated.`
      : '',
    // Volunteered rather than buried. A finding resting on a dozen calls is
    // still a finding, and the reader deciding what to do about it needs to
    // know which kind they are looking at without opening the drill-down.
    h.n < 15 ? `Thin support at ${h.n} calls; treat as a lead rather than a conclusion.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return { title: title(h), finding, severity: severity(h), recommendedAction: action(h), };
}

/**
 * Severity by rule, from the two things that actually determine urgency: how
 * much of a departure the result is, and whether the outcome is one that costs
 * money while you think about it.
 *
 * Deliberately conservative — `urgent` requires both a costly outcome and a
 * large effect, so most findings come out `watch`. A simulator that graded
 * generously would make the demo's findings page look more alarming than the
 * data supports, which is the specific dishonesty this whole layer is built to
 * avoid.
 *
 * `disclos` is in the costly list for the same reason the system prompt names
 * compliance gaps as urgent-worthy: a required disclosure that did not happen
 * is a fine that has already been incurred, whether or not anyone has noticed.
 */
function severity(h: Hypothesis): 'info' | 'watch' | 'urgent' {
  const costly = /escalat|churn|lost|dispute|risk|complaint|disclos/i.test(h.outcome);
  if (costly && h.lift >= 2 && h.n >= 15) return 'urgent';
  if (costly || h.lift >= 2) return 'watch';
  return 'info';
}

/**
 * The outcome is the claim, so it is always named in full. The condition can
 * usually go by its value alone, because conditions read as noun phrases —
 * "price objection calls", "Cadence calls".
 *
 * The first version of this used the bare value on both sides and produced
 * titles like "escalated predicts true" and "hvac calls: false", which are not
 * merely ugly. `true` of *what*? A reader cannot tell whether that page is
 * reporting a compliance gap or a sentiment score, and a finding nobody can
 * read is indistinguishable from one that was never found. Two identical
 * titles from different columns would have been worse still.
 */
function title(h: Hypothesis): string {
  const c = subject(h.condition);
  if (h.family === 'vertical') return `${c} calls: ${claim(h.outcome)}`;
  // The condition of a trend is the time bucket, which the phrasing carries.
  if (h.family === 'trend') return `${subject(h.outcome)} rising over the window`;
  return `${c} predicts ${claim(h.outcome)}`;
}

/** `blocker = price_objection` -> `price objection`; booleans keep the field. */
function subject(term: string): string {
  const [field, val] = split(term);
  if (val === 'true') return humanize(field);
  if (val === 'false') return `no ${humanize(field)}`;
  return humanize(val);
}

/** Unambiguous even out of context: `line_quality = high` -> `line quality is high`. */
function claim(term: string): string {
  const [field, val] = split(term);
  if (val === 'true' || val === 'false') return subject(term);
  return `${humanize(field)} is ${humanize(val)}`;
}

function action(h: Hypothesis): string {
  return (
    `Pull the ${h.k} calls where ${phrase(h.condition)} and ${phrase(h.outcome)}, ` +
    `and check whether the pattern is a coaching gap or a policy one.`
  );
}

/** `blocker = price_objection` -> `blocker is price objection`. */
function phrase(term: string): string {
  const [field, val] = split(term);
  return field === val ? humanize(val) : `${humanize(field)} is ${humanize(val)}`;
}

/** `blocker = price_objection` -> `['blocker', 'price_objection']`, or the term twice. */
function split(term: string): [string, string] {
  const at = term.indexOf(' = ');
  return at < 0 ? [term, term] : [term.slice(0, at), term.slice(at + 3)];
}

function humanize(s: string): string {
  return s.replace(/[_-]+/g, ' ').trim();
}
