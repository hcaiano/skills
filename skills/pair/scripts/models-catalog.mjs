#!/usr/bin/env node
// Read-only inventory of CLI releases and the models their current catalogs
// expose. A failed source stays visible as an error on that source.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexBinary, codexHomeFor, codexModelCatalog } from "./codex-rpc.mjs";
import { CODEX_ID, CURSOR_LINE, CURSOR_VERSION, GROK_LINE, compareVersions, pickLatestGrok } from "./pair-headless.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rosterPath = join(here, "../references/models.md");
const semverPattern = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/u;
const timeoutMs = 10000;
const update = {
  codex: "codex update",
  grok: "grok update",
  opencode: "opencode upgrade",
  claude: "claude update",
  "cursor-agent": "cursor-agent update",
};

const run = (bin, args, { cwd = homedir(), env = process.env, timeout = timeoutMs } = {}) => new Promise((resolve) => {
  let child;
  try { child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { resolve({ error: error.message, missing: error.code === "ENOENT" }); return; }
  let stdout = "";
  let stderr = "";
  let finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolve(result);
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish({ error: `${bin} ${args.join(" ")} timed out` });
  }, timeout);
  child.on("error", (error) => finish({ error: error.message, missing: error.code === "ENOENT" }));
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > 1024 * 1024) {
      child.kill("SIGKILL");
      finish({ error: `${bin} ${args.join(" ")} produced too much output` });
    }
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-500); });
  child.on("close", (code) => finish(code === 0
    ? { stdout: stdout.trim() }
    : { error: `${bin} ${args.join(" ")} exited ${code}: ${stderr.trim()}` }));
});

const versionFrom = (text) => text?.match(semverPattern)?.[0] ?? null;
const semverParts = (version) => {
  const [coreAndPre] = version.split("+");
  const [core, ...pre] = coreAndPre.split("-");
  return { core: core.split(".").map(Number), pre: pre.join("-").split(".").filter(Boolean) };
};
export const compareSemver = (left, right) => {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return Math.sign(a.core[i] - b.core[i]);
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] == null || b.pre[i] == null) return a.pre[i] == null ? -1 : 1;
    if (a.pre[i] === b.pre[i]) continue;
    const an = /^\d+$/u.test(a.pre[i]);
    const bn = /^\d+$/u.test(b.pre[i]);
    if (an && bn) return Math.sign(Number(a.pre[i]) - Number(b.pre[i]));
    if (an !== bn) return an ? -1 : 1;
    return a.pre[i] < b.pre[i] ? -1 : 1;
  }
  return 0;
};

const latestVersion = async (name, env) => {
  if (name === "cursor-agent") return { latest: null, note: "No check-only command; cursor-agent update installs the newest release" };
  if (name === "claude") {
    try {
      const response = await fetch(env.MODELS_CATALOG_CLAUDE_LATEST_URL || "https://downloads.claude.ai/claude-code-releases/latest", {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { latest: null, error: `Claude release endpoint returned ${response.status}` };
      const latest = versionFrom((await response.text()).trim());
      return latest ? { latest } : { latest: null, error: "Claude release endpoint returned no version" };
    } catch (error) { return { latest: null, error: `Claude release lookup failed: ${error.message}` }; }
  }
  if (name === "grok") {
    const result = await run("grok", ["update", "--check", "--json"], { env });
    if (result.error) return { latest: null, error: result.error };
    try {
      const body = JSON.parse(result.stdout);
      if (body.error) return { latest: null, error: String(body.error) };
      const latest = versionFrom(body.latestVersion);
      return latest ? { latest } : { latest: null, error: "Grok update check returned no latestVersion" };
    } catch { return { latest: null, error: "Grok update check returned invalid JSON" }; }
  }
  const pkg = name === "codex" ? "@openai/codex" : "opencode-ai";
  const registry = env.MODELS_CATALOG_NPM_REGISTRY_URL || "https://registry.npmjs.org/";
  const result = await run("npm", ["view", pkg, "version", "--registry", registry], { cwd: homedir(), env });
  if (result.error) return { latest: null, error: result.error };
  const latest = versionFrom(result.stdout);
  return latest ? { latest } : { latest: null, error: `npm returned no version for ${pkg}` };
};

const inspectCli = async (name, offline, env) => {
  const bin = name === "codex" ? codexBinary(env) : name;
  const [installedResult, release] = await Promise.all([
    run(bin, ["--version"], { env }),
    offline ? Promise.resolve({ latest: null }) : latestVersion(name, env),
  ]);
  const installed = versionFrom(installedResult.stdout);
  const latest = release.latest;
  // CODEX_BIN may select an install other than PATH's: update the one inspected.
  const command = name === "codex" && bin !== "codex" ? `${bin} update` : update[name];
  const result = { installed, latest, outdated: installed && latest ? compareSemver(installed, latest) < 0 : null, update: command };
  if (release.note) result.note = release.note;
  if (installedResult.error && !installedResult.missing) result.error = installedResult.error;
  else if (!installedResult.missing && !installed) result.error = `${bin} --version returned no version`;
  if (release.error && !installedResult.missing) result.error = result.error ? `${result.error}; ${release.error}` : release.error;
  return result;
};

const newest = (current, candidate) => !current || compareVersions(candidate.version, current.version) > 0
  || (compareVersions(candidate.version, current.version) === 0 && candidate.id.endsWith("-high") && !current.id.endsWith("-high"))
  ? candidate : current;
const display = (candidates) => Object.fromEntries(
  [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([family, value]) => [family, value.id]),
);

const codexFamilies = (catalog) => {
  const result = new Map();
  for (const entry of catalog.data) {
    if (entry?.hidden === true) continue;
    const id = typeof entry?.model === "string" ? entry.model : entry?.id;
    const match = id?.match(CODEX_ID);
    if (match) result.set(match[2], newest(result.get(match[2]), { id, version: match[1] }));
  }
  return result;
};

const grokFamilies = (listing) => {
  const result = new Map();
  const names = new Set();
  for (const line of listing.split("\n")) {
    const match = line.match(GROK_LINE);
    if (match) names.add(match[1].toLowerCase());
  }
  for (const name of names) {
    const picked = pickLatestGrok(listing, name);
    if (!picked.error) result.set(name, { id: picked.model, version: picked.model.slice(name.length + 1) });
  }
  return result;
};

const cursorVersion = new RegExp(`^([a-z][a-z0-9]*)-${CURSOR_VERSION}(?:-[a-z0-9]+)*$`, "iu");
const cursorFamilies = (listing) => {
  const result = new Map();
  for (const line of listing.split("\n")) {
    const id = line.match(CURSOR_LINE)?.[1];
    if (!id || id.startsWith("gpt-") || id.endsWith("-fast") || id.includes("-thinking-")) continue;
    const plain = id.replace(/-(?:none|minimal|low|medium|high|xhigh|max)$/iu, "");
    const unprefixed = plain.replace(/^(?:claude|muse|cursor)-/iu, "");
    const match = unprefixed.match(cursorVersion);
    if (!match) continue;
    const family = match[1].toLowerCase();
    const version = match[2].replace(/^[a-z]/iu, "").replaceAll("-", ".");
    result.set(family, newest(result.get(family), { id, version }));
  }
  return result;
};

const codexCatalog = async (identity, env) => {
  const home = codexHomeFor(identity, { home: homedir() });
  if (home.error) return { error: home.error };
  try {
    return { models: codexFamilies(await codexModelCatalog({ codexHome: home.codexHome, bin: codexBinary(env), env })) };
  } catch (error) { return { error: error.message }; }
};
const listedCatalog = async (bin, args, parser, env) => {
  const listing = await run(bin, args, { env, timeout: 30000 });
  return listing.error ? { error: listing.error } : { models: parser(listing.stdout) };
};

// The three catalogs are independent: read them together.
const familyCatalog = async (identity, env) => {
  const families = { claude: { models: {}, note: "Claude has no model catalog; its alias is verified by session init" } };
  const raw = {};
  const reads = await Promise.all([
    ["codex", codexCatalog(identity, env)],
    ["grok", listedCatalog("grok", ["models"], grokFamilies, env)],
    ["cursor", listedCatalog("cursor-agent", ["--list-models"], cursorFamilies, env)],
  ].map(async ([name, read]) => [name, await read]));
  for (const [name, read] of reads) {
    families[name] = { models: read.models ? display(read.models) : {}, ...(read.error ? { error: read.error } : {}) };
    if (read.models) raw[name] = read.models;
  }
  return { families, raw };
};

const roster = (source) => {
  const rows = [...source.matchAll(/^\| `([a-z0-9]+)` \| ([a-z, ]+) \| `([^`]+)` \|$/gmu)]
    .map(([, family, harnesses, example]) => ({ family, harnesses: harnesses.split(",").map((name) => name.trim()), example }));
  const known = new Set([...source.matchAll(/`([a-z][a-z0-9]*)`/gu)].map(([, token]) => token));
  return { rows, known };
};

const exampleVersion = (row, harness) => {
  if (harness === "codex") return row.example.match(CODEX_ID)?.[1] ?? null;
  if (harness === "grok") return row.example.startsWith(`${row.family}-`) ? row.example.slice(row.family.length + 1) : null;
  const plain = row.example.replace(/^(?:claude|muse|cursor)-/iu, "").replace(/-(?:none|minimal|low|medium|high|xhigh|max)$/iu, "");
  const match = plain.match(cursorVersion);
  return match?.[1] === row.family ? match[2].replace(/^[a-z]/iu, "").replaceAll("-", ".") : null;
};

export const report = async ({ offline = false, identity = "default", env = process.env, rosterText = readFileSync(rosterPath, "utf8") } = {}) => {
  const names = Object.keys(update);
  const clis = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await inspectCli(name, offline, env)])));
  const { families, raw } = await familyCatalog(identity, env);
  const { rows, known } = roster(rosterText);
  const unknown_families = [];
  for (const [harness, models] of Object.entries(raw)) {
    for (const [family, value] of models) {
      if (![...known].some((token) => family === token || family.startsWith(`${token}-`)))
        unknown_families.push({ harness, family, id: value.id });
    }
  }
  const stale_examples = [];
  for (const row of rows) {
    // The example names one harness's ID; any listed catalog may be ahead of it.
    const version = row.harnesses.map((harness) => exampleVersion(row, harness)).find(Boolean);
    for (const harness of row.harnesses.filter((name) => raw[name])) {
      const current = raw[harness].get(row.family);
      if (current && version && compareVersions(current.version, version) > 0)
        stale_examples.push({ harness, family: row.family, example: row.example, newest: current.id });
    }
  }
  return { clis, families, unknown_families, stale_examples };
};

// Installed skills are reached through symlinks, so compare real paths.
const invokedAsMain = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedAsMain) {
  const args = process.argv.slice(2);
  const valid = args.every((arg, index) => arg === "--offline" || (arg === "--identity" && args[index + 1] && !args[index + 1].startsWith("--")) || args[index - 1] === "--identity");
  if (!valid || args.filter((arg) => arg === "--offline").length > 1 || args.filter((arg) => arg === "--identity").length > 1) {
    process.stderr.write("usage: models-catalog.mjs [--offline] [--identity <name>]\n");
    process.exitCode = 2;
  } else {
    report({ offline: args.includes("--offline"), identity: args.includes("--identity") ? args[args.indexOf("--identity") + 1] : "default" })
      .then((result) => { process.stdout.write(`${JSON.stringify(result)}\n`); })
      .catch((error) => { process.stdout.write(`${JSON.stringify({ error: error.message })}\n`); });
  }
}
