/**
 * Layer 2 — extraction.
 *
 * One call per transcript, against the schema layer 1 discovered. Three
 * things about the shape of this layer are deliberate:
 *
 * **The schema lives in the system prompt.** It is identical for all 240
 * calls, so it belongs in the cached prefix, not the user turn. Putting it in
 * the user turn — next to the transcript, which is what reads naturally —
 * would make every call a cache miss and roughly triple the input bill. This
 * is the single highest-leverage cost decision in the pipeline and it is one
 * line of code either way.
 *
 * **Evidence is mandatory and verbatim.** A value with no span is unverifiable
 * and layer 3 rejects it without spending a token. Asking for the span up
 * front costs a few output tokens per field and turns validation from a
 * second opinion into a check.
 *
 * **Enum values are not constrained by the response schema.** They could be —
 * structured outputs would enforce them for free — but the enum was induced
 * from a 24-call sample and is therefore incomplete. Constraining to it would
 * force the extractor to emit a wrong in-vocabulary value instead of a right
 * out-of-vocabulary one, and would make layer 3's `valueInSchema` check
 * vacuous. Better to let the value through and catch it downstream, where the
 * out-of-vocabulary rate is also evidence that the sample was too small.
 */

import { z } from 'zod';

import { renderTranscript } from '../corpus/generate.js';
import { mapLimit } from '../core/async.js';
import type { LlmProvider } from '../core/llm/provider.js';
import type {
  CallExtraction,
  DiscoveredField,
  DiscoveredSchema,
  FieldExtraction,
  Transcript,
} from '../core/types.js';
import { simulateExtraction } from '../sim/extraction.js';

const EvidenceSchema = z.object({
  quote: z
    .string()
    .describe('Verbatim span from the transcript, copied exactly. Not a paraphrase.'),
  turnIndex: z.number().int().describe('0-based index of the turn the quote came from.'),
});

/**
 * A field's response shape. `value` is nullable on every field including the
 * required ones: "required" means the column is expected to be populated
 * corpus-wide, not that this call must have it, and forcing a value out of a
 * call that does not contain one is how a schema turns into fiction.
 */
function fieldSchema(field: DiscoveredField) {
  const value =
    field.type === 'number'
      ? z.number().nullable()
      : field.type === 'boolean'
        ? z.boolean().nullable()
        : z.string().nullable();

  return z.object({
    value: value.describe(field.description),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe('How sure you are, given the evidence you found. Not how sure you want to sound.'),
    evidence: z.array(EvidenceSchema),
  });
}

function responseSchema(fields: DiscoveredField[]) {
  const shape: Record<string, ReturnType<typeof fieldSchema>> = {};
  for (const f of fields) shape[f.name] = fieldSchema(f);
  return z.object({ fields: z.object(shape) });
}

/**
 * Built once per run and reused byte-identically on every call — see the
 * caching note at the top of the file.
 */
export function extractionSystem(schema: DiscoveredSchema): string {
  const columns = schema.fields
    .map((f) => {
      const spec = [`- ${f.name} (${f.type}${f.required ? ', usually present' : ', often absent'})`];
      spec.push(`    ${f.description}`);
      if (f.enumValues?.length) {
        spec.push(`    Values seen during discovery: ${f.enumValues.join(', ')}`);
        spec.push(`    This list came from a sample and is probably incomplete. If the call clearly`);
        spec.push(`    shows something outside it, report what the call shows.`);
      }
      return spec.join('\n');
    })
    .join('\n');

  return `You are extracting structured records from raw contact-centre call transcripts.

You will be given one transcript. Fill in every column below, or report null.

COLUMNS
${columns}

HOW TO READ THESE TRANSCRIPTS

They are ASR output from live phone calls, not written text. Expect filler and
stutters, words dropped and replaced with [inaudible] or [static], speakers
mislabelled, turns split mid-sentence by an interruption, crosstalk collapsed
into one unattributable turn, and acoustically-plausible mistranscriptions
("for nice" for "furnace", "in voice" for "invoice", "can sell" for "cancel").
Read through all of it. The facts are implied, not announced — nobody says
"my objection is the price", they say "that's a bit steep for what it is".

Two traps in particular:

- Self-correction. "That'll be 52,329— no sorry, 12,329" means 12,329. The
  first number is the one the speaker retracted.
- Negation and hypotheticals. "I'm not cancelling, I just want it looked at"
  is not a cancellation, and "if this happens again I'll switch to ArcticAire"
  is a competitor mention but not a competitor the customer has moved to.

RULES

1. null is a real answer. If the call does not establish a value, say null.
   A plausible guess is worse than a null, because a null gets reviewed and a
   guess gets shipped.
2. Every non-null value needs at least one evidence span: a quote copied
   verbatim from the transcript, and the index of the turn it came from. Copy
   the characters that are actually there, including the mess. Do not clean up
   the quote, do not merge two turns into one quote, and do not paraphrase.
   A span that does not appear in the transcript is worse than no span.
3. Confidence is your estimate that the value is correct, not your estimate of
   how confident an answer should sound. If two readings of the call are
   roughly equally supported, that is a low-confidence answer even when you
   have to pick one. If the cue you relied on sits next to an [inaudible],
   lower it further.
4. Booleans: false means you read the call and the thing did not happen. On a
   badly transcribed call the evidence may simply have been dropped, so a
   false with no supporting span should carry lower confidence than a true.`;
}

export interface ExtractionOptions {
  concurrency: number;
  onProgress?: (done: number, total: number) => void;
}

export async function runExtraction(
  provider: LlmProvider,
  corpus: Transcript[],
  schema: DiscoveredSchema,
  opts: ExtractionOptions,
): Promise<CallExtraction[]> {
  const system = extractionSystem(schema);
  const responses = responseSchema(schema.fields);
  let done = 0;

  return mapLimit(corpus, opts.concurrency, async (transcript) => {
    const result = await provider.generate({
      agent: 'extract.field',
      callId: transcript.callId,
      system,
      user: renderTranscript(transcript),
      schema: responses,
      maxTokens: 4000,
      simulate: () => simulateExtraction(transcript, schema.fields),
    });

    opts.onProgress?.(++done, corpus.length);

    // Normalize into the domain type. The response is keyed by column name;
    // downstream everything is keyed by field, so stamp the name in.
    const fields: Record<string, FieldExtraction> = {};
    for (const [name, v] of Object.entries(result.fields)) {
      fields[name] = { field: name, value: v.value, confidence: v.confidence, evidence: v.evidence };
    }

    return { callId: transcript.callId, fields, attempt: 1 };
  });
}
