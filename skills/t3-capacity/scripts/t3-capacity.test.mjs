import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "t3-capacity.mjs");

// The macOS login keychain ignores HOME: pair's helper finds a stub
// `security` first, so a real Claude login never reaches a test.
const securityStub = (body) => {
  const dir = mkdtempSync(join(tmpdir(), "t3-capacity-stub-"));
  writeFileSync(join(dir, "security"), body);
  chmodSync(join(dir, "security"), 0o755);
  return dir;
};
const stubBin = securityStub("#!/bin/sh\nexit 44\n");

// Answers pair's read-only rate-limit request per CODEX_HOME: the home whose
// path ends in `second` has headroom, every other home is nearly spent.
const fakeCodex = (dir) => {
  const bin = join(dir, "codex-fixture");
  writeFileSync(bin, `#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line', line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='account/rateLimits/read') {
  const used=process.env.CODEX_HOME.endsWith('second')?35:95;
  console.log(JSON.stringify({id:m.id,result:{rateLimitsByLimitId:{codex:{limitId:'codex',
   primary:{usedPercent:used,windowDurationMins:10080,resetsAt:Date.now()/1000+72*3600}}}}}));
 }
});
`);
  chmodSync(bin, 0o755);
  return bin;
};

const login = (file, body = "{}") => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
};
const settingsFile = (home, providerInstances) => {
  const file = join(home, "settings.json");
  writeFileSync(file, JSON.stringify({ providerInstances }));
  return file;
};
const listen = async (handler) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
};

const testEnv = (env) => ({
  ...process.env, PATH: `${stubBin}:${process.env.PATH}`, USAGE_STATE_SKIP_CURSOR: "1",
  CLAUDE_USAGE_URL: "http://127.0.0.1:9/", GROK_USAGE_URL: "http://127.0.0.1:9/", ...env,
});
const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], { env: testEnv(env) });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  child.on("error", reject);
  child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}: ${err}`))));
});

test("only an instance T3's settings list under its driver maps, and a shared history home proves no account", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-launchers-"));
  login(join(home, ".codex", "auth.json"));
  login(join(home, ".codex-profiles", "second", "auth.json"));
  // T3 runs both instances from one history home through two launchers; the
  // second launcher swaps in its own login home.
  const shared = join(home, ".t3", "codex-home");
  const secondLogin = join(home, ".t3", "codex-auth-second");
  mkdirSync(shared, { recursive: true });
  mkdirSync(secondLogin, { recursive: true });
  linkSync(join(home, ".codex", "auth.json"), join(shared, "auth.json"));
  linkSync(join(home, ".codex-profiles", "second", "auth.json"), join(secondLogin, "auth.json"));
  const copied = join(home, "copied-login");
  login(join(copied, "auth.json"));
  copyFileSync(join(home, ".codex", "auth.json"), join(copied, "auth.json"));
  const settings = settingsFile(home, {
    main: { driver: "codex", config: { binaryPath: "/opt/t3-codex", homePath: shared } },
    other: { driver: "codex", config: { binaryPath: "/opt/t3-codex-second", homePath: shared } },
    copy: { driver: "codex", config: { binaryPath: "/opt/t3-codex-copy", homePath: shared } },
    renamed: { driver: "codex", config: {} },
  });
  // `ghost` is absent from the settings and `renamed` is listed as Codex: with
  // no binary or home to read, either would look like a native default login.
  const instances = ["--instance", "main:codex", "--instance", "other:codex", "--instance", "copy:codex",
    "--instance", "ghost:codex", "--instance", "renamed:grok", "--instance", "oc:opencode", "--settings", settings];
  const env = { HOME: home, CODEX_BIN: fakeCodex(home) };

  const guessed = await run(instances, env);
  for (const instance of guessed.instances) {
    assert.deepEqual(instance.pools, [], `${instance.id} mapped without proof`);
    assert.ok(instance.note, `${instance.id} hides why it is unmapped`);
  }
  // The readings stay visible even though no instance claims them.
  assert.equal(guessed.accounts["codex:second"].state, "available");
  assert.deepEqual(guessed.accounts["codex:second"].instances, []);
  assert.deepEqual(guessed.available, []);

  const proved = await run([...instances, "--auth-home", `main=${shared}`,
    "--auth-home", `other=${secondLogin}`, "--auth-home", `copy=${copied}`], env);
  const byId = Object.fromEntries(proved.instances.map((instance) => [instance.id, instance]));
  assert.deepEqual(byId.main.states, { "codex:default": "unavailable" });
  assert.deepEqual(byId.other.states, { "codex:second": "available" });
  assert.equal(byId.other.proof, "same-file");
  // Equal content in a different file is not the same login.
  assert.deepEqual(byId.copy.pools, []);
  assert.deepEqual(proved.available, ["codex:second"]);

  // A declaration names an account of the instance's own vendor.
  const crossed = spawnSync(process.execPath, [script, ...instances, "--declare", "main=claude"],
    { encoding: "utf8", env: testEnv(env) });
  assert.equal(crossed.status, 2);
  assert.match(crossed.stderr, /codex instance cannot bill claude/u);
});

test("a native launcher's settings home is proof, and one login read twice is one account", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-native-"));
  login(join(home, ".codex", "auth.json"));
  mkdirSync(join(home, ".codex-profiles", "second"), { recursive: true });
  linkSync(join(home, ".codex", "auth.json"), join(home, ".codex-profiles", "second", "auth.json"));
  const t3Home = join(home, ".t3", "codex-home");
  mkdirSync(t3Home, { recursive: true });
  linkSync(join(home, ".codex", "auth.json"), join(t3Home, "auth.json"));
  const settings = settingsFile(home, {
    t3: { driver: "codex", config: { binaryPath: "codex", homePath: t3Home } },
    plain: { driver: "codex", config: { binaryPath: "codex" } },
  });
  const output = await run(["--instance", "t3:codex", "--instance", "plain:codex", "--settings", settings],
    { HOME: home, CODEX_BIN: fakeCodex(home) });
  const [t3, plain] = output.instances;
  assert.equal(t3.proof, "same-file");
  assert.equal(t3.auth_home_source, "settings");
  assert.equal(plain.proof, "default-login");
  assert.deepEqual(output.accounts["codex:default"].instances, ["t3", "plain"]);
  // The profile holds the same login file: its reading is not a second pool.
  assert.equal(output.accounts["codex:second"].same_account_as, "codex:default");
  assert.deepEqual(output.accounts["codex:second"].instances, []);
});

test("on macOS a Claude credentials file proves no account, since the quota read may use the Keychain",
  { skip: process.platform !== "darwin" && "pair reads the Keychain only on macOS" }, async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-capacity-claude-"));
    const now = Date.now();
    login(join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "file-token", expiresAt: now + 3600 * 1000 } }));
    const t3Home = join(home, ".t3", "claude-home");
    mkdirSync(t3Home, { recursive: true });
    linkSync(join(home, ".claude", ".credentials.json"), join(t3Home, ".credentials.json"));
    // A Keychain login that expires later than the file: pair's reader takes it.
    const keychain = securityStub(`#!/bin/sh\nprintf '%s' '${JSON.stringify({
      claudeAiOauth: { accessToken: "keychain-token", expiresAt: now + 10 * 3600 * 1000 } })}'\n`);
    const seen = [];
    const server = await listen((request, response) => {
      seen.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ seven_day: { utilization: 10,
        resets_at: new Date(now + 100 * 3600 * 1000).toISOString() } }));
    });
    const settings = settingsFile(home, {
      t3: { driver: "claudeAgent", config: { binaryPath: "claude", homePath: t3Home } },
      plain: { driver: "claudeAgent", config: { binaryPath: "claude" } },
    });
    const args = ["--instance", "t3:claudeAgent", "--instance", "plain:claudeAgent", "--settings", settings];
    const env = { HOME: home, CODEX_BIN: join(home, "no-codex"), PATH: `${keychain}:${process.env.PATH}`,
      CLAUDE_USAGE_URL: `http://127.0.0.1:${server.address().port}/` };
    try {
      const output = await run(args, env);
      assert.deepEqual(seen, ["Bearer keychain-token"]);
      assert.equal(output.accounts.claude.state, "available");
      for (const instance of output.instances) {
        assert.deepEqual(instance.pools, [], `${instance.id} claims a read it cannot prove`);
        assert.match(instance.note, /Keychain/u);
      }
      const declared = await run([...args, "--declare", "t3=claude"], env);
      assert.equal(declared.instances[0].proof, "user-declared");
      assert.deepEqual(declared.instances[0].states, { claude: "available" });
    } finally {
      server.close();
    }
  });

test("Grok reads only the grok.com login, paced like pair's pools", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-grok-"));
  const seen = [];
  const period = (end) => ({ config: { creditUsagePercent: 80,
    currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: new Date(end).toISOString() } } });
  let body = period(Date.now() + 10 * 24 * 3600 * 1000);
  const server = await listen((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const env = { HOME: home, CODEX_BIN: join(home, "no-codex"),
    GROK_USAGE_URL: `http://127.0.0.1:${server.address().port}/` };
  const grokLogin = (credential) => login(join(home, ".grok", "auth.json"),
    JSON.stringify({ "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": credential }));
  const settings = settingsFile(home, { grok: { driver: "grok", config: {} } });
  try {
    grokLogin({ key: "fixture-login", auth_mode: "oidc" });
    // Without the T3 server's settings even a declaration maps nothing.
    const remote = await run(["--instance", "grok:grok", "--declare", "grok=grok"], env);
    assert.deepEqual(remote.instances[0].pools, []);
    assert.equal(remote.accounts.grok.reading.used_percent, 80);
    const read = await run(["--instance", "grok:grok", "--settings", settings], env);
    assert.equal(seen[1], "Bearer fixture-login");
    assert.equal(read.instances[0].proof, "default-login");
    // 80% spent with a third of the month left burns faster than it can fund.
    assert.equal(read.accounts.grok.state, "protected");

    // A period ending on March 31 began on February's last day, not March 3.
    const year = new Date().getUTCFullYear() + (Date.now() < Date.UTC(new Date().getUTCFullYear(), 2, 31) ? 0 : 1);
    body = period(Date.UTC(year, 2, 31));
    const monthEnd = await run(["--instance", "grok:grok"], env);
    assert.equal(monthEnd.accounts.grok.reading.estimated_start, new Date(Date.UTC(year, 2, 0)).toISOString());

    body = { config: {} };
    const unmetered = await run(["--instance", "grok:grok"], env);
    assert.equal(unmetered.accounts.grok.state, "unknown");

    const requests = seen.length;
    grokLogin({ key: "fixture-api-key", auth_mode: "api_key" });
    const apiKey = await run(["--instance", "grok:grok"], env);
    assert.equal(apiKey.accounts.grok.state, "unknown");
    grokLogin({ key: "fixture-login", auth_mode: "oidc" });
    const overridden = await run(["--instance", "grok:grok"], { ...env, XAI_API_KEY: "fixture" });
    assert.match(overridden.accounts.grok.error, /XAI_API_KEY/u);
    assert.equal(seen.length, requests, "a refused login still reached the billing endpoint");
  } finally {
    server.close();
  }
});
