#!/usr/bin/env node
// Read-only questions to a Codex account through `codex app-server` over
// stdio. Exactly three methods are allowed — account, rate limits, and the
// model catalog — so a caller can learn what an account is and what it can
// run, and never start a model turn. Each call spawns one short-lived server,
// runs the documented `initialize` → `initialized` handshake, sends the one
// request, and kills the server on the first answer, on timeout, or when the
// output grows past a bound.
//
// The account is chosen by `codexHome`: Codex keeps one login per
// `CODEX_HOME`, so the named home is the identity. Nothing in the home is
// read here; the server does its own reading and the caller receives only the
// JSON result of the request. The server's stderr is never surfaced: it can
// carry account diagnostics, and an error here only needs to say which step
// failed.
//
// The binary matters as much as the home: two Codex installs on one machine
// publish different catalogs (2026-09-07: 0.147.0 on PATH had no Astra, the
// 0.153.4 app binary did). `CODEX_BIN` names the binary explicitly; the
// portable default is `codex` on PATH, and the caller records which one it
// verified so the catalog it resolved against is the binary it later runs.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export const CODEX_READ_METHODS = new Set([
  "account/read",
  "account/rateLimits/read",
  "model/list",
]);

const CLIENT_INFO = { name: "pair-codex-rpc", title: "pair codex read helper", version: "1" };
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 1000;
// A catalog is a handful of pages at most; a server that keeps paginating is
// looping, and the cursor loop below stops rather than follow it forever.
const MAX_CATALOG_PAGES = 20;

export const codexBinary = (env = process.env) => (env.CODEX_BIN?.trim() ? env.CODEX_BIN.trim() : "codex");

// The binary is verified by asking it for its version — the one call that
// needs no account and no server — so a typo in CODEX_BIN or a missing
// install fails here, before a catalog read is trusted or a session is made.
export const verifyCodexBinary = (bin, { env = process.env } = {}) => {
  // Pin the executable selected on PATH, not the word `codex`: a resumed
  // caller may have a different PATH order. Preserve the selected shim path.
  const candidates = bin.includes("/") ? [resolve(bin)]
    : (env.PATH ?? "").split(delimiter).map((directory) => resolve(directory, bin));
  const executable = candidates.find((candidate) => {
    try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
  });
  if (!executable) return { error: `cannot run ${bin} --version: executable not found` };
  const run = spawnSync(executable, ["--version"], { encoding: "utf8", env, timeout: 15000 });
  if (run.error) return { error: `cannot run ${bin} --version: ${run.error.message}` };
  if (run.status !== 0) return { error: `${bin} --version exited ${run.status}` };
  const version = run.stdout.trim().match(/\d+\.\d+\.\d+\S*/u)?.[0] ?? run.stdout.trim().split("\n")[0];
  return { bin: executable, version: version || null };
};

// The home that identifies a Codex account. `default` is `~/.codex`; a named
// identity is `~/.codex-profiles/<name>`. Only simple names are accepted. A
// named home has to exist already — this helper reads accounts, it never makes
// one — while the default home is the CLI's own to create on first run.
export const CODEX_IDENTITY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export const codexHomeFor = (identity = "default", { home = homedir() } = {}) => {
  const name = identity ?? "default";
  if (!CODEX_IDENTITY_NAME.test(name)) {
    return { error: `invalid identity name ${JSON.stringify(name)} — use letters, digits, _ or -` };
  }
  const path = name === "default" ? join(home, ".codex") : join(home, ".codex-profiles", name);
  try {
    const real = realpathSync(path);
    if (!statSync(real).isDirectory()) return { error: `identity home ${path} is not a directory` };
    return { identity: name, codexHome: real };
  } catch (error) {
    if (name === "default" && error?.code === "ENOENT") return { identity: name, codexHome: path };
    return { error: `identity ${name} has no Codex home at ${path}: ${error.message}` };
  }
};

// Every Codex home on this machine, by identity name. Names only — no file
// inside a home is opened. A profile directory literally named `default`
// cannot shadow the base home.
export const listCodexHomes = ({ home = homedir() } = {}) => {
  const homes = {};
  const base = codexHomeFor("default", { home });
  if (!base.error) homes.default = base.codexHome;
  let entries = [];
  try {
    entries = readdirSync(join(home, ".codex-profiles"), { withFileTypes: true });
  } catch {
    return homes;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !CODEX_IDENTITY_NAME.test(entry.name) || entry.name === "default") continue;
    const named = codexHomeFor(entry.name, { home });
    if (!named.error) homes[entry.name] = named.codexHome;
  }
  return homes;
};

export const codexRead = (
  method,
  params = {},
  { codexHome, timeoutMs = 15000, bin, maxBytes = DEFAULT_MAX_BYTES, env = process.env } = {},
) =>
  new Promise((resolvePromise, rejectPromise) => {
    if (!CODEX_READ_METHODS.has(method)) {
      rejectPromise(new Error(`codexRead allows only ${[...CODEX_READ_METHODS].join(", ")}, not ${method}`));
      return;
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      rejectPromise(new Error(`codexRead needs a positive finite timeoutMs, got ${timeoutMs}`));
      return;
    }
    const binary = bin ?? codexBinary(env);
    const home = codexHome ?? env.CODEX_HOME ?? join(homedir(), ".codex");
    let child;
    try {
      child = spawn(binary, ["app-server"], {
        cwd: homedir(),
        env: { ...env, CODEX_HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(new Error(`cannot run ${binary} app-server: ${error.message}`));
      return;
    }
    let settled = false;
    let buffered = "";
    let bytes = 0;
    let timer = null;
    let killTimer = null;
    // Kill by PID with a bounded escalation: TERM first, KILL after the grace
    // period, so a server that ignores TERM cannot outlive the caller. The
    // pipes are destroyed too, so no late chunk reaches a settled promise.
    const stop = () => {
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try {
          stream?.destroy();
        } catch {
          /* already closed */
        }
      }
      try {
        child.kill("SIGTERM");
      } catch {
        return;
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        finish(new Error(`cannot write to ${binary} app-server: ${error.message}`));
      }
    };
    timer = setTimeout(() => finish(new Error(`${binary} app-server did not answer ${method} within ${timeoutMs}ms`)), timeoutMs);
    child.on("error", (error) => finish(new Error(`cannot run ${binary} app-server: ${error.message}`)));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`${binary} app-server exited ${code ?? -1} before answering ${method}`));
      clearTimeout(killTimer);
    });
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {}); // drained, never surfaced
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        finish(new Error(`${binary} app-server produced more than ${maxBytes} bytes answering ${method}`));
        return;
      }
      buffered += chunk.toString("utf8");
      let newline;
      while (!settled && (newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(new Error(`${binary} app-server initialize failed: ${message.error.message ?? "unknown error"}`));
            return;
          }
          send({ method: "initialized" });
          send({ id: 2, method, params });
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error(`${binary} app-server ${method} failed: ${message.error.message ?? "unknown error"}`));
          } else {
            finish(null, message.result ?? null);
          }
          return;
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: CLIENT_INFO } });
  });

// The complete visible catalog: every `model/list` page, followed by cursor
// until the server reports none. A repeated cursor or more pages than any
// real catalog has is a looping server, and the read fails rather than spin.
export const codexModelCatalog = async ({ codexHome, bin, env = process.env, timeoutMs } = {}) => {
  const data = [];
  const cursors = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const params = cursor ? { cursor } : {};
    const result = await codexRead("model/list", params, { codexHome, bin, env, ...(timeoutMs ? { timeoutMs } : {}) });
    if (Array.isArray(result?.data)) data.push(...result.data);
    const next = result?.nextCursor ?? null;
    if (next == null || next === "") return { data, pages: page + 1 };
    if (typeof next !== "string" || cursors.has(next)) {
      throw new Error(`model/list repeated cursor ${JSON.stringify(next)} on page ${page + 1} — refusing to loop`);
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error(`model/list did not end within ${MAX_CATALOG_PAGES} pages — refusing to loop`);
};
