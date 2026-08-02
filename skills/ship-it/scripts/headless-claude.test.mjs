import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A fake `claude` driven by FAKE_CLAUDE_MODE exercises every path: a good
// run, a hollow success (exit 0, empty result), a refusal, a hang, and a
// writable run that mutates the tree and dies — which must restore it.
const root = mkdtempSync(join(tmpdir(), "headless-claude-test-"));
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "claude"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.FAKE_CLAUDE_MODE;
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
line({ type: "system", subtype: "init" });
if (mode === "ok") { line({ type: "result", is_error: false, result: "3 findings: ..." }); process.exit(0); }
if (mode === "empty") { line({ type: "result", is_error: false, result: "" }); process.exit(0); }
if (mode === "refusal") { line({ type: "result", is_error: true, result: "usage limit reached" }); process.exit(0); }
if (mode === "epipe") {
  for (let i = 0; i < 2000; i++) line({ type: "assistant", payload: "x".repeat(1024) });
  process.stdout.write(
    JSON.stringify({ type: "result", is_error: false, result: "No findings" }) + "\\n",
    () => process.exit(0),
  );
}
if (mode === "hang") { setInterval(() => {}, 1000); }
if (mode === "mutate-and-die") {
  fs.writeFileSync("tracked.txt", "CLOBBERED BY SIMPLIFY\\n");
  fs.writeFileSync("leftover.tmp", "debris\\n");
  process.exit(1);
}
`,
);
chmodSync(join(bin, "claude"), 0o755);

const script = join(new URL(".", import.meta.url).pathname, "headless-claude.mjs");
const env = (mode) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_MODE: mode });
const runOk = (mode, ...args) =>
  JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: "utf8", env: env(mode) }));
const runFail = (mode, ...args) => {
  try {
    execFileSync(process.execPath, [script, ...args], { encoding: "utf8", env: env(mode), stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return JSON.parse(error.stdout);
  }
  throw new Error("expected nonzero exit");
};

test("headless-claude validates content, kills hangs, restores writable trees", () => {
  const receipt = join(root, "claude-receipt.json");
  const ok = runOk("ok", "/code-review", "--receipt", receipt);
  assert.equal(ok.ok, true);
  assert.equal(ok.result, "3 findings: ...");
  assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), ok);

  // Exit 0 around an empty payload or a refusal is a FAILURE.
  assert.match(runFail("empty", "/code-review").reason, /content validation failed/u);
  assert.match(runFail("refusal", "/code-review").reason, /is_error/u);

  const hang = runFail("hang", "/code-review", "--idle-min", "0.05", "--total-min", "0.2");
  assert.equal(hang.killed, true);
  assert.match(hang.reason, /hang/u);

  // Writable failure: tracked content restored byte-for-byte (fingerprint),
  // intent-to-add re-marked, pre-existing untracked preserved, and the
  // run's own debris reported — never deleted silently.
  const repo = join(root, "repo");
  mkdirSync(repo);
  const gitIn = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  gitIn("init", "-q");
  gitIn("config", "user.email", "t@t");
  gitIn("config", "user.name", "t");
  writeFileSync(join(repo, "tracked.txt"), "original\n");
  gitIn("add", "tracked.txt");
  gitIn("commit", "-qm", "base");
  writeFileSync(join(repo, "tracked.txt"), "user edit in progress\n");
  writeFileSync(join(repo, "new-intent.txt"), "intent-to-add contents\n");
  gitIn("add", "--intent-to-add", "new-intent.txt");
  writeFileSync(join(repo, "user-notes.txt"), "pre-existing untracked\n");

  const out = runFail("mutate-and-die", "/simplify", "--writable", "true", "--cwd", repo);
  assert.equal(out.restored, true, out.restore_error);
  assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "user edit in progress\n");
  assert.equal(readFileSync(join(repo, "new-intent.txt"), "utf8"), "intent-to-add contents\n");
  assert.equal(readFileSync(join(repo, "user-notes.txt"), "utf8"), "pre-existing untracked\n");
  assert.deepEqual(out.leftover_untracked, ["leftover.tmp"]);
  const status = gitIn("status", "--porcelain");
  assert.match(status, /new-intent\.txt/u, "intent-to-add must be re-marked");
});

test("headless-claude survives a closed visible-output pipe", async () => {
  const receipt = join(root, "epipe-receipt.json");
  const child = spawn(
    process.execPath,
    [script, "/code-review", "--receipt", receipt],
    { env: env("epipe"), stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.destroy();
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const exit = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exit, 0);
  assert.equal(JSON.parse(stdout).ok, true);
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).result, "No findings");
});
