#!/usr/bin/env node
// Guards send.mjs against the regression that keeps coming back: a message
// pasted into an agent's composer and never submitted. The fake herdr below
// only clears its composer once an Enter arrives, so a send.mjs that drops the
// Enter cannot pass these tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sendScript = join(dirname(fileURLToPath(import.meta.url)), "send.mjs");
const root = mkdtempSync(join(tmpdir(), "send-test-"));
const binDir = join(root, "bin");
const statePath = join(root, "state.json");
spawnSync("mkdir", ["-p", binDir]);

// `needs_enter`: the composer holds the text until an Enter arrives (the real
// bug). `ignores_enter`: nothing ever submits, so send.mjs must fail loudly.
function installFakeHerdr(mode, status = "idle") {
  writeFileSync(statePath, JSON.stringify({ mode, status, composer: null, enters: 0, prompts: 0 }));
  writeFileSync(
    join(binDir, "herdr"),
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const s = JSON.parse(readFileSync(statePath, "utf8"));
const a = process.argv.slice(2);
const save = () => writeFileSync(statePath, JSON.stringify(s));
if (a[0] === "agent" && a[1] === "get") {
  process.stdout.write(JSON.stringify({ result: { agent: { agent_status: s.status } } }));
} else if (a[0] === "agent" && a[1] === "prompt") {
  s.prompts += 1;
  s.composer = a[3].split("\\n").find((l) => l.trim()) ?? "";
  save();
  process.stdout.write("{}");
} else if (a[0] === "agent" && a[1] === "send-keys") {
  s.enters += 1;
  if (s.mode !== "ignores_enter") { s.composer = null; s.status = "working"; }
  save();
  process.stdout.write("{}");
} else if (a[0] === "agent" && a[1] === "read") {
  // Only --source visible returns a screen; the default source is empty, and
  // a send.mjs that forgets it would read every composer as clear.
  if (!a.includes("visible")) { process.stdout.write(""); process.exit(0); }
  const composer = s.composer === null ? "Use /skills to list available skills" : s.composer;
  process.stdout.write("  some earlier output\\n\\n\\u203a " + composer + "\\n\\n  model · ctx\\n");
} else { process.stderr.write("unsupported: " + a.join(" ")); process.exit(1); }
`,
  );
  chmodSync(join(binDir, "herdr"), 0o755);
}

const run = (...args) =>
  spawnSync(process.execPath, [sendScript, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });

const state = () => JSON.parse(readFileSync(statePath, "utf8"));

// A composer that only clears on Enter: send.mjs must supply it and report landed.
installFakeHerdr("needs_enter");
let r = run("w1:p1", "hello there");
let out = JSON.parse(r.stdout);
assert.equal(r.status, 0, `expected success, got ${r.status}: ${r.stdout}${r.stderr}`);
assert.equal(out.landed, true);
assert.ok(state().enters >= 1, "send.mjs must press Enter after the paste");
assert.equal(state().composer, null, "composer must end clear");

// Same for a working target, whose message queues instead of submitting.
installFakeHerdr("needs_enter", "working");
r = run("w1:p1", "queued message");
out = JSON.parse(r.stdout);
assert.equal(r.status, 0);
assert.equal(out.landed, true);
assert.equal(out.queued, true);
assert.ok(state().enters >= 1);

// Multi-line kickoff read from a file, the shape that carries slashes and hashes.
installFakeHerdr("needs_enter");
const kickoff = join(root, "kickoff.txt");
writeFileSync(kickoff, "You are the lead agent for #123\n/simplify later\n`code` and \"quotes\"\n");
r = run("w1:p1", `@${kickoff}`);
assert.equal(r.status, 0, r.stdout + r.stderr);
assert.equal(JSON.parse(r.stdout).landed, true);
assert.ok(state().enters >= 1);

// A composer that never submits must fail loudly, never silently report landed.
installFakeHerdr("ignores_enter");
r = run("w1:p1", "never lands");
out = JSON.parse(r.stdout);
assert.equal(r.status, 1, "an unlanded message must exit non-zero");
assert.equal(out.landed, false);
assert.ok(out.visible, "failure must carry the pane's visible tail for the user");
assert.ok(state().enters >= 1, "it must at least have tried the Enter");

// Usage guards.
installFakeHerdr("needs_enter");
assert.equal(run().status, 2);
assert.equal(run("w1:p1", "   ").status, 2);

// A pane with no agent is a stop, not a send.
installFakeHerdr("needs_enter");
writeFileSync(statePath, JSON.stringify({ ...state(), status: null }));
r = run("w1:p1", "no agent here");
assert.equal(r.status, 1);
assert.equal(JSON.parse(r.stdout).landed, false);

assert.ok(existsSync(sendScript));
process.stdout.write("send.mjs tests: PASS\n");
