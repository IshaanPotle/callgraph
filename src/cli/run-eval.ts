/**
 * The eval, printed in full, plus the check that the eval itself works.
 *
 * The second half is the part worth reading. Everything above `FAULT INJECTION`
 * is a scorecard, and a scorecard is only as good as the harness that produced
 * it — a harness that silently dropped half its errors would print numbers of
 * exactly this shape and nothing about the page would look wrong.
 *
 * So the run is done twice: once clean, once with known corruptions injected at
 * a known rate into known cells. Every injected fault must come out somewhere,
 * and the identity `surfaced + repaired === detectable` either holds or names
 * the ones that went missing. That is a claim about the measuring instrument
 * rather than about the model, and it is the only claim here that could not be
 * made at all against a live provider — you cannot inject a known error rate
 * into a system whose error rate you do not know.
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { CONFIG } from '../config.js';
import { resolveConfig } from '../core/llm/index.js';
import { auditPolicy, recoverFaults, type EvalInput, type FaultRecovery } from '../pipeline/evaluate.js';
import { runPipeline } from '../pipeline/run.js';
import { FaultInjector } from '../sim/faults.js';

const config = resolveConfig();

if (config.provider !== 'stub') {
  // Not a limitation to work around. Injecting known errors into real model
  // output measures nothing: the baseline error rate is already unknown, and
  // adding a known quantity to an unknown one leaves it unknown.
  console.error('run-eval requires the simulator. Fault injection is meaningless against a live model.');
  console.error('Run with LLM_PROVIDER=stub (the default when no API key is set).');
  process.exit(1);
}

const RATES = [0.05, 0.1, 0.2];

console.log('provider: STUB (offline simulator)\n');

const clean = await runPipeline({ config });
const ev = clean.artifact.evalReport;
const policy = auditPolicy(clean.evalInput, ev.critic);

// ---------------------------------------------------------------------------

console.log('ALIGNMENT — discovered columns mapped to gold fields, by mutual information');
for (const a of ev.alignment) {
  const to = a.gold ?? '(none)';
  console.log(
    `  ${a.discovered.padEnd(22)} -> ${to.padEnd(21)} ${a.method.padEnd(11)} ` +
      (a.method === 'unmapped' ? '' : a.score.toFixed(3)),
  );
}
const mapped = ev.alignment.filter((a) => a.gold !== null).length;
console.log(
  `  ${mapped}/${ev.alignment.length} columns mapped, ` +
    `${ev.alignment.filter((a) => a.method === 'similarity').length} on evidence alone ` +
    `(no shared name)`,
);

console.log('\nPER FIELD');
console.log('  field                    n      P      R     F1     FN  wrong    FP');
for (const f of ev.perField) {
  console.log(
    `  ${f.gold.padEnd(20)} ${String(f.support).padStart(4)}  ${f.precision.toFixed(3)}  ` +
      `${f.recall.toFixed(3)}  ${f.f1.toFixed(3)}  ${String(f.falseNegative).padStart(5)}  ` +
      `${String(f.wrongValue).padStart(5)}  ${String(f.falsePositive).padStart(4)}`,
  );
}

console.log('\nHEADLINE');
console.log(`  macro F1              ${ev.macroF1.toFixed(3)}`);
console.log(`  micro accuracy        ${(100 * ev.microAccuracy).toFixed(1)}%`);
console.log(
  `  validation lift       ${(100 * ev.preValidationAccuracy).toFixed(1)}% -> ` +
    `${(100 * ev.postValidationAccuracy).toFixed(1)}%`,
);

console.log('\nCALIBRATION — does a stated confidence of X mean it is right X of the time?');
for (const b of ev.calibration.bins) {
  if (b.count === 0) continue;
  const gap = b.accuracy - b.meanConfidence;
  console.log(
    `  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  n=${String(b.count).padStart(5)}  ` +
      `said ${b.meanConfidence.toFixed(3)}  was ${b.accuracy.toFixed(3)}  ` +
      `${gap >= 0 ? '+' : ''}${gap.toFixed(3)} ${gap > 0.05 ? 'underconfident' : gap < -0.05 ? 'OVERCONFIDENT' : ''}`,
  );
}
console.log(`  expected calibration error: ${ev.calibration.ece.toFixed(4)}`);

console.log('\nCRITIC — is rejecting an extraction the same as it being wrong?');
const c = ev.critic;
console.log(`  TP ${c.truePositive}  FP ${c.falsePositive}  FN ${c.falseNegative}  TN ${c.trueNegative}`);
console.log(`  precision ${c.precision.toFixed(3)}   recall ${c.recall.toFixed(3)}`);
console.log(`  ${(100 * c.deterministicShare).toFixed(1)}% of rejections cost no tokens`);

console.log('\nVALIDATION BUDGET — what the skipped checks let through');
console.log('  decided by       shipped  errors   rate   share of all errors');
for (const ch of policy.channels) {
  console.log(
    `  ${ch.decidedBy.padEnd(14)} ${String(ch.shipped).padStart(7)}  ${String(ch.errors).padStart(6)}  ` +
      `${(100 * ch.errorRate).toFixed(1)}%   ${(100 * ch.shareOfErrors).toFixed(1)}%`,
  );
}
console.log(
  `  full critic coverage would have caught an estimated ` +
    `${policy.recoverableByFullCoverage.toFixed(1)} more of them ` +
    `(uninspected errors x measured critic recall ${policy.criticRecall.toFixed(3)})`,
);

console.log('\nROUTING — send the least-confident share to a human, catch what?');
for (const r of ev.routing) {
  console.log(
    `  review ${(100 * r.reviewShare).toFixed(0).padStart(3)}%  ` +
      `catches ${String(r.errorsCaught).padStart(4)}/${r.errorsTotal} errors ` +
      `(${(100 * r.errorsCaught / Math.max(1, r.errorsTotal)).toFixed(1)}%)  ` +
      `auto-accepted accuracy ${(100 * r.autoAccuracy).toFixed(1)}%`,
  );
}

// ---------------------------------------------------------------------------

console.log('\nFAULT INJECTION — does this harness detect errors, or just produce numbers?');
console.log('  Corrupt known cells at a known rate, run the eval blind, and every fault');
console.log('  must land somewhere: surfaced as an error, repaired by layer 3, or landing');
console.log('  on a value that was already wrong. Anything else is lost, and a lost fault');
console.log('  means the accuracy above is not counting errors it should be counting.\n');
console.log('   rate  injected  unscored  already-wrong  detectable  surfaced  repaired  lost   ok');

const recoveries: { rate: number; recovery: FaultRecovery }[] = [];
for (const rate of RATES) {
  const faults = new FaultInjector({ seed: CONFIG.corpus.seed, rate });
  const faulted = await runPipeline({ config, faults });
  const r = recoverFaults(clean.evalInput, faulted.evalInput, faults.injected);
  recoveries.push({ rate, recovery: r });

  console.log(
    `  ${(100 * rate).toFixed(1).padStart(5)}%  ${String(r.injected).padStart(8)}  ` +
      `${String(r.unscored).padStart(8)}  ${String(r.alreadyWrong).padStart(13)}  ` +
      `${String(r.detectable).padStart(10)}  ${String(r.surfaced).padStart(8)}  ` +
      `${String(r.repaired).padStart(8)}  ${String(r.lost).padStart(4)}  ` +
      `${r.accounted ? ' YES' : ' NO'}`,
  );
}

const allAccounted = recoveries.every((r) => r.recovery.accounted);
console.log(
  `\n  ${allAccounted ? 'PASS' : 'FAIL'} — surfaced + repaired === detectable, lost === 0, ` +
    `at every rate tested.`,
);
// An identity, not a threshold. A rate can be tuned until it looks convincing;
// this either holds or names the faults that went missing.
if (!allAccounted) process.exitCode = 1;

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/eval.json',
  JSON.stringify({ report: ev, policy, faultRecovery: recoveries }, null, 2),
);
console.log('\n  wrote artifacts/eval.json');
