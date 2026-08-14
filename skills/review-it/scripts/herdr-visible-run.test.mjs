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
  const calls = fs.readFileSync(process.env.HERDR_TEST_CALLS, "utf8")
    .trim().split("\\n").filter(Boolean).map(JSON.parse);
  const launched = calls
    .some((call) => call[0] === "pane" && call[1] === "run");
  const targetProbes = calls.filter(
    (call) => call[0] === "pane" && call[1] === "process-info" && call.at(-1) === "w1:p2"
  ).length;
  if (id === "w1:p2" && process.env.TRANSIENT_TARGET && targetProbes === 1) {
    result({ process_info: {
      pane_id: id,
      foreground_processes: [{ name: null, argv0: null, argv: null, cwd: null }]
    } });
    process.exit(0);
  }
  const launchVisible =
    launched && (!process.env.DELAY_LAUNCH || targetProbes >= 8);
  const command = id === "w1:p1"
    ? ["codex"]
    : process.env.BUSY_TARGET
      ? ["node", "busy.js"]
      : launchVisible
        ? ["node", "herdr-visible-run.mjs", "exec"]
        : ["zsh"];
  const exe = command[0];
  result({ process_info: {
    pane_id: id,
    foreground_processes: [
      { name: exe, argv0: exe, argv: command, cwd: process.env.HERDR_TEST_REPO }
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
} else if (key === "pane report-metadata") {
  // Real herdr answers this one with exit 0 and an EMPTY body. Returning JSON
  // here once hid a bug that aborted every visible run.
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
const priorReceipt = join(root, "prior-receipt.json");
writeFileSync(
  priorReceipt,
  JSON.stringify({
    ok: true,
    pane_id: "w1:p2",
    token: "prior-token",
    command: ["printf", "done"],
    exit_code: 0,
    signal: null,
    transcript: join(root, "prior.log"),
  }),
);

test("start validates the pin and launches in a visible sibling pane", () => {
  writeFileSync(calls, "");
  const longPrompt = "review-spec ".repeat(800);
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [script, "start", ...pin, "--label", "ship-it · codex review", "--", "printf", longPrompt],
      { encoding: "utf8", env: { ...baseEnv, TRANSIENT_TARGET: "1" } },
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
  // The pane must declare itself a process pane, or a live pair in this
  // tab counts it as a third agent and its channel goes silent for the gate.
  const declared = seen.find((args) => args[0] === "pane" && args[1] === "report-metadata");
  assert.ok(declared, "a process pane must declare its role");
  assert.ok(declared.includes("role=process-pane"), "declaration must carry role=process-pane");
  assert.ok(
    !seen.find((args) => args[0] === "pane" && args[1] === "run").join(" ").includes(longPrompt),
    "long command argv must travel through a private command file",
  );
});

test("start tolerates a delayed real-pane command launch", () => {
  writeFileSync(calls, "");
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [script, "start", ...pin, "--label", "delayed review", "--", "printf", "ok"],
      { encoding: "utf8", env: { ...baseEnv, DELAY_LAUNCH: "1" } },
    ),
  );
  assert.equal(output.started, true);
  assert.equal(output.pane_id, "w1:p2");
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
          "--prior-receipt", priorReceipt,
          "--prior-token", "prior-token",
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

test("run reuses only a pane owned by a prior completion receipt", () => {
  writeFileSync(calls, "");
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        script,
        "run",
        ...pin,
        "--target-pane", "w1:p2",
        "--prior-receipt", priorReceipt,
        "--prior-token", "prior-token",
        "--label", "review",
        "--",
        "printf", "ok",
      ],
      { encoding: "utf8", env: baseEnv },
    ),
  );
  assert.equal(output.pane_id, "w1:p2");

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
          "--prior-receipt", join(root, "missing.json"),
          "--prior-token", "prior-token",
          "--label", "review",
          "--",
          "printf", "ok",
        ],
        { encoding: "utf8", env: baseEnv, stdio: ["ignore", "pipe", "pipe"] },
      ),
    /Command failed/u,
  );

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
          "--prior-receipt", priorReceipt,
          "--prior-token", "wrong-token",
          "--label", "review",
          "--",
          "printf", "ok",
        ],
        { encoding: "utf8", env: baseEnv, stdio: ["ignore", "pipe", "pipe"] },
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
  const commandFile = join(root, "command.json");
  writeFileSync(
    commandFile,
    JSON.stringify([
      process.execPath,
      "-e",
      "process.stdout.write('progress\\\\n'); process.stderr.write('detail\\\\n')",
    ]),
  );
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
      "--command-file", commandFile,
    ],
    { encoding: "utf8" },
  );
  assert.match(output, /progress/u);
  assert.match(output, /SHIP_IT_VISIBLE_DONE token-1 exit=0/u);
  assert.match(readFileSync(transcript, "utf8"), /progress/u);
  assert.match(readFileSync(transcript, "utf8"), /detail/u);
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).ok, true);
});
