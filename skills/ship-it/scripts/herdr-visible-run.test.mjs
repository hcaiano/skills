import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "herdr-visible-run-test-"));
const bin = join(root, "bin");
const repo = join(root, "repo");
const calls = join(root, "calls.jsonl");
mkdirSync(bin);
mkdirSync(repo);
execFileSync("git", ["-C", repo, "init", "-q"]);

writeFileSync(
  join(bin, "herdr"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_TEST_CALLS, JSON.stringify(args) + "\\n");
const result = (value) => process.stdout.write(JSON.stringify({ result: value }) + "\\n");
const key = args.slice(0, 2).join(" ");
if (key === "pane get") {
  const id = args[2];
  result({ pane: {
    pane_id: id, workspace_id: process.env.BAD_WORKSPACE ? "w2" : "w1",
    tab_id: "w1:t1", terminal_id: id === "w1:p1" ? "term-1" : "term-2",
    agent: id === "w1:p1" ? "codex" : null, cwd: process.env.HERDR_TEST_REPO
  } });
} else if (key === "pane process-info") {
  const id = args.at(-1);
  const exe = id === "w1:p1" ? "codex" : process.env.BUSY_TARGET ? "node" : "zsh";
  result({ process_info: {
    pane_id: id,
    foreground_processes: [
      { name: exe, argv0: exe, argv: [exe], cwd: process.env.HERDR_TEST_REPO }
    ]
  } });
} else if (key === "pane layout") {
  result({ layout: {
    workspace_id: "w1", tab_id: "w1:t1",
    panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 40 } }]
  } });
} else if (key === "pane split") {
  result({ pane: { pane_id: "w1:p2" } });
} else if (key === "pane run") {
  process.exit(0);
} else if (key === "pane rename" || key === "pane close") {
  result({ ok: true });
} else {
  process.stderr.write("unexpected " + args.join(" "));
  process.exit(1);
}
`,
);
chmodSync(join(bin, "herdr"), 0o755);

const script = join(new URL(".", import.meta.url).pathname, "herdr-visible-run.mjs");
const baseEnv = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  HERDR_ENV: "1",
  HERDR_TEST_CALLS: calls,
  HERDR_TEST_REPO: repo,
};
const pin = [
  "--pane", "w1:p1",
  "--workspace", "w1",
  "--tab-id", "w1:t1",
  "--terminal-id", "term-1",
  "--as", "codex",
  "--repo-root", repo,
];

test("start validates the pin and launches in a visible sibling pane", () => {
  writeFileSync(calls, "");
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [script, "start", ...pin, "--label", "ship-it · codex review", "--", "printf", "ok"],
      { encoding: "utf8", env: baseEnv },
    ),
  );
  assert.equal(output.started, true);
  assert.equal(output.pane_id, "w1:p2");
  assert.equal(output.label, "ship-it · codex review");
  const seen = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(seen.some((args) => args[0] === "pane" && args[1] === "split"));
  assert.ok(seen.some((args) => args[0] === "pane" && args[1] === "run"));
});

test("caller drift stops before creating a pane", () => {
  writeFileSync(calls, "");
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [script, "start", ...pin, "--label", "review", "--", "printf", "ok"],
        {
          encoding: "utf8",
          env: { ...baseEnv, BAD_WORKSPACE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    /Command failed/u,
  );
  const seen = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.ok(!seen.some((args) => args[0] === "pane" && args[1] === "split"));
});

test("run refuses to inject input into a busy process pane", () => {
  writeFileSync(calls, "");
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          script,
          "run",
          ...pin,
          "--target-pane", "w1:p2",
          "--label", "review",
          "--",
          "printf", "ok",
        ],
        {
          encoding: "utf8",
          env: { ...baseEnv, BUSY_TARGET: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    /Command failed/u,
  );
  const seen = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.ok(!seen.some((args) => args[0] === "pane" && args[1] === "run"));
});

test("exec streams output and writes transcript plus completion receipt", () => {
  const receipt = join(root, "receipt.json");
  const transcript = join(root, "transcript.log");
  const output = execFileSync(
    process.execPath,
    [
      script,
      "exec",
      "--pane", "w1:p2",
      "--cwd", repo,
      "--token", "token-1",
      "--receipt", receipt,
      "--transcript", transcript,
      "--",
      process.execPath,
      "-e",
      "process.stdout.write('progress\\\\n'); process.stderr.write('detail\\\\n')",
    ],
    { encoding: "utf8" },
  );
  assert.match(output, /progress/u);
  assert.match(output, /SHIP_IT_VISIBLE_DONE token-1 exit=0/u);
  assert.match(readFileSync(transcript, "utf8"), /progress/u);
  assert.match(readFileSync(transcript, "utf8"), /detail/u);
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).ok, true);
});
