# Review — PR #42: Refactor the ingestion pipeline

> Add your comments inline (as a `- [ ]` item under the relevant section) — I'm watching this file and will reply.
> My replies start with a checkbox — tick it when read; your tick without a follow-up closes the thread.

## 🤖 Task log

- [x] Read the diff and summarise the approach
- [x] Answer the batching question *(thread under Design notes)*
- [ ] Benchmark the new parser against the previous release

## Summary

The pull request replaces the line-by-line ingestion loop with a chunked
reader that parses records in batches of 512. Error handling moves from
per-line `try/catch` to a collecting validator that reports all failures at
the end of a batch. The change is well isolated: only `ingest/reader.go` and
its tests are touched.

- [x] Alice (2026-09-02 09:14): **Batch size rationale** <!--thread-->
  Why 512? Feels arbitrary — did we measure this, or is it a guess?

  - 🤖 Agent (2026-09-02 09:31): Measured, though thinly: 256 and 1024 were within 3% of each other on the sample corpus, and 512 sat in the middle. The constant is isolated in `batchSize` with a comment, so tuning it later is a one-line change. I'd call it a defensible default rather than a magic number, but adding the benchmark output to the PR description would make that visible — noted as a task.

## Design notes

The collecting validator changes error semantics: previously the first bad
record aborted the file, now the whole batch is read and all problems are
reported together. Downstream consumers see either a fully ingested batch or
none of it.

- [ ] Alice (2026-09-02 09:48): Is the all-or-nothing batch behaviour safe when a file is appended to while we read it? <!--thread-->

  - 🤖 Agent (2026-09-02 09:55): Good catch — partially. The reader takes the file size at open and never reads past it, so an append during ingestion is simply picked up on the next run. The unsafe case is a writer that rewrites the file in place (truncate + write); for that we rely on the same retry-on-checksum-mismatch loop the old code used. I'll add a test that simulates the rewrite case.

## Tests

Coverage is good on the happy path: batch boundaries, empty files, and the
validator's error aggregation are all exercised. The rewrite-during-read
scenario mentioned above is missing, and the benchmark referenced in the
summary is not committed.

## Findings

### 1. [Suggestion] Surface partial-batch metrics

The reader silently drops incomplete trailing records. That is correct, but a
counter would make the behaviour observable instead of implicit.

- [x] Alice (2026-09-02 10:02): Agreed, and let's expose it on the existing metrics endpoint rather than a log line. <!--thread-->

  - 🤖 Agent (2026-09-02 10:06): Done in the follow-up branch — `ingest_partial_records_total`, labelled by source file. The metrics endpoint already existed, so it is a four-line change. <!--seen:Alice-->

### 2. [Nit] `batchSize` doc comment

The comment explains *what* the constant is, not *why* it is 512 — link the
benchmark once it lands.

## Conclusion

**Approve with suggestions** — the refactor is clean and the semantics change
is deliberate. File the rewrite-case test before merge; the rest can follow.
