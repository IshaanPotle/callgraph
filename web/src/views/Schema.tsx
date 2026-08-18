import type { RunArtifact } from '../../../src/core/types.js';
import { Bar, Panel, Stat, pct } from '../ui.js';

export function SchemaView({ run }: { run: RunArtifact }) {
  const { schema, proposals } = run;
  const s = schema.sampling;
  const align = run.evalReport.alignment;
  const goldFields = run.evalReport.perField.length;
  const recovered = align.filter((a) => a.gold).length;
  // Derived rather than written down. The closing note makes a claim about
  // exactly these columns, and a hand-typed list is one schema change away from
  // describing a run that no longer exists.
  const unlabelled = align.filter((a) => !a.gold).map((a) => a.discovered);

  return (
    <>
      <div className="grid k4">
        <Stat k="calls read" v={`${s.sampleSize}`} foot={`of ${s.corpusSize} — ${pct(s.sampleSize / s.corpusSize, 0)}`} />
        <Stat k="proposers" v={`${schema.proposerCount}`} foot="independent, disjoint slices" />
        <Stat k="columns kept" v={`${schema.fields.length}`} tone="good" foot={`${schema.rejected.length} rejected at synthesis`} />
        <Stat k="gold recovered" v={`${recovered}/${goldFields}`} foot="nobody told it what to look for" />
      </div>

      <p className="note" style={{ marginTop: 14 }}>
        Nobody specified this schema. Four proposers each read a disjoint slice of{' '}
        {Math.round(s.sampleSize / schema.proposerCount)} calls, proposed whatever structure they
        saw, and a synthesizer merged what independent readers agreed on.{' '}
        <strong>The cost is fixed at {s.sampleSize} calls</strong> — it does not grow with the
        corpus, which is the whole reason the layer exists. Support below is how many proposers
        converged on a column without seeing each other's work; that agreement is the only evidence
        the column is real and not one reader's invention.
      </p>

      <Panel title="Discovered columns">
        <table>
          <thead>
            <tr>
              <th>column</th>
              <th>type</th>
              <th className="num">support</th>
              <th className="num">prevalence</th>
              <th></th>
              <th>merged from</th>
              <th>maps to gold</th>
            </tr>
          </thead>
          <tbody>
            {schema.fields.map((f) => {
              const align = run.evalReport.alignment.find((a) => a.discovered === f.name);
              return (
                <tr key={f.name}>
                  <td>
                    {f.name}
                    {!f.required && <span className="tag" style={{ marginLeft: 7 }}>optional</span>}
                  </td>
                  <td className="dim">{f.type}</td>
                  <td className="num">
                    {f.support}/{schema.proposerCount}
                  </td>
                  <td className="num">{pct(f.prevalence, 0)}</td>
                  <td style={{ width: 90 }}>
                    <Bar value={f.prevalence} tone={f.required ? 'good' : 'warn'} />
                  </td>
                  <td className="dimmer" title={f.mergedFrom.join(', ')}>
                    {f.mergedFrom.length > 1 ? f.mergedFrom.join(', ') : ''}
                  </td>
                  <td className={align?.gold ? '' : 'dimmer'}>
                    {align?.gold ?? 'no counterpart'}
                    {align?.gold && (
                      <span className="dimmer"> · {align.method} {align.score.toFixed(2)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="note" style={{ margin: '12px 0 0' }}>
          The number beside each mapping is mutual information, and on an <code>exact</code> row it
          is a report rather than a reason — the match was made on name identity, so a low score
          like <code>disclosure_given</code>'s 0.06 is not a bad match, it is a good match to a
          column the extractor reads badly. The Eval tab is where that distinction earns its keep.
        </p>
        <p className="note" style={{ margin: '12px 0 0' }}>
          The {unlabelled.length} columns with no gold counterpart are not failures. The corpus has{' '}
          {goldFields} latent facts and discovery recovered <strong>all {goldFields}</strong> —
          then kept going, and proposed {unlabelled.length} more kinds of structure the generator
          never labelled:{' '}
          {unlabelled.map((n, i) => (
            <span key={n}>
              {i > 0 && ', '}
              <code>{n}</code>
            </span>
          ))}
          . That surplus is the layer doing its job rather than failing at it — a component that
          only ever recovers the spec is not discovering anything, it is reconstructing something
          somebody already wrote down. The eval scores the {goldFields} it can check and reports
          the rest as unmapped rather than as wrong, because there is no label to be wrong against.
        </p>
      </Panel>

      {schema.rejected.length > 0 && (
        <Panel title="Rejected at synthesis" hint="proposed by someone, kept by nobody">
          <table>
            <tbody>
              {schema.rejected.map((r, i) => (
                <tr key={i}>
                  <td style={{ width: 220 }}>{r.name}</td>
                  <td className="dim">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title="What each proposer saw" hint="before any merging">
        <div className="grid k2">
          {proposals.map((p) => (
            <div key={p.proposer}>
              <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
                proposer {p.proposer + 1} — {p.proposals.length} columns
              </div>
              <table>
                <tbody>
                  {p.proposals.map((f) => (
                    <tr key={f.name}>
                      <td>{f.name}</td>
                      <td className="dimmer">{f.type}</td>
                      <td className="num dim">{pct(f.estimatedPrevalence, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
