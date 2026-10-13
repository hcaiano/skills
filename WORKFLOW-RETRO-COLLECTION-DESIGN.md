# Workflow retro collection design

Status: discovery complete; implementation deferred under the brief's scope gate.
Base: `4a174e11cee06e82a18724e8eed32e61cdc04bc9` on `origin/main`.

## Why implementation stopped

`/tmp/impl-briefs/common.md` requires a design note when the task exceeds
600 changed lines or introduces a new subsystem. The five inspected collection,
pagination, splitting, and database scripts already total 427 lines. Those
scripts lack the requested maintained tests, shared output contract, complete
nested GitHub pagination, and some required secret handling.

The estimated replacement is 750–1,050 lines, including tests and instructions.
This is a sizing estimate, not a measured implementation. Compressing it below
600 lines would hide the boundary cases that motivated the task.

No collector was implemented, no installed skill was changed, and no PR was
opened. The requested 24-hour collector dry run remains outstanding.

## Verified source contracts

Discovery ran on 2026-10-13 with read-only database connections and metadata-only
provider samples. Output contained schema, field names, and counts, not message
contents or credentials.

- PC Node `v24.21.0` and Mac `/opt/homebrew/bin/node` `v26.10.0` both support
  `node:sqlite`. Both opened `file:<home>/.t3/userdata/statev2.sqlite?mode=ro`
  with `{ readOnly: true }` and exposed the required projection tables.
- Claude records have top-level ISO `timestamp` and `sessionId` fields. Codex
  records have top-level ISO `timestamp` and structured `payload` fields.
- Grok `updates.jsonl` records have numeric `timestamp`, `method`, and `params`.
  `chat_history.jsonl` is context, not evidence of activity inside the window.
- A sampled Cursor `chats/**/meta.json` contains `createdAtMs`, `updatedAtMs`,
  and `hasConversation: false`. That sample is a probe.
- `orchestration_v2_projection_threads` has `thread_id`, `payload_json`, and
  thread metadata. The inspected payloads do not expose `parentThreadId` as
  a top-level key, even when that string occurs elsewhere in the payload.
- `orchestration_v2_projection_subagents` provides `thread_id` and
  `child_thread_id`. Build parent chains from those edges. Keep `lineage` and
  `forkedFrom` separately so a fork does not become a delegated child.
- Activity is in `messages.created_at`, turn-item payload timestamps, run
  timestamps, and error items. Thread `updated_at` is not an activity test.
- Run statuses are in `runs`; attempt details are in `run_attempts`. Error
  items and relevant node payloads must accompany failed runs.
- `provider_threads.payload_json` contains `nativeThreadRef` and
  `appThreadId`, which connect provider transcripts to app threads.
- `scheduled_tasks` contains `webhook_token` and `webhook_secret`. Exclude
  these columns from the query, then redact the remaining fields.

A PC discovery query for `[2026-10-12T12:44:35.177Z,
2026-10-13T12:44:35.177Z)` counted 7,455 message rows across 446 threads,
59,723 updated turn-item rows across 448 threads, and 1,266 requested runs
across 435 threads. There were eight scheduled tasks. These counts are source
inventories, not a complete extraction or a measurement of collector speed.

## Proposed files and output contract

Place maintained code directly in `skills/workflow-retro/scripts/`:

| File | Responsibility | Estimated lines |
| --- | --- | --- |
| `io.mjs` | CLI arguments, timestamps, redaction, bounded parts, index | 130–180 |
| `collect-sessions.mjs` | Provider traversal, event filtering, context, parent metadata | 150–210 |
| `collect-t3.mjs` | Read-only activity, lineage, runs, errors, native mapping | 100–140 |
| `list-scheduled-tasks.mjs` | Read-only allowlisted task inventory | 25–40 |
| `collect-prs.mjs` | URL discovery and paginated GitHub collection | 120–170 |
| `collection.test.mjs` | Public CLI tests with temporary fixtures | 180–240 |
| Skill instructions and command reference | PC and Mac commands, reporting contract | 45–70 |

Each collector accepts `--machine`, `--out`, and explicit UTC `--from` and
`--to` where a window applies. Provider collection accepts `--home`; database
commands accept `--db`. Use these same public options for fixture tests.

Each output directory contains numbered JSONL parts and `index.json`. An event
envelope contains `machine`, `source`, `sessionId` or `threadId`, source path,
line number or database row ID, timestamp, `kind`, and redacted `raw` data.
Keep original tool names, structured arguments, and results inside `raw`.
The index lists part byte counts, per-session activity and context counts,
parent references, PR URLs, source availability, and gaps.

Use exclusive output-directory creation and private permissions. A rerun uses
a new directory so stale parts cannot appear in a fresh index. Publish the
completion index only after all streams close successfully. A partial run
retains its gap receipt and returns a nonzero status.

## Implementation rules

1. Traverse with Node filesystem APIs. Use mtime only as a lower-bound
   candidate filter: a file modified after `--to` can still contain events in
   the window. Compare parsed instants using `from <= timestamp < to`.
2. Stream JSONL one record at a time, with file and output backpressure.
   Parse individual records, never an entire transcript. Record malformed
   lines, missing timestamps, unreadable sources, and missing Cursor timelines
   as explicit gaps. Count a Cursor conversation only when its metadata says
   `hasConversation: true`.
3. Select Grok sessions through `updates.jsonl`. Stream history into separate
   `context` envelopes only for selected sessions. Context contributes no
   window action counts or evidence-backed PR discovery.
4. Group Claude `subagents/<agent>.jsonl` with their enclosing parent session.
   Resolve cross-provider parent chains through T3 subagent and native mapping
   records. Emit unresolved or cyclic lineage as a gap, never an inferred root.
5. Redact recursively before serialization. Cover sensitive object keys,
   credential assignments in tool strings, bearer headers, known API-token
   prefixes, URL passwords, and multiline private keys. Redact JSON-encoded
   argument strings as well. Test short passwords and escaped key newlines.
6. Bound parts to 50 MiB by serialized UTF-8 bytes, including delimiters. When
   one redacted record exceeds that limit, emit numbered fragment envelopes
   with a shared record ID. Reassembly must restore the exact redacted record.
   Split after redaction so a secret cannot straddle redaction boundaries.
7. Read each database inside a read transaction with `readOnly: true` and
   `PRAGMA query_only=ON`. Iterate prepared statements. Validate required
   tables and columns before output. Parse payload timestamp instants instead
   of relying on string ordering across timezone formats. Inspect query plans
   before introducing SQL timestamp filters that might exclude valid rows.
8. Select threads through message, item, and run activity. Include ancestor
   metadata and runs spanning the window. An ongoing run that started earlier
   belongs in the inventory without inventing a new in-window event. Include
   attempts, statuses, and errors without loading every payload into memory.
9. Read PR URLs from completed indexes and streamed activity extracts. Deduplicate
   canonical URLs and preserve machine and session provenance. Through `gh`,
   fetch the PR body, all review pages, all review-thread pages, each thread's
   comment pages, and head-commit checks and statuses. Paginate nested
   connections independently. Emit each page immediately; report HTTP and
   GraphQL errors with a nonzero exit status. A partial PR is a source gap.
10. List scheduled tasks through an explicit column allowlist. Preserve title,
    prompt, schedule, bound thread, enabled state, recent status, and errors.
    Collection remains read-only and leaves every task unchanged.

## Delivery units and verification

Blocking work is the shared envelope, redaction, fragmentation, and index
contract. Once frozen, provider and database readers have separate files and
output directories. PR collection consumes their indexes. One owner integrates
the skill instructions after all collectors pass. No shared live output writer
is needed.

1. Deliver shared I/O and provider collection. Test window edges, numeric and
   ISO timestamps, mtime after the upper bound, Claude children, Cursor probes,
   Grok context separation, redaction, and exact fragment reassembly. Run the
   real CLI on a generated transcript larger than a constrained Node heap so
   a whole-file implementation fails while the streaming implementation passes.
2. Deliver T3 and scheduled-task collection. Use a temporary SQLite fixture
   with restarted thread metadata, child chains, forks, failed attempts, errors,
   old ongoing runs, and webhook secrets. Assert emitted records and absence
   of credentials. Verify the database contents remain unchanged.
3. Deliver PR collection. Exercise the public CLI with a fixture `gh` executable
   on `PATH`. Require multiple pages at every nested connection, GraphQL-error
   handling, deduplication, and per-page output. Compare one live PR with `gh`
   independently before claiming remote completeness.
4. Update the skill and run a real 24-hour PC collection under `/tmp` through
   `agent-run heavy`. Read back indexes, check every part's size, and report
   provider sessions, events, T3 threads and runs, tasks, PRs, and all gaps.
   Run the same scripts over `ssh mbp` with `/opt/homebrew/bin/node` before
   claiming Mac collection works.

Keep step 1's exact PC and Mac commands in a linked command reference. Keep
`SKILL.md` short. `REPORT.md` leads with merged fixes and ranked proposals,
then one coverage line. `LIMITS.md` contains source gaps and unrecovered reads.
Advance `last-run` only after both hosts and required sources have complete
receipts. Exclude earlier retro runs at the judgment stage with explicit
session IDs, rather than deleting their raw collection evidence.

## Remaining decisions

The implementation must confirm Cursor transcript locations on both hosts,
Grok numeric timestamp units, database timestamp normalization, and lineage
differences across both schemas. The discovery samples establish field shapes,
not exhaustive provider compatibility. No performance improvement, full source
coverage, test acceptance, or production behavior is claimed by this note.
