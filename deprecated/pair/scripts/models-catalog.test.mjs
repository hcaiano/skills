import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { report, compareSemver } from "./models-catalog.mjs";

const directory = mkdtempSync(join(tmpdir(), "models-catalog-test-"));
const helper = fileURLToPath(new URL("./models-catalog.mjs", import.meta.url));
const fake = `#!${process.execPath}
const fs = require("node:fs");
const bin = require("node:path").basename(process.argv[1]);
const args = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin, args, cwd: process.cwd() }) + "\\n");
if (args[0] === "--version") {
  const versions = { codex: "1.2.3+build.4", grok: "1.0.0", opencode: "2.0.0", claude: "3.0.0", "cursor-agent": "2026.09.28-abc" };
  process.stdout.write(bin + " " + versions[bin] + "\\n");
} else if (bin === "npm" && args[0] === "view") {
  process.stdout.write(args[1] === "@openai/codex" ? "1.2.4\\n" : "2.0.0+build.9\\n");
} else if (bin === "grok" && args[0] === "update") {
  process.stdout.write(JSON.stringify({ latestVersion: "1.0.1" }));
} else if (bin === "grok" && args[0] === "models") {
  process.stdout.write("Available models:\\n* grok-4.8 (default)\\n- grok-4.7\\n");
} else if (bin === "cursor-agent" && args[0] === "--list-models") {
  process.stdout.write("claude-opus-5-6-high - usable\\nclaude-opus-5-5-high - old\\ngemini-4-flash-high - usable\\ngpt-9-sol-high - stale duplicate\\ngrok-4.9-high - ahead of native\\n");
} else if (bin === "codex" && args[0] === "app-server") {
  process.stdin.setEncoding("utf8");
  let text = "";
  process.stdin.on("data", chunk => {
    text += chunk;
    while (text.includes("\\n")) {
      const index = text.indexOf("\\n");
      const line = text.slice(0, index); text = text.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
      if (message.method === "model/list") process.stdout.write(JSON.stringify({ id: message.id, result: { data: [
        { model: "gpt-6.2-sol", hidden: false }, { model: "gpt-6-astra", hidden: false },
        { model: "gpt-7-nova", hidden: false }, { model: "gpt-8-secret", hidden: true }
      ], nextCursor: null } }) + "\\n");
    }
  });
} else process.exit(1);
`;
for (const bin of ["codex", "grok", "opencode", "claude", "cursor-agent", "npm"]) {
  writeFileSync(join(directory, bin), fake);
  chmodSync(join(directory, bin), 0o755);
}
const rosterText = readFileSync(new URL("../references/models.md", import.meta.url), "utf8");
const env = { ...process.env, PATH: directory, CODEX_BIN: join(directory, "codex"), FAKE_LOG: join(directory, "calls.jsonl"), MODELS_CATALOG_CLAUDE_LATEST_URL: "data:text/plain,3.0.0" };

test("compares releases without build metadata", () => {
  assert.equal(compareSemver("2.0.0+old", "2.0.0+new"), 0);
  assert.ok(compareSemver("1.2.3", "1.2.4") < 0);
});

test("reports outdated, current, unknown family and stale example from live catalogs", async () => {
  const result = await report({ env, rosterText });
  assert.equal(result.clis.codex.outdated, true);
  assert.equal(result.clis.codex.update, `${join(directory, "codex")} update`, "the inspected install is the one updated");
  assert.equal(result.clis.opencode.outdated, false);
  assert.equal(result.clis.grok.outdated, true);
  assert.equal(result.clis["cursor-agent"].latest, null);
  assert.equal(result.families.codex.models.sol, "gpt-6.2-sol");
  assert.equal(result.families.cursor.models.opus, "claude-opus-5-6-high");
  assert.equal(result.families.cursor.models.sol, undefined);
  assert.ok(result.unknown_families.some((entry) => entry.family === "nova"));
  assert.ok(result.stale_examples.some((entry) => entry.family === "sol" && entry.newest === "gpt-6.2-sol"));
  assert.ok(result.stale_examples.some((entry) => entry.family === "opus" && entry.newest === "claude-opus-5-6-high"));
  // Every listed harness is checked, not only the row's first one.
  assert.ok(result.stale_examples.some((entry) => entry.harness === "cursor" && entry.family === "grok" && entry.newest === "grok-4.9-high"));
  assert.ok(!result.unknown_families.some((entry) => entry.family === "gemini"));
  const calls = readFileSync(env.FAKE_LOG, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.filter((call) => call.bin === "npm").every((call) => call.cwd === process.env.HOME));
});

test("a missing CLI has an empty installed field without an error", async () => {
  const missing = await report({ offline: true, env: { ...env, CODEX_BIN: join(directory, "absent") }, rosterText });
  assert.equal(missing.clis.codex.installed, null);
  assert.equal(missing.clis.codex.error, undefined);
  assert.ok(missing.families.codex.error);
});

test("offline skips release lookups while reading local catalogs", () => {
  writeFileSync(env.FAKE_LOG, "");
  const run = spawnSync(process.execPath, [helper, "--offline"], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.clis.codex.latest, null);
  assert.equal(result.families.codex.models.sol, "gpt-6.2-sol");
  const calls = readFileSync(env.FAKE_LOG, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.every((call) => call.bin !== "npm" && !(call.bin === "grok" && call.args[0] === "update")));
});

test("runs when reached through a symlinked skill directory, as installed skills are", () => {
  const link = join(mkdtempSync(join(tmpdir(), "models-catalog-link-")), "pair");
  symlinkSync(join(dirname(helper), ".."), link);
  const run = spawnSync(process.execPath, [join(link, "scripts", "models-catalog.mjs"), "--offline"], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(JSON.parse(run.stdout).clis, "the symlinked entry point still prints its report");
});

test("a report that cannot run at all exits nonzero", () => {
  // A scripts folder with no roster beside it: every source may still answer,
  // but the report itself cannot be built.
  const scripts = join(mkdtempSync(join(tmpdir(), "models-catalog-no-roster-")), "scripts");
  cpSync(dirname(helper), scripts, { recursive: true });
  const run = spawnSync(process.execPath, [join(scripts, "models-catalog.mjs"), "--offline"], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(run.status, 1);
  assert.match(JSON.parse(run.stdout).error, /models\.md/u);
});
