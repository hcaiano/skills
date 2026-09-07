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

test("Codex homes have separate usage and stale headroom is not recommended", () => {
  const taskHome = mkdtempSync(join(tmpdir(), "orchestrate-identities-"));
  const snapshot = (home, used, ageMinutes) => {
    const sessions = join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "quota.jsonl"), JSON.stringify({
      timestamp: new Date(Date.now() - ageMinutes * 60000).toISOString(),
      payload: { rate_limits: { limit_id: "codex", primary: {
        used_percent: used, window_minutes: 10080,
        resets_at: Date.now() / 1000 + 72 * 3600,
      } } },
    }) + "\n");
  };
  snapshot(join(taskHome, ".codex"), 95, 0);
  snapshot(join(taskHome, ".codex-profiles", "second"), 10, 0);
  snapshot(join(taskHome, ".codex-profiles", "old"), 0, 360);
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8", env: { ...process.env, HOME: taskHome, USAGE_STATE_SKIP_CURSOR: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.codex.used_percent, 95);
  assert.equal(output.codex_identities.default.state, "unavailable");
  assert.equal(output.codex_identities.second.pool.used_percent, 10);
  assert.equal(output.codex_identities.old.state, "unknown");
  assert.equal(output.recommended_codex_identity, "second");
});

test("live quota stays bound to each Codex home and a failed read is unknown", () => {
  const taskHome = mkdtempSync(join(tmpdir(), "orchestrate-live-identities-"));
  for (const dir of [join(taskHome, ".codex"), join(taskHome, ".codex-profiles", "second")]) {
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "recent.jsonl"), JSON.stringify({
      timestamp: new Date().toISOString(), payload: {rate_limits: {limit_id:"codex",primary:{
        used_percent:5,window_minutes:10080,resets_at:Date.now()/1000+72*3600,
      }}},
    }) + "\n");
  }
  const binary = join(taskHome, "codex-fixture");
  writeFileSync(binary, `#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line', line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='account/rateLimits/read') {
  if(process.env.FAKE_RPC_ERROR==='1') return console.log(JSON.stringify({id:m.id,error:{message:'offline'}}));
  const second=process.env.CODEX_HOME.endsWith('second');
  console.log(JSON.stringify({id:m.id,result:{rateLimitsByLimitId:{codex:{limitId:'codex',
   primary:{usedPercent:second?4:95,windowDurationMins:300,resetsAt:Date.now()/1000+3600},
   secondary:{usedPercent:second?35:20,windowDurationMins:10080,resetsAt:Date.now()/1000+72*3600}
  }}}}));
 }
});
`);
  chmodSync(binary, 0o755);
  const env = {...process.env, HOME:taskHome, CODEX_BIN:binary, USAGE_STATE_SKIP_CURSOR:"1"};
  const result = spawnSync(process.execPath, [script,"--live"], {encoding:"utf8",env,timeout:10000});
  assert.equal(result.status, 0, result.stderr);
  const output=JSON.parse(result.stdout);
  assert.equal(output.codex_identities.default.state,"unavailable");
  assert.equal(output.codex_identities.second.pool.used_percent,35);
  assert.equal(output.codex_identities.second.source,"account/rateLimits/read");
  assert.equal(output.recommended_codex_identity,"second");
  const failed=spawnSync(process.execPath,[script,"--live"],{
    encoding:"utf8",env:{...env,FAKE_RPC_ERROR:"1"},timeout:10000,
  });
  assert.equal(failed.status,0,failed.stderr);
  const unknown=JSON.parse(failed.stdout);
  assert.equal(unknown.codex_identities.second.state,"unknown");
  assert.equal(unknown.recommended_codex_identity,null);
});
