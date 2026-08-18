import type { RunArtifact } from '../../../src/core/types.js';
import { Tracer } from '../../../src/core/trace.js';
import { Bar, Panel, Stat, money, pct } from '../ui.js';

/**
 * Where the money and the time went.
 *
 * Rebuilt from the spans rather than read off a summary the pipeline computed,
 * for the same reason the CLI does it: two sources for one number is two
 * chances to be wrong about it. Every model call in the system goes through the
 * tracer — nothing touches the SDK directly — which is what makes this page a
 * record instead of an estimate.
 */
export function TraceView({ run }: { run: RunArtifact }) {
  const tracer = new Tracer();
  for (const s of run.spans) tracer.record(s);

  const rollups = tracer.byAgent();
  const total = tracer.totalCost();
  const tokens = tracer.totalTokens();
  const v = run.validation;
  const stub = run.meta.provider === 'stub';

  const perCall = total / run.meta.corpusSize;

  return (
    <>
      <div className="grid k4">
        <Stat k="total" v={money(total)} foot={`${run.spans.length.toLocaleString()} model calls`} />
        <Stat k="per call analysed" v={money(perCall)} foot={`across ${run.meta.corpusSize} calls`} />
        <Stat
          k="tokens"
          v={`${Math.round((tokens.input + tokens.output) / 1000)}k`}
          foot={`${Math.round(tokens.input / 1000)}k in / ${Math.round(tokens.output / 1000)}k out`}
        />
        <Stat k="wall clock" v={`${(run.meta.wallMs / 1000).toFixed(1)}s`} foot="end to end, 8-way concurrent" />
      </div>

      <p className="note" style={{ marginTop: 14 }}>
        {stub ? (
          <>
            <strong>The token counts are simulated; the accounting is not.</strong> The simulator
            reports plausible usage per call and everything downstream — the per-model price table,
            the cache-read and cache-write multipliers, the rollups below — is the same code that
            would run against a live API. Point it at Anthropic and these figures change; none of
            this page does. What it demonstrates is that cost is <em>attributable per agent</em>,
            which is the property you need before you can argue about it.
          </>
        ) : (
          <>
            Live usage, priced from the published per-model rates with cache reads and writes
            multiplied out separately.
          </>
        )}
      </p>

      <Panel title="Cost by agent" hint={`${money(total)} across ${run.spans.length.toLocaleString()} calls`}>
        <table>
          <thead>
            <tr>
              <th>agent</th>
              <th className="num">calls</th>
              <th className="num">cost</th>
              <th style={{ width: 150 }}></th>
              <th className="num">share</th>
              <th className="num">in / out tokens</th>
              <th className="num">p50</th>
              <th className="num">p95</th>
              <th className="num">retries</th>
            </tr>
          </thead>
          <tbody>
            {rollups.map((r) => (
              <tr key={r.agent}>
                <td>{r.agent}</td>
                <td className="num dim">{r.calls.toLocaleString()}</td>
                <td className="num">{money(r.costUsd)}</td>
                <td>
                  <Bar value={r.costUsd / total} tone={r.costUsd / total > 0.4 ? 'warn' : ''} />
                </td>
                <td className="num">{pct(r.costUsd / total, 0)}</td>
                <td className="num dimmer">
                  {Math.round(r.inputTokens / 1000)}k / {Math.round(r.outputTokens / 1000)}k
                </td>
                <td className="num dim">{r.p50Ms}ms</td>
                <td className="num dim">{r.p95Ms}ms</td>
                <td className={`num ${r.retries > 0 ? 'warn' : 'dimmer'}`}>{r.retries || ''}</td>
              </tr>
            ))}
            <tr>
              <td>
                <b>total</b>
              </td>
              <td className="num">{run.spans.length.toLocaleString()}</td>
              <td className="num">{money(total)}</td>
              <td colSpan={6}></td>
            </tr>
          </tbody>
        </table>
        <p className="note" style={{ margin: '12px 0 0' }}>
          The shape is the design working. Discovery reads {run.schema.sampling.sampleSize} calls
          once and never again — it is{' '}
          {pct(
            rollups
              .filter((r) => r.agent.startsWith('discovery'))
              .reduce((s, r) => s + r.costUsd, 0) / total,
            1,
          )}{' '}
          of the bill and does not grow with the corpus. Everything else is per-call and scales
          linearly, so the only lever that matters at volume is how many of those{' '}
          {v.fieldsTotal.toLocaleString()} fields need a second model to look at them.
        </p>
      </Panel>

      <Panel title="The validation funnel" hint="cheapest check first, and most fields never reach a model">
        <p className="note">
          The three middle rows partition every extracted field — each one is settled exactly once,
          and they sum to {v.fieldsTotal.toLocaleString()}. The last two are outcomes rather than
          stages: a repair happens after a rejection, and human review is where a field lands when
          the system has run out of ways to answer it cheaply.
        </p>
        <table>
          <thead>
            <tr>
              <th>stage</th>
              <th className="num">fields</th>
              <th style={{ width: 200 }}></th>
              <th className="num">share</th>
              <th>what it costs</th>
            </tr>
          </thead>
          <tbody>
            <FunnelRow n={v.fieldsTotal} total={v.fieldsTotal} label="extracted" cost="—" />
            <FunnelRow
              n={v.decidedDeterministically}
              total={v.fieldsTotal}
              label="settled by string comparison"
              cost="nothing"
              tone="good"
            />
            <FunnelRow
              n={v.unreviewed}
              total={v.fieldsTotal}
              label="accepted unexamined, by budget"
              cost="nothing, and nothing looked"
              tone="warn"
            />
            <FunnelRow
              n={v.criticCalls}
              total={v.fieldsTotal}
              label="sent to a critic"
              cost={money(rollups.find((r) => r.agent === 'validate.critic')?.costUsd ?? 0)}
            />
            <FunnelRow
              n={v.repairs}
              total={v.fieldsTotal}
              label="re-extracted after rejection"
              cost={money(rollups.find((r) => r.agent === 'extract.repair')?.costUsd ?? 0)}
            />
            <FunnelRow
              n={v.humanReview}
              total={v.fieldsTotal}
              label="routed to a person"
              cost="the expensive one"
              tone="bad"
            />
          </tbody>
        </table>
        <p className="note" style={{ margin: '12px 0 0' }}>
          <b>Settled by string comparison</b> and <b>accepted unexamined</b> both cost zero tokens
          and are counted separately on purpose. One is work done cheaply; the other is work not
          done. Reporting them as a single "no model needed" figure would let the funnel look
          thorough by counting its own blind spots as coverage — and as the eval shows, the
          deterministic channel is the one that shipped the most errors.
        </p>
      </Panel>

      <Panel
        title="Per-column critic budget"
        hint={`${v.calibrationCalls} critic calls spent measuring, then rationed`}
      >
        <p className="note">
          Coverage is not a constant. Each column is measured on a fixed calibration sample, and the
          columns that reject more get more of the budget. The observed rate is pulled toward a
          pessimistic prior by an amount that depends on how little was seen, so one unlucky
          rejection in four samples does not buy a column full coverage — the smoothed rate is what
          the policy actually spends against, and both are shown.
        </p>
        <table>
          <thead>
            <tr>
              <th>column</th>
              <th className="num">calibration</th>
              <th className="num">observed reject rate</th>
              <th className="num">smoothed</th>
              <th className="num">eligible</th>
              <th className="num">sampled</th>
              <th className="num">coverage</th>
              <th style={{ width: 100 }}></th>
              <th className="num">forced by suspicion</th>
            </tr>
          </thead>
          <tbody>
            {v.coverage.map((c) => (
              <tr key={c.field}>
                <td>{c.field}</td>
                <td className="num dimmer">
                  {c.calibrationRejects}/{c.calibrationCalls}
                </td>
                <td className={`num ${c.rejectionRate === null ? 'dimmer' : ''}`}>
                  {c.rejectionRate === null ? 'never measured' : pct(c.rejectionRate)}
                </td>
                <td className="num dim">
                  {c.smoothedRate === null ? '—' : pct(c.smoothedRate)}
                </td>
                <td className="num dim">{c.eligible}</td>
                <td className="num dim">{c.sampled}</td>
                <td className="num">{pct(c.coverage, 0)}</td>
                <td>
                  <Bar value={c.coverage} tone={c.coverage > 0.6 ? 'warn' : 'good'} />
                </td>
                <td className={`num ${c.forcedBySuspicion > 0 ? 'warn' : 'dimmer'}`}>
                  {c.forcedBySuspicion || ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note" style={{ margin: '12px 0 0' }}>
          <b>Forced by suspicion</b> is not part of the budget and cannot be sampled away. Suspicion
          is evidence about <em>this specific field</em> — a quote that appears nowhere in the call,
          a value outside the schema — while the budget is a claim about the column as a whole.
          Rationing the first would mean deliberately declining to look at the fields most likely to
          be wrong. A column showing <span className="dimmer">never measured</span> is one where
          calibration never got a clean read, because every eligible field was already being forced;
          that is stored as null rather than zero, since zero would mean the critic looked and found
          nothing.
        </p>
      </Panel>

      <Panel title="Failures" hint="what the provider seam absorbed, and what it did not have to">
        <table>
          <tbody>
            <tr>
              <td className="dim" style={{ paddingRight: 24 }}>calls that errored</td>
              <td className="num">{run.spans.filter((s) => !s.ok).length}</td>
            </tr>
            <tr>
              <td className="dim">retries spent</td>
              <td className="num">{run.spans.reduce((s, x) => s + x.retries, 0)}</td>
            </tr>
            <tr>
              <td className="dim">rejections re-extracted</td>
              <td className="num">{v.repairs}</td>
            </tr>
          </tbody>
        </table>
        {stub ? (
          <p className="note" style={{ margin: '10px 0 0' }}>
            <strong>Those two zeros are a fact about the simulator, not a result.</strong> The stub
            provider never drops a connection and never returns a malformed response — it validates
            its own output against the same Zod schema the real provider validates the model's
            against, and that check has no reason to fail. So this run exercised the retry path zero
            times, and nothing here is evidence that it works. It is worth saying rather than
            leaving as a clean-looking zero: an untested path that reports no failures looks exactly
            like a tested one.{' '}
            <span className="dimmer">
              The live path in <code>src/core/llm/anthropic.ts</code> owns its own retry policy —
              the SDK's is switched off so that every attempt lands in this trace — and retries
              connection failures and 5xx, never a 4xx, because a request the API has already called
              malformed fails identically however many times it is sent. The order of those two
              checks matters: in TypeScript <code>APIConnectionError</code> must be tested before{' '}
              <code>APIError</code>, since the subclass relationship runs the opposite way to the
              one you would guess.
            </span>
          </p>
        ) : (
          <p className="note" style={{ margin: '10px 0 0' }}>
            Connection failures and 5xx are retried with backoff; 4xx are not, because a request the
            API has already called malformed fails identically however many times it is sent.
          </p>
        )}
      </Panel>
    </>
  );
}

function FunnelRow({
  n,
  total,
  label,
  cost,
  tone,
}: {
  n: number;
  total: number;
  label: string;
  cost: string;
  tone?: string;
}) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{n.toLocaleString()}</td>
      <td>
        <Bar value={n / total} tone={tone} />
      </td>
      <td className="num">{pct(n / total)}</td>
      <td className="dim">{cost}</td>
    </tr>
  );
}
