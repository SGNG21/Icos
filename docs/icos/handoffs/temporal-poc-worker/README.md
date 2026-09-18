# temporal-poc worker — Phase 6.1 snapshot

The Temporal worker lives outside this repository (`~/temporal-poc`, not under git).
Files are stored as `.ts.txt` so they are not compiled by ICOS. This folder is a **reference snapshot** of the files changed in Phase 6.1, kept here for
traceability. Source of truth at runtime: `~/temporal-poc/src`.

## What changed
`hermes -z` exits with code 0 and prints the provider error on stdout when an API call
fails (e.g. `API call failed after 3 retries: Stream ended before producing a non-ping SSE
event`). The worker used to report that text as a successful result.

- `hermes-run.ts.txt` — `classifyHermesRun(stdout, usage)`: success only when the structured
  status written by `hermes --usage-file` says `completed === true && failed === false`.
  stdout wording is never used to decide (no string list). Missing/unreadable status fails
  closed.
- `activities.ts.txt` — `greet` passes `--usage-file <tmp>` and throws on a failed run, so the
  workflow calls `reportFailure` (never `reportSuccess`).
- Tests (mocha, `npx mocha --exit --require ts-node/register src/mocha/hermes-run.test.ts src/mocha/greet-hermes.test.ts`):
  the classifier, and `greet` against a fake `hermes` binary that exits 0 with error text.

Restart the worker after changing these files (`ts-node src/worker.ts` in `~/temporal-poc`).
