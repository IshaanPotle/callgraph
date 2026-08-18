import { useState } from 'react';

import type { RunArtifact } from '../../../src/core/types.js';
import { Panel, Stat, humanize, severityTone } from '../ui.js';
import { TranscriptView } from './Transcript.js';

export function FindingsView({ run }: { run: RunArtifact }) {
  const [open, setOpen] = useState<string | null>(null);
  const p = run.patterns;
  const byVerdict = (v: string) => p.hypotheses.filter((h) => h.verdict === v);

  return (
    <>
      <div className="grid k4">
        <Stat k="hypotheses tested" v={p.tested.toLocaleString()} foot={`over ${p.rows} resolved rows`} />
        <Stat k="survived FDR" v={String(p.survivedFdr)} foot={`q < ${p.fdrQ}, Benjamini-Hochberg`} />
        <Stat k="shown as findings" v={String(run.signals.length)} tone="good" foot={`${p.hypotheses.length - byVerdict('finding').length} filtered after surviving`} />
        <Stat k="expected false" v={`~${(p.fdrQ * run.signals.length).toFixed(1)}`} foot="of the findings below, by construction" />
      </div>

      <p className="note" style={{ marginTop: 14 }}>
        Every claim below was enumerated mechanically, tested with an exact binomial tail against
        the corpus baseline, corrected for having taken {p.tested.toLocaleString()} shots at{' '}
        {p.rows} rows, then checked for whether it merely restates the line of business.{' '}
        <strong>The model wrote none of the numbers</strong> — it was handed settled statistics and
        asked only to phrase them, which is the one part of this a language model is actually the
        right tool for.
      </p>

      {run.signals.map((s) => {
        const isOpen = open === s.id;
        return (
          <div className="signal" key={s.id}>
            <header onClick={() => setOpen(isOpen ? null : s.id)}>
              <div>
                <h4>
                  <span className={`tag ${severityTone(s.severity)}`} style={{ marginRight: 9 }}>
                    {s.severity}
                  </span>
                  {s.title}
                </h4>
                <p className="finding">{s.finding}</p>
              </div>
              <div className="metric">
                <div className="big">{s.metric.value}</div>
                <div className="dim">{s.metric.baseline}</div>
                <div className="dimmer">{humanize(s.metric.label)}</div>
              </div>
            </header>

            {isOpen && <SignalBody run={run} signal={s} />}
          </div>
        );
      })}

      <Panel
        title="What was thrown out"
        hint="everything here passed significance and false-discovery correction anyway"
      >
        <p className="note">
          A findings page showing eight results looks identical whether it tested nine candidates or
          four thousand, and those are very different products. These{' '}
          {p.hypotheses.length - byVerdict('finding').length} survived every statistical gate and
          are still not worth a human's attention — which is a claim about the schema, not about the
          calls, so it ships rather than disappearing.
        </p>
        <table>
          <thead>
            <tr>
              <th>verdict</th>
              <th>claim</th>
              <th className="num">n</th>
              <th className="num">lift</th>
              <th className="num">within vertical</th>
            </tr>
          </thead>
          <tbody>
            {p.hypotheses
              .filter((h) => h.verdict !== 'finding')
              .map((h, i) => (
                <tr key={i}>
                  <td>
                    <span className="tag">{h.verdict}</span>
                  </td>
                  <td className="dim">
                    {humanize(h.condition)} → {humanize(h.outcome)}
                  </td>
                  <td className="num">{h.n}</td>
                  <td className="num">{h.lift.toFixed(2)}×</td>
                  <td className="num dim">
                    {h.stratifiedLift === null ? '—' : `${h.stratifiedLift.toFixed(2)}×`}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <div className="legend">
          <span><b>taxonomy</b> — true by construction; the schema describing itself</span>
          <span><b>redundant</b> — a column predicting its own near-duplicate</span>
          <span><b>confounded</b> — the vertical's result in a costume; lift collapses within it</span>
        </div>
      </Panel>

      {p.redundantColumns.length > 0 && (
        <Panel title="Columns carrying the same information" hint="a layer-1 result, surfaced not swallowed">
          <table>
            <tbody>
              {p.redundantColumns.map((r, i) => (
                <tr key={i}>
                  <td>{r.a}</td>
                  <td className="dim">↔</td>
                  <td>{r.b}</td>
                  <td className="num warn">{(100 * r.agreement).toFixed(1)}% agreement</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note" style={{ margin: '10px 0 0' }}>
            Discovery proposed both. Neither is wrong; together they are one column counted twice,
            and every association between them would otherwise have read as a finding.
          </p>
        </Panel>
      )}
    </>
  );
}

function SignalBody({ run, signal }: { run: RunArtifact; signal: RunArtifact['signals'][number] }) {
  const [call, setCall] = useState<string | null>(signal.callIds[0] ?? null);
  const transcript = run.transcripts.find((t) => t.callId === call);

  return (
    <div className="body">
      <div className="action">{signal.recommendedAction}</div>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 7 }}>
        {signal.callIds.length} calls behind this. Open one:
      </div>
      <div className="callchips">
        {signal.callIds.map((id) => (
          <button key={id} aria-pressed={id === call} onClick={() => setCall(id === call ? null : id)}>
            {id}
          </button>
        ))}
      </div>
      {transcript && <TranscriptView transcript={transcript} />}
    </div>
  );
}
