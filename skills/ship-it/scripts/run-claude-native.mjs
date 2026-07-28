#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

const MODES = {
  simplify: {
    prompt: "/simplify",
    permissionMode: "acceptEdits",
    totalTimeoutSeconds: 60 * 60,
    idleTimeoutSeconds: 20 * 60,
  },
  review: {
    prompt: "/code-review",
    permissionMode: "plan",
    totalTimeoutSeconds: 45 * 60,
    idleTimeoutSeconds: 20 * 60,
  },
};

function fail(message) {
  process.stderr.write(`[ship-it/claude] ${message}\n`);
  process.exit(2);
}

function positiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const mode = argv.shift();
  if (!(mode in MODES)) {
    fail("usage: run-claude-native.mjs <simplify|review> [--total-timeout-seconds N] [--idle-timeout-seconds N]");
  }

  const options = {
    mode,
    totalTimeoutSeconds: MODES[mode].totalTimeoutSeconds,
    idleTimeoutSeconds: MODES[mode].idleTimeoutSeconds,
  };

  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) {
      fail(`${flag} requires a value`);
    }
    if (flag === "--total-timeout-seconds") {
      options.totalTimeoutSeconds = positiveInteger(value, flag);
    } else if (flag === "--idle-timeout-seconds") {
      options.idleTimeoutSeconds = positiveInteger(value, flag);
    } else {
      fail(`unknown option: ${flag}`);
    }
  }

  return options;
}

function git(args, { allowFailure = false, encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function statusSnapshot() {
  return git(
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    { encoding: "buffer" },
  ).stdout;
}

function workspaceFingerprint(repoRoot) {
  const hash = createHash("sha256");
  hash.update(git(["rev-parse", "HEAD"], { encoding: "buffer" }).stdout);
  hash.update(statusSnapshot());
  hash.update(git(["diff", "--binary", "HEAD", "--"], { encoding: "buffer" }).stdout);

  const untracked = git(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "buffer" },
  ).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();

  for (const relativePath of untracked) {
    const absolutePath = resolve(repoRoot, relativePath);
    const stat = lstatSync(absolutePath);
    hash.update(relativePath);
    hash.update(String(stat.mode));
    if (stat.isSymbolicLink()) {
      hash.update(readlinkSync(absolutePath));
    } else if (stat.isFile()) {
      hash.update(readFileSync(absolutePath));
    }
  }
  return hash.digest("hex");
}

function stashRefForSha(sha) {
  const result = git(["stash", "list", "--format=%gd %H"]);
  for (const line of result.stdout.split("\n")) {
    const [ref, candidate] = line.trim().split(/\s+/, 2);
    if (candidate === sha) {
      return ref;
    }
  }
  return null;
}

function dropStash(sha) {
  if (!sha) return;
  const ref = stashRefForSha(sha);
  if (!ref) {
    throw new Error(`could not locate safety stash ${sha}`);
  }
  git(["stash", "drop", ref]);
}

function createSafetySnapshot(runId, baselineStatus) {
  if (baselineStatus.length === 0) {
    return null;
  }
  git(["stash", "push", "--include-untracked", "--message", `ship-it-baseline:${runId}`]);
  const sha = git(["rev-parse", "refs/stash"]).stdout.trim();
  git(["stash", "apply", "--index", sha]);
  return sha;
}

function restoreBaseline({ baselineFingerprint, baselineSha, repoRoot, runId }) {
  let failedSha = null;
  if (statusSnapshot().length > 0) {
    git(["stash", "push", "--include-untracked", "--message", `ship-it-failed:${runId}`]);
    failedSha = git(["rev-parse", "refs/stash"]).stdout.trim();
  }

  if (baselineSha) {
    git(["stash", "apply", "--index", baselineSha]);
  }

  const restoredFingerprint = workspaceFingerprint(repoRoot);
  if (restoredFingerprint !== baselineFingerprint) {
    throw new Error(
      `workspace rollback did not reproduce the baseline exactly; ` +
        `baseline stash=${baselineSha || "clean"} failed stash=${failedSha || "none"}`,
    );
  }

  let baselineStashRetained = null;
  try {
    dropStash(baselineSha);
  } catch {
    baselineStashRetained = baselineSha;
  }
  return { failedSha, baselineStashRetained };
}

function emit(event, fields = {}) {
  process.stderr.write(
    `[ship-it/claude] ${JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    })}\n`,
  );
}

async function runClaude(options) {
  const config = MODES[options.mode];
  const claudeBin = process.env.CLAUDE_BIN || "claude";
  const args = [
    "-p",
    "--model",
    "opus",
    "--permission-mode",
    config.permissionMode,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--strict-mcp-config",
    "--no-chrome",
    config.prompt,
  ];

  emit("started", {
    mode: options.mode,
    total_timeout_seconds: options.totalTimeoutSeconds,
    idle_timeout_seconds: options.idleTimeoutSeconds,
  });

  const ownsProcessGroup = process.platform !== "win32";
  const child = spawn(claudeBin, args, {
    cwd: process.cwd(),
    detached: ownsProcessGroup,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let stdoutBuffer = "";
  let resultSeen = false;
  let resultIsError = false;
  let terminationReason = null;
  let escalationTimer = null;

  function observeLine(line) {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "result") {
        resultSeen = true;
        resultIsError = event.is_error === true || event.subtype === "error";
      }
    } catch {
      // Preserve non-JSON output for diagnostics; final success still requires
      // Claude's structured result event.
    }
  }

  child.stdout.on("data", (chunk) => {
    lastProgressAt = Date.now();
    process.stdout.write(chunk);
    stdoutBuffer += chunk.toString("utf8");
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
      observeLine(stdoutBuffer.slice(0, newlineIndex));
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    }
  });

  child.stderr.on("data", (chunk) => {
    lastProgressAt = Date.now();
    process.stderr.write(chunk);
  });

  function terminate(reason) {
    if (terminationReason || child.exitCode !== null) return;
    terminationReason = reason;
    emit("terminating", { mode: options.mode, reason });

    const signalChild = (signal) => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        if (ownsProcessGroup) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };

    signalChild("SIGINT");
    escalationTimer = setTimeout(() => {
      signalChild("SIGTERM");
      escalationTimer = setTimeout(() => {
        signalChild("SIGKILL");
      }, 5_000);
    }, 5_000);
  }

  const signalHandler = (signal) => terminate(`runner received ${signal}`);
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  const watchdogIntervalMs = Math.min(
    30_000,
    Math.max(
      250,
      Math.floor(
        (Math.min(options.totalTimeoutSeconds, options.idleTimeoutSeconds) * 1_000) / 4,
      ),
    ),
  );
  const watchdog = setInterval(() => {
    const now = Date.now();
    const elapsedSeconds = Math.floor((now - startedAt) / 1000);
    const idleSeconds = Math.floor((now - lastProgressAt) / 1000);
    emit("heartbeat", {
      mode: options.mode,
      elapsed_seconds: elapsedSeconds,
      idle_seconds: idleSeconds,
    });
    if (elapsedSeconds >= options.totalTimeoutSeconds) {
      terminate(`total timeout after ${elapsedSeconds}s`);
    } else if (idleSeconds >= options.idleTimeoutSeconds) {
      terminate(`no output progress for ${idleSeconds}s`);
    }
  }, watchdogIntervalMs);

  const outcome = await new Promise((resolvePromise) => {
    child.on("error", (error) => {
      terminationReason ||= `failed to start Claude: ${error.message}`;
    });
    child.on("close", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });

  clearInterval(watchdog);
  clearTimeout(escalationTimer);
  process.off("SIGINT", signalHandler);
  process.off("SIGTERM", signalHandler);
  if (stdoutBuffer) observeLine(stdoutBuffer);

  const success =
    !terminationReason && outcome.code === 0 && resultSeen && !resultIsError;
  return {
    ...outcome,
    success,
    resultSeen,
    resultIsError,
    terminationReason,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = git(["rev-parse", "--show-toplevel"]).stdout.trim();
  const unmerged = git(["diff", "--name-only", "--diff-filter=U"]).stdout.trim();
  if (unmerged) {
    fail("refusing to run with unresolved merge conflicts");
  }

  const runId = randomUUID();
  const baselineStatus = statusSnapshot();
  const baselineFingerprint = workspaceFingerprint(repoRoot);
  let baselineSha = null;

  try {
    baselineSha = createSafetySnapshot(runId, baselineStatus);
    if (workspaceFingerprint(repoRoot) !== baselineFingerprint) {
      throw new Error("safety snapshot changed the working tree");
    }
  } catch (error) {
    fail(`could not create the transactional safety snapshot: ${error.message}`);
  }

  let outcome;
  try {
    outcome = await runClaude(options);
  } catch (error) {
    outcome = {
      success: false,
      code: null,
      signal: null,
      resultSeen: false,
      resultIsError: true,
      terminationReason: error.message,
    };
  }

  if (outcome.success) {
    let baselineStashRetained = null;
    try {
      dropStash(baselineSha);
    } catch {
      baselineStashRetained = baselineSha;
    }
    emit("completed", {
      mode: options.mode,
      result: "success",
      baseline_stash_retained: baselineStashRetained,
    });
    return;
  }

  let rollback;
  try {
    rollback = restoreBaseline({
      baselineFingerprint,
      baselineSha,
      repoRoot,
      runId,
    });
  } catch (error) {
    fail(`Claude failed and automatic rollback needs manual recovery: ${error.message}`);
  }

  emit("completed", {
    mode: options.mode,
    result: "failed",
    exit_code: outcome.code,
    signal: outcome.signal,
    structured_result_seen: outcome.resultSeen,
    reason: outcome.terminationReason || (outcome.resultIsError ? "Claude result reported an error" : "Claude exited without a successful result"),
    failed_stash: rollback.failedSha,
    baseline_stash_retained: rollback.baselineStashRetained,
    workspace_restored: true,
  });
  process.exit(1);
}

await main();
