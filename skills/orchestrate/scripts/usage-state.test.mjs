import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "usage-state.mjs");

test("a one-record Codex session keeps its first JSONL record", () => {
  const home = mkdtempSync(join(tmpdir(), "orchestrate-usage-state-"));
  const sessions = join(home, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  const now = Date.now();
  writeFileSync(join(sessions, "one.jsonl"), `${JSON.stringify({
    timestamp: new Date(now).toISOString(),
    payload: {
      rate_limits: {
        limit_id: "codex",
        primary: {
          used_percent: 33,
          window_minutes: 10080,
          resets_at: (now + 72 * 60 * 60 * 1000) / 1000,
        },
      },
    },
  })}\n`);
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USAGE_STATE_SKIP_CURSOR: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.codex.used_percent, 33);
  assert.equal(output.codex.short_window, null);
  assert.equal(output.cursor, null);
});

test("Cursor native usage reports its two monthly pools", () => {
  const home = mkdtempSync(join(tmpdir(), "orchestrate-cursor-usage-"));
  const bin = join(home, "cursor-agent");
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + 20);
  const reset = next.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  writeFileSync(bin, `#!/bin/sh
printf 'Usage • Ultra  Resets ${reset}\\nIncluded 19%% used\\n  Auto 5%% used\\n  API 74%% used\\n'
`);
  chmodSync(bin, 0o755);
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, CURSOR_AGENT_BIN: bin },
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.cursor.cursor_models.used_percent, 5);
  assert.equal(output.cursor.other_models.used_percent, 74);
  assert.equal(output.cursor.resets_on, reset);
  assert.equal(output.cursor.stale_minutes, 0);
});
