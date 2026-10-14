# Payment problem classifier — run order

Per thread of a payment conversation the pipeline answers three things: which payment it
was about (or NOT_FOUND), what actually happened to the customer, and what would have
removed the problem. Categories are induced afterwards from the readings, never declared
up front.

Every script that spends tokens prints its plan and stops. Nothing reaches the proxy
without `--go`. Models and transport come from `services/problem-classifier/config.ts`;
no script names a model or a URL.

| env key | default | what it does |
| --- | --- | --- |
| `PC_MODEL_EXTRACT` | `claude-haiku-4-5` | pass 1a |
| `PC_MODEL_PICK` | `claude-haiku-4-5` | pass 1b |
| `PC_MODEL_READ` | `claude-opus-4-8` | pass 2 |
| `PC_MODEL_INDUCE` | `claude-opus-4-8` | pass 3's induce call |
| `PC_MODEL_ASSIGN` | follows `PC_MODEL_INDUCE` | pass 3 two-step's assign calls |
| `PC_LLM_PROVIDER` | `VERTEX_AI` | anna-llm-proxy `LLMProvider` |
| `PC_LLM_BASE_URL` | unset | the proxy this tool alone talks to, overriding `LLM_API_BASE_URL` |
| `PC_LLM_STREAM` | `0` | `1` sends every call over `/api/chat/stream`, which the proxy refuses for Claude; anything else uses buffered `/api/chat` |
| `PC_CONCURRENCY` | `3` | calls in flight a pass: pass 1 and pass 2 per thread, pass 3 per assign batch. The stage proxy tolerates 6 |
| `PC_INDUCE_SAMPLE` | `400` | the most readings one pass-3 induce call is sent (see below) |

Both counts are refused rather than clamped when they are not positive integers, and
they are read at import, so a bad value fails before a plan is printed.

### If the stage proxy times out

The stage proxy enforces `REQUEST_TIMEOUT=60` s on the buffered `/api/chat`, which a
pass-2 Opus call or a pass-3 induction will exceed. Two ways out:

1. Set `PC_LLM_BASE_URL` to the production proxy
   (`https://llm-proxy.k1.anna.money`) and leave the rest of the repo's LLM config
   alone.
2. Use pass 3's `--mode two-step` (the default), so no single call is large enough to be
   the one that times out.

Streaming is **not** a way out. `PC_LLM_STREAM=1` points calls at `/api/chat/stream`,
which the 60 s timeout does not govern — but the proxy cannot stream Claude at all and
answers every such call `400 {"error":{"code":4,"message":"Streaming is not supported by
AnthropicSDKAdapter"}}`. Hence the `0` default. It is worth trying again only once the
proxy gains support; until then the runner catches that 400 on the first call, warns
once, and uses the buffered client for the rest of the process.

Which transport a call used is on its `llm-calls.ndjson` line as
`transport: "stream"|"buffered"|"buffered(fallback)"` — the last meaning streaming was
asked for and refused — so a sweep's timeouts can be read back to an endpoint.

Run from the repo root. The pilot snapshot is `pilot-2026-08-19` (122 threads).

## 1 · snapshot the population (BigQuery, no LLM)

```bash
npx tsx packages/backend/src/scripts/pc-snapshot-population.ts \
  --from 2026-08-19 --to 2026-08-19 --name pilot-2026-08-19
```

Already done for the pilot. The selector's source tables are rewritten daily, so
nothing downstream may re-run it — every pass reads `population.json`.

`--leaves` picks which scenario leaves the population is drawn from. It takes a set name
or, for a one-off cut, a comma-separated list of full path keys, which the manifest then
records as `custom`. The sets live in `services/problem-classifier/population.ts`.

| set | leaves | the question |
| --- | --- | --- |
| `money-not-arrived` (default) | missing or failed incoming, incoming pending, outgoing pending | the customer is waiting for money |
| `declines` | blocked or declined outgoing, card declined, blocked or declined card payment, card not working | the customer was told no |

One run, one set: two sets at once are refused rather than merged. Mixing waiting with
refusal multiplies the pass-2 bill and induces categories that answer neither question
cleanly. To ask a question that spans both, pass the path keys explicitly and say so in
the snapshot name.

## 2 · build the bundles (BigQuery, no LLM)

```bash
npx tsx packages/backend/src/scripts/pc-build-bundles.ts --snapshot pilot-2026-08-19
```

## 3 · measure the real prompt sizes

```bash
npx tsx packages/backend/src/scripts/pc-measure-tokens.ts --snapshot pilot-2026-08-19 --n 20
npx tsx packages/backend/src/scripts/pc-measure-tokens.ts --snapshot pilot-2026-08-19 --n 20 --go
```

## 4 · pass 1 twice on the same 20 threads, then compare

Stability check: the same threads under two run labels. `--n 20` takes the first 20
threads in `population.json` order — a seeded shuffle, so the first 20 are a random
sample and must not be re-sorted.

```bash
npx tsx packages/backend/src/scripts/pc-pass1.ts --snapshot pilot-2026-08-19 --run stab1 --n 20
npx tsx packages/backend/src/scripts/pc-pass1.ts --snapshot pilot-2026-08-19 --run stab1 --n 20 --go

npx tsx packages/backend/src/scripts/pc-pass1.ts --snapshot pilot-2026-08-19 --run stab2 --n 20
npx tsx packages/backend/src/scripts/pc-pass1.ts --snapshot pilot-2026-08-19 --run stab2 --n 20 --go

npx tsx packages/backend/src/scripts/pc-compare-pass1.ts \
  --snapshot pilot-2026-08-19 --run-a stab1 --run-b stab2
```

`--n` and `--threads` are alternatives; passing both is an error. The same `--n` works
on `pc-pass2.ts`. To name the ids instead — to re-run the exact threads a previous run
covered, say — list them:

```bash
THREADS=$(python3 -c "import json;print(','.join(t['thread_id'] for t in json.load(open('packages/backend/data/problem-classifier/pilot-2026-08-19/population.json'))['threads'][:20]))")
npx tsx packages/backend/src/scripts/pc-pass1.ts --snapshot pilot-2026-08-19 --run stab1 --threads "$THREADS"
```

`pc-compare-pass1.ts` makes no calls and needs no `--go`.

## 5 · pass 1 over the whole snapshot

```bash
npx tsx packages/backend/src/scripts/pc-pass1.ts --snapshot pilot-2026-08-19 --run r1
npx tsx packages/backend/src/scripts/pc-pass1.ts --snapshot pilot-2026-08-19 --run r1 --go
```

Resumable: a thread with a result file is skipped, so re-running finishes what a
timeout left behind. `--force` re-runs and re-spends.

`--pass1-mode` picks how the shortlist is reached. `regex-first` (the default) builds the
extraction with regexes — UUIDs in the message and task text, money figures the customer
or an automated task wrote — shortlists from it and goes straight to `pick`. `extract` is
paid for only when there is nothing to shortlist or `pick` answers NOT_FOUND, and its
answer is then merged over the regex one. On the 122-thread pilot that plans 115 `pick`
calls and a ceiling of 122 `extract` calls, against 244 for `extract-always` — the original
one-`extract`-a-thread flow, kept for the A/B. Every result file records the branch it took
in `pass1_path`.

## 6 · pass 2 over the whole snapshot

```bash
npx tsx packages/backend/src/scripts/pc-pass2.ts --snapshot pilot-2026-08-19 --run r1
npx tsx packages/backend/src/scripts/pc-pass2.ts --snapshot pilot-2026-08-19 --run r1 --go
```

Refuses to start unless every selected thread has a pass-1 result, and names the missing
ones. Every thread is read, NOT_FOUND and empty-bundle threads included.

## 7 · pass 3 twice, then compare

`--mode two-step` is the default. It splits the induction into one induce call that
returns definitions and no member lists, then assign calls of 25 readings each that
place every thread against that set — so no single call is large enough to be the one
that times out. `--mode one-call` is the original single 16k-token answer, kept because
the earlier inductions were produced with it.

```bash
npx tsx packages/backend/src/scripts/pc-pass3.ts --snapshot pilot-2026-08-19 --run r1 --label a
npx tsx packages/backend/src/scripts/pc-pass3.ts --snapshot pilot-2026-08-19 --run r1 --label a --go

npx tsx packages/backend/src/scripts/pc-pass3.ts --snapshot pilot-2026-08-19 --run r1 --label b
npx tsx packages/backend/src/scripts/pc-pass3.ts --snapshot pilot-2026-08-19 --run r1 --label b --go

npx tsx packages/backend/src/scripts/pc-compare-pass3.ts \
  --snapshot pilot-2026-08-19 --run r1 --label-a a --label-b b
```

The two-step plan prints both calls' sizes: the induce call's chars and estimated input
tokens, then the assign calls' chars sum, p50 and max. The assign figures are an upper
bound — the category block does not exist until induce returns, so it is counted at the
induce call's `max_tokens` in chars.

### Snapshots too large for one induce call

Over `PC_INDUCE_SAMPLE` readings (default 400) one induce call no longer fits
comfortably, so two-step mode induces the categories from a seeded random sample of
that many and **still assigns every reading** in batches. The draw is a shuffle seeded
with the snapshot manifest's own `seed`, so it is the same sample on every run of that
snapshot, and it is recorded as `induce_sample: { size, seed, thread_ids }` in
`pass3/<label>.json`. The plan says so:

```
induce over 400 of 1,547 readings (seeded sample)
```

Below the threshold nothing changes and no `induce_sample` is written. `--mode one-call`
refuses over the same line instead of sampling: it induces and assigns in one answer, so
a sampled input cannot produce the assignment it is asked for.

A thread that comes back with no line, or with a category number that is not in the
set, is retried once on its own; if it still has no valid line it lands in `unassigned`
with the reason `no valid assignment returned`.

Refuses unless pass 2 is complete for every thread in the snapshot. Refuses to
overwrite an existing induction label. `pc-compare-pass3.ts` makes no calls.

## 8 · report

```bash
npx tsx packages/backend/src/scripts/pc-report.ts --snapshot pilot-2026-08-19 --run r1 --label a
```

Makes no calls, so it has no `--go`. It is the only script that prints a count, and it
prints none for a pass that is not complete over the whole snapshot.

## One thing to render a single thread by hand

```bash
npx tsx packages/backend/src/scripts/pc-render.ts \
  --snapshot pilot-2026-08-19 --thread 316251792 --stage extract
```

## Where things land

```
data/problem-classifier/<snapshot>/
  population.json                     the snapshot (never re-derive it)
  bundles/<thread_id>.json
  runs/<run>/pass1/<thread_id>.json   extraction, regex_extraction, pass1_path, shortlist,
                                      pick, state, identified
  runs/<run>/pass2/<thread_id>.json   the reading, prose only
  runs/<run>/pass3/<label>.json       categories + assignment, mode, raw.{induce,assign},
                                      induce_sample when induce saw a sample
  runs/<run>/llm-calls.ndjson         one line per LLM attempt, failures included
```

## Prompts

Loaded by id through `services/prompts.ts`; a new version is a new file and a new id,
never an edit in place. All live in `packages/backend/src/prompts/`.

| prompt | used by |
| --- | --- |
| `pc-extract-v2.md` | pass 1a — v1 plus the card clauses: a merchant is a counterparty, and a refused card payment is a payment rather than a card query |
| `pc-extract-v1.md` | superseded; kept because the earlier extractions were produced with it |
| `pc-pick-v2.md` | pass 1b — v1 plus the refusal clause: a declined record outranks a processed one, and proximity alone is a fair answer on a refusal given by merchant and day |
| `pc-pick-v1.md` | superseded; kept because the earlier picks were produced with it |
| `pc-read-v3.md` | pass 2 — v2 plus the card restatement (merchant and authorisation in place of a rail) and the refusal paragraph: the stated reason, who refused it, and a plain statement when the record holds neither |
| `pc-read-v2.md` | superseded; v1 plus the paragraph that lets the reader disown the identified payment, which pass 1 picks automatically and can get wrong |
| `pc-read-v1.md` | superseded; kept because the earlier readings were produced with it |
| `pc-induce-v3.md` | pass 3 `--mode two-step`, the induce call — definitions and example ids, no member lists. v2 plus the paragraph that stops a politely handled conversation reading as no problem |
| `pc-induce-v2.md` | superseded; kept because the earlier two-step inductions were produced with it |
| `pc-assign-v1.md` | pass 3 `--mode two-step`, the assign calls |
| `pc-induce-v1.md` | pass 3 `--mode one-call` |
