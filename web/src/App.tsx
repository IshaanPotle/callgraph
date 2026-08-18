import { useEffect, useState } from 'react';

import type { RunArtifact } from '../../src/core/types.js';
import { EvalView } from './views/Eval.js';
import { FindingsView } from './views/Findings.js';
import { SchemaView } from './views/Schema.js';
import { TableView } from './views/Table.js';
import { TraceView } from './views/Trace.js';

const TABS = [
  ['findings', 'Findings'],
  ['schema', 'Schema'],
  ['table', 'Table'],
  ['eval', 'Eval'],
  ['trace', 'Cost & trace'],
] as const;

type Tab = (typeof TABS)[number][0];

export function App() {
  const [run, setRun] = useState<RunArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('findings');

  useEffect(() => {
    fetch('/run.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then(setRun)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="shell">
        <div className="loading">
          Could not load <code>artifacts/run.json</code> ({error}).
          <br />
          Run <code>npm run pipeline</code> first — it needs no API key.
        </div>
      </div>
    );
  }

  if (!run) return <div className="shell"><div className="loading">loading run…</div></div>;

  const { meta } = run;
  const stub = meta.provider === 'stub';

  return (
    <div className="shell">
      <div className="masthead">
        <h1>callgraph</h1>
        <span className="sub">
          {meta.corpusSize} call transcripts in, {run.schema.fields.length} columns out, every number
          checked against ground truth
        </span>
      </div>

      {/* Not a footnote and not in a README nobody opened. If the numbers on
          this page came from a simulator, that is the first thing a reader is
          entitled to know, before they have formed an impression of them. */}
      <div className="provenance">
        {stub ? (
          <>
            <b>No model was called to produce this page.</b> Every agent ran against the offline
            simulator in <code>src/sim/</code> — deterministic, seeded, no API key, nothing billed.
            The orchestration, validation, statistics and eval are all real code on real data; the
            <em> cognition</em> is simulated. Set <code>ANTHROPIC_API_KEY</code> and rerun to swap
            in <code>{meta.model}</code> without touching a line of the pipeline.
          </>
        ) : (
          <>
            Live run against <b>{meta.model}</b>. {meta.corpusSize} calls, seed {meta.corpusSeed},{' '}
            {(meta.wallMs / 1000).toFixed(1)}s wall clock.
          </>
        )}
      </div>

      <nav>
        {TABS.map(([id, label]) => (
          <button key={id} aria-current={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'findings' && <FindingsView run={run} />}
      {tab === 'schema' && <SchemaView run={run} />}
      {tab === 'table' && <TableView run={run} />}
      {tab === 'eval' && <EvalView run={run} />}
      {tab === 'trace' && <TraceView run={run} />}
    </div>
  );
}
