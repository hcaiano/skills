import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "run-claude-native.mjs",
);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(t) {
  const cwd = mkdtempSync(join(tmpdir(), "ship-it-claude-runner-"));
  t.after(() => {
    const result = spawnSync("trash", [cwd], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Ship It Test");
  writeFileSync(join(cwd, "tracked.txt"), "committed\n");
  git(cwd, "add", "tracked.txt");
  git(cwd, "commit", "-qm", "test: baseline");
  return cwd;
}

function fakeClaude(cwd, body) {
  const path = join(cwd, "fake-claude");
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function run(cwd, claudeBin, extraArgs = [], mode = "simplify") {
  return spawnSync(
    process.execPath,
    [runner, mode, ...extraArgs],
    {
      cwd,
      env: { ...process.env, CLAUDE_BIN: claudeBin },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
}

test("successful structured result keeps edits and uses isolated streaming flags", (t) => {
  const cwd = makeRepo(t);
  writeFileSync(join(cwd, "tracked.txt"), "committed\nuser change\n");
  const claudeBin = fakeClaude(
    cwd,
    String.raw`
printf '%s\n' "$@" > claude-args.txt
printf 'committed\nuser change\nclaude change\n' > tracked.txt
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"done"}'
`,
  );

  const result = run(cwd, claudeBin);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(cwd, "tracked.txt"), "utf8"),
    "committed\nuser change\nclaude change\n",
  );
  const args = readFileSync(join(cwd, "claude-args.txt"), "utf8");
  assert.match(args, /--output-format\nstream-json/);
  assert.match(args, /--include-partial-messages/);
  assert.match(args, /--strict-mcp-config/);
  assert.match(args, /--no-chrome/);
  assert.match(result.stderr, /"event":"completed".*"result":"success"/);
  assert.doesNotMatch(git(cwd, "stash", "list"), /ship-it-baseline/);
});

test("review mode invokes the native command read-only", (t) => {
  const cwd = makeRepo(t);
  const claudeBin = fakeClaude(
    cwd,
    String.raw`
printf '%s\n' "$@" > claude-args.txt
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"no findings"}'
`,
  );

  const result = run(cwd, claudeBin, [], "review");

  assert.equal(result.status, 0, result.stderr);
  const args = readFileSync(join(cwd, "claude-args.txt"), "utf8");
  assert.match(args, /--permission-mode\nplan/);
  assert.match(args, /\/code-review/);
});

test("failed run restores dirty baseline exactly and preserves partial work in a stash", (t) => {
  const cwd = makeRepo(t);
  writeFileSync(join(cwd, "tracked.txt"), "committed\nuser change\n");
  writeFileSync(join(cwd, "preexisting.txt"), "keep me\n");
  git(cwd, "add", "tracked.txt");
  const claudeBin = fakeClaude(
    cwd,
    String.raw`
printf 'broken partial edit\n' > tracked.txt
printf 'claude artifact\n' > new-file.txt
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}'
exit 7
`,
  );
  const beforeStatus = git(cwd, "status", "--short");

  const result = run(cwd, claudeBin);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    readFileSync(join(cwd, "tracked.txt"), "utf8"),
    "committed\nuser change\n",
  );
  assert.equal(readFileSync(join(cwd, "preexisting.txt"), "utf8"), "keep me\n");
  assert.equal(existsSync(join(cwd, "new-file.txt")), false);
  assert.equal(git(cwd, "status", "--short"), beforeStatus);
  assert.match(git(cwd, "stash", "list"), /ship-it-failed/);
  assert.doesNotMatch(git(cwd, "stash", "list"), /ship-it-baseline/);
  assert.match(result.stderr, /"workspace_restored":true/);
});

test("exit zero without Claude result is failure and rolls back", (t) => {
  const cwd = makeRepo(t);
  const claudeBin = fakeClaude(
    cwd,
    String.raw`
printf 'partial edit\n' > tracked.txt
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"no final result"}]}}'
`,
  );

  const result = run(cwd, claudeBin);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "committed\n");
  assert.match(result.stderr, /"structured_result_seen":false/);
});

test("watchdog terminates a silent process and restores the clean baseline", (t) => {
  const cwd = makeRepo(t);
  const claudeBin = fakeClaude(
    cwd,
    String.raw`
printf 'partial edit\n' > tracked.txt
sleep 10
`,
  );

  const result = run(cwd, claudeBin, [
    "--total-timeout-seconds",
    "2",
    "--idle-timeout-seconds",
    "1",
  ]);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "committed\n");
  assert.match(result.stderr, /no output progress|total timeout/);
  assert.match(result.stderr, /"workspace_restored":true/);
});
