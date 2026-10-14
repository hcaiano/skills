# JSONL record size calibration

Measured on PC and Mac for file mtimes in
`[2026-10-06T17:08:05.000Z, 2026-10-13T17:08:05.000Z)`.
The scan reads all nonempty JSONL lines in matching Codex, Claude and Grok
files, including old events and untimestamped context. It counts bytes without
parsing JSON or writing log content. CRLF terminators do not count. Both scans
completed with exit 0 and no read errors. This is the pre-filter input population,
not a count of timestamped activity or valid tool results.

All sizes below are bytes. Percentiles use the nearest rank.

| Host | Provider | Files | Records | p50 | p90 | p95 | p99 | p99.9 | Maximum | Above 2 MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PC | Codex | 1551 | 741576 | 1011 | 12800 | 29467 | 66262 | 675807 | 21470768 | 346 |
| PC | Claude | 484 | 200228 | 799 | 5155 | 11847 | 59379 | 736129 | 1399869 | 0 |
| PC | Grok | 1081 | 1347890 | 86 | 420 | 1102 | 10854 | 52960 | 1148671 | 0 |
| Mac | Codex | 372 | 183417 | 1094 | 21696 | 44276 | 117871 | 890829 | 18007552 | 61 |
| Mac | Claude | 115 | 53386 | 944 | 6176 | 15640 | 247995 | 1112880 | 1424963 | 0 |
| Mac | Grok | 180 | 245679 | 86 | 117 | 926 | 11047 | 64223 | 835718 | 0 |
| PC | All | 3116 | 2289694 | 87 | 3827 | 9716 | 43884 | 249408 | 21470768 | 346 |
| Mac | All | 667 | 482482 | 395 | 6260 | 18316 | 72338 | 712515 | 18007552 | 61 |

The 1 MiB cap retains 99.848275% of Mac Claude records, below the 99.9%
target. The smallest tested power-of-two cap meeting the target for every
host/provider is 2 MiB. It retains 99.953343% of PC Codex and 99.966742% of
Mac Codex records, and 100% for Claude and Grok on both hosts. Combined retention
is 99.984889% on PC and 99.987357% on Mac. It admits 465 more records than 1 MiB.

The JSONL reader allocates one buffer of `record-bytes + 1` per file and reads
64 KiB chunks. With the default, that buffer is 2,097,153 bytes. Parsing, redaction,
and output encoding need additional memory proportional to the admitted record;
the cap is not a total RSS limit. Lines above it are counted without buffering
their remaining content and produce explicit byte-offset gaps before time
filtering. `--record-bytes` changes this cap independently of `--part-bytes`.

Reproduce with the same window, or replace both bounds for a fresh calibration:

```bash
agent-run task -- node skills/workflow-retro/scripts/measure-record-sizes.mjs 2026-10-06T17:08:05.000Z 2026-10-13T17:08:05.000Z
agent-run task -- ssh mbp /opt/homebrew/bin/node --input-type=module - 2026-10-06T17:08:05.000Z 2026-10-13T17:08:05.000Z < skills/workflow-retro/scripts/measure-record-sizes.mjs
```

The scan fixes each file's end offset when it opens the file. Concurrent writes
can change the population on a later run. Its size histograms contain only
numeric lengths and counts; memory follows the number of distinct lengths.
