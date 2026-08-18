/**
 * The whole run, end to end, as one function.
 *
 * Everything here is deliberately sequential and boring. The interesting
 * decisions all live inside the layers; this file's only job is to hand each
 * one the output of the last and produce a single artifact the UI can read
 * without asking the backend anything.
 *
 * Two things it does that are worth calling out:
 *
 * **The eval sees the same objects the pipeline produced**, not a re-read of
 * serialized output. A harness that scores a round-trip through JSON is partly
 * scoring the serializer, and when the two disagree it is the harness that is
 * wrong in the confusing direction.
 *
 * **Ground truth never touches the pipeline.** `gold` is built here and passed
 * only to `runEval`. No agent, no simulator and no provider is given access to
 * it. That is the property the entire eval rests on, and keeping it in one
 * short function is how it stays checkable by reading rather than by trusting.
 */

import { runActivation } from '../agents/activate.js';
import { runDiscovery } from '../agents/discovery.js';
import { runExtraction } from '../agents/extract.js';
import { runValidation } from '../agents/validate.js';
import { CONFIG } from '../config.js';
import { generateCorpus } from '../corpus/generate.js';
import { createProvider, resolveConfig, type ProviderConfig } from '../core/llm/index.js';
import { Tracer } from '../core/trace.js';
import type { CallFacts, RunArtifact } from '../core/types.js';
import type { FaultInjector } from '../sim/faults.js';
import { findPatterns } from './aggregate.js';
import { runEval, type EvalInput } from './evaluate.js';

export interface RunOptions {
  config?: ProviderConfig;
  /** Simulator-only deliberate corruption. See `src/sim/faults.ts`. */
  faults?: FaultInjector;
  onStage?: (stage: string, detail?: string) => void;
}

export interface RunResult {
  artifact: RunArtifact;
  /** Kept alongside the artifact so `recoverFaults` can be run against it. */
  evalInput: EvalInput;
}

export async function runPipeline(opts: RunOptions = {}): Promise<RunResult> {
  const config = opts.config ?? resolveConfig();
  const tracer = new Tracer();
  const provider = createProvider(config, tracer, opts.faults);

  const startedAt = new Date();
  const t0 = Date.now();
  const runId = `run_${startedAt.toISOString().replace(/[:.]/g, '-')}`;
  const stage = opts.onStage ?? (() => {});

  stage('corpus', `${CONFIG.corpus.size} calls, seed ${CONFIG.corpus.seed}`);
  const generated = generateCorpus(CONFIG.corpus);
  const transcripts = generated.map((c) => c.transcript);
  const gold = new Map<string, CallFacts>(generated.map((c) => [c.facts.callId, c.facts]));

  stage('discover', `${CONFIG.discovery.proposers} proposers over ${CONFIG.discovery.sampleSize} calls`);
  const { schema, proposals } = await runDiscovery(provider, transcripts);
  stage('discover', `${schema.fields.length} columns`);

  // Armed only after discovery, so the schema is always clean. See `arm`.
  opts.faults?.arm(schema.fields);

  stage('extract', `${transcripts.length} calls x ${schema.fields.length} fields`);
  const extractions = await runExtraction(provider, transcripts, schema, {
    concurrency: config.concurrency,
    onProgress: (done, total) => {
      if (done % 60 === 0 || done === total) stage('extract', `${done}/${total}`);
    },
  });

  stage('validate');
  const { calls, stats } = await runValidation(provider, transcripts, extractions, schema, {
    concurrency: config.concurrency,
    onProgress: (done, total) => {
      if (done % 60 === 0 || done === total) stage('validate', `${done}/${total}`);
    },
  });
  stage(
    'validate',
    `${stats.decidedDeterministically} decided free, ${stats.criticCalls} critic calls, ` +
      `${stats.humanReview} to human`,
  );

  stage('aggregate');
  const patterns = findPatterns(calls, transcripts, schema);
  stage(
    'aggregate',
    `${patterns.tested} hypotheses -> ${patterns.survivedFdr} survived FDR -> ` +
      `${patterns.hypotheses.filter((h) => h.verdict === 'finding').length} findings`,
  );

  stage('activate');
  const { signals, omitted } = await runActivation(provider, patterns);
  stage('activate', `${signals.length} signals${omitted > 0 ? `, ${omitted} over cap` : ''}`);

  // First point in the run where ground truth is allowed in the room.
  stage('evaluate');
  const evalInput: EvalInput = {
    runId,
    provider: config.provider,
    gold,
    extractions,
    validated: calls,
    schema,
  };
  const evalReport = runEval(evalInput);
  stage('evaluate', `macro F1 ${evalReport.macroF1.toFixed(3)}, ECE ${evalReport.calibration.ece.toFixed(3)}`);

  const finishedAt = new Date();

  return {
    artifact: {
      meta: {
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        provider: config.provider,
        model: config.model,
        corpusSeed: CONFIG.corpus.seed,
        corpusSize: CONFIG.corpus.size,
        wallMs: Date.now() - t0,
      },
      schema,
      proposals,
      calls,
      signals,
      spans: tracer.all(),
      evalReport,
      patterns,
      validation: stats,
      transcripts,
    },
    evalInput,
  };
}
