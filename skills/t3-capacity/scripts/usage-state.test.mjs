import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "usage-state.mjs");

// The macOS login keychain ignores HOME: every helper spawned here finds this
// stub `security` first, so a real Claude login never reaches a test.
const stubBin = mkdtempSync(join(tmpdir(), "t3-capacity-usage-stub-"));
writeFileSync(join(stubBin, "security"), '#!/bin/sh\ncat "$HOME/.claude/.credentials.json" 2>/dev/null\n');
chmodSync(join(stubBin, "security"), 0o755);
process.env.PATH = `${stubBin}:${process.env.PATH}`;
// Retries of a refused fixture connection wait milliseconds, not seconds.
process.env.USAGE_STATE_RETRY_BASE_MS = "1";

// Ends the two-minute spacing, so the next run reads live again.
const endSpacing = (home) => rmSync(join(home, ".cache", "t3-capacity", "live-attempts.json"), { force: true });
// Backdates every cached live reading past the 10-minute reuse window.
const ageCache = (home) => {
  const file = join(home, ".cache", "t3-capacity", "live-usage.json");
  const cache = JSON.parse(readFileSync(file, "utf8"));
  for (const entry of Object.values(cache)) entry.at -= 11 * 60000;
  writeFileSync(file, JSON.stringify(cache));
  endSpacing(home);
};

test("rejects conflicting live and offline flags", () => {
  const result = spawnSync(process.execPath, [script, "--live", "--offline"], {
    encoding: "utf8", env: { ...process.env, USAGE_STATE_SKIP_CURSOR: "1" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: usage-state\.mjs \[--offline\]/u);
});

test("a one-record Codex session keeps its first JSONL record", () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-usage-state-"));
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
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-cursor-usage-"));
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
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-usage-states-"));
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
    "claude:default": "protected",
    codex: "unknown",
    cursor_models: "available",
    other_models: "unavailable",
  });
});

test("Codex homes have separate usage and stale headroom is not recommended", () => {
  const taskHome = mkdtempSync(join(tmpdir(), "t3-capacity-identities-"));
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
  // The default account is spent, but Codex work still has a home.
  assert.equal(output.states.codex, "available");
});

test("live quota stays bound to each Codex home, and a failed read reuses it for 10 minutes", () => {
  const taskHome = mkdtempSync(join(tmpdir(), "t3-capacity-live-identities-"));
  for (const dir of [join(taskHome, ".codex"), join(taskHome, ".codex-profiles", "second")]) {
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { account_id: dir } }));
    writeFileSync(join(dir, "sessions", "recent.jsonl"), JSON.stringify({
      timestamp: new Date(Date.now() - 30 * 60000).toISOString(), payload: {rate_limits: {limit_id:"codex",primary:{
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
  endSpacing(taskHome);
  const failed=spawnSync(process.execPath,[script,"--live"],{
    encoding:"utf8",env:{...env,FAKE_RPC_ERROR:"1"},timeout:10000,
  });
  assert.equal(failed.status,0,failed.stderr);
  const reused=JSON.parse(failed.stdout);
  assert.equal(reused.codex_identities.second.state,"available");
  assert.equal(reused.codex_identities.second.source,"account/rateLimits/read, cached");
  assert.match(reused.codex_identities.second.note,/reused/u);
  assert.equal(reused.codex_identities.second.pool.stale_minutes,0);
  assert.equal(reused.codex_identities.default.state,"unavailable");
  ageCache(taskHome);
  const expired=spawnSync(process.execPath,[script,"--live"],{
    encoding:"utf8",env:{...env,FAKE_RPC_ERROR:"1"},timeout:10000,
  });
  assert.equal(expired.status,0,expired.stderr);
  const unknown=JSON.parse(expired.stdout);
  assert.equal(unknown.codex_identities.second.state,"unknown");
  assert.equal(unknown.recommended_codex_identity,null);
});

test("a codex on PATH that does not start is skipped, and its error reaches the account", () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-codex-path-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { account_id: "only" } }));
  const dir = (name, files) => {
    const folder = join(home, name);
    mkdirSync(folder);
    for (const [file, body] of Object.entries(files)) {
      writeFileSync(join(folder, file), body);
      chmodSync(join(folder, file), 0o755);
    }
    return folder;
  };
  // A broken npm install, the real failure from 2026-10-07.
  const broken = dir("broken", { codex: "#!/bin/sh\necho 'codex.js:107' >&2\necho '  throw new Error(' >&2\n"
    + "printf '\\033[31mError: Missing optional dependency @openai/codex-linux-x64\\033[0m\\r\\n' >&2\n"
    + "echo '    at codex.js:107:9' >&2\nexit 1\n" });
  const working = dir("working", { codex: `#!${process.execPath}
if (process.argv[2] === "--version") { console.log("codex-cli 0.0.0"); process.exit(0); }
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") console.log(JSON.stringify({ id: m.id, result: {} }));
  if (m.method === "account/rateLimits/read") console.log(JSON.stringify({ id: m.id, result: { rateLimitsByLimitId: { codex: {
    limitId: "codex", secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: Date.now() / 1000 + 72 * 3600 } } } } }));
});
` });
  const nodeOnly = dir("node", {});
  symlinkSync(process.execPath, join(nodeOnly, "node"));
  const run = (path, codexBin) => {
    const env = { ...process.env, HOME: home, PATH: path, USAGE_STATE_SKIP_CURSOR: "1", CLAUDE_USAGE_URL: "http://127.0.0.1:9/" };
    delete env.CODEX_BIN;
    if (codexBin) env.CODEX_BIN = codexBin;
    const result = spawnSync(process.execPath, [script, "--live"], { encoding: "utf8", env, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    endSpacing(home);
    return JSON.parse(result.stdout).codex_identities.default;
  };
  const skipped = run([broken, working, nodeOnly, stubBin].join(":"));
  assert.equal(skipped.state, "available");
  assert.equal(skipped.pool.used_percent, 30);
  // A CLI that does not start says nothing about the account, so the cached
  // reading from the run above is not reused.
  const failed = run([broken, nodeOnly, stubBin].join(":"));
  assert.equal(failed.state, "unknown");
  assert.match(failed.error, /: Error: Missing optional dependency @openai\/codex-linux-x64\)/u);
  assert.match(failed.error, /CODEX_BIN/u);
  const missing = run([nodeOnly, stubBin].join(":"), join(home, "no-codex"));
  assert.equal(missing.state, "unknown");
  assert.match(missing.error, /cannot run .*no-codex/u);
});

// A Claude home with a cool statusline snapshot and a login token, plus a
// usage endpoint that answers each request from `answers` (the last repeats).
const claudeFixture = async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-claude-live-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const now = Date.now() / 1000;
  // A cool pool, older than any cached live reading below.
  writeFileSync(join(home, ".claude", "usage-state.json"), JSON.stringify({
    written_at: now - 1800,
    rate_limits: { seven_day: { used_percentage: 10, resets_at: now + 100 * 3600 } },
  }));
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "fixture-token" },
  }));
  const fixture = { home, answers: [{ status: 200 }], seen: [], delayMs: 0 };
  const server = createServer((request, response) => {
    fixture.seen.push({ at: Date.now(), authorization: request.headers.authorization });
    const { status, headers = {}, drop } = fixture.answers.length > 1 ? fixture.answers.shift() : fixture.answers[0];
    // A connection dropped after the headers, halfway through the body.
    if (drop) {
      response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      response.write("{\"seven_day\":");
      return setTimeout(() => response.socket.destroy(), 50);
    }
    setTimeout(() => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify({
        five_hour: { utilization: 31, resets_at: new Date((now + 2 * 3600) * 1000).toISOString() },
        seven_day: { utilization: 64, resets_at: new Date((now + 134 * 3600) * 1000).toISOString() },
      }));
    }, fixture.delayMs);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.close = () => server.close();
  fixture.run = (mode = "--live", env = {}, platform = process.platform) => new Promise((resolve, reject) => {
    const entry = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
const { pathToFileURL } = await import('node:url');
await import(pathToFileURL(process.argv[1]));`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", entry, script, ...[mode].flat()], { env: {
      ...process.env, HOME: home, USAGE_STATE_SKIP_CURSOR: "1", CODEX_BIN: join(home, "no-codex"),
      CLAUDE_USAGE_URL: `http://127.0.0.1:${server.address().port}/`, ...env,
    } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
  });
  return fixture;
};

test("live Claude usage outranks the statusline snapshot, and a failed read reuses it for 10 minutes", async () => {
  const claude = await claudeFixture();
  const { home, run } = claude;
  try {
    const fresh = await run();
    assert.equal(claude.seen[0].authorization, "Bearer fixture-token");
    assert.equal(fresh.claude_identities.default.source, "oauth/usage");
    assert.equal(fresh.claude_identities.default.pool.used_percent, 64);
    assert.equal(fresh.claude_identities.default.pool.short_window.used_percent, 31);
    assert.equal(fresh.states["claude:default"], "protected");
    endSpacing(home);
    claude.answers = [{ status: 429 }];
    const limited = await run();
    assert.equal(limited.claude_identities.default.source, "oauth/usage, cached");
    assert.equal(limited.claude_identities.default.pool.used_percent, 64);
    assert.equal(limited.claude_identities.default.pool.stale_minutes, 0);
    assert.match(limited.claude_identities.default.note, /429/u);
    assert.equal(limited.claude_identities.default.error, undefined);
    assert.equal(limited.states["claude:default"], "protected");
    endSpacing(home);
    claude.answers = [{ status: 401 }];
    const refused = await run();
    assert.equal(refused.claude_identities.default.source, "statusline");
    assert.match(refused.claude_identities.default.error, /401/u);
    assert.equal(refused.states["claude:default"], "unknown");
    assert.equal((await run("--offline")).claude_identities.default.note, undefined);
    ageCache(home);
    claude.answers = [{ status: 429 }];
    const expired = await run();
    assert.equal(expired.claude_identities.default.source, "statusline");
    assert.equal(expired.states["claude:default"], "unknown");
  } finally {
    claude.close();
  }
});

test("concurrent runs share one live read per account every two minutes", async () => {
  const claude = await claudeFixture();
  claude.delayMs = 500;
  try {
    const runs = await Promise.all(Array.from({ length: 5 }, () => claude.run()));
    assert.equal(claude.seen.length, 1);
    assert.deepEqual(runs.map((output) => output.claude_identities.default.pool.used_percent), [64, 64, 64, 64, 64]);
    assert.deepEqual(runs.map((output) => output.states["claude:default"]), Array(5).fill("protected"));
    const reused = runs.filter((output) => output.claude_identities.default.note);
    assert.equal(reused.length, 4);
    for (const output of reused) {
      assert.equal(output.claude_identities.default.source, "oauth/usage, cached");
      assert.match(output.claude_identities.default.note, /skipped/u);
    }
    claude.answers = [{ status: 429 }];
    assert.equal((await claude.run()).states["claude:default"], "protected");
    assert.equal(claude.seen.length, 1);
  } finally {
    claude.close();
  }
});

test("a read left unfinished by a dead process, or its lock, does not block the next run", async () => {
  const claude = await claudeFixture();
  const dir = join(claude.home, ".cache", "t3-capacity");
  mkdirSync(dir, { recursive: true });
  // The dead process claimed the read 25 s ago and kept the lock directory.
  const key = `claude:${createHash("sha256").update("fixture-token").digest("hex").slice(0, 16)}`;
  writeFileSync(join(dir, "live-attempts.json"), JSON.stringify({ [key]: { started: Date.now() - 25000 } }));
  mkdirSync(join(dir, "lock"));
  utimesSync(join(dir, "lock"), new Date(Date.now() - 5000), new Date(Date.now() - 5000));
  try {
    const output = await claude.run();
    assert.equal(claude.seen.length, 1);
    assert.equal(output.claude_identities.default.source, "oauth/usage");
  } finally {
    claude.close();
  }
});

test("a run inside the spacing after a refused token stays unknown", async () => {
  const claude = await claudeFixture();
  claude.answers = [{ status: 401 }];
  try {
    assert.equal((await claude.run()).states["claude:default"], "unknown");
    const spaced = await claude.run();
    assert.equal(claude.seen.length, 1);
    assert.match(spaced.claude_identities.default.error, /401/u);
    assert.equal(spaced.states["claude:default"], "unknown");
  } finally {
    claude.close();
  }
});

test("a 429 retries once Retry-After has passed, and a run without a recent reading stays unknown", async () => {
  const claude = await claudeFixture();
  // Backoff alone would wait past the retry budget, so only Retry-After retries.
  const env = { USAGE_STATE_RETRY_BASE_MS: "60000" };
  claude.answers = [{ status: 429, headers: { "retry-after": "1" } }, { status: 200 }];
  try {
    const retried = await claude.run("--live", env);
    assert.equal(claude.seen.length, 2);
    assert.ok(claude.seen[1].at - claude.seen[0].at >= 1000);
    assert.equal(retried.claude_identities.default.source, "oauth/usage");
    assert.equal(retried.claude_identities.default.pool.used_percent, 64);
    ageCache(claude.home);
    claude.answers = [{ status: 503, headers: { "retry-after": "0" } }];
    const failed = await claude.run("--live", { USAGE_STATE_RETRY_BASE_MS: "1" });
    assert.equal(claude.seen.length, 5);
    assert.match(failed.claude_identities.default.error, /503/u);
    assert.equal(failed.states["claude:default"], "unknown");
  } finally {
    claude.close();
  }
});

test("a body cut off mid-read retries, and a long Retry-After holds every run off", async () => {
  const claude = await claudeFixture();
  claude.answers = [{ drop: true }, { status: 200 }];
  try {
    const retried = await claude.run();
    assert.equal(claude.seen.length, 2);
    assert.equal(retried.claude_identities.default.source, "oauth/usage");
    ageCache(claude.home);
    claude.answers = [{ status: 429, headers: { "retry-after": "300" } }];
    const limited = await claude.run();
    assert.equal(claude.seen.length, 3);
    assert.equal(limited.states["claude:default"], "unknown");
    const file = join(claude.home, ".cache", "t3-capacity", "live-attempts.json");
    const attempts = JSON.parse(readFileSync(file, "utf8"));
    for (const attempt of Object.values(attempts)) attempt.started -= 3 * 60000;
    writeFileSync(file, JSON.stringify(attempts));
    const held = await claude.run();
    assert.equal(claude.seen.length, 3);
    assert.match(held.claude_identities.default.error, /skipped.*429/u);
  } finally {
    claude.close();
  }
});

test("Codex homes sharing one sessions folder prove no account without --live", () => {
  const taskHome = mkdtempSync(join(tmpdir(), "t3-capacity-shared-sessions-"));
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
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-usage-default-live-"));
  const now = Date.now() / 1000;
  // 64% after 34 of 168 hours: empty in under a day, with five and a half left.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "usage-state.json"), JSON.stringify({
    written_at: now, rate_limits: { seven_day: { used_percentage: 64, resets_at: now + 134 * 3600 } },
  }));
  const env = { ...process.env, HOME: home, USAGE_STATE_SKIP_CURSOR: "1", CODEX_BIN: join(home, "no-codex"),
    CLAUDE_USAGE_URL: "http://127.0.0.1:9/" };
  const byDefault = JSON.parse(spawnSync(process.execPath, [script], { encoding: "utf8", env, timeout: 10000 }).stdout);
  assert.match(byDefault.claude_identities.default.error, /live quota unavailable/u);
  assert.equal(byDefault.states["claude:default"], "protected");
  assert.deepEqual(byDefault.alerts, []);
  const offline = JSON.parse(spawnSync(process.execPath, [script, "--offline"], { encoding: "utf8", env, timeout: 10000 }).stdout);
  assert.equal(offline.claude_identities.default.error, undefined);
  assert.deepEqual(offline.alerts.map((alert) => alert.pool), ["claude:default"]);
  assert.equal(offline.states["claude:default"], "protected");
});

test("a home reached under two identity names is one account, not a shared folder", () => {
  const taskHome = mkdtempSync(join(tmpdir(), "t3-capacity-aliased-home-"));
  const profile = join(taskHome, ".codex-profiles", "main");
  mkdirSync(join(profile, "sessions"), { recursive: true });
  writeFileSync(join(profile, "sessions", "quota.jsonl"), JSON.stringify({
    timestamp: new Date().toISOString(),
    payload: { rate_limits: { limit_id: "codex", primary: {
      used_percent: 20, window_minutes: 10080, resets_at: Date.now() / 1000 + 72 * 3600,
    } } },
  }) + "\n");
  symlinkSync(profile, join(taskHome, ".codex"));
  const result = spawnSync(process.execPath, [script, "--offline"], {
    encoding: "utf8", env: { ...process.env, HOME: taskHome, USAGE_STATE_SKIP_CURSOR: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.codex_identities.default.pool.used_percent, 20);
  assert.equal(output.codex_identities.default.state, "available");
});

test("an expired stored Claude login is refused before any request", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-claude-expired-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "stale-token", expiresAt: Date.now() - 3600 * 1000 },
  }));
  let requests = 0;
  const server = createServer((request, response) => { requests++; response.writeHead(401); response.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10000, env: {
      ...process.env, HOME: home, USAGE_STATE_SKIP_CURSOR: "1", CODEX_BIN: join(home, "no-codex"),
      CLAUDE_USAGE_URL: `http://127.0.0.1:${server.address().port}/`,
    } });
    const output = JSON.parse(run.stdout);
    assert.match(output.claude_identities.default.error, /expired/u);
    assert.equal(output.states["claude:default"], "unknown");
  } finally {
    server.close();
  }
  assert.equal(requests, 0);
});

test("a pool spending fast in its first hours already reads as protected", async () => {
  const { pace, poolState } = await import("./usage-state.mjs");
  // 19% in the first 8 h of a week: four times faster than the week can fund.
  const early = pace(19, 160);
  assert.equal(early.burn_per_day, 38);
  assert.equal(early.pace, 3.13);
  assert.equal(poolState({ ...early, stale_minutes: 0 }), "protected");
  // 3% in the first 4 h stays available: the floor keeps a quiet start quiet.
  const quiet = pace(3, 164);
  assert.equal(quiet.pace, 0.42);
  assert.equal(poolState({ ...quiet, stale_minutes: 0 }), "available");
  // Early-empty alerts wait for 12 whole hours of history.
  assert.equal(pace(19, 168 - 11.75).elapsed_hours, 11);
});

test("Claude credentials follow Linux files and macOS Keychain services", async () => {
  const fixture = await claudeFixture();
  const named = join(fixture.home, "auth-second");
  mkdirSync(named);
  writeFileSync(join(named, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "linux-second" } }));
  const keychain = join(fixture.home, "security");
  const servicesFile = join(fixture.home, "services.jsonl");
  writeFileSync(keychain, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(servicesFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({ claudeAiOauth: { accessToken: 'mac-login' } }));
`);
  chmodSync(keychain, 0o755);
  try {
    const linux = await fixture.run(["--claude-logins", JSON.stringify([{ name: "games" }, { name: "second", secureStorageDir: named }])], {}, "linux");
    assert.deepEqual(fixture.seen.map(({ authorization }) => authorization).sort(), ["Bearer fixture-token", "Bearer linux-second"]);
    assert.equal(linux.claude_identities.second.pool.used_percent, 64);
    const missing = await fixture.run(["--claude-logins", JSON.stringify([{ name: "missing", secureStorageDir: join(named, "absent") }])], {}, "linux");
    assert.equal(missing.claude_identities.missing.state, "unknown");
    assert.equal(fixture.seen.length, 2);
    for (const dir of [null, "/Users/hcaiano/.t3/claude-home", "/Users/test/café", "/Users/test/cafe\u0301"]) {
      const mac = await fixture.run(["--claude-logins", JSON.stringify([{ name: "mac", secureStorageDir: dir }])],
        { PATH: `${fixture.home}:${process.env.PATH}` }, "darwin");
      assert.equal(mac.claude_identities.mac.pool.used_percent, 64);
    }
    assert.deepEqual(JSON.parse('[' + readFileSync(servicesFile, 'utf8').trim().split('\n').join(',') + ']'), [
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      ["find-generic-password", "-s", "Claude Code-credentials-3b43c7fd", "-w"],
      ["find-generic-password", "-s", "Claude Code-credentials-ec5578f1", "-w"],
      ["find-generic-password", "-s", "Claude Code-credentials-ec5578f1", "-w"],
    ]);
    assert.deepEqual(fixture.seen.map(({ authorization }) => authorization).sort(),
      ["Bearer fixture-token", "Bearer linux-second", "Bearer mac-login"]);
  } finally { fixture.close(); }
});

test("Claude login names normalize paths and reject conflicting pool locations", async () => {
  const { parseClaudeLogins } = await import("./usage-state.mjs");
  assert.deepEqual(parseClaudeLogins([
    { name: "games" }, { name: "second", secureStorageDir: "~/.t3/cafe\u0301" }, { name: "games", secureStorageDir: "" },
  ], "/Users/test"), [
    { name: "games", secureStorageDir: null }, { name: "second", secureStorageDir: "/Users/test/.t3/cafe\u0301" },
  ]);
  assert.throws(() => parseClaudeLogins([{ name: "games" }, { name: "games", secureStorageDir: "/other" }]),
    /names different login locations/u);
  assert.throws(() => parseClaudeLogins([{ name: "../bad" }]), /simple name/u);
  assert.throws(() => parseClaudeLogins([{ name: "games", secureStorageDir: 3 }]), /secureStorageDir string/u);

});

test("named Claude accounts read their own tokens and cache, and only the default login gets the statusline", async () => {
  const fixture = await claudeFixture();
  const named = join(fixture.home, ".t3", "claude-auth-second");
  mkdirSync(named, { recursive: true });
  writeFileSync(join(named, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "second-token" } }));
  const service = `Claude Code-credentials-${createHash("sha256").update(named).digest("hex").slice(0, 8)}`;
  const keychain = join(fixture.home, "security");
  writeFileSync(keychain, `#!${process.execPath}
const fs = require('node:fs');
const dir = process.argv[4] === ${JSON.stringify(service)} ? ${JSON.stringify(named)} : process.env.HOME + '/.claude';
process.stdout.write(fs.readFileSync(dir + '/.credentials.json', 'utf8'));
`);
  chmodSync(keychain, 0o755);
  const logins = JSON.stringify([{ name: "games" }, { name: "second", secureStorageDir: named }]);
  try {
    const env = { PATH: `${fixture.home}:${process.env.PATH}` };
    const live = await fixture.run(["--live", "--claude-logins", logins], env);
    assert.deepEqual(fixture.seen.map(({ authorization }) => authorization).sort(), ["Bearer fixture-token", "Bearer second-token"]);
    assert.deepEqual(Object.keys(live.claude_identities).sort(), ["games", "second"]);
    assert.deepEqual(live.states, { "claude:games": "protected", "claude:second": "protected",
      codex: "unknown", cursor_models: "unknown", other_models: "unknown" });
    assert.equal(live.claude_identities.games.pool.used_percent, 64);
    assert.equal(live.claude_identities.second.pool.used_percent, 64);
    const cached = await fixture.run(["--live", "--claude-logins", logins], env);
    assert.equal(fixture.seen.length, 2);
    assert.equal(cached.claude_identities.games.source, "oauth/usage, cached");
    assert.equal(cached.claude_identities.second.source, "oauth/usage, cached");
    const offline = await fixture.run(["--offline", "--claude-logins", logins], env);
    assert.equal(offline.claude_identities.games.pool.used_percent, 10);
    assert.equal(offline.claude_identities.games.source, "statusline");
    assert.deepEqual(offline.claude_identities.second, { secure_storage_dir: named, pool: null, source: null, state: "unknown" });
    writeFileSync(join(named, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "second-token", expiresAt: 1 } }));
    const expired = await fixture.run(["--live", "--claude-logins", logins], env);
    assert.equal(expired.claude_identities.games.pool.used_percent, 64);
    assert.equal(expired.claude_identities.second.state, "unknown");
    assert.equal(expired.claude_identities.second.pool, null);
    assert.match(expired.claude_identities.second.error, /expired/u);
    assert.equal(fixture.seen.length, 2);
  } finally { fixture.close(); }
});
