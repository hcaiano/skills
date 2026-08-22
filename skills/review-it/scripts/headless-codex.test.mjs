import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A fake `codex` driven by FAKE_CODEX_MODE exercises every path: a good review,
// a hollow success (exit 0 with an empty final message), a success that wrote no
// final message at all, a nonzero exit, and a hang that must be killed.
const root = mkdtempSync(join(tmpdir(), "headless-codex-test-"));
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "codex"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.FAKE_CODEX_MODE;
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("--output-last-message") + 1];
// Record argv so the tests can assert the exact flags the wrapper builds.
fs.writeFileSync(process.env.FAKE_CODEX_ARGV, JSON.stringify(argv));
process.stdout.write(JSON.stringify({ type: "item.started" }) + "\\n");
if (mode === "ok") { fs.writeFileSync(out, "2 findings: ...\\n"); process.exit(0); }
// Drift modes mutate the review cwd and still "succeed" — the wrapper's
// fingerprint must turn each into a failure.
if (mode === "mutate-new") { fs.writeFileSync("planted.txt", "x\\n"); fs.writeFileSync(out, "findings\\n"); process.exit(0); }
if (mode === "mutate-tracked") { fs.appendFileSync("tracked.txt", "drift\\n"); fs.writeFileSync(out, "findings\\n"); process.exit(0); }
if (mode === "mutate-untracked") { fs.appendFileSync("loose.txt", "drift\\n"); fs.writeFileSync(out, "findings\\n"); process.exit(0); }
if (mode === "mutate-symlink") { fs.unlinkSync("loose-link"); fs.symlinkSync("target-b", "loose-link"); fs.writeFileSync(out, "findings\\n"); process.exit(0); }
if (mode === "empty") { fs.writeFileSync(out, "   \\n"); process.exit(0); }
if (mode === "nofile") { process.exit(0); }
if (mode === "fail") { process.stderr.write("rate limit\\n"); process.exit(1); }
if (mode === "hang") { setInterval(() => {}, 1000); }
`,
);
chmodSync(join(bin, "codex"), 0o755);

const here = new URL(".", import.meta.url).pathname;
const script = join(here, "headless-codex.mjs");
// Every run gets a purpose-built git repo: resolving "three directories up"
// only lands on a repository in the source checkout, and these tests must
// pass wherever the skill is installed.
const newScratchRepo = (name) => {
  const dir = join(root, name);
  mkdirSync(dir);
  const git = (...args) =>
    spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.test", ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(dir, "loose.txt"), "untracked\n");
  symlinkSync("target-a", join(dir, "loose-link"));
  return dir;
};
const repo = newScratchRepo("base");
const argvLog = join(root, "argv.json");
const env = (mode) => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  FAKE_CODEX_MODE: mode,
  FAKE_CODEX_ARGV: argvLog,
});
const runOk = (mode, ...args) =>
  JSON.parse(
    execFileSync(process.execPath, [script, ...args, "--cwd", repo], { encoding: "utf8", env: env(mode) }),
  );
const runFail = (mode, ...args) => {
  try {
    execFileSync(process.execPath, [script, ...args, "--cwd", repo], {
      encoding: "utf8",
      env: env(mode),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return JSON.parse(error.stdout);
  }
  throw new Error("expected nonzero exit");
};
const sentArgv = () => JSON.parse(readFileSync(argvLog, "utf8"));

const runFailIn = (dir, mode, ...args) => {
  try {
    execFileSync(process.execPath, [script, ...args, "--cwd", dir], {
      encoding: "utf8",
      env: env(mode),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return JSON.parse(error.stdout);
  }
  throw new Error("expected nonzero exit");
};

test("headless-codex passes a completed review and writes its receipt", () => {
  const receipt = join(root, "codex-receipt.json");
  const ok = runOk("ok", "review the diff", "--base", "HEAD", "--receipt", receipt);
  assert.equal(ok.ok, true);
  assert.equal(ok.result, "2 findings: ...");
  assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), ok);
});

test("headless-codex resolves the range itself and records the exact SHA", () => {
  const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const ok = runOk("ok", "axis: Standards", "--base", "HEAD");
  // The range reaches the receipt as a SHA, which is what the delivery's chain
  // of custody records — not a command someone still has to run.
  assert.deepEqual(ok.review_range, {
    selector: "--base",
    ref: "HEAD",
    resolved_sha: head,
    diff_command: `git diff ${head}`,
  });
  const prompt = sentArgv().at(-1);
  assert.match(prompt, new RegExp(`git diff ${head}`, "u"));
  assert.match(prompt, /The range is fixed\. Do not recompute it/u);
  assert.match(prompt, /axis: Standards$/u);
});

test("headless-codex sends only flags codex exec review actually accepts", () => {
  runOk("ok", "p", "--base", "HEAD", "--model", "gpt-5");
  const argv = sentArgv();
  assert.deepEqual(argv.slice(0, 3), ["exec", "review", "--json"]);
  // --json plus the final-message file are what make content validation
  // mechanical instead of an eyeballed transcript.
  assert.ok(argv.includes("--output-last-message"));
  // `codex exec review` has no --sandbox of its own, so the mode arrives as a
  // config override. workspace-write (network off), not read-only: read-only
  // Landlock denies TMPDIR and kills the harness before the review (EROFS);
  // the wrapper's tree fingerprint is what enforces read-only instead.
  assert.equal(argv[argv.indexOf("--config") + 1], 'sandbox_mode="workspace-write"');
  assert.ok(argv.includes("sandbox_workspace_write.network_access=false"));
  assert.equal(argv[argv.indexOf("--model") + 1], "gpt-5");
  // The range selectors are mutually exclusive with a custom prompt, and the
  // prompt is where the axis lives — so they must never reach the CLI.
  for (const rejected of ["--base", "--commit", "--uncommitted", "--color", "--sandbox", "--cd"]) {
    assert.ok(!argv.includes(rejected), `${rejected} must not reach codex exec review`);
  }
});

test("every flag the wrapper sends is one the installed codex accepts", (t) => {
  // The fake codex accepts anything, so it cannot catch a flag the real CLI
  // rejects — which is exactly how --color, --sandbox and --cd got in. This
  // reads the installed CLI's own help instead.
  const help = spawnSync("codex", ["exec", "review", "--help"], { encoding: "utf8" });
  if (help.status !== 0) return t.skip("codex is not installed");
  const accepted = new Set(help.stdout.match(/--[a-z][a-z-]+/gu));
  runOk("ok", "p", "--base", "HEAD", "--model", "gpt-5");
  for (const token of sentArgv().filter((part) => part.startsWith("--"))) {
    assert.ok(accepted.has(token), `codex exec review does not accept ${token}`);
  }
});

test("headless-codex requires exactly one range selector", () => {
  const none = runFail("ok", "review the diff");
  assert.equal(none.ok, false);
  assert.match(none.reason, /exactly one range selector required, got none/u);
  const both = runFail("ok", "review the diff", "--base", "HEAD", "--uncommitted");
  assert.equal(both.ok, false);
  assert.match(both.reason, /--base \+ --uncommitted/u);
});

test("headless-codex fails an unresolvable range before spending a review", () => {
  const bad = runFail("ok", "p", "--base", "origin/definitely-no-such-branch");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /cannot resolve the merge base/u);
  const badCommit = runFail("ok", "p", "--commit", "definitelynotacommit");
  assert.equal(badCommit.ok, false);
  assert.match(badCommit.reason, /cannot resolve commit/u);
});

test("headless-codex fails a hollow success", () => {
  const empty = runFail("empty", "p", "--base", "HEAD");
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /final message is empty/u);
  assert.equal(empty.exit_code, 0);

  const missing = runFail("nofile", "p", "--base", "HEAD");
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no final message file/u);
  assert.equal(missing.exit_code, 0);
});

test("headless-codex fails a nonzero exit and keeps the transcript", () => {
  const failed = runFail("fail", "p", "--base", "HEAD");
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /codex exited 1/u);
  assert.match(readFileSync(failed.log, "utf8"), /rate limit/u);
});

test("headless-codex kills a hang on its idle deadline", () => {
  const hung = runFail("hang", "p", "--base", "HEAD", "--idle-min", "0.05");
  assert.equal(hung.ok, false);
  assert.equal(hung.killed, true);
  assert.match(hung.reason, /hang: no output for/u);
});

test("the fingerprint fails a review that mutated the tree, untracked files included", () => {
  // The sandbox is workspace-write, so the fingerprint is the read-only
  // enforcement: tracked edits, new files, and changed untracked files must
  // all fail — `git diff HEAD` alone never sees the untracked ones.
  for (const [mode, what] of [
    ["mutate-tracked", "a tracked edit"],
    ["mutate-new", "a new untracked file"],
    ["mutate-untracked", "a changed untracked file"],
    ["mutate-symlink", "a retargeted untracked symlink"],
  ]) {
    const dir = newScratchRepo(`drift-${mode}`);
    const receipt = runFailIn(dir, mode, "review it", "--base", "HEAD");
    assert.equal(receipt.ok, false, `${what} must fail the review`);
    assert.match(receipt.tree_changed, /changed during the review/u);
    assert.match(receipt.reason, /must stay read-only/u);
  }
  // And a clean review in the same shape of repo still passes.
  const clean = newScratchRepo("drift-clean");
  const receipt = JSON.parse(
    execFileSync(process.execPath, [script, "review it", "--base", "HEAD", "--cwd", clean], { encoding: "utf8", env: env("ok") }),
  );
  assert.equal(receipt.ok, true);
  assert.equal(receipt.tree_changed, undefined);
});

test("an untracked FIFO never blocks the fingerprint", (t) => {
  // readFileSync on a FIFO blocks forever, outside the supervisor's watchdog;
  // the lstat-first fingerprint records its type without reading it.
  const dir = newScratchRepo("drift-fifo");
  const made = spawnSync("mkfifo", [join(dir, "pipe.fifo")], { encoding: "utf8" });
  if (made.status !== 0) return t.skip("mkfifo unavailable");
  const receipt = JSON.parse(
    execFileSync(process.execPath, [script, "review it", "--base", "HEAD", "--cwd", dir], { encoding: "utf8", env: env("ok") }),
  );
  assert.equal(receipt.ok, true);
  assert.equal(receipt.tree_changed, undefined);
});
