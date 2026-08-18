/**
 * Runs the pipeline and writes the artifact the UI reads.
 *
 * The artifact is committed to the repo. That is unusual and deliberate: the
 * whole point of this demo is that somebody can clone it, run `npm run dev`
 * with no API key and no model access, and see a real run's output rather than
 * a screenshot. Regenerating it requires only `npm run pipeline`, because the
 * corpus is a seed and the default provider is the simulator.
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { resolveConfig } from '../core/llm/index.js';
import { Tracer } from '../core/trace.js';
import { runPipeline } from '../pipeline/run.js';

const config = resolveConfig();

// Said up front rather than in a footnote. Every number this prints is a
// simulator number unless this line says otherwise, and a reader who missed
// that would draw completely wrong conclusions from the eval table below.
console.log(
  config.provider === 'stub'
    ? `provider: STUB (offline simulator, no API key required, no tokens billed)`
    : `provider: ANTHROPIC (live, model ${config.model}, effort ${config.effort})`,
);
console.log('');

const t0 = Date.now();
const { artifact } = await runPipeline({
  config,
  onStage: (stage, detail) => {
    const at = `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7);
    console.log(`${at}  ${stage.padEnd(10)} ${detail ?? ''}`);
  },
});

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/run.json', JSON.stringify(artifact));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// Rebuilt from the spans rather than threaded out of the pipeline, so the
// rollup is derived from the same record the UI shows. Two sources for one
// number is two chances to be wrong about it.
const tracer = new Tracer();
for (const s of artifact.spans) tracer.record(s);

const { meta, evalReport: ev } = artifact;
const dispositions = artifact.calls
  .flatMap((c) => Object.values(c.fields))
  .reduce<Record<string, number>>((acc, f) => {
    acc[f.disposition] = (acc[f.disposition] ?? 0) + 1;
    return acc;
  }, {});
const totalFields = Object.values(dispositions).reduce((a, b) => a + b, 0);

console.log('');
console.log(`run ${meta.runId}  ${(meta.wallMs / 1000).toFixed(1)}s wall`);
console.log('');

console.log('COST');
for (const a of tracer.byAgent()) {
  console.log(
    `  ${a.agent.padEnd(20)} ${String(a.calls).padStart(5)} calls  ` +
      `$${a.costUsd.toFixed(4).padStart(8)}  p50 ${String(Math.round(a.p50Ms)).padStart(5)}ms  ` +
      `p95 ${String(Math.round(a.p95Ms)).padStart(5)}ms` +
      (a.failures > 0 ? `  ${a.failures} failed` : ''),
  );
}
const tok = tracer.totalTokens();
console.log(
  `  ${'TOTAL'.padEnd(20)} ${String(artifact.spans.length).padStart(5)} calls  ` +
    `$${tracer.totalCost().toFixed(4).padStart(8)}  ` +
    `${(tok.input / 1000).toFixed(0)}k in / ${(tok.output / 1000).toFixed(0)}k out`,
);

console.log('');
console.log('WHERE THE FIELDS LANDED');
for (const [k, v] of Object.entries(dispositions).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(14)} ${String(v).padStart(5)}  ${(100 * v / totalFields).toFixed(1)}%`);
}
console.log(
  `  ${'critic seen'.padEnd(14)} ${String(artifact.validation.criticCalls).padStart(5)}  ` +
    `${(100 * artifact.validation.criticCalls / totalFields).toFixed(1)}%  ` +
    `(${artifact.validation.decidedDeterministically} decided without a token)`,
);

console.log('');
console.log('EVAL');
console.log(
  `  macro F1 ${ev.macroF1.toFixed(3)}   micro ${(100 * ev.microAccuracy).toFixed(1)}%   ` +
    `ECE ${ev.calibration.ece.toFixed(3)}`,
);
console.log(
  `  validation lift: ${(100 * ev.preValidationAccuracy).toFixed(1)}% -> ` +
    `${(100 * ev.postValidationAccuracy).toFixed(1)}%`,
);
console.log(
  `  critic: precision ${ev.critic.precision.toFixed(3)}  recall ${ev.critic.recall.toFixed(3)}`,
);
const at20 = ev.routing.find((r) => Math.abs(r.reviewShare - 0.2) < 1e-9);
if (at20) {
  console.log(
    `  routing: 20% to review catches ${(100 * at20.errorsCaught / at20.errorsTotal).toFixed(1)}% of errors`,
  );
}

console.log('');
console.log('FINDINGS');
console.log(
  `  ${artifact.patterns.tested} hypotheses tested, ${artifact.patterns.survivedFdr} survived ` +
    `FDR, ${artifact.signals.length} written`,
);
for (const s of artifact.signals) {
  console.log(`  [${s.severity.padEnd(6)}] ${s.title}  (${s.metric.value})`);
}

console.log('');
console.log('  wrote artifacts/run.json');
