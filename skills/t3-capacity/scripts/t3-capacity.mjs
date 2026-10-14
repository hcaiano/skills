#!/usr/bin/env node
// Joins T3 Code provider instances to live account usage, read-only. Prints
// one JSON object:
//   instances  per --instance: the pools it bills, how that was proved, and
//              their states; an unproved instance bills no known pool
//   accounts   every pool read on this machine, keyed claude:<name>, codex:<name>,
//              cursor_models, other_models, grok, with the instances proved
//              to bill it (an empty list is a reading no instance claimed)
//   available  mapped pools in the available state, lower pace first
//   alerts     the usage reader's early-empty alerts, unchanged
//   candidates with --candidate: each <instance>/<model> with the pool it
//              bills and that pool's state, pace and use
//   choice     the candidate to delegate to, or null when none can take work
//   seats      with --role: each seat's capacity choice and complete target,
//              or a null target with its reason
//
// Each --candidate flag is one preference tier of comma-separated
// <instance>/<model> entries. The choice is the lowest-pace available
// candidate of the first tier holding one, however far down that tier is.
// With no available candidate anywhere, the protected candidate with the
// lowest pace across all tiers takes the work, so the burn spreads to the
// pool with the most room. Unknown and unavailable pools are never chosen.
// Cursor bills its own models (Auto, Composer, Cursor Grok) to cursor_models
// and every other model to other_models, which overflows into on-demand
// spend, so a Cursor candidate takes the state of the pool its model bills.
//
// --mapping names a JSON file holding the settings path and the per-instance
// drivers, login homes and declarations below, so one recorded statement maps
// every run: {"settings": path, "instances": {id: {"driver", "authHome"?, "secureStorageDir"?,
// "declare"?}}}. With neither --instance nor --mapping, the file
// ~/.agents/t3-capacity.json is read when present. Flags add to the file.
//
// Nothing maps without --settings, the settings file of the T3 server this
// shell runs under: the caller confirms that server, since no file proves it.
// An instance must appear there under the driver the capabilities report. The
// settings name each instance's binary and home, but a custom launcher can
// switch the account, and a shared history home is not an account, so a
// mapping needs one of:
//   default-login  a native CLI with no home override: the login the usage
//                  reader reads
//   same-file      the instance's login file is the reader's (device + inode)
//   user-declared  --declare, from an explicit user statement; it names a
//                  pool of the instance's own driver
// On macOS, Claude and Cursor keep their logins in the Keychain, so no
// file comparison says which account was read: Claude maps
// there only by declaration, and Cursor only by default-login or declaration.
// Nothing here prints a credential or runs a launcher; the only files written
// are usage-state's cache of its last good live readings and its record of
// live read attempts, shared with the Grok read here.
// --role <name> --capabilities <saved JSON> resolves one target per capacity[...]
// entry in --models <pstack-models.md>, default ~/.agents/pstack-models.md.
// Commas separate seats, > orders tiers, and | joins equal models in a tier.
// Role aliases are comma-separated before the colon. Effort comments use
// # effort high: feature, refactoring, bug-fix
// # effort medium: how explorer, why investigators
// Other roles default to xhigh. Each target uses the catalog's option key and
// the highest supported effort at or below the role budget.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey, fetchUsage, liveRead, poolFromRaw, poolState, parseClaudeLogins } from './usage-state.mjs';
import { byPace, chooseCandidate, rankCandidates } from './capacity-choice.mjs';
import { parseRole, resolveRole } from './role-target.mjs';

const usage = 'usage: t3-capacity.mjs --instance <id>:<driverKind>... [--auth-home <id>=<dir>]... '
  + '[--declare <id>=<claude:<name>|cursor|grok|codex:<name>>]... [--settings <t3-server-settings.json>] '
  + '[--secure-storage-dir <id>=<dir>]... [--mapping <file>] [--candidate <id>/<model>[,<id>/<model>...]]... '
  + '[--role <name> --capabilities <file> [--models <pstack-models.md>]]';
const fail = (message) => { console.error(message); process.exit(2); };

const instances = [];
const authHomes = new Map();
const secureStorageDirs = new Map();
const declared = new Map();
let settingsFile = null;
let mappingFile = null;
const tiers = [];
let role = null;
let capabilitiesFile = null;
let modelsFile = path.join(os.homedir(), '.agents', 'pstack-models.md');
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
  else if (flag === '--secure-storage-dir') { const [id, dir] = split('='); secureStorageDirs.set(id, expand(dir)); }
  else if (flag === '--declare') {
    const [id, pool] = split('=');
    declared.set(id, pool);
  } else if (flag === '--settings') settingsFile = path.resolve(value);
  else if (flag === '--mapping') mappingFile = expand(value);
  else if (flag === '--role') role = value;
  else if (flag === '--capabilities') capabilitiesFile = expand(value);
  else if (flag === '--models') modelsFile = expand(value);
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
    if (entry.secureStorageDir != null && !secureStorageDirs.has(id)) {
      if (typeof entry.secureStorageDir !== 'string') fail(`mapping ${mappingFile} gives ${id} an invalid secureStorageDir`);
      secureStorageDirs.set(id, entry.secureStorageDir ? expand(entry.secureStorageDir) : null);
    }
    if (entry.declare && !declared.has(id)) declared.set(id, entry.declare);
  }
}
let roleConfig = null;
let capabilities = null;
if (role) {
  if (tiers.length) fail('--role and --candidate cannot be combined');
  if (!capabilitiesFile) fail('--role needs --capabilities');
  try {
    roleConfig = parseRole(fs.readFileSync(modelsFile, 'utf8'), role);
    capabilities = JSON.parse(fs.readFileSync(capabilitiesFile, 'utf8'));
    if (!Array.isArray(capabilities.providers) || capabilities.providers.some((provider) =>
      typeof provider.providerInstanceId !== 'string' || typeof provider.driverKind !== 'string'
      || !Array.isArray(provider.models))) throw new Error('invalid providers catalog');
    for (const provider of capabilities.providers) {
      const existing = instances.find(({ id }) => id === provider.providerInstanceId);
      if (existing && existing.driver !== provider.driverKind) throw new Error(`catalog driver mismatch for ${existing.id}`);
      if (!existing) instances.push({ id: provider.providerInstanceId, driver: provider.driverKind });
    }
  } catch (error) { fail(`cannot resolve role: ${error.message}`); }
}
for (const { instance } of tiers.flat()) {
  if (!instances.some(({ id }) => id === instance)) fail(`--candidate names ${instance}, which no instance lists`);
}
if (!instances.length && !role) fail(`name at least one instance from orchestrator_capabilities\n${usage}`);
// A declaration names an account, never another subscription: the driver
// decides which vendor bills the instance.
const DECLARABLE = { codex: /^codex:[A-Za-z0-9][A-Za-z0-9_-]*$/u, claudeAgent: /^claude:[A-Za-z0-9][A-Za-z0-9_-]*$/u, cursor: /^cursor$/u, grok: /^grok$/u };
for (const [id, pool] of declared) {
  const driver = instances.find((instance) => instance.id === id)?.driver;
  if (!driver) fail(`--declare names ${id}, which no --instance lists`);
  if (driver === 'claudeAgent' && pool === 'claude') fail('bare Claude pool was removed; declare claude:<name>');
  if (!DECLARABLE[driver]?.test(pool)) fail(`a ${driver} instance cannot bill ${pool}`);
}

for (const [id] of secureStorageDirs) {
  if (instances.find((instance) => instance.id === id)?.driver !== 'claudeAgent') {
    fail(`secureStorageDir needs a Claude instance, got ${id}`);
  }
  if (!declared.has(id)) fail(`secureStorageDir needs a named --declare for ${id}`);
}
let claudeLogins;
try {
  const entries = instances.filter(({ driver, id }) => driver === 'claudeAgent' && declared.has(id))
    .map(({ id }) => ({ name: declared.get(id).slice('claude:'.length), secureStorageDir: secureStorageDirs.get(id) }));
  claudeLogins = parseClaudeLogins(entries.length ? entries : [{ name: 'default' }]);
} catch (error) { fail(error.message); }

const home = os.homedir();
const here = path.dirname(fileURLToPath(import.meta.url));
const usageScript = path.join(here, 'usage-state.mjs');

const readUsageState = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [usageScript, '--claude-logins', JSON.stringify(claudeLogins)], { stdio: ['ignore', 'pipe', 'ignore'] });
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
  // The billing read shares usage-state's spacing, retries and cache, under
  // its own account key.
  return liveRead(accountKey('grok', login.key), readGrokBilling(login), { toPool: grokPool });
};
const grokPool = (raw) => {
  const pool = poolFromRaw(raw);
  return pool && { ...pool, period: raw.period, estimated_start: raw.estimated_start };
};
const readGrokBilling = (login) => async () => {
  const { status, ok, body } = await fetchUsage(process.env.GROK_USAGE_URL
    || 'https://cli-chat-proxy.grok.com/v1/billing?format=credits', { authorization: `Bearer ${login.key}` }, 'billing endpoint');
  if (!ok) throw new Error(`billing endpoint answered ${status}`);
  const config = body?.config;
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
  const raw = start && { at: Date.now(), burst: null, period: type.toLowerCase(), estimated_start: new Date(start).toISOString(),
    week: { used: Math.min(Math.max(used, 0), 100), resets_at: end / 1000, window_hours: (end - start) / 3600000 } };
  if (!raw || !poolFromRaw(raw)) throw new Error(`billing period ${type ?? 'unknown'} cannot be paced`);
  return raw;
};

const [usageState, grok] = await Promise.all([
  readUsageState(),
  readGrok().then((read) => (read.pool ? { reading: read.pool, note: read.note }
    : { error: read.error?.message ?? 'billing read gave no reading' }), (error) => ({ error: error.message })),
]);

const accounts = {};
const account = (key, fields) => { accounts[key] = { state: 'unknown', reading: null, ...fields, instances: [] }; };
if (usageState.error) {
  for (const key of [...claudeLogins.map(({ name }) => `claude:${name}`), 'cursor_models', 'other_models']) account(key, { error: usageState.error });
} else {
  for (const [name, entry] of Object.entries(usageState.claude_identities)) {
    account(`claude:${name}`, { state: entry.state, reading: entry.pool, source: entry.source,
      secure_storage_dir: entry.secure_storage_dir,
      ...(entry.error ? { error: entry.error } : {}), ...(entry.note ? { note: entry.note } : {}) });
  }
  for (const key of ['cursor_models', 'other_models']) {
    const reading = usageState.cursor?.[key] ?? null;
    account(key, { state: usageState.states[key], reading: reading && { ...reading, resets_on: usageState.cursor.resets_on },
      ...(reading ? {} : { error: 'no Cursor /usage reading' }) });
  }
  for (const [name, entry] of Object.entries(usageState.codex_identities)) {
    account(`codex:${name}`, { state: entry.state, reading: entry.pool, source: entry.source, home: entry.home,
      ...(entry.error ? { error: entry.error } : {}), ...(entry.note ? { note: entry.note } : {}) });
  }
}
account('grok', grok.reading
  ? { state: poolState(grok.reading), reading: grok.reading, source: grok.note ? 'billing, cached' : 'billing',
    ...(grok.note ? { note: grok.note } : {}) }
  : { error: grok.error });

const fileId = (file) => { try { const s = fs.statSync(file); return `${s.dev}:${s.ino}`; } catch { return null; } };
const codexByLogin = new Map();
for (const [key, entry] of Object.entries(accounts)) {
  if (!key.startsWith('codex:')) continue;
  const id = fileId(path.join(entry.home, 'auth.json'));
  if (!id) continue;
  if (codexByLogin.has(id)) entry.same_account_as = codexByLogin.get(id);
  else codexByLogin.set(id, key);
}

const claudeByLogin = new Map();
for (const { name, secureStorageDir } of claudeLogins) {
  const key = `claude:${name}`;
  const location = secureStorageDir ?? '';
  if (claudeByLogin.has(location)) accounts[key].same_account_as = claudeByLogin.get(location);
  else claudeByLogin.set(location, key);
}

const darwin = process.platform === 'darwin';
const cursorLogin = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'cursor', 'auth.json');
const KEYCHAIN = 'on macOS this login may live in the Keychain, which no file comparison reaches; only the user can declare it';
const DRIVERS = {
  codex: { cli: ['codex'], loginFile: 'auth.json', fileProof: true, defaultProof: true,
    readers: () => [...codexByLogin].map(([id, key]) => ({ id, pools: [key] })), defaultPools: ['codex:default'] },
  claudeAgent: { cli: ['claude'], loginFile: '.credentials.json', fileProof: !darwin, defaultProof: !darwin,
    readers: () => [...claudeByLogin].map(([dir, key]) => ({
      id: fileId(path.join(dir || path.join(home, '.claude'), '.credentials.json')), pools: [key] })),
    defaultPools: claudeByLogin.has('') ? [claudeByLogin.get('')] : [] },
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
    if (spec.defaultProof && !spec.defaultPools.length) {
      return { pools: [], proof: null, launcher, note: 'default login has no recorded pool; declare its account' };
    }
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

const available = Object.entries(accounts)
  .filter(([, entry]) => entry.state === 'available' && entry.instances.length && !entry.same_account_as)
  .sort(([, a], [, b]) => byPace(a.reading, b.reading))
  .map(([key]) => key);

const ranked = rankCandidates(tiers, mapped, accounts);
const choice = chooseCandidate(ranked);

console.log(JSON.stringify({
  instances: mapped, accounts, available, alerts: usageState.alerts ?? [],
  ...(role ? { role, seats: resolveRole(roleConfig, capabilities, mapped, accounts) } : {}),
  ...(tiers.length ? { candidates: ranked.flat(), choice } : {}),
  ...(settingsError ? { settings_error: settingsError } : {}),
}, null, 1));
