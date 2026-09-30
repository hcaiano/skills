import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "usage-state.mjs");

test("rejects conflicting live and offline flags", () => {
  const result = spawnSync(process.execPath, [script, "--live", "--offline"], {
    encoding: "utf8", env: { ...process.env, USAGE_STATE_SKIP_CURSOR: "1" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: usage-state\.mjs \[--offline\]/u);
});

test("a one-record Codex session keeps its first JSONL record", () => {
  const home = mkdtempSync(join(tmpdir(), "pair-usage-state-"));
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
  const result = spawnSync(process.execPath, [script, "--offline"], {
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
    env: { ...process.env, HOME: home, CURSOR_AGENT_BIN: bin, CODEX_BIN: join(home, "no-codex"), CLAUDE_USAGE_URL: "http://127.0.0.1:9/" },
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.cursor.cursor_models.used_percent, 5);
  assert.equal(output.cursor.other_models.used_percent, 74);
  assert.equal(output.cursor.resets_on, reset);
  assert.equal(output.cursor.stale_minutes, 0);
});

test("states classifies every pool with one rule set", () => {
  const home = mkdtempSync(join(tmpdir(), "pair-usage-states-"));
  const now = Date.now() / 1000;
  // 60% spent with 72 of 168 hours left burns faster than the rest can fund.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "usage-state.json"), JSON.stringify({
    written_at: now,
    rate_limits: { seven_day: { used_percentage: 60, resets_at: now + 72 * 3600 } },
  }));
  const bin = join(home, "cursor-agent");
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + 20);
  const reset = next.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  writeFileSync(bin, `#!/bin/sh
printf 'Usage • Ultra  Resets ${reset}\\n  Auto 5%% used\\n  API 95%% used\\n'
`);
  chmodSync(bin, 0o755);
  const env = { ...process.env, HOME: home, CURSOR_AGENT_BIN: bin, CODEX_BIN: join(home, "no-codex"), CLAUDE_USAGE_URL: "http://127.0.0.1:9/" };
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  // Offline never runs Cursor's /usage: its pools read unknown.
  const offline = JSON.parse(spawnSync(process.execPath, [script, "--offline"], { encoding: "utf8", env, timeout: 10000 }).stdout);
  assert.equal(offline.cursor, null);
  assert.equal(offline.states.cursor_models, "unknown");
  assert.deepEqual(JSON.parse(result.stdout).states, {
    claude: "protected",
    codex: "unknown",
    cursor_models: "available",
    other_models: "unavailable",
  });
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
  const result = spawnSync(process.execPath, [script, "--offline"], {
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
  const env = {...process.env, HOME:taskHome, CODEX_BIN:binary, USAGE_STATE_SKIP_CURSOR:"1",
    CLAUDE_USAGE_URL:"http://127.0.0.1:9/"};
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

test("live Claude usage outranks the statusline snapshot, and a failed read is unknown", async () => {
  const home = mkdtempSync(join(tmpdir(), "pair-claude-live-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const now = Date.now() / 1000;
  // A fresh snapshot of a cool pool: alone it would read available.
  writeFileSync(join(home, ".claude", "usage-state.json"), JSON.stringify({
    written_at: now,
    rate_limits: { seven_day: { used_percentage: 10, resets_at: now + 100 * 3600 } },
  }));
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "fixture-token" },
  }));
  let status = 200;
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({
      five_hour: { utilization: 31, resets_at: new Date((now + 2 * 3600) * 1000).toISOString() },
      seven_day: { utilization: 64, resets_at: new Date((now + 134 * 3600) * 1000).toISOString() },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--live"], { env: {
      ...process.env, HOME: home, USAGE_STATE_SKIP_CURSOR: "1",
      CLAUDE_USAGE_URL: `http://127.0.0.1:${server.address().port}/`,
    } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
  });
  try {
    const fresh = await run();
    assert.equal(seen[0], "Bearer fixture-token");
    assert.equal(fresh.claude_source, "oauth/usage");
    assert.equal(fresh.claude.used_percent, 64);
    assert.equal(fresh.claude.short_window.used_percent, 31);
    // 64% after 34 of 168 hours burns far faster than the rest can fund.
    assert.equal(fresh.states.claude, "protected");
    status = 401;
    const failed = await run();
    assert.equal(failed.claude_source, "statusline");
    assert.match(failed.claude_error, /401/u);
    assert.equal(failed.states.claude, "unknown");
  } finally {
    server.close();
  }
});

test("Codex homes sharing one sessions folder prove no account without --live", () => {
  const taskHome = mkdtempSync(join(tmpdir(), "pair-shared-sessions-"));
  const sessions = join(taskHome, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "quota.jsonl"), JSON.stringify({
    timestamp: new Date().toISOString(),
    payload: { rate_limits: { limit_id: "codex", primary: {
      used_percent: 20, window_minutes: 10080, resets_at: Date.now() / 1000 + 72 * 3600,
    } } },
  }) + "\n");
  mkdirSync(join(taskHome, ".codex-profiles", "second"), { recursive: true });
  symlinkSync(sessions, join(taskHome, ".codex-profiles", "second", "sessions"));
  const result = spawnSync(process.execPath, [script, "--offline"], {
    encoding: "utf8", env: { ...process.env, HOME: taskHome, USAGE_STATE_SKIP_CURSOR: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  for (const name of ["default", "second"]) {
    assert.equal(output.codex_identities[name].pool, null);
    assert.equal(output.codex_identities[name].state, "unknown");
  }
  assert.equal(output.recommended_codex_identity, null);
});

test("reads are live by default, and a pool that empties early raises an alert", () => {
  const home = mkdtempSync(join(tmpdir(), "pair-usage-default-live-"));
  const now = Date.now() / 1000;
  // 64% after 34 of 168 hours: empty in under a day, with five and a half left.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "usage-state.json"), JSON.stringify({
    written_at: now, rate_limits: { seven_day: { used_percentage: 64, resets_at: now + 134 * 3600 } },
  }));
  const env = { ...process.env, HOME: home, USAGE_STATE_SKIP_CURSOR: "1", CODEX_BIN: join(home, "no-codex"),
    CLAUDE_USAGE_URL: "http://127.0.0.1:9/" };
  const byDefault = JSON.parse(spawnSync(process.execPath, [script], { encoding: "utf8", env, timeout: 10000 }).stdout);
  // The default run tried the live read (and failed here), so the snapshot is
  // not account proof: it keeps its protected state but raises no alert.
  assert.match(byDefault.claude_error, /live quota unavailable/u);
  assert.equal(byDefault.states.claude, "protected");
  assert.deepEqual(byDefault.alerts, []);
  const offline = JSON.parse(spawnSync(process.execPath, [script, "--offline"], { encoding: "utf8", env, timeout: 10000 }).stdout);
  assert.equal(offline.claude_error, undefined);
  assert.deepEqual(offline.alerts.map((alert) => alert.pool), ["claude"]);
  assert.equal(offline.states.claude, "protected");
});
