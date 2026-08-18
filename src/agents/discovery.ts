/**
 * Layer 1 — schema discovery.
 *
 * Nobody hands you the columns. The question this layer answers is "what
 * fields does this corpus even have?", and it answers it from a bounded
 * sample so the cost does not scale with the corpus.
 *
 * Two agents, deliberately separated:
 *
 *   proposer   — reads a slice of calls, proposes fields. Run N times over
 *                disjoint slices, in parallel, with no shared context. The
 *                disjointness is the point: agreement between proposers who
 *                never saw the same call is evidence the field is real and
 *                not an artifact of six unusual transcripts.
 *
 *   synthesizer — reads every proposal and none of the transcripts, and
 *                merges them into one schema. Separating it from the
 *                proposers is what makes "support" mean anything.
 */

import { z } from 'zod';

import { CONFIG } from '../config.js';
import { renderTranscript } from '../corpus/generate.js';
import type { LlmProvider } from '../core/llm/provider.js';
import type { DiscoveredSchema, FieldProposal, Transcript } from '../core/types.js';
import { slice, stratifiedSample } from '../pipeline/sampling.js';
import { simulateProposals, simulateSynthesis } from '../sim/discovery.js';

const FIELD_TYPE = z.enum(['string', 'enum', 'number', 'date', 'boolean']);

const ProposalSchema = z.object({
  proposals: z.array(
    z.object({
      name: z.string().describe('snake_case column name'),
      description: z.string().describe('One sentence. What this column holds.'),
      type: FIELD_TYPE,
      exampleValues: z
        .array(z.string())
        .describe('One entry per call you read, in order. Use "∅" where the field is absent.'),
      evidenceCallIds: z.array(z.string()).describe('Calls where you positively observed a value.'),
      estimatedPrevalence: z.number().min(0).max(1),
    }),
  ),
});

const SynthesisSchema = z.object({
  fields: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      type: FIELD_TYPE,
      enumValues: z.array(z.string()).nullable(),
      support: z.number().int(),
      mergedFrom: z.array(z.string()),
      prevalence: z.number().min(0).max(1),
      required: z.boolean(),
    }),
  ),
  rejected: z.array(z.object({ name: z.string(), reason: z.string() })),
});

const PROPOSER_SYSTEM = `You are a schema proposer working on raw contact-centre call transcripts.

You will be given a small number of transcripts from one corpus. Your job is to
propose the columns a structured record for this corpus should have — the fields
that would let an operations team query these calls without listening to them.

Rules:
- Propose a column only if you positively observed a value for it. Do not invent
  columns that "would be useful" but that these calls give you no evidence for.
- Prefer columns that vary. A column that takes the same value on every call
  carries no information, however easy it is to extract.
- Facts in these transcripts are implied, not announced. Nobody says "my
  objection is the price". They say "that's a bit steep for what it is".
- The transcripts are ASR output. They contain filler, stutters, dropped words,
  mislabelled speakers, crosstalk, and acoustically-plausible mistranscriptions.
  Read through the noise; do not propose columns about the noise itself.
- exampleValues must have one entry per transcript you were given, in order,
  using "∅" for calls where the field is absent. The distribution matters
  downstream — do not report only the calls where you found something.

You are one of several proposers, each reading different calls. You will not see
their proposals and they will not see yours. Propose what your calls support.`;

const SYNTHESIZER_SYSTEM = `You are merging independent field proposals into a single schema.

Several proposers each read a different, non-overlapping sample of calls from
one corpus and proposed columns. They used different names for the same
concepts. Your job is to work out which proposals are the same column, merge
them, and decide what survives.

How to tell two proposals are the same column:
- Distinctive shared values are the strongest signal. Two proposals whose value
  sets overlap heavily are the same column even if the names look unrelated.
- Values of true/false are NOT evidence of sameness — every boolean column
  shares that value space. Merge booleans on name and description only.
- High-cardinality columns (dates, dollar amounts, free text) share no values
  across disjoint samples by construction. Merge those on name and description
  too; do not conclude they are different because the values differ.

Rejection rules, applied in this order:
1. Support. A column proposed by fewer than ${CONFIG.discovery.minSupport} independent proposers is not
   established. Reject it and say so.
2. Information. A column where one value covers 90% or more of the sampled
   calls carries no signal. Reject it and give the percentage.

For each surviving column: pick the clearest name, keep the most informative
description, list every name it was merged from, and mark it required if it
appears in at least ${Math.round(CONFIG.discovery.requiredPrevalence * 100)}% of sampled calls.

Report rejections. A schema you cannot explain the shape of is not usable.`;

export interface DiscoveryResult {
  schema: DiscoveredSchema;
  proposals: { proposer: number; proposals: FieldProposal[] }[];
}

export async function runDiscovery(
  provider: LlmProvider,
  corpus: Transcript[],
): Promise<DiscoveryResult> {
  const { sampleSize, proposers } = CONFIG.discovery;

  const sample = stratifiedSample(corpus, sampleSize, CONFIG.corpus.seed);
  const byId = new Map(corpus.map((t) => [t.callId, t]));
  const sampled = sample.callIds.map((id) => byId.get(id)!);
  const slices = slice(sampled, proposers);

  // Disjoint slices, no shared context, all in flight at once.
  const batches = await Promise.all(
    slices.map(async (chunk, i) => {
      const result = await provider.generate({
        agent: 'discovery.proposer',
        system: PROPOSER_SYSTEM,
        user: `Corpus: contact-centre calls, mixed verticals.\nYou are proposer ${i + 1} of ${proposers}.\nYou have been given ${chunk.length} transcripts.\n\n${chunk.map(renderTranscript).join('\n\n---\n\n')}`,
        schema: ProposalSchema,
        maxTokens: 8000,
        simulate: () => ({ proposals: simulateProposals(chunk, i) }),
      });
      return { proposer: i, proposals: result.proposals };
    }),
  );

  const synthesis = await provider.generate({
    agent: 'discovery.synthesizer',
    system: SYNTHESIZER_SYSTEM,
    user: `${proposers} proposers each read ${Math.round(sampleSize / proposers)} calls from a ${corpus.length}-call corpus.\nSample size: ${sampleSize}.\n\n${JSON.stringify(batches, null, 2)}`,
    schema: SynthesisSchema,
    maxTokens: 12_000,
    simulate: () => simulateSynthesis(batches, sampleSize),
  });

  return {
    schema: {
      fields: synthesis.fields.map(({ enumValues, ...rest }) => ({
        ...rest,
        ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
      })),
      sampling: {
        corpusSize: corpus.length,
        sampleSize: sample.callIds.length,
        strategy: sample.strategy,
        sampledCallIds: sample.callIds,
      },
      proposerCount: proposers,
      rejected: synthesis.rejected,
    },
    proposals: batches,
  };
}
