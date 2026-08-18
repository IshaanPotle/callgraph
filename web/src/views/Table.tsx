import { useMemo, useState } from 'react';

import type { RunArtifact, ValidatedField } from '../../../src/core/types.js';
import { Panel, pct } from '../ui.js';
import { TranscriptView } from './Transcript.js';

/**
 * The output table, with the provenance of every cell one click away.
 *
 * The colouring is the argument. A product that shows only the values is
 * claiming they are all equally trustworthy, which they are not: some were
 * cleared by a string comparison, some by a critic, some were repaired after a
 * rejection, and some are open questions the system declined to answer. Those
 * are four different things and the table says which is which.
 */
export function TableView({ run }: { run: RunArtifact }) {
  const [sel, setSel] = useState<{ callId: string; field: string } | null>(null);
  const [vertical, setVertical] = useState<string>('all');

  const columns = run.schema.fields.map((f) => f.name);
  const rows = useMemo(
    () => run.calls.filter((c) => vertical === 'all' || c.vertical === vertical),
    [run.calls, vertical],
  );

  const counts = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const c of run.calls) for (const f of Object.values(c.fields)) acc[f.disposition] = (acc[f.disposition] ?? 0) + 1;
    return acc;
  }, [run.calls]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const selected = sel && run.calls.find((c) => c.callId === sel.callId)?.fields[sel.field];

  return (
    <>
      <p className="note">
        {run.calls.length} calls × {columns.length} discovered columns. Colour is not decoration:{' '}
        <strong>every cell carries how it was decided</strong>, and clicking one shows the quote it
        was pulled from, the checks that ran, and what the critic said. A cell routed to human
        review is not an error — it is the system declining to answer, which is the behaviour you
        want and the one that never survives a demo optimised for a full table.
      </p>

      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12 }}>
        <select
          value={vertical}
          onChange={(e) => setVertical(e.target.value)}
          style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 4, padding: '5px 9px', fontFamily: 'inherit' }}
        >
          <option value="all">all verticals ({run.calls.length})</option>
          {['hvac', 'claims', 'saas'].map((v) => (
            <option key={v} value={v}>
              {v} ({run.calls.filter((c) => c.vertical === v).length})
            </option>
          ))}
        </select>
        <div className="legend" style={{ margin: 0 }}>
          <span><i className="swatch" style={{ background: 'var(--line)' }} /> accepted {pct((counts.accepted ?? 0) / total, 0)}</span>
          <span><i className="swatch" style={{ background: 'var(--warn)' }} /> repaired after rejection {counts.repaired ?? 0}</span>
          <span><i className="swatch" style={{ background: 'var(--bad)' }} /> routed to human {pct((counts.human_review ?? 0) / total, 0)}</span>
        </div>
      </div>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>call</th>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((call) => (
              <tr key={call.callId}>
                <td className="dim">{call.callId}</td>
                {columns.map((c) => {
                  const f = call.fields[c];
                  const isSel = sel?.callId === call.callId && sel.field === c;
                  return (
                    <td
                      key={c}
                      className={`cell ${f?.disposition ?? ''} ${isSel ? 'sel' : ''}`}
                      onClick={() => setSel(isSel ? null : { callId: call.callId, field: c })}
                      title={f ? `${f.disposition} · confidence ${f.confidence.toFixed(2)}` : ''}
                    >
                      {render(f)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sel && selected && (
        <div className="inspector">
          <Inspector run={run} callId={sel.callId} field={selected} />
        </div>
      )}
    </>
  );
}

function render(f: ValidatedField | undefined) {
  if (!f) return <span className="dimmer">—</span>;
  if (f.disposition === 'human_review') return <span className="dimmer">needs review</span>;
  if (f.value === null) return <span className="dimmer">null</span>;
  return String(f.value);
}

function Inspector({ run, callId, field }: { run: RunArtifact; callId: string; field: ValidatedField }) {
  const transcript = run.transcripts.find((t) => t.callId === callId)!;
  const ev = field.evidence[0];
  const last = field.verdicts.at(-1);

  return (
    <Panel title={`${callId} · ${field.field}`} hint={`${field.disposition} after ${field.attempts} attempt${field.attempts === 1 ? '' : 's'}`}>
      <table style={{ width: 'auto' }}>
        <tbody>
          <tr>
            <td className="dim" style={{ paddingRight: 22 }}>value</td>
            <td>{field.value === null ? <span className="dimmer">null</span> : String(field.value)}</td>
          </tr>
          <tr>
            <td className="dim">stated confidence</td>
            <td>{field.confidence.toFixed(2)}</td>
          </tr>
          <tr>
            <td className="dim">settled by</td>
            <td>{last?.decidedBy ?? '—'}{last && ` · ${last.verdict}`}</td>
          </tr>
        </tbody>
      </table>

      {last && (
        <div className="checks">
          {Object.entries(last.checks).map(([k, v]) => (
            <span key={k} className={`tag ${v ? 'good' : 'bad'}`}>
              {v ? '✓' : '✗'} {k.replace(/([A-Z])/g, ' $1').toLowerCase()}
            </span>
          ))}
        </div>
      )}

      {field.verdicts.map((v, i) => (
        <div key={i} className="quote">
          <span className={`tag ${v.verdict === 'accept' ? 'good' : 'bad'}`}>{v.verdict}</span>{' '}
          <span className="dimmer">{v.decidedBy}</span> — {v.reason}
        </div>
      ))}

      {ev ? (
        <TranscriptView transcript={transcript} highlight={ev.quote} highlightTurn={ev.turnIndex} />
      ) : (
        <p className="note" style={{ marginTop: 10 }}>
          No evidence span. A non-null value with nothing behind it is rejected before a critic is
          ever called — see <code>hasEvidence</code>.
        </p>
      )}
    </Panel>
  );
}
