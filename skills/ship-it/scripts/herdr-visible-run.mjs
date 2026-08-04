#!/usr/bin/env node

// Run a long ship-it command in a visible shell pane inside the caller's
// transcript-proven Herdr tab. `start` creates the pane; `run` reuses one
// previously created by this helper. Both return immediately with a marker,
// receipt path, and transcript path. The child mode streams output in the pane
// while recording the same bytes for the gate receipt.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const mode = argv.shift();
let cleanupPane = null;
let cleanupCommandFile = null;

const fail = (message, code = 1) => {
  if (cleanupCommandFile && existsSync(cleanupCommandFile)) {
    unlinkSync(cleanupCommandFile);
    cleanupCommandFile = null;
  }
  if (cleanupPane) {
    spawnSync("herdr", ["pane", "close", cleanupPane], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    cleanupPane = null;
  }
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const take = (name, required = true) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    if (required) fail(`missing --${name}`, 2);
    return null;
  }
  const value = argv[index + 1];
  if (!value || value === "--") fail(`missing value for --${name}`, 2);
  argv.splice(index, 2);
  return value;
};

const commandAfterSeparator = () => {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) {
    fail("missing command after --", 2);
  }
  const command = argv.slice(separator + 1);
  argv.splice(separator);
  if (argv.length) fail(`unexpected arguments: ${argv.join(" ")}`, 2);
  return command;
};

const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });

const herdrCommand = (...args) => {
  const outcome = run("herdr", args);
  if (outcome.status !== 0) {
    fail(
      `herdr ${args.join(" ")} failed: ${
        outcome.stderr?.trim() || outcome.error?.message || `exit ${outcome.status}`
      }`,
    );
  }
  return outcome.stdout;
};

const herdrResult = (...args) => {
  const output = herdrCommand(...args);
  try {
    return JSON.parse(output).result;
  } catch {
    fail(`herdr ${args.join(" ")} returned invalid JSON`);
  }
};

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
const sleepSync = (milliseconds) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const doneMarker = (token) => `SHIP_IT_VISIBLE_DONE ${token}`;

// The caller and target checks differ only in what they assert, so the fetch,
// the malformed-record hard stop, and the executable extraction live here once.
const foregroundProcesses = (paneId, role, allowTransient = false) => {
  const info = herdrResult("pane", "process-info", "--pane", paneId)?.process_info;
  if (!info || info.pane_id !== paneId || !Array.isArray(info.foreground_processes)) {
    if (allowTransient) return null;
    fail(`herdr returned malformed process info for ${role} ${paneId}`);
  }
  const processes = [];
  for (const entry of info.foreground_processes) {
    // herdr omits argv for processes whose full command line it cannot read
    // (npx/bunx wrappers, some helpers). Identity still resolves through
    // name/argv0/cwd, so validate argv only when it is present.
    if (
      entry === null ||
      typeof entry !== "object" ||
      (Object.hasOwn(entry, "argv") &&
        (!Array.isArray(entry.argv) ||
          !entry.argv.every((part) => typeof part === "string")))
    ) {
      if (allowTransient) return null;
      fail(`herdr returned malformed foreground process for ${role} ${paneId}`);
    }
    processes.push({
      argv: entry.argv ?? [],
      cwd: entry.cwd,
      executables: [entry.name, entry.argv0, entry.argv?.[0]]
        .filter((value) => typeof value === "string")
        .map((value) => basename(value).toLowerCase()),
    });
  }
  return processes;
};

const validateCaller = ({ pane, workspace, tabId, terminalId, agent, repoRoot }) => {
  if (process.env.HERDR_ENV !== "1") fail("ship-it visible runs require HERDR_ENV=1");
  if (!["claude", "codex"].includes(agent)) fail(`unsupported caller agent: ${agent}`);
  if (!isAbsolute(repoRoot)) fail("--repo-root must be absolute");
  const root = run("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"]);
  if (
    root.status !== 0 ||
    realpathSync(root.stdout.trim()) !== realpathSync(repoRoot)
  ) {
    fail(`--repo-root is not the exact Git root: ${repoRoot}`);
  }
  const live = herdrResult("pane", "get", pane)?.pane;
  if (
    !live ||
    live.pane_id !== pane ||
    live.workspace_id !== workspace ||
    live.tab_id !== tabId ||
    live.terminal_id !== terminalId ||
    live.agent !== agent
  ) {
    fail(`caller pin drifted for ${pane}; rerun transcript proof`);
  }
  const hosted = foregroundProcesses(pane, "caller").some(
    (entry) => entry.executables.includes(agent) && entry.cwd === repoRoot,
  );
  if (!hosted) {
    fail(`pane ${pane} no longer hosts ${agent} at ${repoRoot}; rerun caller proof`);
  }
  return live;
};

const SHELLS = new Set(
  ["sh", "bash", "zsh", "fish", "dash", basename(process.env.SHELL ?? "")]
    .filter(Boolean)
    .map((name) => name.toLowerCase()),
);

// A freshly split pane needs a moment to exec its shell; a reused pane must be
// idle already. Backoff settles the common case on the first probe instead of
// spending twenty of them.
const STARTUP_BACKOFF_MS = [25, 50, 100, 200, 400, 800, 1600];
const LAUNCH_BACKOFF_MS = [25, 50, 100, 200, 400, 800, 1600];

const validateTarget = (paneId, caller, repoRoot, allowStartupWait) => {
  const pane = herdrResult("pane", "get", paneId)?.pane;
  if (
    !pane ||
    pane.pane_id !== paneId ||
    pane.workspace_id !== caller.workspace_id ||
    pane.tab_id !== caller.tab_id ||
    pane.cwd !== repoRoot ||
    pane.agent
  ) {
    fail(`target ${paneId} is not an available shell pane in the pinned unit`);
  }
  const backoff = allowStartupWait ? STARTUP_BACKOFF_MS : [];
  for (let attempt = 0; ; attempt++) {
    const foreground =
      foregroundProcesses(paneId, "target", allowStartupWait) ?? [];
    const available =
      foreground.length > 0 &&
      foreground.every(
        (entry) =>
          entry.cwd === repoRoot &&
          entry.executables.some((name) => SHELLS.has(name)),
      );
    if (available) return pane;
    if (attempt >= backoff.length) break;
    sleepSync(backoff[attempt]);
  }
  fail(`target ${paneId} is busy; wait for its command to finish before reuse`);
};

const validatePriorReceipt = (path, paneId, expectedToken) => {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`cannot read prior completion receipt: ${path}`);
  }
  if (
    !receipt ||
    receipt.pane_id !== paneId ||
    receipt.token !== expectedToken ||
    !Array.isArray(receipt.command) ||
    typeof receipt.transcript !== "string" ||
    (!Number.isInteger(receipt.exit_code) && typeof receipt.signal !== "string")
  ) {
    fail(`prior completion receipt does not own pane ${paneId}`);
  }
};

const confirmLaunch = (paneId, receipt) => {
  for (let attempt = 0; ; attempt++) {
    if (existsSync(receipt)) return;
    const running = (foregroundProcesses(paneId, "launched command", true) ?? []).some(
      (entry) =>
        entry.executables.includes("node") &&
        entry.argv.some((part) => basename(part) === basename(scriptPath)) &&
        entry.argv.includes("exec"),
    );
    if (running) return;
    if (attempt >= LAUNCH_BACKOFF_MS.length) break;
    sleepSync(LAUNCH_BACKOFF_MS[attempt]);
  }
  fail(`pane ${paneId} did not start the requested command`);
};

const createPane = (pin) => {
  const layout = herdrResult("pane", "layout", "--pane", pin.pane)?.layout;
  if (
    !layout ||
    layout.workspace_id !== pin.workspace ||
    layout.tab_id !== pin.tabId
  ) {
    fail(`layout drifted for caller pane ${pin.pane}`);
  }
  const area = layout.panes?.find((item) => item.pane_id === pin.pane)?.rect;
  const created = herdrResult(
    "pane",
    "split",
    pin.pane,
    "--direction",
    area?.width >= 100 ? "right" : "down",
    "--ratio",
    "0.42",
    "--cwd",
    pin.repoRoot,
    "--no-focus",
  )?.pane;
  if (!created?.pane_id) fail("herdr pane split returned no pane ID");
  cleanupPane = created.pane_id;
  // Herdr detects the agent this pane is about to run as a real agent in the
  // caller's tab, which makes a live herdr-pair look ambiguous and silences the
  // pair channel for the whole gate. Declare the pane for what it is so the
  // pair helper can skip it; an undeclared extra agent must still be ambiguous.
  herdrResult(
    "pane",
    "report-metadata",
    created.pane_id,
    "--source",
    "ship-it",
    "--token",
    "role=process-pane",
  );
  return created.pane_id;
};

const launch = (targetPane, cwd, label, command) => {
  const token = randomUUID();
  const receipt = join(tmpdir(), `ship-it-visible-${token}.json`);
  const transcript = join(tmpdir(), `ship-it-visible-${token}.log`);
  const commandFile = join(tmpdir(), `ship-it-command-${token}.json`);
  writeFileSync(commandFile, `${JSON.stringify(command)}\n`, { mode: 0o600 });
  cleanupCommandFile = commandFile;
  const childCommand = [
    process.execPath,
    scriptPath,
    "exec",
    "--pane",
    targetPane,
    "--cwd",
    cwd,
    "--token",
    token,
    "--receipt",
    receipt,
    "--transcript",
    transcript,
    "--command-file",
    commandFile,
  ]
    .map(shellQuote)
    .join(" ");
  herdrResult("pane", "rename", targetPane, label);
  herdrCommand("pane", "run", targetPane, childCommand);
  confirmLaunch(targetPane, receipt);
  cleanupCommandFile = null;
  process.stdout.write(
    `${JSON.stringify(
      {
        started: true,
        pane_id: targetPane,
        label,
        token,
        marker: doneMarker(token),
        receipt,
        transcript,
      },
      null,
      2,
    )}\n`,
  );
};

if (mode === "exec") {
  const pane = take("pane");
  const cwd = take("cwd");
  const token = take("token");
  const receipt = take("receipt");
  const transcript = take("transcript");
  const commandFile = take("command-file");
  cleanupCommandFile = commandFile;
  let command;
  try {
    command = JSON.parse(readFileSync(commandFile, "utf8"));
  } catch {
    fail(`cannot read command file: ${commandFile}`);
  }
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string")
  ) {
    fail(`command file contains invalid argv: ${commandFile}`);
  }
  unlinkSync(commandFile);
  cleanupCommandFile = null;
  if (argv.length) fail(`unexpected arguments: ${argv.join(" ")}`, 2);
  const started = Date.now();
  const transcriptFd = openSync(transcript, "w");
  const child = spawn(command[0], command.slice(1), {
    cwd,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const mirror = (stream) => (chunk) => {
    writeSync(transcriptFd, chunk);
    stream.write(chunk);
  };
  child.stdout.on("data", mirror(process.stdout));
  child.stderr.on("data", mirror(process.stderr));
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
  });
  child.on("close", (code, signal) => {
    closeSync(transcriptFd);
    const result = {
      ok: code === 0,
      pane_id: pane,
      token,
      command,
      exit_code: code,
      signal,
      seconds: Math.round((Date.now() - started) / 1000),
      transcript,
    };
    writeFileSync(receipt, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(
      `\n${doneMarker(token)} exit=${code ?? "signal"} receipt=${receipt}\n`,
    );
    process.exit(code ?? 1);
  });
} else if (mode === "start" || mode === "run") {
  const pin = {
    pane: take("pane"),
    workspace: take("workspace"),
    tabId: take("tab-id"),
    terminalId: take("terminal-id"),
    agent: take("as"),
    repoRoot: take("repo-root"),
  };
  const label = take("label");
  const target = mode === "run" ? take("target-pane") : null;
  const priorReceipt = mode === "run" ? take("prior-receipt") : null;
  const priorToken = mode === "run" ? take("prior-token") : null;
  const command = commandAfterSeparator();
  const caller = validateCaller(pin);
  if (target) validatePriorReceipt(priorReceipt, target, priorToken);
  // Every failure below routes through fail(), which closes cleanupPane before
  // exiting — so a pane created here is never left behind.
  const targetPane = target ?? createPane(pin);
  validateTarget(targetPane, caller, pin.repoRoot, true);
  launch(targetPane, pin.repoRoot, label, command);
  cleanupPane = null;
} else {
  fail(
    "usage: herdr-visible-run.mjs start|run <caller pin> --label TEXT [--target-pane ID --prior-receipt PATH --prior-token TOKEN] -- COMMAND [ARG ...]",
    2,
  );
}
