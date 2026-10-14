import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "t3-capacity.mjs");

// The macOS login keychain ignores HOME: usage-state finds a stub
// `security` first, so a real Claude login never reaches a test.
const securityStub = (body) => {
  const dir = mkdtempSync(join(tmpdir(), "t3-capacity-stub-"));
  writeFileSync(join(dir, "security"), body);
  chmodSync(join(dir, "security"), 0o755);
  return dir;
};
const stubBin = securityStub("#!/bin/sh\nexit 44\n");

// Answers usage-state's read-only rate-limit request per CODEX_HOME: the home whose
// path ends in `second` has headroom, `third` burns faster than it can fund,
// `hot` burns faster still, every other home is nearly spent.
const fakeCodex = (dir) => {
  const bin = join(dir, "codex-fixture");
  writeFileSync(bin, `#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line', line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='account/rateLimits/read') {
  const used=process.env.CODEX_HOME.endsWith('second')?35:process.env.CODEX_HOME.endsWith('third')?70:process.env.CODEX_HOME.endsWith('hot')?85:95;
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
  CLAUDE_USAGE_URL: "http://127.0.0.1:9/", GROK_USAGE_URL: "http://127.0.0.1:9/", USAGE_STATE_RETRY_BASE_MS: "1", ...env,
});
// Ends usage-state's two-minute spacing, so the next run reads live again.
const endSpacing = (home) => rmSync(join(home, ".cache", "t3-capacity", "live-attempts.json"), { force: true });
const run = (args, env, platform = null) => new Promise((resolve, reject) => {
  const entry = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
const { pathToFileURL } = await import('node:url');
await import(pathToFileURL(process.argv[1]));`;
  const launch = platform ? ["--input-type=module", "--eval", entry, script, ...args] : [script, ...args];
  const child = spawn(process.execPath, launch, { env: testEnv(env) });
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
  { skip: process.platform !== "darwin" && "usage-state reads the Keychain only on macOS" }, async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-capacity-claude-"));
    const now = Date.now();
    login(join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "file-token", expiresAt: now + 3600 * 1000 } }));
    const t3Home = join(home, ".t3", "claude-home");
    mkdirSync(t3Home, { recursive: true });
    linkSync(join(home, ".claude", ".credentials.json"), join(t3Home, ".credentials.json"));
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
      assert.equal(output.accounts["claude:default"].state, "available");
      for (const instance of output.instances) {
        assert.deepEqual(instance.pools, [], `${instance.id} claims a read it cannot prove`);
        assert.match(instance.note, /Keychain/u);
      }
      const declared = await run([...args, "--declare", "t3=claude:games"], env);
      assert.equal(declared.instances[0].proof, "user-declared");
      assert.deepEqual(declared.instances[0].states, { "claude:games": "available" });
    } finally {
      server.close();
    }
  });

test("Grok reads only the grok.com login, paced like usage-state's pools", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-grok-"));
  const seen = [];
  const period = (end) => ({ config: { creditUsagePercent: 80,
    currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: new Date(end).toISOString() } } });
  let body = period(Date.now() + 10 * 24 * 3600 * 1000);
  let status = 200;
  const server = await listen((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(status, { "content-type": "application/json" });
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
    endSpacing(home);
    const read = await run(["--instance", "grok:grok", "--settings", settings], env);
    assert.equal(seen[1], "Bearer fixture-login");
    assert.equal(read.instances[0].proof, "default-login");
    assert.equal(read.accounts.grok.source, "billing");
    // 80% spent with a third of the month left burns faster than it can fund.
    assert.equal(read.accounts.grok.state, "protected");

    // Inside the spacing the endpoint is not asked again; after it, a 429
    // retries and then reuses the reading, like usage-state's pools.
    const spaced = await run(["--instance", "grok:grok"], env);
    assert.equal(seen.length, 2);
    assert.equal(spaced.accounts.grok.source, "billing, cached");
    assert.match(spaced.accounts.grok.note, /skipped/u);
    assert.equal(spaced.accounts.grok.reading.period, "monthly");
    endSpacing(home);
    status = 429;
    const limited = await run(["--instance", "grok:grok"], env);
    assert.equal(seen.length, 5);
    assert.match(limited.accounts.grok.note, /429/u);
    assert.equal(limited.accounts.grok.state, "protected");
    status = 200;

    // A period ending on March 31 began on February's last day, not March 3.
    const year = new Date().getUTCFullYear() + (Date.now() < Date.UTC(new Date().getUTCFullYear(), 2, 31) ? 0 : 1);
    body = period(Date.UTC(year, 2, 31));
    endSpacing(home);
    const monthEnd = await run(["--instance", "grok:grok"], env);
    assert.equal(monthEnd.accounts.grok.reading.estimated_start, new Date(Date.UTC(year, 2, 0)).toISOString());

    body = { config: {} };
    endSpacing(home);
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

test("a recorded mapping maps every run, and the choice takes the first tier with capacity", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-candidates-"));
  const homes = {};
  for (const name of ["spent", "second", "third", "hot"]) {
    homes[name] = join(home, ".codex-profiles", name);
    login(join(homes[name], "auth.json"));
  }
  login(join(home, ".codex", "auth.json"));
  const settings = settingsFile(home, Object.fromEntries([
    ...Object.keys(homes).map((name) => [name, { driver: "codex", config: { binaryPath: `/opt/t3-${name}` } }]),
    ["cursor", { driver: "cursor", config: { binaryPath: "/opt/t3-cursor" } }],
  ]));
  mkdirSync(join(home, ".agents"), { recursive: true });
  writeFileSync(join(home, ".agents", "t3-capacity.json"), JSON.stringify({ settings, instances: {
    ...Object.fromEntries(Object.entries(homes).map(([name, dir]) => [name, { driver: "codex", authHome: dir }])),
    cursor: { driver: "cursor", declare: "cursor" },
  } }));
  const env = { HOME: home, CODEX_BIN: fakeCodex(home) };
  const pick = async (...tiers) => (await run(tiers.flatMap((tier) => ["--candidate", tier]), env)).choice;

  const recorded = await run([], env);
  assert.deepEqual(Object.fromEntries(recorded.instances.map(({ id, states }) => [id, states])), {
    spent: { "codex:spent": "unavailable" }, second: { "codex:second": "available" },
    third: { "codex:third": "protected" }, hot: { "codex:hot": "protected" },
    cursor: { cursor_models: "unknown", other_models: "unknown" },
  });

  // Work falls through protected and spent tiers to the first one with headroom,
  // however far down, and within a tier headroom wins.
  assert.equal((await pick("third/m", "second/m")).instance, "second");
  assert.equal((await pick("third/m,second/m")).instance, "second");
  assert.equal((await pick("third/m", "hot/m", "second/m")).instance, "second");
  assert.equal((await pick("third/m", "spent/m", "cursor/composer", "second/m")).instance, "second");
  // A tier with headroom keeps the work even when a later tier also has it.
  assert.equal((await pick("second/m", "third/m")).instance, "second");
  // With no headroom anywhere, the protected pool burning slowest takes work in any tier.
  assert.equal((await pick("hot/m", "third/m")).instance, "third");
  assert.equal((await pick("third/m", "hot/m")).instance, "third");
  assert.equal((await pick("spent/m", "hot/m", "cursor/composer", "third/m")).instance, "third");
  // Spent and unknown pools never take work.
  assert.equal(await pick("spent/m", "cursor/composer"), null);

  // Cursor's own models and every other model draw different pools.
  const cursor = await run(["--candidate", "cursor/grok-4.7,cursor/composer-2.5,cursor/claude-opus-5-5"], env);
  assert.deepEqual(cursor.candidates.map(({ pool }) => pool), ["cursor_models", "cursor_models", "other_models"]);
});

test("role CLI reads the default models file and mapping, and returns complete delegate targets", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-role-"));
  login(join(home, ".codex-profiles", "second", "auth.json"));
  const settings = settingsFile(home, { second: { driver: "codex", config: { binaryPath: "codex",
    homePath: join(home, ".codex-profiles", "second") } } });
  mkdirSync(join(home, ".agents"), { recursive: true });
  writeFileSync(join(home, ".agents", "t3-capacity.json"), JSON.stringify({ settings }));
  const models = "# effort high: feature, refactoring\nfeature, refactoring: capacity[sol], capacity[missing]\n";
  writeFileSync(join(home, ".agents", "pstack-models.md"), models);
  const capabilities = join(home, "capabilities.json");
  writeFileSync(capabilities, JSON.stringify({ providers: [{ providerInstanceId: "second", driverKind: "codex",
    models: [{ id: "sol", options: [{ id: "reasoningEffort", options: [{ id: "medium" }, { id: "high" }] }] }] }] }));
  const args = ["--role", "refactoring", "--capabilities", capabilities];
  const env = { HOME: home, CODEX_BIN: fakeCodex(home) };
  const output = await run(args, env);
  assert.equal(output.role, "refactoring");
  assert.deepEqual(output.seats[0].target, { providerInstanceId: "second", model: "sol",
    options: [{ id: "reasoningEffort", value: "high" }] });
  assert.equal(output.seats[1].choice, null);
  assert.equal(output.seats[1].target, null);
  assert.deepEqual(output.seats[1].rejected, [{ model: "missing", reason: "model missing from catalog" }]);

  const alternate = join(home, "alternate.md");
  writeFileSync(alternate, "# effort medium: refactoring\nrefactoring: capacity[sol]\n");
  const overridden = await run([...args, "--models", alternate], env);
  assert.deepEqual(overridden.seats[0].target.options, [{ id: "reasoningEffort", value: "medium" }]);
  const unknown = await run(["--role", "unknown", "--capabilities", capabilities], env);
  assert.equal(unknown.seats[0].target, null);
  assert.equal(unknown.seats[0].reason, "unknown role unknown");

  const invalid = spawnSync(process.execPath, [script, ...args, "--candidate", "second/sol"],
    { encoding: "utf8", env: testEnv(env) });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /cannot be combined/u);
});

test("named Claude mappings read independent accounts and select the one with capacity in candidate and role modes", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-claude-accounts-"));
  const authDir = join(home, ".t3", "claude-auth-gatticaiano");
  const overrideDir = join(home, ".t3", "claude-auth-override");
  const games = { claudeAiOauth: { accessToken: "games-token" } };
  const second = { claudeAiOauth: { accessToken: "second-token" } };
  const third = { claudeAiOauth: { accessToken: "third-token" } };
  login(join(home, ".claude", ".credentials.json"), JSON.stringify(games));
  login(join(authDir, ".credentials.json"), JSON.stringify(second));
  login(join(overrideDir, ".credentials.json"), JSON.stringify(third));
  const { createHash } = await import("node:crypto");
  const service = `Claude Code-credentials-${createHash("sha256").update(authDir).digest("hex").slice(0, 8)}`;
  const overrideService = `Claude Code-credentials-${createHash("sha256").update(overrideDir).digest("hex").slice(0, 8)}`;
  const keychain = securityStub(`#!${process.execPath}
console.log(JSON.stringify(process.argv[4] === ${JSON.stringify(service)} ? ${JSON.stringify(second)}
  : process.argv[4] === ${JSON.stringify(overrideService)} ? ${JSON.stringify(third)} : ${JSON.stringify(games)}));
`);
  const seen = [];
  const server = await listen((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ seven_day: {
      utilization: request.headers.authorization === "Bearer games-token" ? 95
        : request.headers.authorization === "Bearer third-token" ? 23 : 10,
      resets_at: new Date(Date.now() + 100 * 3600000).toISOString(),
    } }));
  });
  const settings = settingsFile(home, {
    claudeAgent: { driver: "claudeAgent", config: { binaryPath: "/opt/claude-launcher", homePath: join(home, "history") } },
    claudeAgent_gatticaiano: { driver: "claudeAgent", config: { binaryPath: "/opt/claude-second", homePath: join(home, "history") } },
    alias: { driver: "claudeAgent", config: {} },
  });
  const instances = {
    claudeAgent: { driver: "claudeAgent", declare: "claude:games" },
    claudeAgent_gatticaiano: { driver: "claudeAgent", declare: "claude:gatticaiano", secureStorageDir: authDir },
    alias: { driver: "claudeAgent", declare: "claude:games" },
  };
  const mapping = join(home, "mapping.json");
  writeFileSync(mapping, JSON.stringify({ settings, instances }));
  const args = ["--mapping", mapping];
  const env = { HOME: home, CODEX_BIN: join(home, "missing"), PATH: `${keychain}:${process.env.PATH}`,
    CLAUDE_USAGE_URL: `http://127.0.0.1:${server.address().port}/` };
  try {
    const output = await run([...args, "--candidate", "claudeAgent/opus,claudeAgent_gatticaiano/opus,alias/opus"], env);
    assert.deepEqual(seen.sort(), ["Bearer games-token", "Bearer second-token"]);
    assert.deepEqual(Object.keys(output.accounts).sort(),
      ["claude:games", "claude:gatticaiano", "codex:default", "cursor_models", "grok", "other_models"]);
    assert.deepEqual(output.accounts["claude:games"].instances, ["claudeAgent", "alias"]);
    assert.deepEqual(output.accounts["claude:gatticaiano"].instances, ["claudeAgent_gatticaiano"]);
    assert.equal(output.accounts["claude:games"].reading.used_percent, 95);
    assert.equal(output.accounts["claude:gatticaiano"].reading.used_percent, 10);
    assert.deepEqual(output.available, ["claude:gatticaiano"]);
    assert.deepEqual(output.choice, { tier: 0, instance: "claudeAgent_gatticaiano", model: "opus",
      pool: "claude:gatticaiano", state: "available", pace: 0.16, used_percent: 10 });
    const capabilities = join(home, "capabilities.json");
    writeFileSync(capabilities, JSON.stringify({ providers: ["claudeAgent", "claudeAgent_gatticaiano"].map((id) => ({
      providerInstanceId: id, driverKind: "claudeAgent", models: [{ id: "opus", options: [
        { id: "effort", options: [{ id: "medium" }, { id: "high" }] },
      ] }],
    })) }));
    const models = join(home, "models.md");
    writeFileSync(models, "# effort high: feature\nfeature: capacity[opus]\n");
    const role = await run([...args, "--role", "feature", "--models", models, "--capabilities", capabilities], env);
    assert.deepEqual(role.seats[0].target, { providerInstanceId: "claudeAgent_gatticaiano", model: "opus",
      options: [{ id: "effort", value: "high" }] });
    assert.deepEqual(role.seats[0].candidates.map(({ model, pool }) => [model, pool]),
      [["opus", "claude:games"], ["opus", "claude:gatticaiano"]]);
    assert.equal(seen.length, 2);
    const override = await run([...args, "--secure-storage-dir", `claudeAgent_gatticaiano=${overrideDir}`], env);
    assert.equal(override.accounts["claude:gatticaiano"].reading.used_percent, 23);
    assert.equal(override.accounts["claude:gatticaiano"].secure_storage_dir, overrideDir);
    assert.equal(seen[2], "Bearer third-token");
    const bare = spawnSync(process.execPath, [script, ...args, "--declare", "claudeAgent=claude"],
      { encoding: "utf8", env: testEnv(env) });
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /bare Claude pool was removed; declare claude:<name>/u);
    writeFileSync(mapping, JSON.stringify({ settings, instances: {
      ...instances, alias: { driver: "claudeAgent", declare: "claude:games", secureStorageDir: authDir },
    } }));
    const conflict = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: testEnv(env) });
    assert.equal(conflict.status, 2);
    assert.match(conflict.stderr, /names different login locations/u);
  } finally { server.close(); }
});

test("two Claude pool names for the default login still map to one account", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-claude-alias-"));
  const settings = settingsFile(home, { main: { driver: "claudeAgent" }, alias: { driver: "claudeAgent" } });
  const output = await run(["--settings", settings, "--instance", "main:claudeAgent", "--instance", "alias:claudeAgent",
    "--declare", "main=claude:games", "--declare", "alias=claude:alias"], { HOME: home, CODEX_BIN: join(home, "missing") });
  assert.deepEqual(output.instances.map(({ pools }) => pools), [["claude:games"], ["claude:games"]]);
  assert.equal(output.accounts["claude:alias"].same_account_as, "claude:games");
  assert.deepEqual(output.accounts["claude:games"].instances, ["main", "alias"]);
});

test("a native Linux Claude login without a recorded default pool asks for a declaration", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-capacity-claude-unrecorded-"));
  const settings = settingsFile(home, { named: { driver: "claudeAgent" }, native: { driver: "claudeAgent" } });
  const output = await run(["--settings", settings, "--instance", "named:claudeAgent", "--instance", "native:claudeAgent",
    "--declare", "named=claude:second", "--secure-storage-dir", `named=${join(home, "named-auth")}`],
    { HOME: home, CODEX_BIN: join(home, "missing") }, "linux");
  assert.deepEqual(output.instances[0].pools, ["claude:second"]);
  assert.deepEqual(output.instances[1], { id: "native", driver: "claudeAgent", pools: [], proof: null,
    launcher: "native", note: "default login has no recorded pool; declare its account", states: {} });
});
