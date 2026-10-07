#!/usr/bin/env node
// Read-only questions to a Codex account through `codex app-server` over
// stdio. Only the rate-limit read is allowed, so a caller can learn how much
// an account has left and never start a model turn. Each call spawns one
// short-lived server, runs the documented `initialize` → `initialized`
// handshake, sends the one request, and kills the server on the first answer,
// on timeout, or when the output grows past a bound.
//
// The account is chosen by `codexHome`: Codex keeps one login per
// `CODEX_HOME`, so the named home is the identity. Nothing in the home is
// read here; the server does its own reading and the caller receives only the
// JSON result of the request. The server's stderr is never surfaced: it can
// carry account diagnostics, and an error here only needs to say which step
// failed.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const CODEX_READ_METHODS = new Set(["account/rateLimits/read"]);

const CLIENT_INFO = { name: "t3-capacity-codex-rpc", title: "t3-capacity codex read helper", version: "1" };
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 1000;

const VERSION_TIMEOUT_MS = 5000;

// The Codex CLI to run: CODEX_BIN when set, else the first `codex` on PATH
// whose `--version` exits 0. A broken install earlier on PATH, such as an npm
// package missing its platform binary, would otherwise fail every read as an
// account that never answered. `--version` touches no account, so its error
// line, stripped of control characters, is safe to report. PATH entries
// resolve against the working directory, an empty one meaning that directory,
// and the result is kept per PATH and working directory.
const resolved = new Map();
// Terminal escape sequences, then any remaining control character.
const printable = (text) =>
  text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-_])/gu, "").replace(/[\p{Cc}]/gu, " ");
export const resolveCodexBinary = (env = process.env) => {
  if (env.CODEX_BIN?.trim()) return { binary: env.CODEX_BIN.trim() };
  const key = `${process.cwd()}\0${env.PATH ?? ""}`;
  if (resolved.has(key)) return resolved.get(key);
  const failures = [];
  let result = null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    const candidate = join(resolve(dir || "."), "codex");
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const probe = spawnSync(candidate, ["--version"], { env, encoding: "utf8", timeout: VERSION_TIMEOUT_MS });
    if (probe.status === 0) {
      result = { binary: candidate };
      break;
    }
    const lines = (probe.stderr ?? "").split("\n").map((line) => printable(line).trim()).filter(Boolean);
    const reason = probe.error?.message ?? (lines.find((line) => /^\w*Error\b/u.test(line)) ?? lines[0] ?? `exit ${probe.status}`);
    failures.push(`${candidate}: ${reason.slice(0, 200)}`);
  }
  result ??= {
    error: failures.length
      ? `no codex on PATH starts; set CODEX_BIN to a working codex (${failures.join("; ")})`
      : "codex is not on PATH; set CODEX_BIN",
  };
  resolved.set(key, result);
  return result;
};

// The home that identifies a Codex account. `default` is `~/.codex`; a named
// identity is `~/.codex-profiles/<name>`. Only simple names are accepted. A
// named home has to exist already — this helper reads accounts, it never makes
// one — while the default home is the CLI's own to create on first run.
const CODEX_IDENTITY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

const codexHomeFor = (identity = "default", { home = homedir() } = {}) => {
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
    const found = bin ? { binary: bin } : resolveCodexBinary(env);
    if (found.error) {
      rejectPromise(Object.assign(new Error(found.error), { startup: true }));
      return;
    }
    const { binary } = found;
    const home = codexHome ?? env.CODEX_HOME ?? join(homedir(), ".codex");
    let child;
    try {
      child = spawn(binary, ["app-server"], {
        cwd: homedir(),
        env: { ...env, CODEX_HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(Object.assign(new Error(`cannot run ${binary} app-server: ${error.message}`), { startup: true }));
      return;
    }
    let settled = false;
    // Until the server answers initialize, a failure means the CLI did not
    // start, which says nothing about the account.
    let started = false;
    const startupError = (message) => Object.assign(new Error(message), { startup: !started });
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
    child.on("error", (error) => finish(startupError(`cannot run ${binary} app-server: ${error.message}`)));
    child.on("close", (code) => {
      if (!settled) finish(startupError(`${binary} app-server exited ${code ?? -1} before answering ${method}`));
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
          started = true;
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
