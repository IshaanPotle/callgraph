# callgraph

Messy call transcripts in, a structured table out, and a scorecard that says how much of it to believe.

240 synthetic support calls across three verticals. Nobody specifies the schema — the system reads
10% of the corpus, proposes columns, extracts them from every call, argues with itself about which
values are grounded, tests 4,145 statistical hypotheses over the result, and reports its own
accuracy against ground truth it was never shown.

```bash
npm install
npm run all     # corpus -> pipeline -> eval, about a second, no API key
npm run dev     # open the UI at localhost:5173
```

---

## Read this before the numbers

**No language model has ever run in this repo.** Not once. Every agent call was served by an
offline simulator in `src/sim/` — deterministic, seeded, no key, nothing billed. The `$6.95` on the
cost page is a real calculation over simulated token counts. The `0.849` macro F1 is a real
measurement of a fake extractor.

So be precise about what this does and doesn't demonstrate:

| Real | Simulated |
|---|---|
| Orchestration, concurrency, retry policy, tracing | The cognition — every model response |
| The validation funnel and its budget policy | Token counts (plausible, not measured) |
| The statistics: exact binomial tails, BH correction, confound control | |
| The eval harness, and the fault injection that tests the harness | |
| Schema alignment by mutual information | |

The numbers are a demonstration that the *measurement apparatus* works, not a claim about how well
Claude extracts fields from call transcripts. I can't make that claim; I don't have the key. What I
can show is that when the key is added, there is already a scorecard waiting to grade it, and the
scorecard has been tested against injected faults to prove it doesn't lose errors.

`src/core/llm/` has two providers behind one interface. `stub.ts` is what ran. `anthropic.ts` is
written, typechecked, and never executed — `claude-opus-5`, adaptive thinking, structured outputs
via `zodOutputFormat`. Both validate against the same Zod schema, which is the only reason
swapping them is a change to nothing but the environment:

```bash
export ANTHROPIC_API_KEY=sk-...
npm run pipeline        # same code path, now live. LLM_PROVIDER=stub forces offline.
```

The provider resolves live if a key is present and offline if not, so a fresh clone never fails
with an auth error — it runs and says which one it used, on the first line of output and at the top
of the UI.

`npm run eval` is the one command that refuses to run live, on purpose. Injecting a known error
rate into real model output measures nothing: the baseline error rate is already unknown, and
adding a known quantity to an unknown one leaves it unknown. The fault-injection harness needs a
system whose true errors are knowable, which is exactly what the simulator is for.

---

## The four layers

**1 — Discover** (`src/agents/discovery.ts`). Four proposers each read a disjoint slice of 6 calls
and propose whatever structure they see. A synthesizer keeps what at least two of them found
independently. Cost is fixed at 24 calls and does not grow with the corpus — 2.8% of the bill.

It recovered all 10 latent facts the generator planted, plus four kinds of structure nobody
labelled (`hold_event`, `line_quality`, `audio_gap`, `identity_check`). It also proposed
`line_quality` and `audio_gap` separately when they agree on 100% of calls, which is a duplicate
column, and the pipeline says so rather than hiding it.

**2 — Extract** (`src/agents/extract.ts`). Per call, per column, with an evidence span and a stated
confidence. A value with no quote behind it is rejected before a critic is ever called.

**3 — Validate** (`src/agents/validate.ts`). A funnel ordered cheapest-first: deterministic checks,
then a confidence gate, then a critic, then repair, then a human. 1,708 of 3,360 fields are settled
by string comparison at zero cost. Critic coverage is rationed per column by a rejection rate
measured on a calibration sample and smoothed toward a pessimistic prior — a column that rejected
once in four samples doesn't get full coverage on that evidence.

**4 — Activate** (`src/pipeline/aggregate.ts`, `src/agents/activate.ts`). 4,145 hypotheses
enumerated mechanically, each tested with an exact binomial tail, corrected with
Benjamini-Hochberg, then classified: `taxonomy` (the schema restating itself), `redundant` (a
column predicting its near-duplicate), `confounded` (lift collapses under direct standardisation
within vertical), or `finding`. 34 survive FDR; 8 are worth showing.

**The model writes none of the numbers.** It receives settled statistics and phrases them, which is
the one part of this a language model is the right tool for.

---

## The parts I'd actually want reviewed

Most of the interesting work is in what the system reports about itself.

**The eval is tested, not trusted.** Every metric is computed against gold labels, so a harness
that silently dropped errors would produce a clean, plausible, entirely wrong scorecard and nothing
would say so. Against a live model there's no way to check this — you never learn the true error.
The simulator removes the circularity: corrupt known cells at a known rate, run the eval blind, and
assert `surfaced + repaired === detectable` and `lost === 0`. It holds at 5%, 10% and 20% injection.
An identity rather than a rate, because a rate can be tuned until it looks convincing.

**The cheapest checks ship the most errors.** The deterministic channel — the one that costs
nothing and looks like free accuracy — carries 78.5% of all shipped errors at 17.0%, more than
double the error rate of fields nothing looked at. Those checks verify a quote is real, not that
the value read from it is right. The cost saving is defensible anyway, and for an unflattering
second reason: skipping the critic is cheap largely because the critic is finding so little
(precision 0.250, recall 0.022).

**The validation funnel is at parity with a free policy.** The funnel routes 13.5% of fields to a
human and catches 29.9% of all errors. Ranking by confidence alone and reviewing the bottom 13.5%
catches 31.1% — slightly more, at no cost, while the funnel's critic accounts for $3.82 of the
$6.95 bill. The funnel produces evidence spans and reasons a confidence sort can't, so a reviewer
sees *why* a field was flagged. But measured purely on errors caught per dollar, this layer has not
yet earned its cost, and that's worth knowing before scaling it to millions of calls.

**Schema alignment can flatter itself.** Discovered columns are matched to gold by mutual
information, which has a failure mode: a column the extractor reads *badly* carries little
information about the truth, so a purely evidence-based matcher would drop it as unmapped and
report a higher macro F1 the worse extraction got. `disclosure_given` scores 0.061 — far under the
0.2 floor. Exact name identity is checked first and overrides the floor, which is why that row
scores 0.742 on the page instead of quietly not existing.

**Confidence is not the routing signal it looks like.** ECE 0.208, systematically
*under*confident — when the extractor says 0.36 it's right 92% of the time. So the review-budget
curve is reported directly instead: at 20% human review you catch 39.9% of errors and what ships
automatically is 88.8% accurate. That's the number an operations lead can act on.

**`null` and `0` are different.** A column showing `never measured` in the budget table is one
where calibration never got a clean read. Storing that as `0` would claim the critic looked and
found nothing.

Three columns score badly — `sentiment` 0.700, `disclosureGiven` 0.742, `dollarAmount` 0.746 — and
they're on the front of the scorecard. A demo reporting 98% on everything has either solved the
problem or isn't measuring it.

---

## Layout

About 9,100 lines, a fifth of it comments — the reasoning behind a threshold is worth more than the
threshold. `src/config.ts` is the clearest example: every knob in the system in one file, each one
with the argument for its value rather than just the value.

```
src/
  core/       1132   types, tracer, provider seam (llm/anthropic.ts | llm/stub.ts)
  sim/        1706   the simulator — quarantined, so the boundary is visible in the file tree
  corpus/     1399   latent CallFacts -> rendered messy transcripts
  agents/     1166   discovery, extract, validate, activate
  pipeline/   1895   run.ts is the orchestrator (142 lines); the rest is aggregate.ts
                     (statistics) and evaluate.ts (alignment, F1, calibration, fault injection)
  cli/         322   gen-corpus, run-pipeline, run-eval
  config.ts          every threshold in the system, with the argument for each one
web/          1362   React + Vite over the committed artifacts — no server, no API
artifacts/           run.json + eval.json, committed on purpose (see artifacts/README.md)
```

Ground truth exists before the text does: the generator writes `CallFacts`, then renders
transcripts *from* them, so labels cost nothing and can't be contaminated by what the extractor
did. `CallFacts` reaches exactly one function in the codebase, and it's the evaluator.

---

## What this isn't

It isn't a product, it isn't multi-tenant, and there's no database — a real version of this is
Postgres and a queue, not JSON on disk. The corpus is synthetic, so the extractor's difficulty
profile is one I chose, however hard I tried not to make it flattering. Nothing here has met a real
call.

The thing I'd want to find out first with a key and a day: whether the critic's recall stays at
0.022 against a real model, because if it does, the honest move is to delete that layer and spend
the budget on human review instead.

---

Built for the voiceops Founding AI Engineer posting. TypeScript end to end, no agent framework —
the orchestration is `src/pipeline/run.ts`, 142 lines of ordinary code, because a four-stage
pipeline with a concurrency limit does not need a framework and is much easier to instrument
without one.

— Ishaan Potle
