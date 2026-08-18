# Why these files are in the repo

`run.json` (2.3 MB) and `eval.json` are build outputs, and committing build outputs is normally
wrong. They are here anyway, for one reason: **the demo has to work for someone who has no API key
and thirty seconds.**

`git clone && npm install && npm run dev` shows a complete run — 240 calls, every extracted cell,
every evidence quote, the full trace and the eval — with no key, no server, and no build step for
the data. Vite serves this directory as `publicDir`, so the UI fetches `/run.json` at runtime the
same way it would fetch an API.

The alternative was a screenshot, and a screenshot is exactly the kind of demo this project is
arguing against.

## They are not sacred

Nothing here is hand-edited and nothing depends on it staying put. Delete both files and run
`npm run all` — the corpus is generated from seed `20260817` and the simulator is deterministic, so
you get the same artifacts back. Every extracted value, every critic verdict, every one of the
4,145 hypotheses and all 1,221 trace spans come back the same.

Not *byte*-identical, and the exceptions are worth naming rather than rounding off: `meta.runId`,
`meta.startedAt` / `finishedAt` / `wallMs`, and each span's `id`, `startedAt` and `durationMs`.
Those are wall-clock facts about the machine that ran it, and a build that faked them to make a
checksum match would be lying to pass its own test. Strip those fields and the two runs are equal:

```bash
cp artifacts/run.json /tmp/before.json && npm run pipeline
python3 - <<'EOF'
import json
a, b = (json.load(open(p)) for p in ('/tmp/before.json', 'artifacts/run.json'))
for o in (a, b):
    for k in ('runId', 'startedAt', 'finishedAt', 'wallMs'): o['meta'].pop(k, None)
    o['evalReport'].pop('runId', None)
    for s in o['spans']:
        for k in ('id', 'startedAt', 'durationMs'): s.pop(k, None)
print(json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True))
EOF
```

That is the actual claim being made: not "trust this JSON" but "regenerate it and check."

## What's in them

- **`run.json`** — the pipeline artifact: transcripts, the discovered schema and every proposer's
  raw proposals, all 3,360 validated fields with their evidence and critic verdicts, all 4,145
  tested hypotheses, the 8 surfaced signals, the eval report, and every trace span.
- **`eval.json`** — the two things the pipeline doesn't produce because they require re-running it
  under different conditions: the policy audit (what the skipped checks let through) and the
  fault-injection recovery table at 5%, 10% and 20%.

Both were produced by the offline simulator. No model has run in this repo. See the root README.
