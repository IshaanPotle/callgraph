/**
 * Offline simulation of the discovery layer.
 *
 * Two agents live here, and they are simulated at different levels of
 * fidelity on purpose:
 *
 *   - The *proposer* simulator is shallow. It runs the detector library over
 *     its slice and reports what fired. The interesting behaviour it has to
 *     reproduce is that four proposers looking at four disjoint slices
 *     disagree — about names, about descriptions, about prevalence, and
 *     sometimes about whether a column exists at all.
 *
 *   - The *synthesizer* simulator is a real implementation. Merging N noisy
 *     field proposals into one schema is a clustering problem with an actual
 *     answer, and the algorithm below (union-find over three similarity
 *     signals, then two rejection rules) is what the live agent is asked to
 *     do in prose. It is not a lookup table.
 */

import { CONFIG } from '../config.js';
import { Rng, hashString } from '../core/rng.js';
import type { DiscoveredField, FieldProposal, FieldType, Transcript } from '../core/types.js';
import { DETECTORS, normalizeName, stem, tokenize } from './detectors.js';

// ---------------------------------------------------------------------------
// Proposer
// ---------------------------------------------------------------------------

export function simulateProposals(slice: Transcript[], proposerIndex: number): FieldProposal[] {
  const rng = new Rng(hashString(`propose:${proposerIndex}:${slice.map((t) => t.callId).join(',')}`));
  const out: FieldProposal[] = [];

  for (const detector of DETECTORS) {
    const observations = slice.map((t) => ({ callId: t.callId, m: detector.match(t) }));

    // A proposer only invents a column for something it positively saw. An
    // all-false boolean across six calls does not suggest a column exists.
    const positives = observations.filter(
      (o) => o.m != null && o.m.value !== null && o.m.value !== false,
    );
    if (positives.length === 0) continue;

    // Salience gate: seen twice, or once but unmistakably.
    const peak = Math.max(...positives.map((o) => o.m!.strength));
    if (positives.length < 2 && peak < 0.75) continue;

    // Every call in the slice contributes a value, including the negative and
    // absent ones. Synthesis needs the real distribution to judge whether a
    // column carries information — positives alone would make every boolean
    // look like a constant.
    const exampleValues = observations.map((o) =>
      o.m == null || o.m.value === null ? '∅' : String(o.m.value),
    );

    const observed = positives.length / slice.length;

    out.push({
      name: detector.aliases[proposerIndex % detector.aliases.length]!,
      description: detector.descriptions[proposerIndex % detector.descriptions.length]!,
      type: detector.type,
      exampleValues,
      evidenceCallIds: positives.map((o) => o.callId),
      // Extrapolating corpus prevalence from six calls is guesswork, and the
      // proposer's estimate should look like guesswork.
      estimatedPrevalence: clamp01(observed + rng.float(-0.12, 0.12)),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

/**
 * Shape mirrors the synthesizer's response schema, not `DiscoveredField` —
 * `enumValues` is explicitly nullable because a JSON schema an LLM fills in
 * cannot have "sometimes absent" keys.
 */
export interface SynthesizedField {
  name: string;
  description: string;
  type: FieldType;
  enumValues: string[] | null;
  support: number;
  mergedFrom: string[];
  prevalence: number;
  required: boolean;
}

export interface SynthesisResult {
  fields: SynthesizedField[];
  rejected: { name: string; reason: string }[];
}

interface Flat extends FieldProposal {
  proposer: number;
}

export function simulateSynthesis(
  batches: { proposer: number; proposals: FieldProposal[] }[],
  sampleSize: number,
): SynthesisResult {
  const flat: Flat[] = batches.flatMap((b) =>
    b.proposals.map((p) => ({ ...p, proposer: b.proposer })),
  );

  const idf = buildIdf(flat);
  const clusters = cluster(flat, idf);

  const fields: SynthesizedField[] = [];
  const rejected: { name: string; reason: string }[] = [];

  for (const members of clusters) {
    const names = members.map((m) => m.name);
    const label = pickName(names);
    const support = new Set(members.map((m) => m.proposer)).size;
    if (support < CONFIG.discovery.minSupport) {
      rejected.push({
        name: label,
        reason: `only ${support} of ${batches.length} proposers surfaced this; below the support floor of ${CONFIG.discovery.minSupport}`,
      });
      continue;
    }

    // A column whose value is nearly always the same carries no information,
    // however reliably it can be extracted. This is the rule that culls
    // "audio_quality_issue" without anyone having hand-labelled it as junk.
    const values = members.flatMap((m) => m.exampleValues);
    const share = majorityShare(values);
    if (share.fraction >= NEAR_CONSTANT) {
      rejected.push({
        name: label,
        reason: `near-constant: ${(share.fraction * 100).toFixed(0)}% of sampled calls take the value "${share.value}" — no discriminative power`,
      });
      continue;
    }

    const observed = new Set(members.flatMap((m) => m.evidenceCallIds)).size;
    const prevalence = clamp01(observed / sampleSize);
    const type = majorityType(members);

    fields.push({
      name: label,
      description: longest(members.map((m) => m.description)),
      type,
      enumValues: type === 'enum' ? [...new Set(values.filter((v) => v !== '∅'))].sort() : null,
      support,
      mergedFrom: [...new Set(names)].sort(),
      prevalence,
      required: prevalence >= CONFIG.discovery.requiredPrevalence,
    });
  }

  // Stable, legible order: strongest consensus first.
  fields.sort((a, b) => b.support - a.support || b.prevalence - a.prevalence || a.name.localeCompare(b.name));
  return { fields, rejected };
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

const MERGE_THRESHOLD = 0.34;
const NEAR_CONSTANT = 0.9;

/**
 * Agglomerative, average-linkage, with one hard structural constraint: a
 * cluster may not contain two proposals from the same proposer.
 *
 * Both details are load-bearing, and the first version of this had neither.
 * Naive transitive union-find collapsed the entire schema into a single
 * field, because `call_reason` and `call_outcome` share the token "call",
 * `call_outcome` and `hold_event` share "event", and so on down the chain
 * until every column in the corpus was one column. Average linkage stops the
 * chaining; the disjointness constraint makes it impossible in principle,
 * since each proposer emits at most one proposal per concept and a cluster
 * holding two of them is definitionally wrong.
 */
function cluster(flat: Flat[], idf: Map<string, number>): Flat[][] {
  let groups = flat.map((f) => [f]);

  for (;;) {
    let best = { i: -1, j: -1, score: MERGE_THRESHOLD };

    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i]!;
        const b = groups[j]!;
        const proposers = new Set(a.map((m) => m.proposer));
        if (b.some((m) => proposers.has(m.proposer))) continue;

        let total = 0;
        for (const x of a) for (const y of b) total += similarity(x, y, idf);
        const score = total / (a.length * b.length);
        if (score > best.score) best = { i, j, score };
      }
    }

    if (best.i < 0) break;
    groups = groups.map((g, k) => (k === best.i ? [...g, ...groups[best.j]!] : g));
    groups.splice(best.j, 1);
  }

  return groups;
}

/**
 * Inverse document frequency over the proposals themselves.
 *
 * Without this, "call", "customer" and "agent" — words that appear in half
 * the proposals in a contact-centre schema — count as evidence that two
 * columns are the same column. They are evidence of nothing.
 */
function buildIdf(flat: Flat[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const p of flat) {
    for (const tok of signature(p)) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  const n = flat.length;
  return new Map([...df].map(([tok, count]) => [tok, Math.log((n + 1) / (count + 0.5))]));
}

function signature(p: Flat): Set<string> {
  return new Set([...normalizeName(p.name), ...tokenize(p.description)].map(stem));
}

/**
 * Three signals, best-of. Which one carries a given field is not uniform:
 *
 *   - Enums with distinctive values merge on value overlap even when two
 *     proposers picked unrelated names ("blocker" vs "friction_point").
 *   - Dates and amounts share no values at all across disjoint slices — every
 *     call has a different one — so they can only merge on name and prose.
 *   - Booleans all share {true, false}, which is why value overlap is gated
 *     on the value space being discriminative. Without that gate every
 *     boolean column in the schema collapses into one.
 */
function similarity(a: Flat, b: Flat, idf: Map<string, number>): number {
  if (a.proposer === b.proposer) return 0; // one proposer, one opinion per concept
  if (a.type !== b.type) return 0;

  const nameSim = weighted(tokens(normalizeName(a.name)), tokens(normalizeName(b.name)), idf);
  const descSim = weighted(tokens(tokenize(a.description)), tokens(tokenize(b.description)), idf);

  let valueSim = 0;
  const va = distinct(a.exampleValues);
  const vb = distinct(b.exampleValues);
  const union = new Set([...va, ...vb]);
  if (union.size >= 3 && !isBooleanSpace(union)) valueSim = overlap(va, vb);

  return Math.max(nameSim, descSim, valueSim);
}

function tokens(words: string[]): Set<string> {
  return new Set(words.map(stem));
}

/** Overlap coefficient over IDF mass, not raw token counts. */
function weighted(a: Set<string>, b: Set<string>, idf: Map<string, number>): number {
  const w = (s: Set<string>) => [...s].reduce((sum, t) => sum + (idf.get(t) ?? 1), 0);
  const [wa, wb] = [w(a), w(b)];
  if (wa === 0 || wb === 0) return 0;

  let shared = 0;
  for (const t of a) if (b.has(t)) shared += idf.get(t) ?? 1;
  return shared / Math.min(wa, wb);
}

/** Plain overlap coefficient — used only where values are already distinctive. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const x of a) if (b.has(x)) hits++;
  return hits / Math.min(a.size, b.size);
}

function distinct(values: string[]): Set<string> {
  return new Set(values.filter((v) => v !== '∅'));
}

function isBooleanSpace(values: Set<string>): boolean {
  return [...values].every((v) => v === 'true' || v === 'false');
}

// ---------------------------------------------------------------------------

function pickName(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()].sort(
    (x, y) => y[1] - x[1] || x[0].length - y[0].length || x[0].localeCompare(y[0]),
  )[0]![0];
}

function majorityShare(values: string[]): { value: string; fraction: number } {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [value, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { value, fraction: n / values.length };
}

function majorityType(members: Flat[]): FieldType {
  const counts = new Map<FieldType, number>();
  for (const m of members) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

function longest(strings: string[]): string {
  return strings.reduce((a, b) => (b.length > a.length ? b : a));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
