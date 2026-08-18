import { useEffect, useState } from 'react';

import type { RunArtifact } from '../../../src/core/types.js';
import type { FaultRecovery, PolicyAudit } from '../../../src/pipeline/evaluate.js';
import { Bar, Panel, Stat, pct } from '../ui.js';

interface EvalExtras {
  policy: PolicyAudit;
  faultRecovery: { rate: number; recovery: FaultRecovery }[];
}

export function EvalView({ run }: { run: RunArtifact }) {
  const [extras, setExtras] = useState<EvalExtras | null>(null);
  const ev = run.evalReport;

  useEffect(() => {
    fetch('/eval.json')
      .then((r) => (r.ok ? r.json() : null))
      .then(setExtras)
      .catch(() => setExtras(null));
  }, []);

  const worst = [...ev.perField].sort((a, b) => a.f1 - b.f1)[0]!;
  const at20 = ev.routing.find((r) => Math.abs(r.reviewShare - 0.2) < 1e-9);

  return (
    <>
      <p className="note">
        The corpus was generated from latent facts and then <em>rendered</em> into messy
        transcripts, so ground truth existed before the text did and no labelling budget was spent.
        Nothing downstream of the generator can see it — <code>CallFacts</code> reaches exactly one
        function in the codebase, and it is this one.{' '}
        <strong>These numbers are not all good, and the bad ones are the point:</strong> a demo that
        reports 98% on everything has either solved the problem or is not measuring it.
      </p>

      <div className="grid k4">
        <Stat k="macro F1" v={ev.macroF1.toFixed(3)} foot="unweighted across 10 gold fields" />
        <Stat k="micro accuracy" v={pct(ev.microAccuracy)} foot={`${ev.callsScored} calls scored`} />
        <Stat
          k="calibration error"
          v={ev.calibration.ece.toFixed(3)}
          tone="warn"
          foot="stated confidence vs. being right"
        />
        <Stat
          k="worst column"
          v={worst.f1.toFixed(3)}
          tone="bad"
          foot={`${worst.gold} — reported, not hidden`}
        />
      </div>

      <Panel title="Per field" hint="against latent truth the pipeline never saw">
        <table>
          <thead>
            <tr>
              <th>gold field</th>
              <th>discovered as</th>
              <th className="num">n</th>
              <th className="num">precision</th>
              <th className="num">recall</th>
              <th className="num">F1</th>
              <th style={{ width: 110 }}></th>
              <th className="num">missed</th>
              <th className="num">wrong</th>
              <th className="num">invented</th>
            </tr>
          </thead>
          <tbody>
            {ev.perField.map((f) => (
              <tr key={f.gold}>
                <td>{f.gold}</td>
                <td className="dimmer">{f.discovered ?? '—'}</td>
                <td className="num dim">{f.support}</td>
                <td className="num">{f.precision.toFixed(3)}</td>
                <td className="num">{f.recall.toFixed(3)}</td>
                <td className="num">{f.f1.toFixed(3)}</td>
                <td>
                  <Bar value={f.f1} tone={f.f1 > 0.9 ? 'good' : f.f1 > 0.75 ? '' : 'bad'} />
                </td>
                <td className="num dim">{f.falseNegative || ''}</td>
                <td className="num dim">{f.wrongValue || ''}</td>
                <td className="num dim">{f.falsePositive || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note" style={{ margin: '12px 0 0' }}>
          Three failure modes, kept apart on purpose. <b>Missed</b> is a null where a value existed,{' '}
          <b>wrong</b> is a value that disagrees, <b>invented</b> is a value where truth was null.
          Pooling them into one accuracy number would hide that <code>objection</code> is not a weak
          extractor at all — its recall is 0.97 and it invents an objection on 60 calls that had
          none, which is a prompt problem, not a model one.
        </p>
      </Panel>

      <Panel title="Schema alignment" hint="how discovered columns were matched to gold, without being told">
        <p className="note">
          Discovery invents its own names, so scoring requires knowing which column means what. The
          mapping is earned rather than declared: normalized mutual information between each
          discovered column and each gold field, then greedy bipartite matching.{' '}
          <strong>
            {ev.alignment.filter((a) => a.method === 'similarity').length} of them were matched on
            evidence alone
          </strong>{' '}
          — <code>followup_date</code> → <code>commitmentDate</code> share no substring; they were
          paired because they carry the same information across 240 calls.
        </p>
        <table>
          <thead>
            <tr>
              <th>discovered</th>
              <th>gold</th>
              <th>matched by</th>
              <th className="num">score</th>
              <th style={{ width: 110 }}></th>
            </tr>
          </thead>
          <tbody>
            {ev.alignment.map((a) => (
              <tr key={a.discovered}>
                <td>{a.discovered}</td>
                <td className={a.gold ? '' : 'dimmer'}>{a.gold ?? 'no counterpart'}</td>
                <td className="dim">{a.method}</td>
                <td className="num">{a.method === 'unmapped' ? '' : a.score.toFixed(3)}</td>
                <td>{a.method !== 'unmapped' && <Bar value={a.score} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note" style={{ margin: '12px 0 0' }}>
          Matching on evidence alone has a failure mode that would have flattered this page, and{' '}
          <code>disclosure_given</code> is it. Its mutual information with{' '}
          <code>disclosureGiven</code> is <strong>0.061</strong> — far below the 0.2 floor a
          similarity match needs — <em>because the extractor is bad at that column</em>. A column
          the model reads poorly carries little information about the truth, so a purely
          evidence-based matcher would leave it unmapped, drop it from the scorecard, and report a
          higher macro F1 the worse the extraction got. So exact name identity is checked first and
          overrides the floor. That is the row scoring 0.742 here rather than quietly not existing.
        </p>
      </Panel>

      <div className="grid k2">
        <Panel title="Calibration" hint={`ECE ${ev.calibration.ece.toFixed(3)}`}>
          <p className="note">
            When the extractor says 0.35, is it right 35% of the time? No — it is right 92% of the
            time. This model is badly <b>under</b>confident in the middle of its range, which is the
            forgiving direction to be wrong in and still means a confidence threshold is not the
            routing signal it looks like.
          </p>
          <table>
            <thead>
              <tr>
                <th>bin</th>
                <th className="num">n</th>
                <th className="num">said</th>
                <th className="num">was</th>
                <th style={{ width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {ev.calibration.bins
                .filter((b) => b.count > 0)
                .map((b, i) => (
                  <tr key={i}>
                    <td className="dim">
                      {b.lo.toFixed(1)}–{b.hi.toFixed(1)}
                    </td>
                    <td className="num dim">{b.count}</td>
                    <td className="num">{b.meanConfidence.toFixed(2)}</td>
                    <td className="num">{b.accuracy.toFixed(2)}</td>
                    <td>
                      <Bar
                        value={b.accuracy}
                        tone={b.accuracy < b.meanConfidence - 0.05 ? 'bad' : 'good'}
                      />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="The critic" hint="is rejecting the same as being wrong?">
          <p className="note">
            Mostly it is not, and this is the least flattering panel here. The critic checks whether
            a value is <em>grounded</em> — that the quote is real and the value follows from it — and
            grounding is not correctness. It catches fabrication reliably and disagreement barely at
            all.
          </p>
          <table>
            <tbody>
              <tr>
                <td className="dim">caught a real error</td>
                <td className="num good">{ev.critic.truePositive}</td>
              </tr>
              <tr>
                <td className="dim">rejected a correct value</td>
                <td className="num bad">{ev.critic.falsePositive}</td>
              </tr>
              <tr>
                <td className="dim">passed a wrong value</td>
                <td className="num bad">{ev.critic.falseNegative}</td>
              </tr>
              <tr>
                <td className="dim">passed a correct value</td>
                <td className="num">{ev.critic.trueNegative}</td>
              </tr>
              <tr>
                <td className="dim">precision / recall</td>
                <td className="num">
                  {ev.critic.precision.toFixed(3)} / {ev.critic.recall.toFixed(3)}
                </td>
              </tr>
              <tr>
                <td className="dim">rejections costing no tokens</td>
                <td className="num good">{pct(ev.critic.deterministicShare)}</td>
              </tr>
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Human review budget" hint="the curve you actually operate on">
        <p className="note">
          A number nobody can act on is decoration. This is the one an operations lead uses: route
          the least-confident share to a person, and this is what you catch.{' '}
          {at20 && (
            <>
              At <strong>{pct(at20.reviewShare, 0)} review</strong> you catch{' '}
              <strong>{pct(at20.errorsCaught / at20.errorsTotal)}</strong> of all errors and what
              ships automatically is {pct(at20.autoAccuracy)} accurate.
            </>
          )}
        </p>
        <table>
          <thead>
            <tr>
              <th className="num">review</th>
              <th className="num">errors caught</th>
              <th style={{ width: 200 }}></th>
              <th className="num">auto-accepted accuracy</th>
            </tr>
          </thead>
          <tbody>
            {ev.routing.map((r) => (
              <tr key={r.reviewShare}>
                <td className="num">{pct(r.reviewShare, 0)}</td>
                <td className="num">
                  {r.errorsCaught} / {r.errorsTotal}
                </td>
                <td>
                  <Bar value={r.errorsCaught / Math.max(1, r.errorsTotal)} tone="good" />
                </td>
                <td className="num">{pct(r.autoAccuracy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {extras && <BudgetPanel policy={extras.policy} />}
      {extras && <FaultPanel rows={extras.faultRecovery} />}
    </>
  );
}

function BudgetPanel({ policy }: { policy: PolicyAudit }) {
  // Scaled to the worst channel rather than to 1.0. These rates all sit under
  // 20%, and bars that never leave the left fifth of the cell communicate
  // nothing about the thing the panel is about, which is their ratio.
  const worst = Math.max(...policy.channels.map((c) => c.errorRate), 1e-9);
  return (
    <Panel title="What the skipped checks let through" hint="pricing the cost lever honestly">
      <p className="note">
        The validation layer does not critique every cell — a confidence gate and a per-column
        budget decide what is worth a model call. The cost line reads well and is not the question.
        The question is what came through the gap, and the answer inverts the framing:{' '}
        <strong>
          the fields a deterministic check cleared are the worst channel on the page
        </strong>
        , carrying {pct(policy.channels.find((c) => c.decidedBy === 'deterministic')!.shareOfErrors, 0)}{' '}
        of all shipped errors at more than double the error rate of the fields nothing looked at.
        Those checks verify that a quote is real, not that the value read from it is right.
      </p>
      <table>
        <thead>
          <tr>
            <th>settled by</th>
            <th className="num">shipped</th>
            <th className="num">errors</th>
            <th className="num">error rate</th>
            <th style={{ width: 140 }}></th>
            <th className="num">share of all errors</th>
          </tr>
        </thead>
        <tbody>
          {policy.channels.map((c) => (
            <tr key={c.decidedBy}>
              <td>{c.decidedBy}</td>
              <td className="num dim">{c.shipped}</td>
              <td className="num">{c.errors}</td>
              <td className="num">{pct(c.errorRate)}</td>
              <td>
                <Bar value={c.errorRate / worst} tone={c.errorRate > 0.1 ? 'bad' : 'good'} />
              </td>
              <td className="num">{pct(c.shareOfErrors)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note" style={{ margin: '12px 0 0' }}>
        Full critic coverage would have caught an estimated{' '}
        <strong>{policy.recoverableByFullCoverage.toFixed(1)} more errors</strong> — the uninspected
        errors scaled by the critic's <em>measured</em> recall of{' '}
        {policy.criticRecall.toFixed(3)}, rather than by an assumption that it would have caught what
        it never saw. The saving is defensible, and for a second unflattering reason: skipping the
        critic is cheap largely because the critic is finding so little.
      </p>
    </Panel>
  );
}

/**
 * The only panel here that is a claim about the harness rather than the model.
 * Everything above is scored against gold labels, so a harness that silently
 * dropped half its errors would render this exact page and look fine.
 */
function FaultPanel({ rows }: { rows: { rate: number; recovery: FaultRecovery }[] }) {
  const allOk = rows.every((r) => r.recovery.accounted);
  return (
    <Panel title="Does the eval detect errors, or just produce numbers?" hint="fault injection">
      <p className="note">
        Every metric above is computed against gold labels, so an eval that quietly lost errors
        would report a clean, plausible, entirely wrong accuracy and nothing on this page would say
        so. Against a live model there is no way to check — you never learn the true error, only
        what your labels claim, and that is the thing under test. A simulator removes the
        circularity: corrupt known cells at a known rate, run the eval blind, and{' '}
        <strong>every injected fault must come out somewhere</strong>. Surfaced as an error,
        repaired by layer 3, or landing on a value that was already wrong. Anywhere else is lost.
      </p>
      <table>
        <thead>
          <tr>
            <th className="num">injection rate</th>
            <th className="num">injected</th>
            <th className="num">unscoreable</th>
            <th className="num">already wrong</th>
            <th className="num">detectable</th>
            <th className="num">surfaced</th>
            <th className="num">repaired</th>
            <th className="num">lost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ rate, recovery: r }) => (
            <tr key={rate}>
              <td className="num">{pct(rate, 0)}</td>
              <td className="num dim">{r.injected}</td>
              <td className="num dimmer">{r.unscored}</td>
              <td className="num dimmer">{r.alreadyWrong}</td>
              <td className="num">{r.detectable}</td>
              <td className="num good">{r.surfaced}</td>
              <td className="num good">{r.repaired}</td>
              <td className={`num ${r.lost === 0 ? 'good' : 'bad'}`}>{r.lost}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note" style={{ margin: '12px 0 0' }}>
        <span className={`tag ${allOk ? 'good' : 'bad'}`}>{allOk ? 'pass' : 'fail'}</span>{' '}
        <code>surfaced + repaired === detectable</code> and <code>lost === 0</code> at every rate.
        An identity rather than a rate, deliberately — a rate can be tuned until it looks
        convincing; this either holds or names the faults that went missing.
      </p>
    </Panel>
  );
}
