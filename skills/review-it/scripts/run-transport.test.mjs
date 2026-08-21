import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "run-transport-test-"));
const script = join(new URL(".", import.meta.url).pathname, "run-transport.mjs");

// HERDR_ENV leaks in from the surrounding session, so every case states the
// value it is testing rather than inheriting one.
const runAt = (cwd, env, ...args) =>
  execFileSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, HERDR_ENV: "", ...env },
  });
const run = (env, ...args) => runAt(root, env, ...args);
const runFailAt = (cwd, env, ...args) => {
  try {
    execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, HERDR_ENV: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, status: error.status };
  }
  throw new Error("expected nonzero exit");
};
const runFail = (env, ...args) => runFailAt(root, env, ...args);

const PIN = [
  "--pane", "w1:p1",
  "--workspace", "w1",
  "--tab-id", "w1:t1",
  "--as", "claude",
  "--terminal-id", "term_1",
  "--repo-root", root,
];

test("local transport runs a command end to end and validates its receipt", () => {
  const started = JSON.parse(
    run({}, "start", "--label", "ship-it · spec review", "--", "sh", "-c", "echo findings; echo warn >&2"),
  );
  assert.equal(started.transport, "local");
  assert.equal(started.pane_id, null);
  assert.equal(started.marker, null);
  assert.ok(Number.isInteger(started.pid));
  assert.equal(started.label, "ship-it · spec review");

  const done = JSON.parse(run({}, "wait", "--run-file", started.run_file, "--timeout-ms", "30000"));
  assert.equal(done.ok, true);
  assert.equal(done.transport, "local");
  assert.equal(done.exit_code, 0);
  // Both streams land in the transcript: outside Herdr it is the only record.
  const transcript = readFileSync(started.transcript, "utf8");
  assert.match(transcript, /findings/u);
  assert.match(transcript, /warn/u);
});

test("local transport reports a failing command instead of passing it", () => {
  const started = JSON.parse(run({}, "start", "--label", "l", "--", "sh", "-c", "exit 3"));
  const failed = runFail({}, "wait", "--run-file", started.run_file, "--timeout-ms", "30000");
  const done = JSON.parse(failed.stdout);
  assert.equal(done.ok, false);
  assert.equal(done.exit_code, 3);
  assert.match(done.reason, /command exited 3/u);
  assert.equal(failed.status, 1);
});

test("wait rejects a completion receipt that does not own the launch", () => {
  const started = JSON.parse(run({}, "start", "--label", "l", "--", "sh", "-c", "true"));
  JSON.parse(run({}, "wait", "--run-file", started.run_file, "--timeout-ms", "30000"));
  // Forge a receipt from some other run; the token is the launch's identity.
  const receipt = JSON.parse(readFileSync(started.receipt, "utf8"));
  writeFileSync(started.receipt, JSON.stringify({ ...receipt, token: "someone-elses-token" }));
  const done = JSON.parse(runFail({}, "wait", "--run-file", started.run_file, "--timeout-ms", "30000").stdout);
  assert.equal(done.ok, false);
  assert.match(done.reason, /token does not match this launch/u);
});

test("local wait times out on a run that is still going, without killing it", () => {
  const started = JSON.parse(run({}, "start", "--label", "l", "--", "sh", "-c", "sleep 30"));
  const done = JSON.parse(runFail({}, "wait", "--run-file", started.run_file, "--timeout-ms", "1500").stdout);
  assert.equal(done.ok, false);
  assert.match(done.reason, /no completion receipt within 1500ms/u);
  // The wrappers own deadlines and killing; the transport only observes.
  assert.doesNotThrow(() => process.kill(started.pid, 0));
  process.kill(started.pid, "SIGKILL");
});

test("inside Herdr an incomplete pin stops the gate instead of going invisible", () => {
  const failed = runFail({ HERDR_ENV: "1" }, "start", "--label", "l", "--", "true");
  assert.match(failed.stderr, /HERDR_ENV=1 but the caller pin is incomplete/u);
  assert.match(failed.stderr, /--pane/u);
  assert.match(failed.stderr, /instead of demoting this run to an invisible process/u);

  const partial = runFail(
    { HERDR_ENV: "1" },
    "start", "--pane", "w1:p1", "--workspace", "w1", "--label", "l", "--", "true",
  );
  assert.match(partial.stderr, /missing --tab-id/u);
});

test("a no-TTY headless pair executor ignores inherited Herdr mode", () => {
  const worktree = join(root, "headless-pair-worktree");
  mkdirSync(worktree);
  execFileSync("git", ["init", worktree]);
  const gitDir = execFileSync(
    "git",
    ["-C", worktree, "rev-parse", "--absolute-git-dir"],
    { encoding: "utf8" },
  ).trim();
  const pairState = join(gitDir, "pair");
  mkdirSync(pairState);
  writeFileSync(
    join(pairState, "session.json"),
    JSON.stringify({ sid: "headless-session", partner: "codex" }),
  );
  writeFileSync(
    join(pairState, "in-flight.json"),
    JSON.stringify({ partner_pid: process.pid, receipt_file: join(pairState, "receipt.json") }),
  );

  const started = JSON.parse(
    runAt(
      worktree,
      { HERDR_ENV: "1" },
      "start", "--label", "headless executor review", "--", "sh", "-c", "echo reviewed",
    ),
  );
  assert.equal(started.transport, "local");
  assert.equal(started.selection, "headless-pair-executor");
  const done = JSON.parse(
    runAt(worktree, { HERDR_ENV: "1" }, "wait", "--run-file", started.run_file, "--timeout-ms", "30000"),
  );
  assert.equal(done.ok, true);

  const pinned = runFailAt(
    worktree,
    { HERDR_ENV: "1" },
    "start", ...PIN, "--label", "l", "--", "true",
  );
  assert.match(pinned.stderr, /from a headless pair executor/u);
});

test("a pin outside Herdr is a mistake, not a silent local run", () => {
  const failed = runFail({}, "start", ...PIN, "--label", "l", "--", "true");
  assert.match(failed.stderr, /without HERDR_ENV=1/u);
  assert.doesNotMatch(failed.stderr, /transport failed/u);
});

test("a complete pin inside Herdr dispatches to the Herdr backend", () => {
  // No live Herdr here, so the delegation itself is what this proves: the
  // Herdr branch ran and reported through its own transport, and nothing fell
  // back to a local process.
  const failed = runFail({ HERDR_ENV: "1" }, "start", ...PIN, "--label", "l", "--", "true");
  assert.match(failed.stderr, /herdr transport failed/u);
  assert.doesNotMatch(failed.stdout, /"transport": "local"/u);
});

test("the pin carries whatever agent kind the caller proved, not a fixed roster", () => {
  const grokPin = PIN.map((value) => (value === "claude" ? "grok" : value));
  const failed = runFail({ HERDR_ENV: "1" }, "start", ...grokPin, "--label", "l", "--", "true");
  // It reached the Herdr backend rather than being rejected as an unknown
  // kind, and it never demoted itself to a local run.
  assert.match(failed.stderr, /herdr transport failed/u);
  assert.doesNotMatch(failed.stderr, /unsupported caller agent/u);
  assert.doesNotMatch(failed.stdout, /"transport": "local"/u);
});

test("target-pane reuse belongs to the Herdr backend alone", () => {
  const failed = runFail({}, "start", "--label", "l", "--target-pane", "w1:p9", "--", "true");
  assert.match(failed.stderr, /--target-pane needs the herdr transport/u);
});

test("usage errors name both modes", () => {
  const failed = runFail({}, "bogus");
  assert.match(failed.stderr, /usage: run-transport\.mjs start/u);
  assert.match(failed.stderr, /run-transport\.mjs wait --run-file/u);
});
