#!/usr/bin/env node
// Joins T3 Code provider instances to live account usage, read-only. Prints
// one JSON object:
//   instances  per --instance: the pools it bills, how that was proved, and
//              their states; an unproved instance bills no known pool
//   accounts   every pool read on this machine, keyed claude, codex:<name>,
//              cursor_models, other_models, grok, with the instances proved
//              to bill it (an empty list is a reading no instance claimed)
//   available  mapped pools in the available state, lower pace first
//   alerts     usage-state's early-empty alerts, unchanged
//   candidates with --candidate: each <instance>/<model> with the pool it
//              bills and that pool's state, pace and use
//   choice     the candidate to delegate to, or null when none can take work
//
// Each --candidate flag is one preference tier of comma-separated
// <instance>/<model> entries. The choice is the first tier holding an
// available candidate, then the first holding a protected one; within a tier
// the lowest pace wins. Unknown and unavailable pools are never chosen.
// Cursor bills its own models (Auto, Composer, Cursor Grok) to cursor_models
// and every other model to other_models, which overflows into on-demand
// spend, so a Cursor candidate takes the state of the pool its model bills.
//
// --mapping names a JSON file holding the settings path and the per-instance
// drivers, login homes and declarations below, so one recorded statement maps
// every run: {"settings": path, "instances": {id: {"driver", "authHome"?,
// "declare"?}}}. With neither --instance nor --mapping, the file
// ~/.agents/t3-capacity.json is read when present. Flags add to the file.
//
// Nothing maps without --settings, the settings file of the T3 server this
// shell runs under: the caller confirms that server, since no file proves it.
// An instance must appear there under the driver the capabilities report. The
// settings name each instance's binary and home, but a custom launcher can
// switch the account, and a shared history home is not an account, so a
// mapping needs one of:
//   default-login  a native CLI with no home override: the login usage-state reads
//   same-file      the instance's login file is the reader's (device + inode)
//   user-declared  --declare, from an explicit user statement; it names a
//                  pool of the instance's own driver
// On macOS, usage-state's Claude read takes whichever of the credentials file and
// the login Keychain expires last, and the Cursor CLI keeps its login in the
// Keychain, so neither file says which account was read: Claude maps there
// only by declaration, and Cursor only by default-login or declaration.
// Nothing here writes a file, prints a credential, or runs a launcher.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pace, poolState } from './usage-state.mjs';

const usage = 'usage: t3-capacity.mjs --instance <id>:<driverKind>... [--auth-home <id>=<dir>]... '
  + '[--declare <id>=<claude|cursor|grok|codex:<name>>]... [--settings <t3-server-settings.json>] '
  + '[--mapping <file>] [--candidate <id>/<model>[,<id>/<model>...]]...';
const fail = (message) => { console.error(message); process.exit(2); };

const instances = [];
const authHomes = new Map();
const declared = new Map();
let settingsFile = null;
let mappingFile = null;
const tiers = [];
const expand = (dir) => path.resolve(dir.replace(/^~(?=\/|$)/u, os.homedir()));
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const [flag, value] = [args[i], args[i + 1]];
  if (value == null) fail(usage);
  const split = (separator) => {
    const at = value.indexOf(separator);
    if (at < 1 || at === value.length - 1) fail(`${flag} needs <id>${separator}<value>, got ${value}\n${usage}`);
    return [value.slice(0, at), value.slice(at + 1)];
  };
  if (flag === '--instance') { const [id, driver] = split(':'); instances.push({ id, driver }); }
  else if (flag === '--auth-home') { const [id, dir] = split('='); authHomes.set(id, expand(dir)); }
  else if (flag === '--declare') {
    const [id, pool] = split('=');
    declared.set(id, pool);
  } else if (flag === '--settings') settingsFile = path.resolve(value);
  else if (flag === '--mapping') mappingFile = expand(value);
  else if (flag === '--candidate') {
    tiers.push(value.split(',').map((entry) => {
      const at = entry.indexOf('/');
      if (at < 1 || at === entry.length - 1) fail(`--candidate needs <id>/<model>, got ${entry}\n${usage}`);
      return { instance: entry.slice(0, at), model: entry.slice(at + 1) };
    }));
  } else fail(usage);
}
const defaultMapping = path.join(os.homedir(), '.agents', 't3-capacity.json');
if (!mappingFile && !instances.length && fs.existsSync(defaultMapping)) mappingFile = defaultMapping;
if (mappingFile) {
  let mapping;
  try { mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8')); }
  catch { fail(`mapping ${mappingFile} is missing or not JSON`); }
  settingsFile ??= mapping.settings ? expand(mapping.settings) : null;
  for (const [id, entry] of Object.entries(mapping.instances ?? {})) {
    if (!entry?.driver) fail(`mapping ${mappingFile} gives ${id} no driver`);
    if (!instances.some((instance) => instance.id === id)) instances.push({ id, driver: entry.driver });
    if (entry.authHome && !authHomes.has(id)) authHomes.set(id, expand(entry.authHome));
    if (entry.declare && !declared.has(id)) declared.set(id, entry.declare);
  }
}
for (const { instance } of tiers.flat()) {
  if (!instances.some(({ id }) => id === instance)) fail(`--candidate names ${instance}, which no instance lists`);
}
if (!instances.length) fail(`name at least one instance from orchestrator_capabilities\n${usage}`);
// A declaration names an account, never another subscription: the driver
// decides which vendor bills the instance.
const DECLARABLE = { codex: /^codex:[A-Za-z0-9][A-Za-z0-9_-]*$/u, claudeAgent: /^claude$/u, cursor: /^cursor$/u, grok: /^grok$/u };
for (const [id, pool] of declared) {
  const driver = instances.find((instance) => instance.id === id)?.driver;
  if (!driver) fail(`--declare names ${id}, which no --instance lists`);
  if (!DECLARABLE[driver]?.test(pool)) fail(`a ${driver} instance cannot bill ${pool}`);
}

const home = os.homedir();
const here = path.dirname(fileURLToPath(import.meta.url));
const usageScript = path.join(here, 'usage-state.mjs');

const readUsageState = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [usageScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.on('error', (error) => resolve({ error: `usage-state did not run: ${error.message}` }));
  child.on('close', (code) => {
    try { resolve(code === 0 ? JSON.parse(out) : { error: `usage-state exited ${code}` }); }
    catch { resolve({ error: 'usage-state printed no JSON' }); }
  });
});

// The grok.com login the Grok CLI uses by default, read the way T3's own
// Grok usage reader does. An API key, another auth deployment, or a custom
// endpoint names a different account, so each refuses rather than guesses.
const GROK_LOGIN_KEYS = ['https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828', 'https://accounts.x.ai/sign-in'];
const GROK_AUTH_ENV = ['XAI_API_KEY', 'GROK_AUTH', 'GROK_OIDC_ISSUER', 'GROK_OIDC_CLIENT_ID', 'GROK_OAUTH2_ISSUER',
  'GROK_OAUTH2_CLIENT_ID', 'GROK_OAUTH2_PRINCIPAL_TYPE', 'GROK_OAUTH2_PRINCIPAL_ID', 'GROK_AUTH_PROVIDER_COMMAND',
  'GROK_LOCAL_AUTH', 'GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_MODELS_BASE_URL', 'GROK_CONFIG', 'GROK_CONFIG_PATH'];
const grokHome = path.join(home, '.grok');
const readGrok = async () => {
  const fromEnv = GROK_AUTH_ENV.find((name) => process.env[name]?.trim());
  if (fromEnv) throw new Error(`${fromEnv} selects another Grok account or endpoint`);
  for (const file of ['config.toml', 'managed_config.toml', 'requirements.toml'].map((name) => path.join(grokHome, name))
    .concat(['/etc/grok/managed_config.toml', '/etc/grok/requirements.toml'])) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch {}
    if (/^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/mu.test(text)) {
      throw new Error(`${file} selects a custom Grok account or endpoint`);
    }
  }
  let logins;
  try { logins = JSON.parse(fs.readFileSync(path.join(grokHome, 'auth.json'), 'utf8')); }
  catch { throw new Error('no Grok CLI login'); }
  const login = GROK_LOGIN_KEYS.map((key) => logins[key]).find(Boolean);
  if (!login?.key || login.auth_mode === 'api_key') throw new Error('no grok.com login; API keys are never read');
  if (login.expires_at && Date.parse(login.expires_at) < Date.now()) {
    throw new Error('the stored Grok login expired; any Grok CLI session refreshes it');
  }
  const response = await fetch(process.env.GROK_USAGE_URL || 'https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
    headers: { authorization: `Bearer ${login.key}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`billing endpoint answered ${response.status}`);
  const config = (await response.json())?.config;
  const used = config?.creditUsagePercent;
  // xAI omits the percentage until usage registers: no number proves no headroom.
  if (!Number.isFinite(used)) throw new Error('billing read carried no usage percentage');
  const type = config.currentPeriod?.type?.replace(/^USAGE_PERIOD_TYPE_/u, '');
  const end = Date.parse(config.currentPeriod?.end ?? '');
  if (!Number.isFinite(end)) throw new Error('billing read carried no period end');
  // xAI sends only the period end. The start is estimated as one week, or the
  // same day a month earlier clamped to that month's length (a period ending
  // on the 31st after a 30-day month started on the 30th, not the 1st).
  let start = null;
  if (type === 'WEEKLY') start = end - 168 * 3600000;
  if (type === 'MONTHLY') {
    const e = new Date(end);
    const [year, month] = e.getUTCMonth() === 0 ? [e.getUTCFullYear() - 1, 11] : [e.getUTCFullYear(), e.getUTCMonth() - 1];
    const day = Math.min(e.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    start = Date.UTC(year, month, day, e.getUTCHours(), e.getUTCMinutes(), e.getUTCSeconds(), e.getUTCMilliseconds());
  }
  const hoursLeft = (end - Date.now()) / 3600000;
  const reading = start ? pace(Math.min(Math.max(used, 0), 100), hoursLeft, (end - start) / 3600000) : null;
  if (!reading) throw new Error(`billing period ${type ?? 'unknown'} cannot be paced`);
  return { ...reading, short_window: null, stale_minutes: 0, period: type.toLowerCase(),
    estimated_start: new Date(start).toISOString() };
};

const [usageState, grok] = await Promise.all([
  readUsageState(),
  readGrok().then((reading) => ({ reading }), (error) => ({ error: error.message })),
]);

const accounts = {};
const account = (key, fields) => { accounts[key] = { state: 'unknown', reading: null, ...fields, instances: [] }; };
if (usageState.error) {
  for (const key of ['claude', 'cursor_models', 'other_models']) account(key, { error: usageState.error });
} else {
  account('claude', { state: usageState.states.claude, reading: usageState.claude, source: usageState.claude_source,
    ...(usageState.claude_error ? { error: usageState.claude_error } : {}) });
  for (const key of ['cursor_models', 'other_models']) {
    const reading = usageState.cursor?.[key] ?? null;
    account(key, { state: usageState.states[key], reading: reading && { ...reading, resets_on: usageState.cursor.resets_on },
      ...(reading ? {} : { error: 'no Cursor /usage reading' }) });
  }
  for (const [name, entry] of Object.entries(usageState.codex_identities)) {
    account(`codex:${name}`, { state: entry.state, reading: entry.pool, source: entry.source, home: entry.home,
      ...(entry.error ? { error: entry.error } : {}) });
  }
}
account('grok', grok.reading
  ? { state: poolState(grok.reading), reading: grok.reading, source: 'billing' }
  : { error: grok.error });

const fileId = (file) => { try { const s = fs.statSync(file); return `${s.dev}:${s.ino}`; } catch { return null; } };
// Two Codex homes holding one login file are one account, read twice.
const codexByLogin = new Map();
for (const [key, entry] of Object.entries(accounts)) {
  if (!key.startsWith('codex:')) continue;
  const id = fileId(path.join(entry.home, 'auth.json'));
  if (!id) continue;
  if (codexByLogin.has(id)) entry.same_account_as = codexByLogin.get(id);
  else codexByLogin.set(id, key);
}

const darwin = process.platform === 'darwin';
const cursorLogin = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'cursor', 'auth.json');
const KEYCHAIN = 'on macOS this login may live in the Keychain, which no file comparison reaches; only the user can declare it';
const DRIVERS = {
  codex: { cli: ['codex'], loginFile: 'auth.json', fileProof: true, defaultProof: true,
    readers: () => [...codexByLogin].map(([id, key]) => ({ id, pools: [key] })), defaultPools: ['codex:default'] },
  claudeAgent: { cli: ['claude'], loginFile: '.credentials.json', fileProof: !darwin, defaultProof: !darwin,
    readers: () => [{ id: fileId(path.join(home, '.claude', '.credentials.json')), pools: ['claude'] }], defaultPools: ['claude'] },
  cursor: { cli: ['cursor-agent', 'agent'], loginFile: 'auth.json', fileProof: !darwin, defaultProof: true,
    readers: () => [{ id: fileId(cursorLogin), pools: ['cursor_models', 'other_models'] }], defaultPools: ['cursor_models', 'other_models'] },
  grok: { cli: ['grok'], loginFile: 'auth.json', fileProof: true, defaultProof: true,
    readers: () => [{ id: fileId(path.join(grokHome, 'auth.json')), pools: ['grok'] }], defaultPools: ['grok'] },
};

let settings = {};
let settingsError = null;
if (!settingsFile) settingsError = 'no --settings for the T3 server this shell runs under';
else {
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch (error) { settingsError = error.code === 'ENOENT' ? `no T3 settings at ${settingsFile}` : 'T3 settings unreadable'; }
}

const prove = ({ id, driver }) => {
  const spec = DRIVERS[driver];
  if (!spec) return { pools: [], proof: null, note: `no usage reader for driver ${driver}` };
  // Without the T3 server's settings, these readings may describe another
  // machine's accounts: not even a declaration maps.
  if (settingsError) return { pools: [], proof: null, note: settingsError };
  const entry = settings.providerInstances?.[id];
  if (!entry) return { pools: [], proof: null, note: 'not in the T3 settings given' };
  if (entry.driver !== driver) {
    return { pools: [], proof: null, note: `the T3 settings give driver ${entry.driver}, not ${driver}` };
  }
  if (declared.has(id)) {
    const pool = declared.get(id);
    return { pools: pool === 'cursor' ? ['cursor_models', 'other_models'] : [pool], proof: 'user-declared' };
  }
  const config = entry.config ?? {};
  const binary = config.binaryPath?.trim();
  const launcher = !binary || spec.cli.includes(path.basename(binary)) ? 'native' : 'custom';
  const settingsHome = (driver === 'codex' && config.shadowHomePath?.trim()) || config.homePath?.trim() || null;
  let authHome = authHomes.get(id) ?? null;
  let source = authHome ? 'declared' : null;
  if (!authHome && launcher === 'custom') {
    return { pools: [], proof: null, launcher, note: `launcher ${path.basename(binary)} can select any account; `
      + 'read it and pass the login home it sets with --auth-home' };
  }
  if (!authHome && !settingsHome) {
    return spec.defaultProof
      ? { pools: spec.defaultPools, proof: 'default-login', launcher }
      : { pools: [], proof: null, launcher, note: KEYCHAIN };
  }
  if (!authHome) [authHome, source] = [settingsHome, 'settings'];
  const base = { launcher, auth_home: authHome, auth_home_source: source };
  if (!spec.fileProof) return { ...base, pools: [], proof: null, note: KEYCHAIN };
  const login = fileId(path.join(authHome, spec.loginFile));
  if (!login) {
    return { ...base, pools: [], proof: null, note: `no ${spec.loginFile} in the login home; only the user can declare it` };
  }
  const reader = spec.readers().find((candidate) => candidate.id === login);
  if (!reader) return { ...base, pools: [], proof: null, note: 'its login file is none of the files read here' };
  return { ...base, pools: reader.pools, proof: 'same-file' };
};

const mapped = instances.map((instance) => {
  const result = { id: instance.id, driver: instance.driver, ...prove(instance) };
  result.pools = result.pools.map((pool) => accounts[pool]?.same_account_as ?? pool);
  for (const pool of result.pools) {
    if (!accounts[pool]) account(pool, { error: 'no reading for this pool here' });
    accounts[pool].instances.push(instance.id);
  }
  result.states = Object.fromEntries(result.pools.map((pool) => [pool, accounts[pool].state]));
  return result;
});

const byPace = (a, b) => (a.pace ?? 1) - (b.pace ?? 1) || (a.used_percent ?? 100) - (b.used_percent ?? 100);
const available = Object.entries(accounts)
  .filter(([, entry]) => entry.state === 'available' && entry.instances.length && !entry.same_account_as)
  .sort(([, a], [, b]) => byPace(a.reading, b.reading))
  .map(([key]) => key);

const cursorOwn = /^(?:default|auto|composer|grok)(?:[-.]|$)/iu;
const ranked = tiers.map((tier, index) => tier.map(({ instance, model }) => {
  const { pools, driver } = mapped.find(({ id }) => id === instance);
  const billed = driver === 'cursor' && pools.length ? [cursorOwn.test(model) ? 'cursor_models' : 'other_models'] : pools;
  const pool = billed.length === 1 ? billed[0] : null;
  const reading = pool ? accounts[pool].reading : null;
  return { tier: index, instance, model, pool, state: pool ? accounts[pool].state : 'unknown',
    pace: reading?.pace ?? null, used_percent: reading?.used_percent ?? null };
}));
let choice = null;
for (const state of ['available', 'protected']) {
  for (const tier of ranked) {
    choice = tier.filter((candidate) => candidate.state === state).sort(byPace)[0] ?? null;
    if (choice) break;
  }
  if (choice) break;
}

console.log(JSON.stringify({
  instances: mapped, accounts, available, alerts: usageState.alerts ?? [],
  ...(tiers.length ? { candidates: ranked.flat(), choice } : {}),
  ...(settingsError ? { settings_error: settingsError } : {}),
}, null, 1));
