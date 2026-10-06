import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A fake `claude` driven by FAKE_CLAUDE_MODE exercises every path: a good
// run, a hollow success (exit 0, empty result), a refusal, and a hang.
const root = mkdtempSync(join(tmpdir(), "headless-claude-test-"));
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "claude"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.FAKE_CLAUDE_MODE;
// Record argv so the tests can assert the exact flags the wrapper builds.
if (process.env.FAKE_CLAUDE_ARGV) fs.writeFileSync(process.env.FAKE_CLAUDE_ARGV, JSON.stringify(process.argv.slice(2)));
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
`,
);
chmodSync(join(bin, "claude"), 0o755);

const script = join(new URL(".", import.meta.url).pathname, "headless-claude.mjs");
const argvLog = join(root, "argv.json");
const env = (mode) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_ARGV: argvLog });
// --cwd keeps every run inside the scratch dir, never the checkout.
const runOk = (mode, ...args) =>
  JSON.parse(execFileSync(process.execPath, [script, ...args, "--cwd", root], { encoding: "utf8", env: env(mode) }));
const runFail = (mode, ...args) => {
  try {
    execFileSync(process.execPath, [script, ...args, "--cwd", root], { encoding: "utf8", env: env(mode), stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return JSON.parse(error.stdout);
  }
  throw new Error("expected nonzero exit");
};

test("headless-claude reviews in plan mode, validates content, and kills hangs", () => {
  const receipt = join(root, "claude-receipt.json");
  const ok = runOk("ok", "review prompt", "--effort", "high", "--receipt", receipt);
  assert.equal(ok.ok, true);
  assert.equal(ok.result, "3 findings: ...");
  assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), ok);
  const argv = JSON.parse(readFileSync(argvLog, "utf8"));
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "plan");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");

  // Exit 0 around an empty payload or a refusal is a FAILURE.
  assert.match(runFail("empty", "review prompt").reason, /content validation failed/u);
  assert.match(runFail("refusal", "review prompt").reason, /is_error/u);

  const hang = runFail("hang", "review prompt", "--idle-min", "0.05", "--total-min", "0.2");
  assert.equal(hang.killed, true);
  assert.match(hang.reason, /hang/u);
});

test("headless-claude survives a closed visible-output pipe", async () => {
  const receipt = join(root, "epipe-receipt.json");
  const child = spawn(
    process.execPath,
    [script, "review prompt", "--receipt", receipt, "--cwd", root],
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
