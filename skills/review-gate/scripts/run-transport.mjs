#!/usr/bin/env node

// Runs a long ship-it command through whichever transport this machine has,
// and reports which one ran. `start` launches and returns immediately so a dual
// review can start both legs before waiting on either; `wait` blocks until one
// finishes and validates its completion receipt.
//
//   RUN=$(node run-transport.mjs start <caller pin> --label TEXT -- CMD [ARG...])
//   node run-transport.mjs wait --run-file "$(printf '%s' "$RUN" | jq -r .run_file)"
//
// Two backends, one receipt shape:
//   herdr — HERDR_ENV=1 and a caller pin: delegates to herdr-visible-run.mjs
//           unchanged, so the run lands in a labeled pane the user can watch
//           and interject in.
//   local — no Herdr: a detached child streams into a transcript file. Same
//           timeouts and same content validation, because those live in the
//           wrappers (headless-claude.mjs, headless-codex.mjs), never in the
//           pane. What a local run loses is the user's live observation and
//           interjection — the transcript is a file to tail, not a pane to type
//           into.
//
// Inside Herdr a missing or drifted pin is a hard stop, never a quiet demotion
// to an invisible process: the user expects to see a gate that Herdr is hosting.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  argReader,
  completionRecord,
  readCommandFile,
  sleepSync,
} from "./transport-lib.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const herdrRunner = join(scriptPath, "..", "herdr-visible-run.mjs");
const argv = process.argv.slice(2);
const mode = argv.shift();

const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const { take, commandAfterSeparator } = argReader(argv, fail);

const PIN_FLAGS = ["pane", "workspace", "tab-id", "as", "terminal-id", "repo-root"];
const POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 3600000;

const emit = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

// Reads a completion receipt and proves it belongs to this launch. Shared by
// both backends because both write the same shape — that sameness is what lets
// the gate's later steps stop caring which transport ran, and completionRecord
// in transport-lib.mjs is the single writer that makes it true.
const validateReceipt = (path, token, paneId, transport) => {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, reason: `cannot read completion receipt: ${path}` };
  }
  if (receipt?.token !== token) {
    return { ok: false, reason: `completion receipt token does not match this launch: ${path}` };
  }
  if ((receipt.pane_id ?? null) !== (paneId ?? null)) {
    return { ok: false, reason: `completion receipt pane does not match this launch: ${path}` };
  }
  if (receipt.transport !== transport) {
    return { ok: false, reason: `completion receipt records transport ${receipt.transport ?? "none"}, not the ${transport} run this launch started: ${path}` };
  }
  if (!Number.isInteger(receipt.exit_code) && typeof receipt.signal !== "string") {
    return { ok: false, reason: `completion receipt records no outcome: ${path}` };
  }
  return {
    ok: receipt.exit_code === 0,
    reason: receipt.exit_code === 0
      ? null
      : `command exited ${receipt.signal ? `on ${receipt.signal}` : receipt.exit_code}`,
    exit_code: receipt.exit_code,
    signal: receipt.signal ?? null,
    seconds: receipt.seconds ?? null,
    command: receipt.command ?? null,
    transcript: receipt.transcript ?? null,
  };
};

if (mode === "exec") {
  // The local backend's supervisor: detached from the caller, so it writes to
  // the transcript alone and reports through the receipt.
  const token = take("token");
  const receipt = take("receipt");
  const transcript = take("transcript");
  const commandFile = take("command-file");
  const cwd = take("cwd");
  const command = readCommandFile(commandFile, fail);
  unlinkSync(commandFile);
  if (argv.length) fail(`unexpected arguments: ${argv.join(" ")}`, 2);
  const started = Date.now();
  const transcriptFd = openSync(transcript, "w");
  const child = spawn(command[0], command.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const mirror = (chunk) => writeSync(transcriptFd, chunk);
  child.stdout.on("data", mirror);
  child.stderr.on("data", mirror);
  child.on("error", (error) => {
    writeSync(transcriptFd, `${error.message}\n`);
  });
  child.on("close", (code, signal) => {
    closeSync(transcriptFd);
    writeFileSync(
      receipt,
      `${JSON.stringify(
        completionRecord({
          transport: "local",
          paneId: null,
          token,
          command,
          code,
          signal,
          startedAt: started,
          transcript,
        }),
        null,
        2,
      )}\n`,
    );
    process.exit(code ?? 1);
  });
} else if (mode === "start") {
  const pin = Object.fromEntries(PIN_FLAGS.map((name) => [name, take(name, false)]));
  const label = take("label");
  const target = take("target-pane", false);
  const priorReceipt = take("prior-receipt", false);
  const priorToken = take("prior-token", false);
  const command = commandAfterSeparator();
  const pinned = PIN_FLAGS.filter((name) => pin[name]);

  if (process.env.HERDR_ENV === "1") {
    if (pinned.length !== PIN_FLAGS.length) {
      const missing = PIN_FLAGS.filter((name) => !pin[name]);
      fail(
        `HERDR_ENV=1 but the caller pin is incomplete (missing --${missing.join(", --")}). ` +
          "A gate hosted by Herdr runs in a pane the user can watch; rerun the caller pane proof " +
          "instead of demoting this run to an invisible process.",
      );
    }
    const forwarded = [
      target ? "run" : "start",
      ...PIN_FLAGS.flatMap((name) => [`--${name}`, pin[name]]),
      "--label",
      label,
      ...(target ? ["--target-pane", target] : []),
      ...(priorReceipt ? ["--prior-receipt", priorReceipt] : []),
      ...(priorToken ? ["--prior-token", priorToken] : []),
      "--",
      ...command,
    ];
    const outcome = spawnSync(process.execPath, [herdrRunner, ...forwarded], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (outcome.status !== 0) {
      fail(
        `herdr transport failed: ${outcome.stderr?.trim() || outcome.error?.message || `exit ${outcome.status}`}`,
      );
    }
    let started;
    try {
      started = JSON.parse(outcome.stdout);
    } catch {
      fail("herdr transport returned invalid JSON");
    }
    const runFile = join(tmpdir(), `ship-it-run-${started.token}.json`);
    const descriptor = { transport: "herdr", pid: null, ...started, run_file: runFile };
    writeFileSync(runFile, `${JSON.stringify(descriptor, null, 2)}\n`);
    emit(descriptor);
  } else {
    if (pinned.length) {
      fail(
        `caller pin passed (--${pinned.join(", --")}) without HERDR_ENV=1. ` +
          "Start Herdr for a visible run, or drop the pin to run locally.",
      );
    }
    if (target) fail("--target-pane needs the herdr transport; the local transport has no panes", 2);
    const cwd = process.cwd();
    if (!isAbsolute(cwd)) fail("cannot resolve an absolute working directory");
    const token = randomUUID();
    const receipt = join(tmpdir(), `ship-it-local-${token}.json`);
    const transcript = join(tmpdir(), `ship-it-local-${token}.log`);
    const commandFile = join(tmpdir(), `ship-it-command-${token}.json`);
    const runFile = join(tmpdir(), `ship-it-run-${token}.json`);
    writeFileSync(commandFile, `${JSON.stringify(command)}\n`, { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        "exec",
        "--token", token,
        "--receipt", receipt,
        "--transcript", transcript,
        "--command-file", commandFile,
        "--cwd", cwd,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    const descriptor = {
      transport: "local",
      started: true,
      pane_id: null,
      pid: child.pid,
      label,
      token,
      marker: null,
      receipt,
      transcript,
      run_file: runFile,
    };
    writeFileSync(runFile, `${JSON.stringify(descriptor, null, 2)}\n`);
    emit(descriptor);
  }
} else if (mode === "wait") {
  const runFile = take("run-file");
  const timeoutMs = parseInt(take("timeout-ms", false) ?? `${DEFAULT_TIMEOUT_MS}`, 10);
  let run;
  try {
    run = JSON.parse(readFileSync(runFile, "utf8"));
  } catch {
    fail(`cannot read run descriptor: ${runFile}`);
  }
  if (argv.length) fail(`unexpected arguments: ${argv.join(" ")}`, 2);

  if (run.transport === "herdr") {
    const outcome = spawnSync(
      "herdr",
      ["pane", "wait-output", run.pane_id, "--match", run.marker, "--timeout", `${timeoutMs}`],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (outcome.status !== 0 && !existsSync(run.receipt)) {
      // A marker timeout is the gate's current state, not silence: the caller
      // inspects the named pane rather than assuming the run is dead.
      emit({
        ok: false,
        transport: "herdr",
        reason: `no completion marker in pane ${run.pane_id} within ${timeoutMs}ms — inspect it with: herdr pane get ${run.pane_id}; herdr pane process-info ${run.pane_id}; herdr pane read ${run.pane_id} --source recent-unwrapped`,
        pane_id: run.pane_id,
        transcript: run.transcript,
      });
      process.exit(1);
    }
  } else if (run.transport === "local") {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(run.receipt)) {
      let alive = true;
      try {
        process.kill(run.pid, 0);
      } catch {
        alive = false;
      }
      // One more look after the supervisor exits: the receipt is written just
      // before it goes, so a dead pid and a present receipt is the normal race.
      if (!alive && !existsSync(run.receipt)) {
        emit({
          ok: false,
          transport: "local",
          reason: `supervisor ${run.pid} exited without writing a completion receipt`,
          transcript: run.transcript,
        });
        process.exit(1);
      }
      if (Date.now() > deadline) {
        emit({
          ok: false,
          transport: "local",
          reason: `no completion receipt within ${timeoutMs}ms — the run is still going; read its transcript: ${run.transcript}`,
          pid: run.pid,
          transcript: run.transcript,
        });
        process.exit(1);
      }
      sleepSync(POLL_MS);
    }
  } else {
    fail(`unknown transport in run descriptor: ${run.transport}`);
  }

  const result = validateReceipt(run.receipt, run.token, run.pane_id, run.transport);
  emit({
    transport: run.transport,
    pane_id: run.pane_id ?? null,
    receipt: run.receipt,
    ...result,
  });
  process.exit(result.ok ? 0 : 1);
} else {
  fail(
    "usage: run-transport.mjs start [<caller pin>] --label TEXT [--target-pane ID --prior-receipt PATH --prior-token TOKEN] -- COMMAND [ARG ...]\n" +
      "       run-transport.mjs wait --run-file PATH [--timeout-ms N]",
    2,
  );
}
